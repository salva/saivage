import { mkdir, opendir, open, readdir, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";

import type { InProcessToolHandler } from "../runtime.js";
import type { ToolEntry } from "../types.js";
import type { BuiltinContext } from "./context.js";
import { classifyFsError, type ClassifiedFsError } from "./errors.js";
import { parseNonNegativeInt } from "./limits.js";
import { authorizePathMutation, resolvePath } from "./paths.js";

function translateSegment(seg: string): string {
  let out = "";
  let i = 0;
  while (i < seg.length) {
    const c = seg[i];
    if (c === "*") { out += "[^/]*"; i += 1; continue; }
    if (c === "?") { out += "[^/]"; i += 1; continue; }
    if (c === "[") {
      const close = seg.indexOf("]", i + 1);
      if (close === -1) throw new Error("Unterminated character class");
      out += seg.slice(i, close + 1);
      i = close + 1;
      continue;
    }
    if (/[.+^$()|{}\\]/.test(c)) { out += "\\" + c; i += 1; continue; }
    out += c;
    i += 1;
  }
  return out;
}

function globToRegExp(pattern: string): RegExp {
  const segments = pattern.split("/");
  const out: string[] = ["^"];
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const isLast = i === segments.length - 1;
    const isFirst = i === 0;

    if (seg === "**") {
      if (isFirst && isLast) {
        out.push(".*");
        continue;
      }
      if (isFirst) {
        out.push("(?:[^/]+/)*");
        continue;
      }
      if (isLast) {
        out.push(".*");
        continue;
      }
      out.push("(?:[^/]+/)*");
      continue;
    }

    if (seg.includes("**")) {
      throw new Error(
        `'**' must occupy an entire path segment (got '${seg}')`,
      );
    }

    out.push(translateSegment(seg));
    if (!isLast) {
      const next = segments[i + 1];
      if (!(next === "**" && i + 1 < segments.length - 1)) {
        out.push("/");
      } else {
        out.push("/");
      }
    }
  }
  out.push("$");
  return new RegExp(out.join(""));
}

const filesystemTools: ToolEntry[] = [
  {
    name: "read_file",
    description:
      "Read a windowed slice of a UTF-8 file. Returns up to mcp.maxFileReadBytes bytes per call. " +
      "Use offset/length for windowed reads on larger files. " +
      "Binary content (NUL byte in the first 4 KiB) is rejected; " +
      "use run_command with file/xxd or download_file for raw bytes.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        offset: {
          type: "number",
          description: "Byte offset to start reading from. Must be a non-negative integer. Default 0.",
        },
        length: {
          type: "number",
          description:
            "Maximum number of bytes to read. Must be a non-negative integer and at most mcp.maxFileReadBytes. " +
            "Defaults to mcp.maxFileReadBytes.",
        },
      },
      required: ["path"],
    },
  },
  {
    name: "write_file",
    description: "Write content to a file (creates parent dirs if needed)",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" }, content: { type: "string" } },
      required: ["path", "content"],
    },
  },
  {
    name: "list_dir",
    description: "List contents of a directory",
    inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
  },
  {
    name: "search_files",
    description:
      "Recursively search for files matching a glob under 'directory'. " +
      "Glob dialect: '*' matches one path segment's chars, '?' matches " +
      "one char, '[...]' is a character class, '**' matches zero or more " +
      "path segments. Skips '.git' and 'node_modules' by default. " +
      "Hard ceilings come from mcp.maxSearchResults (default 1000), " +
      "mcp.maxSearchDepth (default 20), mcp.maxSearchMs (default 10000). " +
      "Per-call 'max_results' may only lower the ceiling.",
    inputSchema: {
      type: "object",
      properties: {
        directory: { type: "string" },
        pattern: { type: "string" },
        max_results: {
          type: "number",
          description:
            "Optional non-negative integer cap on returned matches. " +
            "Must be <= mcp.maxSearchResults.",
        },
      },
      required: ["directory", "pattern"],
    },
  },
];

export function makeFilesystemService(context: BuiltinContext): {
  tools: ToolEntry[];
  handler: InProcessToolHandler;
} {
  const handler: InProcessToolHandler = async (toolName, args, ctx) => {
    switch (toolName) {
      case "read_file": {
        const fp = resolvePath(args.path as string, context.project.projectRoot);

        let offset: number | undefined;
        let length: number | undefined;
        try {
          offset = parseNonNegativeInt(args.offset, "offset");
          length = parseNonNegativeInt(args.length, "length");
        } catch (err) {
          return {
            content: {
              error: `INVALID_ARGUMENT: ${(err as Error).message}`,
              code: "INVALID_ARGUMENT",
              path: args.path,
            },
            isError: true,
          };
        }

        if (length !== undefined && length > context.limits.maxFileReadBytes) {
          return {
            content: {
              error:
                `LENGTH_TOO_LARGE: length=${length} exceeds ` +
                `mcp.maxFileReadBytes=${context.limits.maxFileReadBytes}. ` +
                `Issue multiple windowed reads or use run_command head/tail.`,
              code: "LENGTH_TOO_LARGE",
              path: args.path,
              length,
              max_bytes: context.limits.maxFileReadBytes,
            },
            isError: true,
          };
        }

        let st;
        try {
          st = await stat(fp);
        } catch (err) {
          const classified = classifyFsError(err, args.path as string, "stat");
          return { content: { ...classified, path: args.path }, isError: true };
        }
        if (!st.isFile()) {
          return {
            content: {
              error: `NOT_A_FILE: ${args.path} is not a regular file`,
              code: "NOT_A_FILE",
              path: args.path,
            },
            isError: true,
          };
        }

        const totalSize = st.size;
        const effectiveOffset = offset ?? 0;

        if (effectiveOffset > totalSize) {
          return {
            content: {
              error:
                `INVALID_RANGE: offset=${effectiveOffset} exceeds ` +
                `file size=${totalSize}`,
              code: "INVALID_RANGE",
              path: args.path,
              offset: effectiveOffset,
              size_bytes: totalSize,
            },
            isError: true,
          };
        }

        if (
          offset === undefined &&
          length === undefined &&
          totalSize > context.limits.maxFileReadBytes
        ) {
          return {
            content: {
              error:
                `FILE_TOO_LARGE: size=${totalSize} bytes exceeds ` +
                `mcp.maxFileReadBytes=${context.limits.maxFileReadBytes}. ` +
                `Re-issue with explicit offset/length (each <= ${context.limits.maxFileReadBytes}), ` +
                `or use run_command with head/tail/grep, or use search_files.`,
              code: "FILE_TOO_LARGE",
              path: args.path,
              size_bytes: totalSize,
              max_bytes: context.limits.maxFileReadBytes,
            },
            isError: true,
          };
        }

        let handle;
        try {
          handle = await open(fp, "r");
        } catch (err) {
          const classified = classifyFsError(err, args.path as string, "open");
          return { content: { ...classified, path: args.path }, isError: true };
        }

        let probeBytes = 0;
        let windowBytes = 0;
        let probeBuffer = Buffer.alloc(0);
        let windowBuffer: Buffer = Buffer.alloc(0);
        let isBinary = false;
        let readFailure: ClassifiedFsError | null = null;
        try {
          const probeSize = Math.min(4096, totalSize);
          if (probeSize > 0) {
            probeBuffer = Buffer.alloc(probeSize);
            const probeRead = await handle.read(probeBuffer, 0, probeSize, 0);
            probeBytes = probeRead.bytesRead;
            if (probeBuffer.subarray(0, probeBytes).includes(0)) {
              isBinary = true;
            }
          }

          if (!isBinary) {
            const effectiveLength = length ?? context.limits.maxFileReadBytes;
            const remaining = totalSize - effectiveOffset;
            const toRead = Math.min(effectiveLength, remaining);
            if (toRead > 0) {
              if (effectiveOffset === 0 && toRead <= probeBytes) {
                windowBuffer = probeBuffer.subarray(0, toRead) as Buffer;
                windowBytes = toRead;
              } else {
                windowBuffer = Buffer.alloc(toRead);
                const winRead = await handle.read(windowBuffer, 0, toRead, effectiveOffset);
                windowBytes = winRead.bytesRead;
              }
            }
          }
        } catch (err) {
          readFailure = classifyFsError(err, args.path as string, "read");
        } finally {
          try {
            await handle.close();
          } catch (closeErr) {
            // Primary read/binary observations are earlier and more actionable.
            if (!readFailure && !isBinary) {
              readFailure = classifyFsError(closeErr, args.path as string, "close");
            }
          }
        }

        if (isBinary) {
          return {
            content: {
              error:
                `BINARY_CONTENT: ${args.path} contains a NUL byte in its ` +
                `first ${probeBytes} bytes. Use run_command with file/xxd, ` +
                `or download_file if you need the raw bytes.`,
              code: "BINARY_CONTENT",
              path: args.path,
              size_bytes: totalSize,
            },
            isError: true,
          };
        }

        if (readFailure) {
          return { content: { ...readFailure, path: args.path }, isError: true };
        }

        const content = windowBuffer.subarray(0, windowBytes).toString("utf-8");
        const truncated = effectiveOffset + windowBytes < totalSize;
        return {
          content: {
            content,
            offset: effectiveOffset,
            length: windowBytes,
            size_bytes: totalSize,
            truncated,
          },
          isError: false,
        };
      }
      case "write_file": {
        const authorized = authorizePathMutation(ctx, args.path as string, context.project.projectRoot);
        if ("error" in authorized) return { content: authorized.error, isError: true };
        const fp = authorized.path;
        await mkdir(dirname(fp), { recursive: true });
        await writeFile(fp, args.content as string, "utf-8");
        return { content: { written: true, path: fp }, isError: false };
      }
      case "list_dir": {
        const dp = resolvePath(args.path as string, context.project.projectRoot);
        const entries = (await readdir(dp, { withFileTypes: true })).map((e) => ({
          name: e.name,
          type: e.isDirectory() ? "dir" : "file",
        }));
        return { content: { entries }, isError: false };
      }
      case "search_files": {
        const dir = resolvePath(args.directory as string, context.project.projectRoot);
        const pattern = args.pattern;

        if (typeof pattern !== "string" || pattern.length === 0) {
          return {
            content: {
              error: "INVALID_ARGUMENT: pattern must be a non-empty string",
              code: "INVALID_ARGUMENT",
              directory: args.directory,
            },
            isError: true,
          };
        }

        let maxResults: number;
        try {
          const override = parseNonNegativeInt(args.max_results, "max_results");
          maxResults = override === undefined
            ? context.limits.maxSearchResults
            : Math.min(override, context.limits.maxSearchResults);
        } catch (err) {
          return {
            content: {
              error: `INVALID_ARGUMENT: ${(err as Error).message}`,
              code: "INVALID_ARGUMENT",
              directory: args.directory,
            },
            isError: true,
          };
        }

        let regex: RegExp;
        try {
          regex = globToRegExp(pattern);
        } catch (err) {
          return {
            content: {
              error: `INVALID_PATTERN: ${(err as Error).message}`,
              code: "INVALID_PATTERN",
              directory: args.directory,
              pattern,
            },
            isError: true,
          };
        }

        const rootErrorEnvelope = (err: unknown, op: "stat" | "open") => {
          const classified = classifyFsError(err, dir, op);
          if ((classified.errno as string | undefined) === "ENOTDIR") {
            return {
              error: `NOT_A_DIRECTORY: ${args.directory} is not a directory`,
              code: "NOT_A_DIRECTORY" as const,
              directory: args.directory,
              errno: "ENOTDIR" as const,
            };
          }
          return { ...classified, directory: args.directory };
        };

        let dirStat: Awaited<ReturnType<typeof stat>>;
        try {
          dirStat = await stat(dir);
        } catch (err) {
          return { content: rootErrorEnvelope(err, "stat"), isError: true };
        }
        if (!dirStat.isDirectory()) {
          return {
            content: {
              error: `NOT_A_DIRECTORY: ${args.directory} is not a directory`,
              code: "NOT_A_DIRECTORY",
              directory: args.directory,
            },
            isError: true,
          };
        }

        const deadline = Date.now() + context.limits.maxSearchMs;
        const files: string[] = [];
        const skipped: Array<{ path: string; code: "PERMISSION_DENIED" | "NOT_FOUND" }> = [];
        let truncatedReason: "results" | "depth" | "time" | null = null;
        let rootError: ReturnType<typeof rootErrorEnvelope> | null = null;
        let fatalWalkError:
          | { error: string; code: "READ_DIRECTORY_FAILED"; errno?: string; path: string }
          | null = null;

        const visit = async (current: string, depth: number): Promise<void> => {
          if (truncatedReason !== null || rootError !== null || fatalWalkError !== null) return;
          if (Date.now() > deadline) { truncatedReason = "time"; return; }
          if (depth > context.limits.maxSearchDepth) { truncatedReason = "depth"; return; }

          let handle: Awaited<ReturnType<typeof opendir>>;
          try {
            handle = await opendir(current);
          } catch (err) {
            if (depth === 0) {
              rootError = rootErrorEnvelope(err, "open");
              return;
            }
            const classified = classifyFsError(err, current, "open");
            if (classified.code === "PERMISSION_DENIED") {
              skipped.push({ path: current, code: "PERMISSION_DENIED" });
              return;
            }
            if (classified.code === "NOT_FOUND") {
              skipped.push({ path: current, code: "NOT_FOUND" });
              return;
            }
            fatalWalkError = {
              error: `READ_DIRECTORY_FAILED: ${classified.error}`,
              code: "READ_DIRECTORY_FAILED",
              ...(classified.errno ? { errno: classified.errno } : {}),
              path: current,
            };
            return;
          }

          try {
            for await (const entry of handle) {
              if (truncatedReason !== null || rootError !== null || fatalWalkError !== null) return;
              if (Date.now() > deadline) { truncatedReason = "time"; return; }
              const full = join(current, entry.name);
              if (entry.isDirectory()) {
                if (entry.name === ".git" || entry.name === "node_modules") continue;
                await visit(full, depth + 1);
                continue;
              }
              if (!entry.isFile()) continue;
              const rel = relative(dir, full);
              if (!regex.test(rel)) continue;
              if (files.length >= maxResults) {
                truncatedReason = "results";
                return;
              }
              files.push(full);
            }
          } catch (err) {
            if (depth === 0) {
              rootError = rootErrorEnvelope(err, "open");
              return;
            }
            const classified = classifyFsError(err, current, "read");
            if (classified.code === "PERMISSION_DENIED" || classified.code === "NOT_FOUND") {
              skipped.push({ path: current, code: classified.code });
              return;
            }
            fatalWalkError = {
              error: `READ_DIRECTORY_FAILED: ${classified.error}`,
              code: "READ_DIRECTORY_FAILED",
              ...(classified.errno ? { errno: classified.errno } : {}),
              path: current,
            };
          }
        };

        await visit(dir, 0);

        const rootErrorFinal = rootError as ReturnType<typeof rootErrorEnvelope> | null;
        if (rootErrorFinal !== null) {
          return { content: rootErrorFinal, isError: true };
        }
        const fatalWalkErrorFinal = fatalWalkError as
          | { error: string; code: "READ_DIRECTORY_FAILED"; errno?: string; path: string }
          | null;
        if (fatalWalkErrorFinal !== null) {
          return {
            content: { ...fatalWalkErrorFinal, directory: args.directory },
            isError: true,
          };
        }

        return {
          content: {
            files,
            truncated: truncatedReason !== null,
            truncated_reason: truncatedReason,
            max_results: maxResults,
            max_depth: context.limits.maxSearchDepth,
            max_ms: context.limits.maxSearchMs,
            ...(skipped.length > 0 ? { skipped } : {}),
          },
          isError: false,
        };
      }
      default:
        return { content: { error: `Unknown filesystem tool: ${toolName}` }, isError: true };
    }
  };

  return { tools: filesystemTools, handler };
}
