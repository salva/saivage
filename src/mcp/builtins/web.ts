import { mkdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, relative } from "node:path";

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
  type HttpFetchErrorCode,
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

interface DownloadAttempt {
  url: string;
  attempt: number;
  status?: number;
  ok?: boolean;
  code?: HttpFetchErrorCode;
  error?: string;
  errno?: string;
  bytes?: number;
  headers?: Record<string, string>;
}

interface DownloadSuccess {
  url: string;
  path: string;
  bytes: number;
  sha256: string;
  headers: Record<string, string>;
  attempts: DownloadAttempt[];
}

type DownloadOutcome =
  | { ok: true; success: DownloadSuccess }
  | {
      ok: false;
      failure: ClassifiedHttpError & { status?: number };
      attempt: DownloadAttempt;
    };

async function downloadUrl(
  context: BuiltinContext,
  url: URL,
  outPath: string,
  options: {
    maxBytes: number;
    headers?: Record<string, string>;
    attempts: DownloadAttempt[];
    attemptNumber: number;
  },
): Promise<DownloadOutcome> {
  let timed: TimedFetch;
  try {
    timed = await fetchWithTimeout(
      url,
      { headers: { "User-Agent": "Saivage/0.1 data-agent", ...(options.headers ?? {}) } },
      context.limits.fetchTimeoutMs,
    );
  } catch (err) {
    const cls = classifyNetworkError(err, url.toString());
    const attempt: DownloadAttempt = {
      url: url.toString(),
      attempt: options.attemptNumber,
      code: cls.code,
      error: cls.error,
      errno: cls.errno,
    };
    options.attempts.push(attempt);
    return { ok: false, failure: cls, attempt };
  }
  try {
    const { response, signal, timedOut } = timed;
    const responseHeaders = headersObject(response.headers);
    const attempt: DownloadAttempt = {
      url: url.toString(),
      attempt: options.attemptNumber,
      status: response.status,
      ok: response.ok,
      headers: responseHeaders,
    };
    options.attempts.push(attempt);

    if (!response.ok) {
      await discardBody(response);
      const failure: ClassifiedHttpError & { status?: number } = {
        code: "UPSTREAM_HTTP_ERROR",
        error: `UPSTREAM_HTTP_ERROR: ${url} returned HTTP ${response.status}.`,
        status: response.status,
      };
      attempt.code = failure.code;
      attempt.error = failure.error;
      return { ok: false, failure, attempt };
    }

    const contentLength = Number(response.headers.get("content-length") ?? 0);
    if (contentLength > options.maxBytes) {
      await discardBody(response);
      const failure: ClassifiedHttpError = {
        code: "RESPONSE_TOO_LARGE",
        error: `RESPONSE_TOO_LARGE: Content-Length ${contentLength} exceeds max_bytes ${options.maxBytes}`,
      };
      attempt.code = failure.code;
      attempt.error = failure.error;
      return { ok: false, failure, attempt };
    }

    let read: BoundedReadResult<Buffer>;
    try {
      read = await readBoundedBinaryBody(response, options.maxBytes, signal);
    } catch (err) {
      const cls = classifyNetworkError(err, url.toString(), { timedOut: timedOut() });
      attempt.code = cls.code;
      attempt.error = cls.error;
      attempt.errno = cls.errno;
      return { ok: false, failure: cls, attempt };
    }
    attempt.bytes = read.bytes;
    if (read.truncated) {
      const failure: ClassifiedHttpError = {
        code: "RESPONSE_TOO_LARGE",
        error: `RESPONSE_TOO_LARGE: body exceeds max_bytes ${options.maxBytes}`,
      };
      attempt.code = failure.code;
      attempt.error = failure.error;
      return { ok: false, failure, attempt };
    }

    try {
      await mkdir(dirname(outPath), { recursive: true });
      await writeFile(outPath, read.body);
    } catch (err) {
      const failure: ClassifiedHttpError = {
        code: "IO_ERROR",
        error: `IO_ERROR: ${err instanceof Error ? err.message : String(err)}`,
        errno: (err as NodeJS.ErrnoException).code,
      };
      attempt.code = failure.code;
      attempt.error = failure.error;
      attempt.errno = failure.errno;
      return { ok: false, failure, attempt };
    }

    return {
      ok: true,
      success: {
        url: url.toString(),
        path: relative(context.project.projectRoot, outPath),
        bytes: read.bytes,
        sha256: createHash("sha256").update(read.body).digest("hex"),
        headers: responseHeaders,
        attempts: options.attempts,
      },
    };
  } finally {
    timed.dispose();
  }
}

const dataTools: ToolEntry[] = [
  {
    name: "web_search",
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
    name: "fetch_url",
    description: "Fetch a URL as text with status, selected headers, and a truncated body. Use for API docs, CSV previews, metadata pages, and robots-friendly web pages. The byte cap bounds the raw response stream.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string" },
        max_bytes: { type: "number", description: "Maximum response bytes to read from the upstream stream (default mcp.maxFetchBytes; clamped 1000..1000000)" },
      },
      required: ["url"],
    },
  },
  {
    name: "fetch_page_text",
    description: "Fetch an HTML page and return readable text extracted from it. Use this before falling back to Playwright for simple static pages. The byte cap bounds the raw HTML stream, not the stripped output.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string" },
        max_bytes: { type: "number", description: "Maximum raw HTML bytes to read from the upstream stream before stripping (default mcp.maxFetchBytes; clamped 1000..1000000)" },
      },
      required: ["url"],
    },
  },
  {
    name: "download_file",
    description: "Download a public http/https file to any project-relative path chosen by the task, returning path, byte size, sha256, and provenance headers.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string" },
        path: { type: "string", description: "Project-relative output path selected for this artifact; not restricted to one directory" },
        max_bytes: { type: "number", description: "Maximum bytes allowed (default 250MB)" },
        headers: { type: "object", description: "Optional request headers for sources that require a documented header such as Accept" },
      },
      required: ["url", "path"],
    },
  },
  {
    name: "download_with_fallbacks",
    description: "Try multiple http/https source URLs with bounded retries, save the first successful artifact, and return an attempt log for provenance and reliability accounting.",
    inputSchema: {
      type: "object",
      properties: {
        urls: { type: "array", items: { type: "string" }, description: "Candidate source URLs in preference order" },
        path: { type: "string", description: "Project-relative output path selected for this artifact; not restricted to one directory" },
        max_bytes: { type: "number", description: "Maximum bytes allowed (default 250MB)" },
        retries_per_url: { type: "number", description: "Attempts per URL before trying the next source (default 2, max 5)" },
        headers: { type: "object", description: "Optional request headers applied to each candidate URL" },
        manifest_path: { type: "string", description: "Optional project-relative JSON path where the source attempts and selected artifact metadata should be written" },
      },
      required: ["urls", "path"],
    },
  },
  {
    name: "head_url",
    description: "Request URL metadata without downloading the full body. Use to check availability, content type, file size, etag, and last-modified.",
    inputSchema: {
      type: "object",
      properties: { url: { type: "string" } },
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
      case "web_search": {
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

      case "fetch_url": {
        let url: URL;
        try {
          url = parseHttpUrl(String(args.url));
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
        const maxBytes = Math.min(Math.max(Number(args.max_bytes ?? context.limits.maxFetchBytes), 1_000), 1_000_000);
        let timed: TimedFetch;
        try {
          timed = await fetchWithTimeout(
            url,
            { headers: { "User-Agent": "Saivage/0.1 data-agent" } },
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
          if (!response.ok) {
            await discardBody(response);
            return {
              content: {
                code: "UPSTREAM_HTTP_ERROR",
                error: `UPSTREAM_HTTP_ERROR: ${url} returned HTTP ${response.status}.`,
                url: url.toString(),
                status: response.status,
                headers: headersObject(response.headers),
              },
              isError: true,
            };
          }
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
          return {
            content: {
              url: url.toString(),
              status: response.status,
              ok: response.ok,
              headers: headersObject(response.headers),
              content: read.body,
              bytes_read: read.bytes,
              truncated: read.truncated,
            },
            isError: false,
          };
        } finally {
          timed.dispose();
        }
      }

      case "fetch_page_text": {
        let url: URL;
        try {
          url = parseHttpUrl(String(args.url));
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
        const maxBytes = Math.min(Math.max(Number(args.max_bytes ?? context.limits.maxFetchBytes), 1_000), 1_000_000);
        let timed: TimedFetch;
        try {
          timed = await fetchWithTimeout(
            url,
            { headers: { "User-Agent": "Saivage/0.1 data-agent" } },
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
          if (!response.ok) {
            await discardBody(response);
            return {
              content: {
                code: "UPSTREAM_HTTP_ERROR",
                error: `UPSTREAM_HTTP_ERROR: ${url} returned HTTP ${response.status}.`,
                url: url.toString(),
                status: response.status,
                headers: headersObject(response.headers),
              },
              isError: true,
            };
          }
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
          const stripped = stripHtml(read.body);
          return {
            content: {
              url: url.toString(),
              status: response.status,
              ok: response.ok,
              headers: headersObject(response.headers),
              text: stripped,
              bytes_read: read.bytes,
              truncated: read.truncated,
            },
            isError: false,
          };
        } finally {
          timed.dispose();
        }
      }

      case "download_file": {
        let url: URL;
        try {
          url = parseHttpUrl(String(args.url));
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
        const authorized = authorizePathMutation(ctx, String(args.path), context.project.projectRoot);
        if ("error" in authorized) return { content: authorized.error, isError: true };
        const outPath = authorized.path;
        const maxBytes = Math.min(Math.max(Number(args.max_bytes ?? context.limits.maxDownloadBytes), 1), 2 * 1024 * 1024 * 1024);
        const attempts: DownloadAttempt[] = [];
        const outcome = await downloadUrl(context, url, outPath, {
          maxBytes,
          headers: args.headers as Record<string, string> | undefined,
          attempts,
          attemptNumber: 1,
        });
        if (outcome.ok) return { content: outcome.success, isError: false };
        return {
          content: {
            ...outcome.failure,
            url: url.toString(),
            attempts,
          },
          isError: true,
        };
      }

      case "download_with_fallbacks": {
        const rawUrls = Array.isArray(args.urls) ? args.urls.map(String).filter(Boolean) : [];
        if (rawUrls.length === 0) {
          return {
            content: {
              code: "INVALID_ARGUMENT",
              error: "INVALID_ARGUMENT: urls must contain at least one source",
            },
            isError: true,
          };
        }
        const authorized = authorizePathMutation(ctx, String(args.path), context.project.projectRoot);
        if ("error" in authorized) return { content: authorized.error, isError: true };
        const outPath = authorized.path;
        let manifestPath: string | null = null;
        if (args.manifest_path) {
          const manifestAuthorized = authorizePathMutation(ctx, String(args.manifest_path), context.project.projectRoot);
          if ("error" in manifestAuthorized) return { content: manifestAuthorized.error, isError: true };
          manifestPath = manifestAuthorized.path;
        }
        const maxBytes = Math.min(Math.max(Number(args.max_bytes ?? context.limits.maxDownloadBytes), 1), 2 * 1024 * 1024 * 1024);
        const retriesPerUrl = Math.min(Math.max(Number(args.retries_per_url ?? 2), 1), 5);
        const headers = args.headers as Record<string, string> | undefined;
        const attempts: DownloadAttempt[] = [];
        let lastFailure: (ClassifiedHttpError & { status?: number }) | null = null;

        for (const rawUrl of rawUrls) {
          let url: URL;
          try {
            url = parseHttpUrl(rawUrl);
          } catch (err) {
            const cls: ClassifiedHttpError = {
              code: "INVALID_ARGUMENT",
              error: `INVALID_ARGUMENT: ${err instanceof Error ? err.message : String(err)}`,
            };
            attempts.push({ url: rawUrl, attempt: 0, code: cls.code, error: cls.error });
            lastFailure = cls;
            continue;
          }
          for (let attemptNumber = 1; attemptNumber <= retriesPerUrl; attemptNumber++) {
            const outcome = await downloadUrl(context, url, outPath, {
              maxBytes, headers, attempts, attemptNumber,
            });
            if (outcome.ok) {
              const success = outcome.success;
              if (manifestPath) {
                await mkdir(dirname(manifestPath), { recursive: true });
                await writeFile(manifestPath, JSON.stringify(success, null, 2) + "\n", "utf-8");
              }
              return { content: { ...success, selected_url: success.url }, isError: false };
            }
            lastFailure = outcome.failure;
          }
        }

        const baseFailure = lastFailure
          ?? ({ code: "NETWORK_ERROR" as const, error: "NETWORK_ERROR: all sources failed" } satisfies ClassifiedHttpError);
        const failure = {
          ...baseFailure,
          error: lastFailure
            ? `ALL_SOURCES_FAILED: last failure: ${lastFailure.error}`
            : "ALL_SOURCES_FAILED: no sources attempted",
          path: relative(context.project.projectRoot, outPath),
          attempts,
        };
        if (manifestPath) {
          await mkdir(dirname(manifestPath), { recursive: true });
          await writeFile(manifestPath, JSON.stringify(failure, null, 2) + "\n", "utf-8");
        }
        return { content: failure, isError: true };
      }

      case "head_url": {
        const url = parseHttpUrl(String(args.url));
        const response = await fetch(url, { method: "HEAD", headers: { "User-Agent": "Saivage/0.1 data-agent" } });
        return { content: { url: url.toString(), status: response.status, ok: response.ok, headers: headersObject(response.headers) }, isError: false };
      }

      default:
        return { content: { error: `Unknown data tool: ${toolName}` }, isError: true };
    }
  };

  return { tools: dataTools, handler };
}
