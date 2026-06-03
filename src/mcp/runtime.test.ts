import { describe, expect, it } from "vitest";
import { McpRuntime, type McpRuntimeOptions } from "./runtime.js";
import type { ServiceEntry } from "./types.js";
import type { SaivageConfig } from "../config.js";
import type { ToolCallContext } from "./toolContext.js";

function makeEntry(name = "broken"): ServiceEntry {
  return {
    name,
    version: "0.1.0",
    origin: "external",
    command: "broken-command",
    args: [],
    env: {},
    transport: "stdio",
    tools: [],
    capabilities: [],
    createdAt: new Date().toISOString(),
  };
}

const baseCtx = (role: ToolCallContext["role"]): ToolCallContext => ({
  role,
  agentId: `${role}-test`,
  projectRoot: "/tmp/project",
});

describe("McpRuntime external service cooldown", () => {
  it("cooldowns a service after repeated startup failures", async () => {
    let now = 1_000;
    let connects = 0;
    const runtime = new McpRuntime(
      {
        runtime: { restartOnCrash: true, continuousImprovement: true, healthCheckIntervalMs: 0, idleShutdownMs: 0, maxServices: 50 },
        mcp: {
          shellTimeoutMs: 4 * 60 * 60 * 1000,
          shellTimeoutFloorMs: 10 * 60 * 1000,
          inProcessTimeoutMs: 300_000,
          maxOutputBytes: 100 * 1024,
          maxFetchChars: 200_000,
          maxDownloadBytes: 250 * 1024 * 1024,
          maxFileReadBytes: 200_000,
        },
      } as unknown as SaivageConfig,
      {
        now: () => now,
        crashFailureThreshold: 3,
        crashFailureWindowMs: 1_000,
        crashCooldownMs: 5_000,
        clientFactory: () => ({
          connected: false,
          connect: async () => {
            connects += 1;
            throw new Error("startup failed");
          },
          disconnect: async () => undefined,
          getTools: () => [],
          callTool: async () => ({ content: [], isError: false }),
        } as unknown as ReturnType<NonNullable<McpRuntimeOptions["clientFactory"]>>),
      },
    );

    const entry = makeEntry();
    await expect(runtime.startFromEntry(entry)).rejects.toThrow("startup failed");
    now += 100;
    await expect(runtime.startFromEntry(entry)).rejects.toThrow("startup failed");
    now += 100;
    await expect(runtime.startFromEntry(entry)).rejects.toThrow("startup failed");
    expect(connects).toBe(3);

    await expect(runtime.startFromEntry(entry)).rejects.toThrow("cooling down");
    expect(connects).toBe(3);

    now += 5_001;
    await expect(runtime.startFromEntry(entry)).rejects.toThrow("startup failed");
    expect(connects).toBe(4);
  });

  it("throws a config-pointing error when a service is not registered or running", async () => {
    const runtime = new McpRuntime({
      runtime: { restartOnCrash: true, continuousImprovement: true, healthCheckIntervalMs: 0, idleShutdownMs: 0, maxServices: 50 },
      mcp: {
        shellTimeoutMs: 4 * 60 * 60 * 1000,
        shellTimeoutFloorMs: 10 * 60 * 1000,
        inProcessTimeoutMs: 300_000,
        maxOutputBytes: 100 * 1024,
        maxFetchChars: 200_000,
        maxDownloadBytes: 250 * 1024 * 1024,
        maxFileReadBytes: 200_000,
      },
    } as unknown as SaivageConfig);
    await expect(runtime.getRunningService("ghost")).rejects.toThrow(/config\.mcpServers/);
  });

  it("does not expose or start configured external services that were not started", async () => {
    const runtime = new McpRuntime({
      runtime: { restartOnCrash: true, continuousImprovement: true, healthCheckIntervalMs: 0, idleShutdownMs: 1, maxServices: 50 },
      mcp: {
        shellTimeoutMs: 4 * 60 * 60 * 1000,
        shellTimeoutFloorMs: 10 * 60 * 1000,
        inProcessTimeoutMs: 300_000,
        maxOutputBytes: 100 * 1024,
        maxFetchChars: 200_000,
        maxDownloadBytes: 250 * 1024 * 1024,
        maxFileReadBytes: 200_000,
      },
    } as unknown as SaivageConfig);

    expect(runtime.listRunning()).toEqual([]);
    expect(runtime.getAllTools()).toEqual([]);
    await expect(runtime.callTool("external-web", "fetch_url", {}, { ...baseCtx("chat"), operatorContext: true }))
      .rejects.toThrow(/autostart: true and restart the runtime/);
  });
});

describe("McpRuntime role/tool enforcement", () => {
  function makeRuntime(): McpRuntime {
    return new McpRuntime({
      runtime: { restartOnCrash: true, continuousImprovement: true, healthCheckIntervalMs: 0, idleShutdownMs: 0, maxServices: 50 },
      mcp: {
        shellTimeoutMs: 4 * 60 * 60 * 1000,
        shellTimeoutFloorMs: 10 * 60 * 1000,
        inProcessTimeoutMs: 300_000,
        maxOutputBytes: 100 * 1024,
        maxFetchChars: 200_000,
        maxDownloadBytes: 250 * 1024 * 1024,
        maxFileReadBytes: 200_000,
      },
    } as unknown as SaivageConfig);
  }

  it("denies planner shell calls through direct runtime invocation", async () => {
    const runtime = makeRuntime();
    runtime.registerInProcess(
      "shell",
      [{ name: "run_command", description: "run", inputSchema: { type: "object" } }],
      async () => ({ content: { ok: true }, isError: false }),
    );

    await expect(runtime.callTool("shell", "run_command", { command: "pwd" }, baseCtx("planner")))
      .rejects.toThrow(/UNAUTHORIZED_TOOL/);
  });

  it("denies reviewer write_file through direct runtime invocation", async () => {
    const runtime = makeRuntime();
    runtime.registerInProcess(
      "filesystem",
      [{ name: "write_file", description: "write", inputSchema: { type: "object" } }],
      async () => ({ content: { ok: true }, isError: false }),
    );

    await expect(runtime.callTool("filesystem", "write_file", { path: "src/a.ts" }, baseCtx("reviewer")))
      .rejects.toThrow(/UNAUTHORIZED_TOOL/);
  });

  it("denies chat download tools", async () => {
    const runtime = makeRuntime();
    runtime.registerInProcess(
      "data",
      [{ name: "download_file", description: "download", inputSchema: { type: "object" } }],
      async () => ({ content: { ok: true }, isError: false }),
    );

    await expect(runtime.callTool("data", "download_file", { path: "data/a.bin" }, baseCtx("chat")))
      .rejects.toThrow(/UNAUTHORIZED_TOOL/);
  });

  it("allows operator context to bypass role filtering", async () => {
    const runtime = makeRuntime();
    runtime.registerInProcess(
      "shell",
      [{ name: "run_command", description: "run", inputSchema: { type: "object" } }],
      async () => ({ content: { ok: true }, isError: false }),
    );

    await expect(runtime.callTool("shell", "run_command", {}, { ...baseCtx("planner"), operatorContext: true }))
      .resolves.toEqual({ ok: true });
  });

  it("rejects agent-originated external MCP calls", async () => {
    const runtime = new McpRuntime(
      {
        runtime: { restartOnCrash: true, continuousImprovement: true, healthCheckIntervalMs: 0, idleShutdownMs: 0, maxServices: 50 },
        mcp: {
          shellTimeoutMs: 4 * 60 * 60 * 1000,
          shellTimeoutFloorMs: 10 * 60 * 1000,
          inProcessTimeoutMs: 300_000,
          maxOutputBytes: 100 * 1024,
          maxFetchChars: 200_000,
          maxDownloadBytes: 250 * 1024 * 1024,
          maxFileReadBytes: 200_000,
        },
      } as unknown as SaivageConfig,
      {
        clientFactory: () => ({
          connected: true,
          connect: async () => undefined,
          disconnect: async () => undefined,
          getTools: () => [{ name: "fetch_url", description: "fetch", inputSchema: { type: "object" } }],
          callTool: async () => ({ content: { ok: true }, isError: false }),
        } as unknown as ReturnType<NonNullable<McpRuntimeOptions["clientFactory"]>>),
      },
    );
    await runtime.startFromEntry(makeEntry("external-web"));

    await expect(runtime.callTool("external-web", "fetch_url", { url: "https://example.com" }, baseCtx("researcher")))
      .rejects.toThrow(/external MCP tool/);
  });
});
