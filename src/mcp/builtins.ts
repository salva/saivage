/**
 * Saivage — Built-in MCP Services (in-process)
 *
 * Core services (filesystem, shell, git, skills) run in-process — no
 * subprocess spawning, no external dependencies. Services that need
 * libraries not yet integrated (web, memory, index, lock) are registered
 * as unavailable stubs so they stay out of the agent-facing tool catalog.
 */

import type { McpRuntime, InProcessToolHandler } from "./runtime.js";
import type { ToolEntry } from "./registry.js";
import { knowledgeSkillsTools, knowledgeSkillsHandler } from "./knowledgeSkills.js";
import { knowledgeMemoryTools, knowledgeMemoryHandler } from "./knowledgeMemory.js";

import {
  closeSync,
  createWriteStream,
  readFileSync,
  readSync,
  writeFileSync,
  readdirSync,
  mkdirSync,
  existsSync,
  openSync,
  statSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { promisify } from "node:util";
import { log } from "../log.js";
import type { PromptInjectionCop, PromptInjectionScanResult } from "../security/prompt-injection-cop.js";
import { disabledCop } from "../security/prompt-injection-cop.js";

const execFileAsync = promisify(execFile);
const MAX_OUTPUT = 100 * 1024; // 100 KB
const PROCESS_KILL_GRACE_MS = 2_000;
const OUTPUT_GROWTH_POLL_MS = 1_000;
/** Hard wall-clock cap applied when the agent omits timeout_ms.
 *  Must be shorter than McpRuntime.SHELL_TIMEOUT_MS so the process is
 *  cleanly terminated before the outer promise-race fires. */
const MAX_WALL_CLOCK_MS = 4 * 60 * 60 * 1000 - 30_000; // 3 h 59 m 30 s
const MAX_FETCH_CHARS = 200_000;
const MAX_DOWNLOAD_BYTES = 250 * 1024 * 1024;
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
  error?: string;
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
): Promise<DownloadSuccess | null> {
  const response = await fetch(url, {
    headers: { "User-Agent": "Saivage/0.1 data-agent", ...(options.headers ?? {}) },
  });
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
    attempt.error = `HTTP ${response.status}`;
    return null;
  }

  const contentLength = Number(response.headers.get("content-length") ?? 0);
  if (contentLength > options.maxBytes) {
    attempt.error = `Download size ${contentLength} exceeds max_bytes ${options.maxBytes}`;
    return null;
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  attempt.bytes = buffer.byteLength;
  if (buffer.byteLength > options.maxBytes) {
    attempt.error = `Download size ${buffer.byteLength} exceeds max_bytes ${options.maxBytes}`;
    return null;
  }

  const scannableText = bufferToScannableText(buffer, response.headers.get("content-type") ?? undefined);
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
      attempt.error = err instanceof Error ? err.message : String(err);
      return null;
    }
  }

  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, buffer);
  return {
    url: url.toString(),
    path: relative(projectRoot(), outPath),
    bytes: buffer.byteLength,
    sha256: createHash("sha256").update(buffer).digest("hex"),
    headers: responseHeaders,
    attempts: options.attempts,
    prompt_injection_scan: promptInjectionScan,
  };
}

// ─── Filesystem ─────────────────────────────────────────────────────────────

const filesystemTools: ToolEntry[] = [
  {
    name: "read_file",
    description: "Read the contents of a file",
    inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
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
      const content = readFileSync(fp, "utf-8");
      return { content: { content }, isError: false };
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
      mkdirSync(dirname(fp), { recursive: true });
      writeFileSync(fp, args.content as string, "utf-8");
      return { content: { written: true, path: fp }, isError: false };
    }
    case "list_dir": {
      const dp = resolvePath(args.path as string);
      const entries = readdirSync(dp, { withFileTypes: true }).map((e) => ({
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
  // properly killed even when the agent omits timeout_ms.
  const effectiveTimeout = timeout ?? MAX_WALL_CLOCK_MS;
  const result = await runShellCommand(command, cwd, effectiveTimeout, inactivityTimeout, outputPaths);
  return { content: result, isError: false };
};

const DEFAULT_MIN_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes

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
 * configurable via SAIVAGE_SHELL_TIMEOUT_FLOOR_MS (set to 0 to disable, e.g.
 * for tests that need to exercise short timeouts deterministically).
 */
function clampTimeout(ms: number | undefined): number | undefined {
  if (ms === undefined) return undefined;
  return Math.max(ms, shellTimeoutFloorMs());
}

function shellTimeoutFloorMs(): number {
  const raw = process.env["SAIVAGE_SHELL_TIMEOUT_FLOOR_MS"];
  if (raw === undefined) return DEFAULT_MIN_TIMEOUT_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_MIN_TIMEOUT_MS;
  return Math.floor(parsed);
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
  return new Promise((resolve, reject) => {
    const startedAtMs = Date.now();
    const startedAt = new Date(startedAtMs).toISOString();
    mkdirSync(dirname(outputPaths.stdoutAbs), { recursive: true });
    mkdirSync(dirname(outputPaths.stderrAbs), { recursive: true });
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
      if (timeoutKind) return;
      timeoutKind = kind;
      terminateChild(child);
      killTimer = setTimeout(() => terminateChild(child, "SIGKILL"), PROCESS_KILL_GRACE_MS);
    };

    const checkOutputGrowth = () => {
      if (!inactivityTimeoutMs) return;
      const outputBytes = Math.max(
        lastOutputBytes,
        safeFileSize(outputPaths.stdoutAbs) + safeFileSize(outputPaths.stderrAbs),
      );
      if (outputBytes > lastOutputBytes) {
        lastOutputBytes = outputBytes;
        lastGrowthAt = Date.now();
        return;
      }
      if (Date.now() - lastGrowthAt >= inactivityTimeoutMs) terminate("inactivity");
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
      clearTimers();
      const completedAtMs = Date.now();
      const completedAt = new Date(completedAtMs).toISOString();
      await Promise.all([finishStream(stdoutStream), finishStream(stderrStream)]);
      const stdout = readFileTail(outputPaths.stdoutAbs, MAX_OUTPUT);
      let stderr = readFileTail(outputPaths.stderrAbs, MAX_OUTPUT);
      const stdoutBytes = safeFileSize(outputPaths.stdoutAbs);
      const stderrBytes = safeFileSize(outputPaths.stderrAbs);
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

function safeFileSize(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

function growthPollInterval(inactivityTimeoutMs: number): number {
  return Math.max(25, Math.min(OUTPUT_GROWTH_POLL_MS, Math.floor(inactivityTimeoutMs / 4) || 25));
}

function readFileTail(path: string, maxBytes: number): string {
  const size = safeFileSize(path);
  if (size === 0) return "";
  const length = Math.min(size, maxBytes);
  const buffer = Buffer.alloc(length);
  const fd = openSync(path, "r");
  try {
    readSync(fd, buffer, 0, length, size - length);
  } finally {
    closeSync(fd);
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
    description: "Fetch a URL as text with status, selected headers, and a truncated body. Use for API docs, CSV previews, metadata pages, and robots-friendly web pages.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string" },
        max_chars: { type: "number", description: "Maximum response characters to return (default 200000)" },
      },
      required: ["url"],
    },
  },
  {
    name: "fetch_page_text",
    description: "Fetch an HTML page and return readable text extracted from it. Use this before falling back to Playwright for simple static pages.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string" },
        max_chars: { type: "number", description: "Maximum extracted text characters to return (default 200000)" },
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
      const url = parseHttpUrl(String(args.url));
      const maxChars = Math.min(Math.max(Number(args.max_chars ?? MAX_FETCH_CHARS), 1_000), 1_000_000);
      const response = await fetch(url, { headers: { "User-Agent": "Saivage/0.1 data-agent" } });
      const text = await response.text();
      const content = text.slice(0, maxChars);
      let promptInjectionScan: PromptInjectionScanResult;
      try {
        promptInjectionScan = await scanUntrustedText(
          promptInjectionCop,
          url.toString(),
          content,
          response.headers.get("content-type") ?? undefined,
        );
      } catch (err) {
        return { content: { error: err instanceof Error ? err.message : String(err), url: url.toString() }, isError: true };
      }
      return {
        content: {
          url: url.toString(),
          status: response.status,
          ok: response.ok,
          headers: headersObject(response.headers),
          content,
          truncated: text.length > maxChars,
          prompt_injection_scan: promptInjectionScan,
        },
        isError: false,
      };
    }

    case "fetch_page_text": {
      const url = parseHttpUrl(String(args.url));
      const maxChars = Math.min(Math.max(Number(args.max_chars ?? MAX_FETCH_CHARS), 1_000), 1_000_000);
      const response = await fetch(url, { headers: { "User-Agent": "Saivage/0.1 data-agent" } });
      const html = await response.text();
      const text = stripHtml(html);
      const content = text.slice(0, maxChars);
      let promptInjectionScan: PromptInjectionScanResult;
      try {
        promptInjectionScan = await scanUntrustedText(
          promptInjectionCop,
          url.toString(),
          content,
          response.headers.get("content-type") ?? undefined,
        );
      } catch (err) {
        return { content: { error: err instanceof Error ? err.message : String(err), url: url.toString() }, isError: true };
      }
      return {
        content: {
          url: url.toString(),
          status: response.status,
          ok: response.ok,
          headers: headersObject(response.headers),
          text: content,
          truncated: text.length > maxChars,
          prompt_injection_scan: promptInjectionScan,
        },
        isError: false,
      };
    }

    case "download_file": {
      const url = parseHttpUrl(String(args.url));
      const outPath = resolvePath(String(args.path));
      const maxBytes = Math.min(Math.max(Number(args.max_bytes ?? MAX_DOWNLOAD_BYTES), 1), 2 * 1024 * 1024 * 1024);
      const attempts: DownloadAttempt[] = [];
      try {
        const result = await downloadUrl(url, outPath, {
          maxBytes,
          headers: args.headers as Record<string, string> | undefined,
          attempts,
          attemptNumber: 1,
          promptInjectionCop,
        });
        if (result) return { content: result, isError: false };
      } catch (err) {
        attempts.push({ url: url.toString(), attempt: 1, error: err instanceof Error ? err.message : String(err) });
      }
      return { content: { error: "Download failed", url: url.toString(), attempts }, isError: true };
    }

    case "download_with_fallbacks": {
      const urls = Array.isArray(args.urls) ? args.urls.map(String).filter(Boolean) : [];
      if (urls.length === 0) return { content: { error: "urls must contain at least one source" }, isError: true };
      const outPath = resolvePath(String(args.path));
      const manifestPath = args.manifest_path ? resolvePath(String(args.manifest_path)) : null;
      const maxBytes = Math.min(Math.max(Number(args.max_bytes ?? MAX_DOWNLOAD_BYTES), 1), 2 * 1024 * 1024 * 1024);
      const retriesPerUrl = Math.min(Math.max(Number(args.retries_per_url ?? 2), 1), 5);
      const headers = args.headers as Record<string, string> | undefined;
      const attempts: DownloadAttempt[] = [];

      for (const rawUrl of urls) {
        let url: URL;
        try {
          url = parseHttpUrl(rawUrl);
        } catch (err) {
          attempts.push({ url: rawUrl, attempt: 0, error: err instanceof Error ? err.message : String(err) });
          continue;
        }

        for (let attemptNumber = 1; attemptNumber <= retriesPerUrl; attemptNumber++) {
          try {
            const result = await downloadUrl(url, outPath, { maxBytes, headers, attempts, attemptNumber, promptInjectionCop });
            if (result) {
              if (manifestPath) {
                mkdirSync(dirname(manifestPath), { recursive: true });
                writeFileSync(manifestPath, JSON.stringify(result, null, 2) + "\n", "utf-8");
              }
              return { content: { ...result, selected_url: result.url }, isError: false };
            }
          } catch (err) {
            attempts.push({
              url: url.toString(),
              attempt: attemptNumber,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }
      }

      const failure = { error: "All download sources failed", path: relative(projectRoot(), outPath), attempts };
      if (manifestPath) {
        mkdirSync(dirname(manifestPath), { recursive: true });
        writeFileSync(manifestPath, JSON.stringify(failure, null, 2) + "\n", "utf-8");
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
export function registerBuiltinServices(mcpRuntime: McpRuntime, options: BuiltinServicesOptions = {}): void {
  const promptInjectionCop = options.promptInjectionCop ?? disabledCop();
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
