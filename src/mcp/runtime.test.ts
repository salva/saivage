import { describe, expect, it } from "vitest";
import { McpRuntime } from "./runtime.js";
import type { ServiceEntry } from "./registry.js";

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
    status: "active",
    createdAt: new Date().toISOString(),
  };
}

describe("McpRuntime external service cooldown", () => {
  it("cooldowns a service after repeated startup failures", async () => {
    let now = 1_000;
    let connects = 0;
    const runtime = new McpRuntime(
      { restartOnCrash: true, continuousImprovement: true, healthCheckIntervalMs: 0, idleShutdownMs: 0, maxServices: 50 },
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
        } as any),
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
});