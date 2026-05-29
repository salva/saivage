import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SaivageConfigSchema } from "../config.js";
import { seedProject } from "../store/project.js";
import { withRuntime } from "./cli-actions.js";

const LEAK_SENSITIVE_KINDS = [
  "ChildProcess",
  "Pipe",
  "PipeWrap",
  "Process",
  "Timeout",
  "FSReqCallback",
  "FileHandle",
  "HandleWrap",
] as const;

const isLinux = process.platform === "linux";

function histogram(kinds: readonly string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const kind of kinds) counts.set(kind, (counts.get(kind) ?? 0) + 1);
  return counts;
}

async function fdCount(): Promise<number> {
  return (await readdir("/proc/self/fd")).length;
}

async function nextTick(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

let tmpRoot: string | undefined;
const ENV_KEYS = [
  "PROJECT_ROOT",
  "SAIVAGE_ROOT",
  "OPENAI_API_KEY",
  "OPENAI_CODEX_API_KEY",
  "ANTHROPIC_API_KEY",
  "OPENCODE_API_KEY",
  "LLAMACPP_BASE_URL",
] as const;
const previousEnv = new Map<string, string | undefined>();

beforeEach(() => {
  process.exitCode = undefined;
  previousEnv.clear();
  for (const key of ENV_KEYS) {
    previousEnv.set(key, process.env[key]);
    Reflect.deleteProperty(process.env, key);
  }
});

afterEach(async () => {
  process.exitCode = undefined;
  for (const key of ENV_KEYS) {
    const value = previousEnv.get(key);
    if (value === undefined) Reflect.deleteProperty(process.env, key);
    else process.env[key] = value;
  }
  vi.restoreAllMocks();
  if (tmpRoot) {
    await rm(tmpRoot, { recursive: true, force: true });
    tmpRoot = undefined;
  }
});

async function seedBootstrapProject(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "saivage-g48-"));
  tmpRoot = dir;
  await seedProject(dir, { name: "g48-test", objectives: ["test"] });

  const config = SaivageConfigSchema.parse({
    models: { default: "ollama/llama3.1:70b" },
    runtime: {
      healthCheckIntervalMs: 0,
      idleShutdownMs: 0,
    },
    supervisor: {
      enabled: false,
    },
  });
  await writeFile(
    join(dir, ".saivage", "saivage.json"),
    `${JSON.stringify(config, null, 2)}\n`,
    "utf-8",
  );
  return dir;
}

describe("G48 resource-leak regression", () => {
  it("collapses MCP, timer, and FD resources after a throwing runtime callback", async () => {
    const projectRoot = await seedBootstrapProject();
    const before = histogram(process.getActiveResourcesInfo());
    const fdBefore = isLinux ? await fdCount() : 0;

    vi.spyOn(process, "exit").mockImplementation(((code?: string | number | null) => {
      throw new Error(`__exit:${code ?? 0}`);
    }) as never);
    vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(
      withRuntime(projectRoot, async () => {
        throw new Error("simulated inspect failure");
      }),
    ).rejects.toThrow("__exit:1");

    await nextTick();
    await nextTick();

    const after = histogram(process.getActiveResourcesInfo());
    for (const kind of LEAK_SENSITIVE_KINDS) {
      const afterCount = after.get(kind) ?? 0;
      const beforeCount = before.get(kind) ?? 0;
      expect(afterCount, `leaked ${afterCount - beforeCount} extra ${kind} after shutdown`)
        .toBeLessThanOrEqual(beforeCount);
    }

    if (isLinux) {
      const fdAfter = await fdCount();
      expect(fdAfter, `FD count grew from ${fdBefore} to ${fdAfter}`)
        .toBeLessThanOrEqual(fdBefore + 2);
    }
  }, 60_000);
});
