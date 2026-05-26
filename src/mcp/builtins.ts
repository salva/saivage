/**
 * Saivage — Built-in MCP Services (in-process)
 *
 * Core services (filesystem, shell, git, skills) run in-process — no
 * subprocess spawning, no external dependencies. Services that need
 * libraries not yet integrated (web, memory, index, lock) are registered
 * as unavailable stubs so they stay out of the agent-facing tool catalog.
 */

import type { McpRuntime, InProcessToolHandler } from "./runtime.js";
import type { ToolEntry } from "./types.js";
import { knowledgeSkillsTools, knowledgeSkillsHandler } from "./knowledgeSkills.js";
import { knowledgeMemoryTools, knowledgeMemoryHandler } from "./knowledgeMemory.js";

import { createWriteStream } from "node:fs";
import { writeFile, mkdir, readdir, stat, open } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { promisify } from "node:util";
import { log } from "../log.js";
import type { PromptInjectionCop, PromptInjectionScanResult } from "../security/prompt-injection-cop.js";
import { disabledCop } from "../security/prompt-injection-cop.js";
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
} from "./httpFetch.js";

const execFileAsync = promisify(execFile);
/** Headroom between the inner wall-clock cap and the outer McpRuntime
 *  race so the inner kill timer always wins and emits a structured result. */
export const WALL_CLOCK_HEADROOM_MS = 30_000;
let MAX_OUTPUT = 100 * 1024; // 100 KB
const PROCESS_KILL_GRACE_MS = 2_000;
const OUTPUT_GROWTH_POLL_MS = 1_000;
let MAX_FETCH_BYTES = 200_000;
let MAX_DOWNLOAD_BYTES = 250 * 1024 * 1024;
let MAX_FILE_READ_BYTES = 200_000;
let FETCH_TIMEOUT_MS = 60_000;
let SHELL_TIMEOUT_FLOOR_MS = 10 * 60 * 1000; // 10 minutes
const MAX_SCAN_DECODE_BYTES = 1_000_000;

function projectRoot(): string {
  return process.env["PROJECT_ROOT"] ?? process.cwd();
}

function assertInside(baseDir: string, candidate: string, label: string): string {
  const base = resolve(baseDir);
  const target = resolve(candidate);
  const rel = relative(base, target);
  if (rel === "" || (!rel.startsWith("..") && !rel.startsWith("/"))) {
    return target;
  }
  throw new Error(`${label} must stay inside ${base}`);
}

function resolvePath(p: string): string {
  const root = projectRoot();
  const target = p.startsWith("/") ? p : join(root, p);
  return assertInside(root, target, "Path");
}

function resolveSkillPath(skillsDir: string, name: string): string {
  if (!/^[a-zA-Z0-9._-]+$/.test(name)) {
    throw new Error("Skill name may only contain letters, numbers, dots, underscores, and hyphens");
  }
  return assertInside(skillsDir, join(skillsDir, `${name}.md`), "Skill path");
}

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
  prompt_injection_scan?: PromptInjectionScanResult;
}

type DownloadOutcome =
  | { ok: true; success: DownloadSuccess }
  | {
      ok: false;
      failure: ClassifiedHttpError & { status?: number };
      attempt: DownloadAttempt;
    };

interface BuiltinServicesOptions {
  promptInjectionCop?: PromptInjectionCop;
}

function isTextLikeContentType(contentType: string | undefined): boolean {
  if (!contentType) return false;
  return /\b(text|json|xml|csv|html|javascript|ecmascript|markdown|yaml|toml|plain)\b/i.test(contentType);
}

function looksTextLike(buffer: Buffer): boolean {
  const sample = buffer.subarray(0, Math.min(buffer.byteLength, 8192));
  if (sample.length === 0) return false;
  let printable = 0;
  for (const byte of sample) {
    if (byte === 0) return false;
    if (byte === 9 || byte === 10 || byte === 13 || (byte >= 32 && byte <= 126) || byte >= 128) printable++;
  }
  return printable / sample.length > 0.85;
}

function bufferToScannableText(buffer: Buffer, contentType: string | undefined): string | null {
  if (!isTextLikeContentType(contentType) && !looksTextLike(buffer)) return null;
  return buffer.subarray(0, Math.min(buffer.byteLength, MAX_SCAN_DECODE_BYTES)).toString("utf-8");
}

async function scanUntrustedText(
  scanner: PromptInjectionCop,
  source: string,
  content: string,
  contentType?: string,
): Promise<PromptInjectionScanResult> {
  const scan = await scanner.scan({ source, content, contentType });
  if (!scan.allowed) {
    throw new Error(`Prompt injection blocked: ${scan.reason}`);
  }
  return scan;
}

async function downloadUrl(
  url: URL,
  outPath: string,
  options: {
    maxBytes: number;
    headers?: Record<string, string>;
    attempts: DownloadAttempt[];
    attemptNumber: number;
    promptInjectionCop: PromptInjectionCop;
  },
): Promise<DownloadOutcome> {
  let timed: TimedFetch;
  try {
    timed = await fetchWithTimeout(
      url,
      { headers: { "User-Agent": "Saivage/0.1 data-agent", ...(options.headers ?? {}) } },
      FETCH_TIMEOUT_MS,
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

    const scannableText = bufferToScannableText(
      read.body,
      response.headers.get("content-type") ?? undefined,
    );
    let promptInjectionScan: PromptInjectionScanResult = {
      allowed: true,
      verdict: "allow",
      reason: "download appears to be binary/non-text content; prompt-injection scan not applicable",
      confidence: 0,
      scanner: "skipped",
    };
    if (scannableText !== null) {
      try {
        promptInjectionScan = await scanUntrustedText(
          options.promptInjectionCop,
          url.toString(),
          scannableText,
          response.headers.get("content-type") ?? undefined,
        );
      } catch (err) {
        const failure: ClassifiedHttpError = {
          code: "NETWORK_ERROR",
          error: err instanceof Error ? err.message : String(err),
        };
        attempt.code = failure.code;
        attempt.error = failure.error;
        return { ok: false, failure, attempt };
      }
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
        path: relative(projectRoot(), outPath),
        bytes: read.bytes,
        sha256: createHash("sha256").update(read.body).digest("hex"),
        headers: responseHeaders,
        attempts: options.attempts,
        prompt_injection_scan: promptInjectionScan,
      },
    };
  } finally {
    timed.dispose();
  }
}

// ─── Filesystem ─────────────────────────────────────────────────────────────

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
    description: "Search for files matching a glob pattern",
    inputSchema: {
      type: "object",
      properties: { directory: { type: "string" }, pattern: { type: "string" } },
      required: ["directory", "pattern"],
    },
  },
];

const filesystemHandler: InProcessToolHandler = async (toolName, args) => {
  switch (toolName) {
    case "read_file": {
      const fp = resolvePath(args.path as string);

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

      if (length !== undefined && length > MAX_FILE_READ_BYTES) {
        return {
          content: {
            error:
              `LENGTH_TOO_LARGE: length=${length} exceeds ` +
              `mcp.maxFileReadBytes=${MAX_FILE_READ_BYTES}. ` +
              `Issue multiple windowed reads or use run_command head/tail.`,
            code: "LENGTH_TOO_LARGE",
            path: args.path,
            length,
            max_bytes: MAX_FILE_READ_BYTES,
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
        totalSize > MAX_FILE_READ_BYTES
      ) {
        return {
          content: {
            error:
              `FILE_TOO_LARGE: size=${totalSize} bytes exceeds ` +
              `mcp.maxFileReadBytes=${MAX_FILE_READ_BYTES}. ` +
              `Re-issue with explicit offset/length (each <= ${MAX_FILE_READ_BYTES}), ` +
              `or use run_command with head/tail/grep, or use search_files.`,
            code: "FILE_TOO_LARGE",
            path: args.path,
            size_bytes: totalSize,
            max_bytes: MAX_FILE_READ_BYTES,
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
          const effectiveLength = length ?? MAX_FILE_READ_BYTES;
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
          // A close() rejection only surfaces when no primary failure
          // (read rejection or binary detection) has been recorded; the
          // primary observation always wins because it is the earlier,
          // root-cause signal.
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
      const fp = resolvePath(args.path as string);
      // FR-17 / WI-15 — read-only knowledge store: write_file must never
      // create or mutate records under .saivage/skills/ or .saivage/memory/.
      // Knowledge changes must go through create_skill / create_memory.
      const saivageDir = join(projectRoot(), ".saivage");
      const blockedRoots = [join(saivageDir, "skills"), join(saivageDir, "memory")];
      for (const blocked of blockedRoots) {
        if (fp === blocked || fp.startsWith(blocked + "/")) {
          return {
            content: {
              error:
                `BLOCKED_PATH: write_file cannot write to ${fp}. ` +
                `Use create_skill / create_memory MCP tools to mutate knowledge records.`,
            },
            isError: true,
          };
        }
      }
      await mkdir(dirname(fp), { recursive: true });
      await writeFile(fp, args.content as string, "utf-8");
      return { content: { written: true, path: fp }, isError: false };
    }
    case "list_dir": {
      const dp = resolvePath(args.path as string);
      const entries = (await readdir(dp, { withFileTypes: true })).map((e) => ({
        name: e.name,
        type: e.isDirectory() ? "dir" : "file",
      }));
      return { content: { entries }, isError: false };
    }
    case "search_files": {
      const dir = resolvePath(args.directory as string);
      const pattern = args.pattern as string;
      // Use find with -path for glob patterns that include directories
      const findArgs = pattern.includes("/")
        ? [dir, "-path", `*/${pattern}`, "-type", "f"]
        : [dir, "-name", pattern, "-type", "f"];
      try {
        const { stdout } = await execFileAsync(
          "find",
          findArgs,
          { maxBuffer: MAX_OUTPUT },
        );
        const files = stdout.trim().split("\n").filter(Boolean);
        return { content: { files }, isError: false };
      } catch {
        return { content: { files: [] }, isError: false };
      }
    }
    default:
      return { content: { error: `Unknown filesystem tool: ${toolName}` }, isError: true };
  }
};

// ─── Shell ──────────────────────────────────────────────────────────────────

const shellTools: ToolEntry[] = [
  {
    name: "run_command",
    description: "Execute a shell command. Output is written to log files; only a capped tail is returned. For long-running work (tests, builds, training, experiments, data processing), prefer 'inactivity_timeout_ms' over 'timeout_ms' — it kills the process only when output stops, allowing legitimate long work to continue. The minimum accepted timeout is 600000 (10 minutes); lower values are raised automatically.",
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string" },
        cwd: { type: "string" },
        timeout_ms: {
          type: "number",
          description: "Hard wall-clock timeout in milliseconds. Use only when you need an absolute time cap. Minimum 600000 (10 min). Omit or set 0 for no limit.",
        },
        timeout: {
          type: "number",
          description: "Deprecated alias for timeout_ms.",
        },
        inactivity_timeout_ms: {
          type: "number",
          description: "Kill the process if stdout/stderr stop growing for this many milliseconds. Preferred over timeout_ms for most commands. Minimum 600000 (10 min). Omit or set 0 to disable.",
        },
        idle_timeout_ms: {
          type: "number",
          description: "Deprecated alias for inactivity_timeout_ms.",
        },
        stdout_path: {
          type: "string",
          description: "Optional project-relative file path for full stdout. Defaults to .saivage/tmp/command-logs/...",
        },
        stderr_path: {
          type: "string",
          description: "Optional project-relative file path for full stderr. Defaults to .saivage/tmp/command-logs/...",
        },
      },
      required: ["command"],
    },
  },
];

function parseNonNegativeInt(raw: unknown, label: string): number | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (
    typeof raw !== "number" ||
    !Number.isFinite(raw) ||
    raw < 0 ||
    !Number.isInteger(raw)
  ) {
    throw new Error(`${label} must be a non-negative integer`);
  }
  return raw;
}

export type FsErrorCode = "NOT_FOUND" | "PERMISSION_DENIED" | "NOT_A_FILE" | "IO_ERROR";

export interface ClassifiedFsError {
  code: FsErrorCode;
  error: string;
  errno?: string;
}

// Exported for unit testing only. classifyFsError is intentionally
// scoped to read_file's contract; other filesystem tools should add
// their own classifier if they need one.
export function classifyFsError(
  err: unknown,
  path: string,
  context: "stat" | "open" | "read" | "close",
): ClassifiedFsError {
  const errno = (err as NodeJS.ErrnoException | undefined)?.code;
  const msg = (err as Error | undefined)?.message ?? String(err);
  switch (errno) {
    case "ENOENT":
    case "ENOTDIR":
      return {
        code: "NOT_FOUND",
        error:
          `NOT_FOUND: ${path} does not exist (during ${context}). ` +
          `Check the spelling or use list_dir on the parent directory.`,
        errno,
      };
    case "EACCES":
    case "EPERM":
      return {
        code: "PERMISSION_DENIED",
        error:
          `PERMISSION_DENIED: filesystem denied access to ${path} ` +
          `(during ${context}). Verify permissions on the path and its parents.`,
        errno,
      };
    case "EISDIR":
      return {
        code: "NOT_A_FILE",
        error:
          `NOT_A_FILE: ${path} is a directory (open returned EISDIR). ` +
          `Use list_dir.`,
        errno,
      };
    default:
      return {
        code: "IO_ERROR",
        error:
          `IO_ERROR: low-level I/O error on ${path} (during ${context}): ${msg}`,
        ...(errno ? { errno } : {}),
      };
  }
}

function parseOptionalTimeoutMs(
  args: Record<string, unknown>,
  keys: string[],
  label: string,
): number | undefined {
  const raw = keys.map((key) => args[key]).find((value) => value !== undefined && value !== null);
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0) {
    throw new Error(`${label} must be a non-negative finite number of milliseconds`);
  }
  const timeout = Math.floor(raw);
  return timeout === 0 ? undefined : timeout;
}

/**
 * Enforce a minimum timeout floor. Values below the floor are raised so
 * autonomous agents cannot prematurely kill long-running jobs. The floor is
 * configured via config.mcp.shellTimeoutFloorMs (set to 0 to disable, e.g.
 * for tests that need to exercise short timeouts deterministically).
 */
function clampTimeout(ms: number | undefined): number | undefined {
  if (ms === undefined) return undefined;
  return Math.max(ms, SHELL_TIMEOUT_FLOOR_MS);
}

/**
 * Patterns of environment variable names whose values must NOT be inherited
 * by shell child processes. Agents very rarely need credentials in shell
 * commands; leaking them would create a one-shot exfiltration path via
 * `env` + any outbound network tool. Override exact values explicitly via
 * the `cwd` and dedicated tools when needed.
 */
const SECRET_ENV_PATTERNS: RegExp[] = [
  /API[_-]?KEY/i,
  /(?:^|_)TOKEN(?:$|_)/i,
  /SECRET/i,
  /PASSWORD/i,
  /PASSWD/i,
  /CREDENTIAL/i,
  /^ANTHROPIC_/i,
  /^OPENAI_/i,
  /^GITHUB_/i,
  /^GH_/i,
  /^TELEGRAM_/i,
  /^SAIVAGE_API_TOKEN$/i,
  /^AWS_(ACCESS|SECRET|SESSION)/i,
];

export function filterShellEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if (SECRET_ENV_PATTERNS.some((pattern) => pattern.test(key))) continue;
    result[key] = value;
  }
  return result;
}

async function runShellCommand(
  command: string,
  cwd: string,
  timeoutMs: number | undefined,
  inactivityTimeoutMs: number | undefined,
  outputPaths: CommandLogPaths,
): Promise<CommandResult> {
  await mkdir(dirname(outputPaths.stdoutAbs), { recursive: true });
  await mkdir(dirname(outputPaths.stderrAbs), { recursive: true });
  return new Promise((resolve, reject) => {
    const startedAtMs = Date.now();
    const startedAt = new Date(startedAtMs).toISOString();
    const stdoutStream = createWriteStream(outputPaths.stdoutAbs, { flags: "w" });
    const stderrStream = createWriteStream(outputPaths.stderrAbs, { flags: "w" });
    const child = spawn(command, {
      cwd,
      shell: true,
      detached: process.platform !== "win32",
      env: { ...filterShellEnv(process.env), PROJECT_ROOT: projectRoot() },
    });

    let timeoutKind: "total" | "inactivity" | null = null;
    let totalTimer: ReturnType<typeof setTimeout> | null = null;
    let growthTimer: ReturnType<typeof setInterval> | null = null;
    let killTimer: ReturnType<typeof setTimeout> | null = null;
    let lastOutputBytes = 0;
    let lastGrowthAt = startedAtMs;
    let lastOutputAt: string | null = null;
    let settled = false;
    let inFlightTick = false;

    const recordOutput = (chunk: Buffer | string) => {
      lastOutputBytes += Buffer.byteLength(chunk);
      lastGrowthAt = Date.now();
      lastOutputAt = new Date(lastGrowthAt).toISOString();
    };

    const clearTimers = () => {
      if (totalTimer) clearTimeout(totalTimer);
      if (growthTimer) clearInterval(growthTimer);
      if (killTimer) clearTimeout(killTimer);
    };

    const terminate = (kind: "total" | "inactivity") => {
      if (settled || timeoutKind) return;
      timeoutKind = kind;
      terminateChild(child);
      killTimer = setTimeout(() => terminateChild(child, "SIGKILL"), PROCESS_KILL_GRACE_MS);
    };

    const checkOutputGrowth = () => {
      if (!inactivityTimeoutMs || inFlightTick || settled) return;
      inFlightTick = true;
      void (async () => {
        try {
          const [s1, s2] = await Promise.all([
            safeFileSize(outputPaths.stdoutAbs),
            safeFileSize(outputPaths.stderrAbs),
          ]);
          if (settled) return;
          const outputBytes = Math.max(lastOutputBytes, s1 + s2);
          if (outputBytes > lastOutputBytes) {
            lastOutputBytes = outputBytes;
            lastGrowthAt = Date.now();
            return;
          }
          if (settled) return;
          if (Date.now() - lastGrowthAt >= inactivityTimeoutMs) terminate("inactivity");
        } finally {
          inFlightTick = false;
        }
      })();
    };

    if (timeoutMs) totalTimer = setTimeout(() => terminate("total"), timeoutMs);
    if (inactivityTimeoutMs) growthTimer = setInterval(checkOutputGrowth, growthPollInterval(inactivityTimeoutMs));

    child.stdout.on("data", (chunk: Buffer) => {
      recordOutput(chunk);
      stdoutStream.write(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      recordOutput(chunk);
      stderrStream.write(chunk);
    });

    stdoutStream.on("error", (err) => {
      clearTimers();
      terminateChild(child, "SIGKILL");
      reject(err);
    });
    stderrStream.on("error", (err) => {
      clearTimers();
      terminateChild(child, "SIGKILL");
      reject(err);
    });

    child.on("error", (err) => {
      clearTimers();
      reject(err);
    });

    child.on("close", async (code) => {
      settled = true;
      clearTimers();
      const completedAtMs = Date.now();
      const completedAt = new Date(completedAtMs).toISOString();
      await Promise.all([finishStream(stdoutStream), finishStream(stderrStream)]);
      const [stdout, stderrTail] = await Promise.all([
        readFileTail(outputPaths.stdoutAbs, MAX_OUTPUT),
        readFileTail(outputPaths.stderrAbs, MAX_OUTPUT),
      ]);
      let stderr = stderrTail;
      const [stdoutBytes, stderrBytes] = await Promise.all([
        safeFileSize(outputPaths.stdoutAbs),
        safeFileSize(outputPaths.stderrAbs),
      ]);
      if (stdoutBytes > MAX_OUTPUT) stderr = appendTimeoutMessage(stderr, `[Saivage returned only the last ${MAX_OUTPUT} bytes of stdout; full log: ${outputPaths.stdoutRel}]`);
      if (stderrBytes > MAX_OUTPUT) stderr = appendTimeoutMessage(stderr, `[Saivage returned only the last ${MAX_OUTPUT} bytes of stderr; full log: ${outputPaths.stderrRel}]`);
      const base = {
        stdout,
        stderr,
        stdout_path: outputPaths.stdoutRel,
        stderr_path: outputPaths.stderrRel,
        stdout_bytes: stdoutBytes,
        stderr_bytes: stderrBytes,
        started_at: startedAt,
        completed_at: completedAt,
        duration_ms: completedAtMs - startedAtMs,
        last_output_at: lastOutputAt,
      };
      if (timeoutKind === "total") {
        resolve({ ...base, stderr: appendTimeoutMessage(stderr, `Command timed out after ${timeoutMs}ms`), exitCode: 124 });
        return;
      }
      if (timeoutKind === "inactivity") {
        resolve({
          ...base,
          stderr: appendTimeoutMessage(
            stderr,
            `Command output files did not grow for ${inactivityTimeoutMs}ms and the process was terminated (last output: ${lastOutputAt ?? "never"})`,
          ),
          exitCode: 124,
        });
        return;
      }
      resolve({ ...base, exitCode: code ?? 1 });
    });
  });
}

function appendTimeoutMessage(stderr: string, message: string): string {
  return stderr ? `${stderr}\n${message}` : message;
}

interface CommandLogPaths {
  stdoutAbs: string;
  stderrAbs: string;
  stdoutRel: string;
  stderrRel: string;
}

interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  stdout_path: string;
  stderr_path: string;
  stdout_bytes: number;
  stderr_bytes: number;
  started_at: string;
  completed_at: string;
  duration_ms: number;
  last_output_at: string | null;
}

function resolveCommandLogPaths(args: Record<string, unknown>): CommandLogPaths {
  const id = `${Date.now()}-${randomUUID().slice(0, 8)}`;
  const stdoutAbs = typeof args.stdout_path === "string"
    ? resolvePath(args.stdout_path)
    : resolvePath(`.saivage/tmp/command-logs/${id}.stdout.log`);
  const stderrAbs = typeof args.stderr_path === "string"
    ? resolvePath(args.stderr_path)
    : resolvePath(`.saivage/tmp/command-logs/${id}.stderr.log`);
  return {
    stdoutAbs,
    stderrAbs,
    stdoutRel: relative(projectRoot(), stdoutAbs),
    stderrRel: relative(projectRoot(), stderrAbs),
  };
}

async function safeFileSize(path: string): Promise<number> {
  try {
    return (await stat(path)).size;
  } catch {
    return 0;
  }
}

function growthPollInterval(inactivityTimeoutMs: number): number {
  return Math.max(25, Math.min(OUTPUT_GROWTH_POLL_MS, Math.floor(inactivityTimeoutMs / 4) || 25));
}

async function readFileTail(path: string, maxBytes: number): Promise<string> {
  const size = await safeFileSize(path);
  if (size === 0) return "";
  const length = Math.min(size, maxBytes);
  const buffer = Buffer.alloc(length);
  const handle = await open(path, "r");
  try {
    await handle.read(buffer, 0, length, size - length);
  } finally {
    await handle.close();
  }
  return buffer.toString("utf-8");
}

function finishStream(stream: NodeJS.WritableStream): Promise<void> {
  const writable = stream as NodeJS.WritableStream & { writableEnded?: boolean; writableFinished?: boolean };
  if (writable.writableEnded || writable.writableFinished) return Promise.resolve();
  return new Promise((resolve) => {
    stream.once("finish", () => resolve());
    stream.end();
  });
}

function terminateChild(child: ChildProcessWithoutNullStreams, signal: NodeJS.Signals = "SIGTERM"): void {
  if (process.platform !== "win32" && child.pid) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // Fall through to killing the direct child.
    }
  }
  child.kill(signal);
}

// ─── Data Acquisition ───────────────────────────────────────────────────────

const dataTools: ToolEntry[] = [
  {
    name: "web_search",
    description: "Search the public web for data sources, APIs, documentation, and downloadable datasets. Returns candidate URLs with snippets when available.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        max_results: { type: "number", description: "Maximum number of results to return (default 8, max 20)" },
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

function createDataHandler(promptInjectionCop: PromptInjectionCop): InProcessToolHandler {
  return async (toolName, args) => {
  switch (toolName) {
    case "web_search": {
      const query = String(args.query ?? "").trim();
      if (!query) return { content: { error: "query is required" }, isError: true };
      const maxResults = Math.min(Math.max(Number(args.max_results ?? 8), 1), 20);
      const searchUrl = new URL("https://duckduckgo.com/html/");
      searchUrl.searchParams.set("q", query);
      const response = await fetch(searchUrl, { headers: { "User-Agent": "Saivage/0.1 data-agent" } });
      const html = await response.text();
      const results: Array<{ title: string; url: string; snippet?: string }> = [];
      const resultRegex = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi;
      for (const match of html.matchAll(resultRegex)) {
        let url = match[1] ?? "";
        try {
          const parsed = new URL(url, searchUrl);
          const uddg = parsed.searchParams.get("uddg");
          if (uddg) url = decodeURIComponent(uddg);
        } catch {
          // Keep original URL.
        }
        results.push({ title: stripHtml(match[2] ?? ""), url, snippet: stripHtml(match[3] ?? "") });
        if (results.length >= maxResults) break;
      }
      return { content: { query, results, status: response.status }, isError: false };
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
      const maxBytes = Math.min(Math.max(Number(args.max_bytes ?? MAX_FETCH_BYTES), 1_000), 1_000_000);
      let timed: TimedFetch;
      try {
        timed = await fetchWithTimeout(
          url,
          { headers: { "User-Agent": "Saivage/0.1 data-agent" } },
          FETCH_TIMEOUT_MS,
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
        let promptInjectionScan: PromptInjectionScanResult;
        try {
          promptInjectionScan = await scanUntrustedText(
            promptInjectionCop,
            url.toString(),
            read.body,
            response.headers.get("content-type") ?? undefined,
          );
        } catch (err) {
          return {
            content: { error: err instanceof Error ? err.message : String(err), url: url.toString() },
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
            prompt_injection_scan: promptInjectionScan,
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
      const maxBytes = Math.min(Math.max(Number(args.max_bytes ?? MAX_FETCH_BYTES), 1_000), 1_000_000);
      let timed: TimedFetch;
      try {
        timed = await fetchWithTimeout(
          url,
          { headers: { "User-Agent": "Saivage/0.1 data-agent" } },
          FETCH_TIMEOUT_MS,
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
        let promptInjectionScan: PromptInjectionScanResult;
        try {
          promptInjectionScan = await scanUntrustedText(
            promptInjectionCop,
            url.toString(),
            stripped,
            response.headers.get("content-type") ?? undefined,
          );
        } catch (err) {
          return {
            content: { error: err instanceof Error ? err.message : String(err), url: url.toString() },
            isError: true,
          };
        }
        return {
          content: {
            url: url.toString(),
            status: response.status,
            ok: response.ok,
            headers: headersObject(response.headers),
            text: stripped,
            bytes_read: read.bytes,
            truncated: read.truncated,
            prompt_injection_scan: promptInjectionScan,
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
      const outPath = resolvePath(String(args.path));
      const maxBytes = Math.min(Math.max(Number(args.max_bytes ?? MAX_DOWNLOAD_BYTES), 1), 2 * 1024 * 1024 * 1024);
      const attempts: DownloadAttempt[] = [];
      const outcome = await downloadUrl(url, outPath, {
        maxBytes,
        headers: args.headers as Record<string, string> | undefined,
        attempts,
        attemptNumber: 1,
        promptInjectionCop,
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
      const outPath = resolvePath(String(args.path));
      const manifestPath = args.manifest_path ? resolvePath(String(args.manifest_path)) : null;
      const maxBytes = Math.min(Math.max(Number(args.max_bytes ?? MAX_DOWNLOAD_BYTES), 1), 2 * 1024 * 1024 * 1024);
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
          const outcome = await downloadUrl(url, outPath, {
            maxBytes, headers, attempts, attemptNumber, promptInjectionCop,
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
        path: relative(projectRoot(), outPath),
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
}

// ─── Git ────────────────────────────────────────────────────────────────────

const gitTools: ToolEntry[] = [
  { name: "git_status", description: "Show working tree status", inputSchema: { type: "object", properties: {} } },
  { name: "git_create_branch", description: "Create and checkout a new branch", inputSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] } },
  { name: "git_checkout", description: "Checkout a branch or ref", inputSchema: { type: "object", properties: { ref: { type: "string" } }, required: ["ref"] } },
  { name: "git_commit", description: "Stage specified files and commit", inputSchema: { type: "object", properties: { files: { type: "array", items: { type: "string" } }, message: { type: "string" }, task_id: { type: "string" } }, required: ["files", "message"] } },
  { name: "git_merge", description: "Merge a branch", inputSchema: { type: "object", properties: { branch: { type: "string" } }, required: ["branch"] } },
  { name: "git_diff", description: "Show diff", inputSchema: { type: "object", properties: { files: { type: "array", items: { type: "string" } }, ref1: { type: "string" }, ref2: { type: "string" } } } },
  { name: "git_delete_branch", description: "Delete a branch", inputSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] } },
  { name: "git_log", description: "Show recent commit log", inputSchema: { type: "object", properties: { n: { type: "number" }, branch: { type: "string" } } } },
];

async function gitExec(gitArgs: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync("git", gitArgs, { cwd, maxBuffer: MAX_OUTPUT });
  return stdout.trim();
}

const gitHandler: InProcessToolHandler = async (toolName, args) => {
  const cwd = projectRoot();

  switch (toolName) {
    case "git_status": {
      const raw = await gitExec(["status", "--porcelain"], cwd);
      const lines = raw.split("\n").filter(Boolean);
      const modified: string[] = [];
      const added: string[] = [];
      const deleted: string[] = [];
      const untracked: string[] = [];
      for (const line of lines) {
        const status = line.substring(0, 2);
        const file = line.substring(3);
        if (status.includes("?")) untracked.push(file);
        else if (status.includes("D")) deleted.push(file);
        else if (status.includes("A")) added.push(file);
        else modified.push(file);
      }
      return { content: { modified, added, deleted, untracked }, isError: false };
    }

    case "git_create_branch": {
      const name = args.name as string;
      await gitExec(["checkout", "-b", name], cwd);
      return { content: { branch: name, created: true }, isError: false };
    }

    case "git_checkout": {
      const ref = args.ref as string;
      await gitExec(["checkout", ref], cwd);
      return { content: { ref, checked_out: true }, isError: false };
    }

    case "git_commit": {
      const files = args.files as string[] | undefined;
      if (!files || files.length === 0) {
        return { content: { error: "files is required — explicit file list enforces per-agent commit scoping" }, isError: true };
      }
      const message = args.message as string;
      const taskId = args.task_id as string | undefined;
      const prefix = taskId ? `[tsk-${taskId}] ` : "";

      for (const f of files) {
        await gitExec(["add", "--", f], cwd);
      }

      try {
        await gitExec(["commit", "-m", prefix + message], cwd);
      } catch (err: unknown) {
        const msg = (err as Error).message ?? "";
        if (msg.includes("nothing to commit")) {
          return { content: { sha: "none", message: "Nothing to commit" }, isError: false };
        }
        const status = await gitExec(["status", "--porcelain"], cwd);
        if (status.includes("UU") || status.includes("AA")) {
          const conflictFiles = status
            .split("\n")
            .filter((l) => l.startsWith("UU") || l.startsWith("AA"))
            .map((l) => l.substring(3));
          return { content: { error: "CONFLICT", files: conflictFiles }, isError: true };
        }
        throw err;
      }

      const sha = await gitExec(["rev-parse", "HEAD"], cwd);
      return { content: { sha }, isError: false };
    }

    case "git_merge": {
      const branch = args.branch as string;
      const output = await gitExec(["merge", branch], cwd);
      return { content: { merged: true, output }, isError: false };
    }

    case "git_diff": {
      const files = args.files as string[] | undefined;
      const ref1 = args.ref1 as string | undefined;
      const ref2 = args.ref2 as string | undefined;
      const gitArgs = ["diff"];
      if (ref1) gitArgs.push(ref1);
      if (ref2) gitArgs.push(ref2);
      if (files?.length) {
        gitArgs.push("--");
        gitArgs.push(...files);
      }
      const diff = await gitExec(gitArgs, cwd);
      return { content: { diff }, isError: false };
    }

    case "git_delete_branch": {
      const name = args.name as string;
      await gitExec(["branch", "-d", name], cwd);
      return { content: { branch: name, deleted: true }, isError: false };
    }

    case "git_log": {
      const n = (args.n as number | undefined) ?? 10;
      const branch = args.branch as string | undefined;
      const gitArgs = ["log", "--format=%H%x00%s%x00%an%x00%aI", `-n`, String(n)];
      if (branch) gitArgs.push(branch);
      const raw = await gitExec(gitArgs, cwd);
      const commits = raw
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          const [sha, message, author, date] = line.split("\0");
          return { sha, message, author, date };
        });
      return { content: { commits }, isError: false };
    }

    default:
      return { content: { error: `Unknown git tool: ${toolName}` }, isError: true };
  }
};

// ─── Stubs (not yet implemented) ────────────────────────────────────────────

function stubHandler(serviceName: string): InProcessToolHandler {
  return async (toolName) => ({
    content: { error: `Service "${serviceName}" is not yet implemented. Tool "${toolName}" is unavailable.` },
    isError: true,
  });
}

const webTools: ToolEntry[] = [
  { name: "fetch_url", description: "Fetch raw URL content", inputSchema: { type: "object", properties: { url: { type: "string" } }, required: ["url"] } },
  { name: "fetch_page_content", description: "Fetch and extract page text", inputSchema: { type: "object", properties: { url: { type: "string" } }, required: ["url"] } },
];

const indexTools: ToolEntry[] = [
  { name: "index_ingest", description: "Index a document for search", inputSchema: { type: "object", properties: { id: { type: "string" }, type: { type: "string" }, content: { type: "string" } }, required: ["id", "type", "content"] } },
  { name: "index_search", description: "Full-text search across indexed documents", inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } },
];

const lockTools: ToolEntry[] = [
  { name: "lock_acquire", description: "Acquire an advisory lock", inputSchema: { type: "object", properties: { name: { type: "string" }, holder: { type: "string" } }, required: ["name", "holder"] } },
  { name: "lock_release", description: "Release a lock", inputSchema: { type: "object", properties: { name: { type: "string" }, holder: { type: "string" } }, required: ["name", "holder"] } },
  { name: "lock_status", description: "Check lock status", inputSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] } },
  { name: "lock_list", description: "List all active locks", inputSchema: { type: "object", properties: {} } },
];

// ─── Registration ───────────────────────────────────────────────────────────

/**
 * Register all built-in services as in-process handlers on the MCP runtime.
 * No subprocess spawning — all operations run directly in the Node.js process.
 */
export function registerBuiltinServices(
  mcpRuntime: McpRuntime,
  mcpConfig: import("../config.js").SaivageConfig["mcp"],
  options: BuiltinServicesOptions = {},
): void {
  const promptInjectionCop = options.promptInjectionCop ?? disabledCop();
  MAX_OUTPUT = mcpConfig.maxOutputBytes;
  MAX_FETCH_BYTES = mcpConfig.maxFetchBytes;
  MAX_DOWNLOAD_BYTES = mcpConfig.maxDownloadBytes;
  MAX_FILE_READ_BYTES = mcpConfig.maxFileReadBytes;
  FETCH_TIMEOUT_MS = mcpConfig.fetchTimeoutMs;
  SHELL_TIMEOUT_FLOOR_MS = mcpConfig.shellTimeoutFloorMs;
  const innerCapMs = mcpConfig.shellTimeoutMs - WALL_CLOCK_HEADROOM_MS;

  const shellHandler: InProcessToolHandler = async (toolName, args) => {
    if (toolName !== "run_command") {
      return { content: { error: `Unknown shell tool: ${toolName}` }, isError: true };
    }

    const command = args.command as string;
    const cwd = args.cwd ? resolvePath(args.cwd as string) : projectRoot();
    const timeout = clampTimeout(parseOptionalTimeoutMs(args, ["timeout_ms", "timeout"], "timeout_ms"));
    const inactivityTimeout = clampTimeout(parseOptionalTimeoutMs(
      args,
      ["inactivity_timeout_ms", "idle_timeout_ms"],
      "inactivity_timeout_ms",
    ));
    const outputPaths = resolveCommandLogPaths(args);

    // Always enforce a hard wall-clock cap so the process group is
    // properly killed even when the agent omits timeout_ms. The cap is
    // derived from mcpConfig.shellTimeoutMs minus WALL_CLOCK_HEADROOM_MS
    // and also clamps caller-supplied timeout_ms.
    const effectiveTimeout = Math.min(timeout ?? innerCapMs, innerCapMs);
    const result = await runShellCommand(command, cwd, effectiveTimeout, inactivityTimeout, outputPaths);
    return { content: result, isError: false };
  };

  mcpRuntime.registerInProcess("filesystem", filesystemTools, filesystemHandler);
  mcpRuntime.registerInProcess("shell", shellTools, shellHandler);
  mcpRuntime.registerInProcess("data", dataTools, createDataHandler(promptInjectionCop));
  mcpRuntime.registerInProcess("git", gitTools, gitHandler);
  mcpRuntime.registerInProcess("skills", knowledgeSkillsTools, knowledgeSkillsHandler);
  mcpRuntime.registerInProcess("memory", knowledgeMemoryTools, knowledgeMemoryHandler);

  // Stubs — services that need external dependencies not yet integrated
  mcpRuntime.registerInProcess("web", webTools, stubHandler("web"), { available: false });
  mcpRuntime.registerInProcess("index", indexTools, stubHandler("index"), { available: false });
  mcpRuntime.registerInProcess("lock", lockTools, stubHandler("lock"), { available: false });

  log.info("[builtins] 7 built-in services registered (6 active, 3 stubs)");
}
