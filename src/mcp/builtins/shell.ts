import { createWriteStream } from "node:fs";
import { mkdir, open, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

import type { SaivageConfig } from "../../config.js";
import type { InProcessToolHandler } from "../runtime.js";
import type { ToolCallContext } from "../toolContext.js";
import type { ToolEntry } from "../types.js";
import {
  DEFAULT_BUILTIN_SECURITY_CONTEXT,
  filterShellEnv as filterShellEnvWithSecurity,
  type BuiltinContext,
  type BuiltinSecurityContext,
} from "./context.js";
import { authorizePathMutation, resolvePath } from "./paths.js";

/** Headroom between the inner wall-clock cap and the outer McpRuntime
 *  race so the inner kill timer always wins and emits a structured result. */
export const WALL_CLOCK_HEADROOM_MS = 30_000;
const PROCESS_KILL_GRACE_MS = 2_000;
const OUTPUT_GROWTH_POLL_MS = 1_000;

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
        inactivity_timeout_ms: {
          type: "number",
          description: "Kill the process if stdout/stderr stop growing for this many milliseconds. Preferred over timeout_ms for most commands. Minimum 600000 (10 min). Omit or set 0 to disable.",
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
function clampTimeout(ms: number | undefined, context: BuiltinContext): number | undefined {
  if (ms === undefined) return undefined;
  return Math.max(ms, context.limits.shellTimeoutFloorMs);
}

export function filterShellEnv(
  env: NodeJS.ProcessEnv,
  security: BuiltinSecurityContext = DEFAULT_BUILTIN_SECURITY_CONTEXT,
): NodeJS.ProcessEnv {
  return filterShellEnvWithSecurity(env, security);
}

async function runShellCommand(
  command: string,
  cwd: string,
  timeoutMs: number | undefined,
  inactivityTimeoutMs: number | undefined,
  outputPaths: CommandLogPaths,
  context: BuiltinContext,
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
      env: { ...filterShellEnv(process.env, context.security), PROJECT_ROOT: context.project.projectRoot },
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
        readFileTail(outputPaths.stdoutAbs, context.limits.maxOutputBytes),
        readFileTail(outputPaths.stderrAbs, context.limits.maxOutputBytes),
      ]);
      let stderr = stderrTail;
      const [stdoutBytes, stderrBytes] = await Promise.all([
        safeFileSize(outputPaths.stdoutAbs),
        safeFileSize(outputPaths.stderrAbs),
      ]);
      if (stdoutBytes > context.limits.maxOutputBytes) stderr = appendTimeoutMessage(stderr, `[Saivage returned only the last ${context.limits.maxOutputBytes} bytes of stdout; full log: ${outputPaths.stdoutRel}]`);
      if (stderrBytes > context.limits.maxOutputBytes) stderr = appendTimeoutMessage(stderr, `[Saivage returned only the last ${context.limits.maxOutputBytes} bytes of stderr; full log: ${outputPaths.stderrRel}]`);
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

function resolveCommandLogPaths(
  args: Record<string, unknown>,
  context: BuiltinContext,
  ctx?: ToolCallContext,
): CommandLogPaths | { error: { error: string; code: "BLOCKED_PATH"; path: string } } {
  const id = `${Date.now()}-${randomUUID().slice(0, 8)}`;
  const explicitStdout = typeof args.stdout_path === "string";
  const explicitStderr = typeof args.stderr_path === "string";
  const stdoutRel = explicitStdout ? args.stdout_path as string : `.saivage/tmp/command-logs/${id}.stdout.log`;
  const stderrRel = explicitStderr ? args.stderr_path as string : `.saivage/tmp/command-logs/${id}.stderr.log`;
  const stdout = explicitStdout
    ? authorizePathMutation(ctx, stdoutRel, context.project.projectRoot)
    : { path: resolvePath(stdoutRel, context.project.projectRoot), relativePath: stdoutRel };
  if ("error" in stdout) return { error: stdout.error };
  const stderr = explicitStderr
    ? authorizePathMutation(ctx, stderrRel, context.project.projectRoot)
    : { path: resolvePath(stderrRel, context.project.projectRoot), relativePath: stderrRel };
  if ("error" in stderr) return { error: stderr.error };
  return {
    stdoutAbs: stdout.path,
    stderrAbs: stderr.path,
    stdoutRel: stdout.relativePath,
    stderrRel: stderr.relativePath,
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

export function makeShellService(
  context: BuiltinContext,
  mcpConfig: SaivageConfig["mcp"],
): {
  tools: ToolEntry[];
  handler: InProcessToolHandler;
} {
  const innerCapMs = mcpConfig.shellTimeoutMs - WALL_CLOCK_HEADROOM_MS;

  const handler: InProcessToolHandler = async (toolName, args, ctx) => {
    if (toolName !== "run_command") {
      return { content: { error: `Unknown shell tool: ${toolName}` }, isError: true };
    }

    const command = args.command as string;
    const cwd = args.cwd ? resolvePath(args.cwd as string, context.project.projectRoot) : context.project.projectRoot;
    const timeout = clampTimeout(parseOptionalTimeoutMs(args, ["timeout_ms"], "timeout_ms"), context);
    const inactivityTimeout = clampTimeout(parseOptionalTimeoutMs(
      args,
      ["inactivity_timeout_ms"],
      "inactivity_timeout_ms",
    ), context);
    const outputPaths = resolveCommandLogPaths(args, context, ctx);
    if ("error" in outputPaths) return { content: outputPaths.error, isError: true };

    // Always enforce a hard wall-clock cap so the process group is
    // properly killed even when the agent omits timeout_ms. The cap is
    // derived from mcpConfig.shellTimeoutMs minus WALL_CLOCK_HEADROOM_MS
    // and also clamps caller-supplied timeout_ms.
    const effectiveTimeout = Math.min(timeout ?? innerCapMs, innerCapMs);
    const result = await runShellCommand(
      command,
      cwd,
      effectiveTimeout,
      inactivityTimeout,
      outputPaths,
      context,
    );
    return { content: result, isError: false };
  };

  return { tools: shellTools, handler };
}
