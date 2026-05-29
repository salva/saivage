/**
 * Saivage — toolContext tests (WI-06, M1).
 *
 * Covers:
 *   • `ToolCallContext` end-to-end propagation through `McpRuntime.callTool`
 *     into an in-process handler.
 *   • `defaultAuthor` derivation rules.
 *   • `withContext` wrapper preserves handler semantics.
 *
 * Spawner-side propagation (createChildSpawner / runPlanner / web-chat /
 * telegram-chat) is asserted in their respective integration tests; this
 * file pins the runtime-level seam.
 */

import { describe, expect, it } from "vitest";
import { McpRuntime, type McpRuntimeOptions } from "./runtime.js";
import { defaultAuthor, withContext, type ToolCallContext } from "./toolContext.js";
import type { ToolEntry } from "./types.js";
import type { SaivageConfig } from "../config.js";

const ctx: ToolCallContext = {
  role: "coder",
  agentId: "coder-7",
  projectRoot: "/tmp/proj",
  stageId: "stg-A",
};

const toolDef: ToolEntry = {
  name: "probe",
  description: "probe tool",
  inputSchema: { type: "object", properties: {}, additionalProperties: true },
};

function makeRuntime(): McpRuntime {
  return new McpRuntime(
    {
      runtime: { restartOnCrash: false, continuousImprovement: false, healthCheckIntervalMs: 0, idleShutdownMs: 0, maxServices: 50 },
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
      now: () => 0,
      crashFailureThreshold: 99,
      crashFailureWindowMs: 1_000,
      crashCooldownMs: 1_000,
      clientFactory: () =>
        ({
          connected: false,
          connect: async () => undefined,
          disconnect: async () => undefined,
          getTools: () => [],
          callTool: async () => ({ content: [], isError: false }),
        }) as unknown as ReturnType<NonNullable<McpRuntimeOptions["clientFactory"]>>,
    },
  );
}

describe("ToolCallContext propagation", () => {
  it("forwards ctx into the in-process handler", async () => {
    const runtime = makeRuntime();
    let seen: ToolCallContext | undefined;
    runtime.registerInProcess(
      "probe-svc",
      [toolDef],
      async (_name, _args, c) => {
        seen = c;
        return { content: { ok: true }, isError: false };
      },
    );

    await runtime.callTool("probe-svc", "probe", {}, ctx);

    expect(seen).toBeDefined();
    expect(seen?.role).toBe("coder");
    expect(seen?.agentId).toBe("coder-7");
    expect(seen?.stageId).toBe("stg-A");
    expect(seen?.projectRoot).toBe("/tmp/proj");
  });

  it("forwards undefined ctx when caller omits it (legacy handlers)", async () => {
    const runtime = makeRuntime();
    let seen: ToolCallContext | undefined = ctx;
    runtime.registerInProcess(
      "probe-svc",
      [toolDef],
      async (_name, _args, c) => {
        seen = c;
        return { content: { ok: true }, isError: false };
      },
    );

    await runtime.callTool("probe-svc", "probe", {});

    expect(seen).toBeUndefined();
  });

  it("propagates channelId/sessionId for chat-originated calls", async () => {
    const runtime = makeRuntime();
    let seen: ToolCallContext | undefined;
    runtime.registerInProcess(
      "probe-svc",
      [toolDef],
      async (_name, _args, c) => {
        seen = c;
        return { content: {}, isError: false };
      },
    );

    const chatCtx: ToolCallContext = {
      role: "chat",
      agentId: "chat-1",
      projectRoot: "/tmp/proj",
      channelId: "web",
      sessionId: "sess-42",
    };
    await runtime.callTool("probe-svc", "probe", {}, chatCtx);

    expect(seen?.channelId).toBe("web");
    expect(seen?.sessionId).toBe("sess-42");
    expect(seen?.stageId).toBeUndefined();
  });
});

describe("defaultAuthor", () => {
  it("uses author when provided", () => {
    expect(
      defaultAuthor({ role: "coder", agentId: "c-1", author: "explicit" }),
    ).toBe("explicit");
  });

  it("falls back to role:agentId", () => {
    expect(defaultAuthor({ role: "planner", agentId: "p-9" })).toBe("planner:p-9");
  });
});

describe("withContext", () => {
  it("wraps a handler and forwards ctx", async () => {
    let received: ToolCallContext | undefined;
    const wrapped = withContext(async (_name, _args, c) => {
      received = c;
      return { content: { ok: true }, isError: false };
    });
    const result = await wrapped("probe", {}, ctx);
    expect(result.isError).toBe(false);
    expect(received).toEqual(ctx);
  });
});
