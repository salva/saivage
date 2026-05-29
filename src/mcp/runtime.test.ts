import { describe, expect, it } from "vitest";
import { McpRuntime, type McpRuntimeOptions } from "./runtime.js";
import type { ServiceEntry } from "./types.js";
import type { SaivageConfig } from "../config.js";

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
    await expect(runtime.startService("ghost")).rejects.toThrow(/config\.mcpServers/);
  });
});