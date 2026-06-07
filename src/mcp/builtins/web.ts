import { mkdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";

import { parse as parseHtml, type HTMLElement } from "node-html-parser";

import type { InProcessToolHandler } from "../runtime.js";
import type { ToolEntry } from "../types.js";
import {
  fetchWithTimeout,
  readBoundedTextBody,
  readBoundedBinaryBody,
  discardBody,
  classifyNetworkError,
  type BoundedReadResult,
  type ClassifiedHttpError,
  type TimedFetch,
} from "../httpFetch.js";
import type { BuiltinContext } from "./context.js";
import { parseNonNegativeInt } from "./limits.js";
import { authorizePathMutation } from "./paths.js";

function parseHttpUrl(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("URL must use http or https");
  }
  return url;
}

function headersObject(headers: Headers): Record<string, string> {
  const result: Record<string, string> = {};
  for (const key of ["content-type", "content-length", "last-modified", "etag"]) {
    const value = headers.get(key);
    if (value) result[key] = value;
  }
  return result;
}

function imageMime(contentType: string): string | null {
  const mime = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
  if (["image/png", "image/jpeg", "image/webp", "image/gif"].includes(mime)) return mime;
  return null;
}

function isTextMime(contentType: string): boolean {
  const mime = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
  return mime.startsWith("text/") || [
    "application/json",
    "application/javascript",
    "application/xml",
    "application/xhtml+xml",
    "application/x-ndjson",
  ].includes(mime);
}

function stripHtml(value: string): string {
  return value
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

export interface DdgResult {
  title: string;
  url: string;
  snippet: string;
}

export interface DdgExtraction {
  results: DdgResult[];
  skipped: number;
}

function climbToResultContainer(node: HTMLElement): HTMLElement | null {
  let cur: HTMLElement | null = node;
  for (let i = 0; cur && i < 6; i += 1) {
    if (cur.classList?.contains("result")) return cur;
    cur = (cur.parentNode as HTMLElement | null) ?? null;
  }
  return null;
}

function signatureOf(html: string): string {
  return createHash("sha256").update(html).digest("hex").slice(0, 16);
}

/**
 * Extract DuckDuckGo HTML-endpoint results from a response body. `base`
 * is the request URL (used to resolve relative anchor hrefs). `max` is
 * the caller's effective ceiling. Markup with zero candidate anchors
 * returns an empty result list; the handler upgrades that to
 * `NO_RESULTS_PARSED`. The `uddg` query parameter is decoded exactly
 * once via `URLSearchParams.get` and validated by `new URL` — no second
 * `decodeURIComponent` pass.
 */
export function extractDdgResults(html: string, base: URL, max: number): DdgExtraction {
  const root = parseHtml(html, {
    lowerCaseTagName: false,
    comment: false,
    blockTextElements: { script: false, style: false, noscript: false, pre: false },
  });
  const anchors = root.querySelectorAll("a.result__a");
  const results: DdgResult[] = [];
  let skipped = 0;
  for (const a of anchors) {
    if (results.length >= max) break;
    const href = a.getAttribute("href");
    if (!href) { skipped += 1; continue; }
    let resolvedUrl: string;
    try {
      const parsedHref = new URL(href, base);
      const uddg = parsedHref.searchParams.get("uddg");
      if (uddg !== null) {
        const candidate = new URL(uddg);
        if (candidate.protocol !== "http:" && candidate.protocol !== "https:") {
          skipped += 1;
          continue;
        }
        resolvedUrl = candidate.toString();
      } else {
        resolvedUrl = parsedHref.toString();
      }
    } catch {
      skipped += 1;
      continue;
    }
    const title = (a.text ?? "").replace(/\s+/g, " ").trim();
    const container = climbToResultContainer(a);
    const snippetNode = container?.querySelector("a.result__snippet, .result__snippet");
    const snippet = snippetNode ? (snippetNode.text ?? "").replace(/\s+/g, " ").trim() : "";
    results.push({ title, url: resolvedUrl, snippet });
  }
  return { results, skipped };
}

type WebfetchReadMode = "auto" | "text" | "multimodal";

function webfetchReadMode(value: unknown): WebfetchReadMode {
  if (value === undefined || value === "auto") return "auto";
  if (value === "text" || value === "multimodal") return value;
  throw new Error("read_mode must be 'auto', 'text', or 'multimodal'");
}

function boundedPositiveInt(value: unknown, fallback: number, min: number, max: number, name: string): number {
  const raw = value === undefined ? fallback : Number(value);
  if (!Number.isFinite(raw) || raw < 0 || !Number.isInteger(raw)) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return Math.min(Math.max(raw, min), max);
}

async function writeStash(context: BuiltinContext, text: string): Promise<string> {
  const hash = createHash("sha256").update(text).digest("hex").slice(0, 16);
  const stashPath = `.saivage/tmp/stash/webfetch-${Date.now()}-${hash}.txt`;
  const absolute = join(context.project.projectRoot, stashPath);
  await mkdir(dirname(absolute), { recursive: true });
  await writeFile(absolute, text, "utf-8");
  return stashPath;
}

const dataTools: ToolEntry[] = [
  {
    name: "websearch",
    description:
      "Search the public web for data sources, APIs, documentation, and downloadable datasets. " +
      "Returns candidate URLs with snippets when available. On failure the envelope carries a " +
      "stable `code`: one of `INVALID_ARGUMENT`, `TIMEOUT`, `NETWORK_ERROR`, `UPSTREAM_HTTP_ERROR`, " +
      "`RESPONSE_TOO_LARGE`, `PARSE_FAILURE`, or `NO_RESULTS_PARSED`.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        max_results: {
          type: "number",
          description:
            "Maximum number of results to return. Default and ceiling are controlled by " +
            "`mcp.webSearchMaxResults` (default 20, max 50). Any larger value is clamped to the ceiling.",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "webfetch",
    description: "Fetch an HTTP(S) URL as bounded raw bytes or decoded text, optionally saving the fetched content to an authorized project path. metadata_only uses GET with Range bytes=0-0.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string" },
        read_mode: { type: "string", enum: ["auto", "text", "multimodal"], description: "Default 'auto' returns raw bytes as base64. 'text' returns decoded UTF-8 text. 'multimodal' returns image attachments when supported." },
        metadata_only: { type: "boolean", description: "Fetch only response metadata using GET with Range: bytes=0-0. Cannot be combined with save_as." },
        max_bytes: { type: "number", description: "Maximum response bytes to read (default mcp.maxFetchBytes; clamped 1..1000000 for inline fetches)." },
        max_inline_bytes: { type: "number", description: "Maximum decoded text bytes returned inline before spilling text to .saivage/tmp/stash/." },
        save_as: { type: "string", description: "Optional project-relative path to save fetched raw bytes or decoded text. Requires path mutation authorization." },
      },
      required: ["url"],
    },
  },
];

export function makeDataService(context: BuiltinContext): {
  tools: ToolEntry[];
  handler: InProcessToolHandler;
} {
  const handler: InProcessToolHandler = async (toolName, args, ctx) => {
    switch (toolName) {
      case "websearch": {
        const query = typeof args.query === "string" ? args.query.trim() : "";
        if (!query) {
          return {
            content: { error: "INVALID_ARGUMENT: query must be a non-empty string", code: "INVALID_ARGUMENT" },
            isError: true,
          };
        }

        let maxResults: number;
        try {
          const override = parseNonNegativeInt(args.max_results, "max_results");
          maxResults = override === undefined
            ? context.limits.webSearchMaxResults
            : Math.min(Math.max(override, 1), context.limits.webSearchMaxResults);
        } catch (err) {
          return {
            content: {
              error: `INVALID_ARGUMENT: ${(err as Error).message}`,
              code: "INVALID_ARGUMENT",
              query,
            },
            isError: true,
          };
        }

        const searchUrl = new URL(context.limits.webSearchEndpoint);
        searchUrl.searchParams.set("q", query);

        let timed: TimedFetch;
        try {
          timed = await fetchWithTimeout(
            searchUrl,
            { headers: { "User-Agent": "Saivage/0.1 data-agent" } },
            context.limits.webSearchTimeoutMs,
          );
        } catch (err) {
          const classified: ClassifiedHttpError = classifyNetworkError(err, searchUrl.toString());
          const content: Record<string, unknown> = { ...classified, query };
          if (classified.code === "TIMEOUT") content.timeout_ms = context.limits.webSearchTimeoutMs;
          return { content, isError: true };
        }

        try {
          const { response, signal, timedOut } = timed;

          if (!response.ok) {
            await discardBody(response);
            return {
              content: {
                error: `UPSTREAM_HTTP_ERROR: DuckDuckGo returned ${response.status}`,
                code: "UPSTREAM_HTTP_ERROR",
                query,
                status: response.status,
              },
              isError: true,
            };
          }

          let read: BoundedReadResult<string>;
          try {
            read = await readBoundedTextBody(response, context.limits.webSearchMaxBytes, signal);
          } catch (err) {
            const classified: ClassifiedHttpError = classifyNetworkError(
              err,
              searchUrl.toString(),
              { timedOut: timedOut() },
            );
            const content: Record<string, unknown> = { ...classified, query };
            if (classified.code === "TIMEOUT") content.timeout_ms = context.limits.webSearchTimeoutMs;
            return { content, isError: true };
          }

          if (read.truncated) {
            return {
              content: {
                error: `RESPONSE_TOO_LARGE: DuckDuckGo response exceeded ${context.limits.webSearchMaxBytes} bytes`,
                code: "RESPONSE_TOO_LARGE",
                query,
                max_bytes: context.limits.webSearchMaxBytes,
              },
              isError: true,
            };
          }

          let extracted: DdgExtraction;
          try {
            extracted = extractDdgResults(read.body, searchUrl, maxResults);
          } catch (err) {
            return {
              content: {
                error: `PARSE_FAILURE: ${(err as Error).message}`,
                code: "PARSE_FAILURE",
                query,
              },
              isError: true,
            };
          }

          if (extracted.results.length === 0) {
            return {
              content: {
                error: "NO_RESULTS_PARSED: DuckDuckGo response parsed but no result anchors matched; markup may have drifted",
                code: "NO_RESULTS_PARSED",
                query,
                status: response.status,
                bytes: read.body.length,
                markup_signature: signatureOf(read.body),
              },
              isError: true,
            };
          }

          return {
            content: {
              query,
              results: extracted.results,
              status: response.status,
              skipped: extracted.skipped,
            },
            isError: false,
          };
        } finally {
          timed.dispose();
        }
      }

      case "webfetch": {
        let url: URL;
        let readMode: WebfetchReadMode;
        let maxBytes: number;
        let maxInlineBytes: number;
        try {
          url = parseHttpUrl(String(args.url));
          readMode = webfetchReadMode(args.read_mode);
          maxBytes = boundedPositiveInt(args.max_bytes, context.limits.maxFetchBytes, 1, 1_000_000, "max_bytes");
          maxInlineBytes = boundedPositiveInt(args.max_inline_bytes, context.limits.maxFileReadBytes, 0, 1_000_000, "max_inline_bytes");
        } catch (err) {
          return {
            content: {
              code: "INVALID_ARGUMENT",
              error: `INVALID_ARGUMENT: ${err instanceof Error ? err.message : String(err)}`,
              url: String(args.url),
            },
            isError: true,
          };
        }
        const metadataOnly = Boolean(args.metadata_only);
        const saveAs = typeof args.save_as === "string" && args.save_as.length > 0 ? args.save_as : undefined;
        if (metadataOnly && saveAs) {
          return {
            content: {
              code: "INVALID_ARGUMENT",
              error: "INVALID_ARGUMENT: metadata_only cannot be combined with save_as",
              url: url.toString(),
            },
            isError: true,
          };
        }
        const authorized = saveAs ? authorizePathMutation(ctx, saveAs, context.project.projectRoot) : undefined;
        if (authorized && "error" in authorized) return { content: authorized.error, isError: true };

        let timed: TimedFetch;
        try {
          timed = await fetchWithTimeout(
            url,
            { headers: { "User-Agent": "Saivage/0.1 data-agent", ...(metadataOnly ? { Range: "bytes=0-0" } : {}) } },
            context.limits.fetchTimeoutMs,
          );
        } catch (err) {
          return {
            content: { ...classifyNetworkError(err, url.toString()), url: url.toString() },
            isError: true,
          };
        }
        try {
          const { response, signal, timedOut } = timed;
          const responseHeaders = headersObject(response.headers);
          if (metadataOnly) {
            await discardBody(response);
            return {
              content: { url: url.toString(), status: response.status, ok: response.ok, headers: responseHeaders },
              isError: false,
            };
          }
          if (!response.ok) {
            await discardBody(response);
            return {
              content: {
                code: "UPSTREAM_HTTP_ERROR",
                error: `UPSTREAM_HTTP_ERROR: ${url} returned HTTP ${response.status}.`,
                url: url.toString(),
                status: response.status,
                headers: responseHeaders,
              },
              isError: true,
            };
          }
          const declaredLength = response.headers.get("content-length");
          if (declaredLength !== null) {
            const declaredBytes = Number(declaredLength);
            if (Number.isFinite(declaredBytes) && declaredBytes > maxBytes) {
              await discardBody(response);
              return { content: { code: "RESPONSE_TOO_LARGE", error: `RESPONSE_TOO_LARGE: content-length ${declaredBytes} exceeds max_bytes ${maxBytes}`, url: url.toString(), max_bytes: maxBytes, content_length: declaredBytes }, isError: true };
            }
          }
          const contentType = response.headers.get("content-type") ?? "";
          const mime = imageMime(contentType);
          const shouldReadText = readMode === "text" || (!authorized && readMode === "auto" && !mime && isTextMime(contentType));
          if (shouldReadText) {
            let read: BoundedReadResult<string>;
            try {
              read = await readBoundedTextBody(response, maxBytes, signal);
            } catch (err) {
              return {
                content: {
                  ...classifyNetworkError(err, url.toString(), { timedOut: timedOut() }),
                  url: url.toString(),
                },
                isError: true,
              };
            }
            if (read.truncated) {
              return { content: { code: "RESPONSE_TOO_LARGE", error: `RESPONSE_TOO_LARGE: body exceeds max_bytes ${maxBytes}`, url: url.toString() }, isError: true };
            }
            if (authorized && !("error" in authorized)) {
              await mkdir(dirname(authorized.path), { recursive: true });
              await writeFile(authorized.path, read.body, "utf-8");
              return { content: { url: url.toString(), status: response.status, ok: response.ok, headers: responseHeaders, bytes_read: read.bytes, sha256: createHash("sha256").update(read.body).digest("hex"), saved_path: authorized.relativePath }, isError: false };
            }
            const result: Record<string, unknown> = { url: url.toString(), status: response.status, ok: response.ok, headers: responseHeaders, bytes_read: read.bytes, truncated: false };
            if (Buffer.byteLength(read.body, "utf-8") > maxInlineBytes) {
              result.stash_path = await writeStash(context, read.body);
              result.content_preview = read.body.slice(0, maxInlineBytes);
            } else {
              result.content = read.body;
            }
            return { content: result, isError: false };
          }
          let read: BoundedReadResult<Buffer>;
          try {
            read = await readBoundedBinaryBody(response, maxBytes, signal);
          } catch (err) {
            return {
              content: {
                ...classifyNetworkError(err, url.toString(), { timedOut: timedOut() }),
                url: url.toString(),
              },
              isError: true,
            };
          }
          if (read.truncated) {
            return { content: { code: "RESPONSE_TOO_LARGE", error: `RESPONSE_TOO_LARGE: body exceeds max_bytes ${maxBytes}`, url: url.toString() }, isError: true };
          }
          if (authorized && !("error" in authorized)) {
            await mkdir(dirname(authorized.path), { recursive: true });
            await writeFile(authorized.path, read.body);
            return { content: { url: url.toString(), status: response.status, ok: response.ok, headers: responseHeaders, bytes_read: read.bytes, sha256: createHash("sha256").update(read.body).digest("hex"), saved_path: authorized.relativePath }, isError: false };
          }
          if ((readMode === "multimodal" || readMode === "auto") && mime) {
            return {
              content: {
                text: "Image fetched successfully",
                url: url.toString(),
                status: response.status,
                ok: response.ok,
                headers: responseHeaders,
                bytes_read: read.bytes,
                attachments: [{ mime, url: `data:${mime};base64,${read.body.toString("base64")}`, filename: url.pathname.split("/").filter(Boolean).at(-1) }],
              },
              isError: false,
            };
          }
          if (readMode === "multimodal") {
            return { content: { code: "UNSUPPORTED_MEDIA_TYPE", error: `UNSUPPORTED_MEDIA_TYPE: ${contentType || "unknown"} cannot be attached`, url: url.toString(), status: response.status, headers: responseHeaders }, isError: true };
          }
          return {
            content: { code: "UNSUPPORTED_BINARY_CONTENT", error: `UNSUPPORTED_BINARY_CONTENT: ${contentType || "unknown"} is not safe for inline return; use save_as to persist it`, url: url.toString(), status: response.status, headers: responseHeaders, bytes_read: read.bytes, sha256: createHash("sha256").update(read.body).digest("hex") },
            isError: true,
          };
        } finally {
          timed.dispose();
        }
      }

      default:
        return { content: { error: `Unknown data tool: ${toolName}` }, isError: true };
    }
  };

  return { tools: dataTools, handler };
}
