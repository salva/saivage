import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { PlannerAgent } from "./planner.js";
import type { AgentContext } from "./types.js";
import type { ChildSpawner } from "../runtime/dispatcher.js";
import type { RuntimeToolEntry } from "../mcp/runtime.js";
import type { ChatRequest, ChatResponse, ToolCallResult } from "../providers/types.js";

const LEGACY_TOKEN = "PLAN_" + "COMPLETE";

type AbortSignalLike = { aborted: boolean };
type RouterRequest = ChatRequest & { modelSpec?: string };
type ScriptedResponse = ChatResponse | ((request: RouterRequest, index: number) => ChatResponse);

interface ScriptedRouter {
  calls: RouterRequest[];
  getMaxContextTokens: () => number;
  countTokens: () => number;
  chat: (request: RouterRequest) => Promise<ChatResponse>;
  resetModelHealth: () => void;
}

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "saivage-planner-test-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function textResponse(content: string): ChatResponse {
  return {
    content,
    toolCalls: [],
    finishReason: "end_turn",
    usage: { inputTokens: 1, outputTokens: 1 },
  };
}

function toolResponse(toolCalls: ToolCallResult[], content = ""): ChatResponse {
  return {
    content,
    toolCalls,
    finishReason: "tool_use",
    usage: { inputTokens: 1, outputTokens: 1 },
  };
}

function toolCall(id: string, name: string, input: unknown): ToolCallResult {
  return { id, name, input };
}

function makeRouter(script: ScriptedResponse[]): ScriptedRouter {
  const calls: RouterRequest[] = [];
  return {
    calls,
    getMaxContextTokens: () => 200_000,
    countTokens: () => 0,
    chat: async (request: RouterRequest): Promise<ChatResponse> => {
      calls.push(request);
      const index = calls.length - 1;
      const entry = script[index] ?? textResponse("Still working.");
      return typeof entry === "function" ? entry(request, index) : entry;
    },
    resetModelHealth: () => undefined,
  };
}

function planTool(name: string): RuntimeToolEntry {
  return {
    service: "plan",
    name,
    description: name,
    inputSchema: { type: "object", properties: {} },
  };
}

function validatePlanDone(args: Record<string, unknown>): { ok: true } {
  if (typeof args.reason !== "string" || args.reason.trim() === "") {
    throw new Error("VALIDATION_ERROR: plan_done requires a non-empty reason");
  }
  return { ok: true };
}

function makePlannerContext(
  root: string,
  router: ScriptedRouter,
  opts: {
    abortSignal?: AbortSignalLike;
    onPlanDoneCall?: () => void;
  } = {},
): { ctx: AgentContext; abortSignal: AbortSignalLike } {
  const saivageDir = join(root, ".saivage");
  const abortSignal = opts.abortSignal ?? { aborted: false };
  for (const dir of [
    saivageDir,
    join(saivageDir, "skills"),
    join(saivageDir, "memory"),
    join(saivageDir, "notes"),
    join(saivageDir, "stages"),
    join(saivageDir, "inspections"),
    join(saivageDir, "tools"),
    join(saivageDir, "tmp", "state"),
    join(saivageDir, "tmp", "chats"),
    join(saivageDir, "tmp", "inspector-workspace"),
    join(saivageDir, "tmp", "work"),
  ]) {
    mkdirSync(dir, { recursive: true });
  }

  const ctx: AgentContext = {
    project: {
      projectRoot: root,
      saivageDir,
      config: {
        project_name: "test",
        objectives: ["test objective"],
        provider: "test",
        notifications: { channels: [], filters: { min_severity: "info", categories: [] } },
        skills: { max_per_agent: 5 },
      },
      paths: {
        plan: join(saivageDir, "plan.json"),
        planHistory: join(saivageDir, "plan-history.json"),
        stages: join(saivageDir, "stages"),
        notes: join(saivageDir, "notes"),
        inspections: join(saivageDir, "inspections"),
        skills: join(saivageDir, "skills"),
        memory: join(saivageDir, "memory"),
        tools: join(saivageDir, "tools"),
        research: join(root, "research"),
        tmp: join(saivageDir, "tmp"),
        runtimeState: join(saivageDir, "tmp", "state", "runtime.json"),
        shutdownRequest: join(saivageDir, "tmp", "state", "shutdown-request.json"),
        shutdownSummary: join(saivageDir, "tmp", "state", "shutdown-summary.json"),
        chats: join(saivageDir, "tmp", "chats"),
        inspectorWorkspace: join(saivageDir, "tmp", "inspector-workspace"),
        work: join(saivageDir, "tmp", "work"),
        telegramSubscriptions: join(saivageDir, "telegram-subscriptions.json"),
      },
    },
    router: router as unknown as AgentContext["router"],
    mcpRuntime: {
      getAllTools: () => [
        planTool("plan_done"),
        planTool("plan_add_stage"),
        planTool("plan_get"),
        planTool("plan_get_history"),
        planTool("plan_set_current"),
      ],
      callTool: async (service: string, tool: string, args: Record<string, unknown>) => {
        if (service === "plan" && tool === "plan_done") {
          opts.onPlanDoneCall?.();
          return validatePlanDone(args);
        }
        if (service === "plan" && tool === "plan_add_stage") return { ok: true };
        return { ok: true };
      },
    } as unknown as AgentContext["mcpRuntime"],
    agentId: "planner-1",
    role: "planner",
    stageId: undefined,
    modelSpec: "test/model",
  };

  return { ctx, abortSignal };
}

const failingChildSpawner: ChildSpawner = async () => {
  throw new Error("planner test should not spawn children");
};

function assistantTextEquals(m: { role: string; content: unknown }, target: string): boolean {
  if (m.role !== "assistant") return false;
  if (typeof m.content === "string") return m.content === target;
  if (Array.isArray(m.content)) {
    const textBlocks = (m.content as any[])
      .filter((b: any) => b?.type === "text")
      .map((b: any) => b.text ?? "");
    return textBlocks.join("") === target;
  }
  return false;
}

function messageText(m: { content: unknown }): string {
  if (typeof m.content === "string") return m.content;
  if (Array.isArray(m.content)) {
    return (m.content as any[])
      .filter((b: any) => b?.type === "text")
      .map((b: any) => b.text ?? "")
      .join("");
  }
  return "";
}

describe("PlannerAgent plan_done terminal protocol", () => {
  it("terminates on a single plan_done tool call", async () => {
    const router = makeRouter([
      toolResponse([
        toolCall("tc-done", "plan_done", { reason: "objectives verified" }),
      ]),
    ]);
    const { ctx } = makePlannerContext(tmpDir, router);
    const planner = await PlannerAgent.create(ctx, failingChildSpawner);

    const result = await planner.run();

    expect(result).toEqual({
      kind: "success",
      data: { completion: "plan_done", summary: "objectives verified" },
    });
    expect(router.calls).toHaveLength(1);
  });

  it("a rejected batched plan_done followed by a valid single plan_done uses the second reason", async () => {
    let planDoneCallCount = 0;
    const router = makeRouter([
      toolResponse([
        toolCall("tc-add", "plan_add_stage", { stage: { id: "stg-1" } }),
        toolCall("tc-done", "plan_done", { reason: "old" }),
      ]),
      toolResponse([
        toolCall("tc-done-2", "plan_done", { reason: "new" }),
      ]),
    ]);
    const { ctx } = makePlannerContext(tmpDir, router, {
      onPlanDoneCall: () => { planDoneCallCount += 1; },
    });
    const planner = await PlannerAgent.create(ctx, failingChildSpawner);

    const result = await planner.run();

    expect(result).toEqual({
      kind: "success",
      data: { completion: "plan_done", summary: "new" },
    });
    expect(router.calls).toHaveLength(2);
    expect(planDoneCallCount).toBe(2);
  });

  it("does not terminate when plan_done is batched with another plan tool", async () => {
    const router = makeRouter([
      toolResponse([
        toolCall("tc-add", "plan_add_stage", { stage: { id: "stg-1" } }),
        toolCall("tc-done", "plan_done", { reason: "batched" }),
      ]),
    ]);
    const { ctx } = makePlannerContext(tmpDir, router);
    const planner = await PlannerAgent.create(ctx, failingChildSpawner);

    const result = await planner.run();

    expect(result.kind).toBe("failure");
    expect(router.calls.length).toBeGreaterThan(1);
  });

  it("does not terminate when plan_done is batched with a dispatch tool", async () => {
    const router = makeRouter([
      toolResponse([
        toolCall("tc-manager", "run_manager", { stage: { id: "stg-1" } }),
        toolCall("tc-done", "plan_done", { reason: "batched with dispatch" }),
      ]),
    ]);
    const { ctx } = makePlannerContext(tmpDir, router);
    const childSpawner: ChildSpawner = async () => ({
      kind: "success",
      data: { result: "completed", summary: "stage done" },
    });
    const planner = await PlannerAgent.create(ctx, childSpawner);

    const result = await planner.run();

    expect(result.kind).toBe("failure");
    expect(router.calls.length).toBeGreaterThan(1);
  });

  it("does not terminate when the plan_done dispatch result is an error", async () => {
    const router = makeRouter([
      toolResponse([
        toolCall("tc-done", "plan_done", { reason: "" }),
      ]),
    ]);
    const { ctx } = makePlannerContext(tmpDir, router);
    const planner = await PlannerAgent.create(ctx, failingChildSpawner);

    const result = await planner.run();

    expect(result.kind).toBe("failure");
    expect(router.calls.length).toBeGreaterThan(1);
    expect(JSON.stringify(router.calls[1].messages)).toContain("VALIDATION_ERROR");
  });

  it("aborts when the abort signal flips during mcpRuntime.callTool", async () => {
    const abortSignal = { aborted: false };
    const router = makeRouter([
      toolResponse([
        toolCall("tc-done", "plan_done", { reason: "objectives verified" }),
      ]),
    ]);
    const { ctx } = makePlannerContext(tmpDir, router, {
      abortSignal,
      onPlanDoneCall: () => { abortSignal.aborted = true; },
    });
    const planner = await PlannerAgent.create(ctx, failingChildSpawner, { abortSignal });

    const result = await planner.run();

    expect(result.kind).toBe("abort");
  });

  it("does not terminate on a bare legacy-text response", async () => {
    const router = makeRouter([
      textResponse(LEGACY_TOKEN),
    ]);
    const { ctx } = makePlannerContext(tmpDir, router);
    const planner = await PlannerAgent.create(ctx, failingChildSpawner);

    const result = await planner.run();

    expect(result.kind).toBe("failure");
    expect(router.calls.length).toBeGreaterThan(1);
  });

  it("does not duplicate the nudged assistant message in this.messages", async () => {
    const router = makeRouter([
      textResponse("I have nothing else to do."),
      toolResponse([
        toolCall("tc-done", "plan_done", { reason: "objectives verified" }),
      ]),
    ]);
    const { ctx } = makePlannerContext(tmpDir, router);
    const planner = await PlannerAgent.create(ctx, failingChildSpawner);

    const result = await planner.run();

    expect(result.kind).toBe("success");
    expect(router.calls).toHaveLength(2);

    const msgs = router.calls[1].messages as any[];
    const count = msgs.filter((m) =>
      assistantTextEquals(m, "I have nothing else to do."),
    ).length;
    expect(count).toBe(1);

    const idx = msgs.findIndex((m) =>
      assistantTextEquals(m, "I have nothing else to do."),
    );
    expect(idx).toBeGreaterThanOrEqual(0);
    const next = msgs[idx + 1];
    expect(next?.role).toBe("user");
    expect(messageText(next).startsWith("SYSTEM: You ended your turn with text only")).toBe(true);
  });
});
