import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PlannerAgent } from "../agents/planner.js";
import { makeStubModel, stubTool } from "./test-helpers/stub-model.js";
import { NoteManager } from "../runtime/notes.js";
import type { AgentContext, AgentResult } from "../agents/types.js";
import type { DispatchableRole } from "../agents/roster.js";
import type { ChatRequest, ChatResponse } from "../providers/types.js";
import { RECOVERY_PROMPT } from "./bootstrap.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "saivage-planner-correction-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("planner self-correction loop", () => {
  it("on STAGE_MISMATCH, the next call can repair with plan_set_current for the same stage", async () => {
    const { calls, modelCalls, result } = await runPlannerCorrection([
      stubTool("run_manager", { stage: { id: "stage-X" } }, "Dispatching too early.", "run-1"),
      stubTool("plan_set_current", { stage_id: "stage-X" }, "Repairing current stage.", "set-1"),
      stubTool("run_manager", { stage: { id: "stage-X" } }, "Dispatching again.", "run-2"),
      stubTool("plan_done", { reason: "repaired" }, "Done.", "done-1"),
    ]);

    expect(result.kind).toBe("success");
    const runIdx = calls.findIndex((c) => c.name === "run_manager");
    expect(calls[runIdx + 1]).toEqual({
      name: "plan_set_current",
      args: { stage_id: "stage-X" },
    });
    expect(JSON.stringify(modelCalls[1].messages)).toContain("STAGE_MISMATCH");
  });

  it("on STAGE_NOT_FOUND, the next call can repair with plan_add_stage", async () => {
    const { calls, modelCalls, result } = await runPlannerCorrection([
      stubTool("run_manager", { stage: { id: "stage-X" } }, "Dispatching missing stage.", "run-1"),
      stubTool("plan_add_stage", { stage: { id: "stage-X" } }, "Adding missing stage.", "add-1"),
      stubTool("plan_set_current", { stage_id: "stage-X" }, "Setting current stage.", "set-1"),
      stubTool("run_manager", { stage: { id: "stage-X" } }, "Dispatching again.", "run-2"),
      stubTool("plan_done", { reason: "repaired" }, "Done.", "done-1"),
    ], "STAGE_NOT_FOUND");

    expect(result.kind).toBe("success");
    const runIdx = calls.findIndex((c) => c.name === "run_manager");
    expect(calls[runIdx + 1].name).toBe("plan_add_stage");
    expect(JSON.stringify(modelCalls[1].messages)).toContain("STAGE_NOT_FOUND");
  });

  it("does not re-emit run_manager before the missing precondition tool runs", async () => {
    const { calls } = await runPlannerCorrection([
      stubTool("run_manager", { stage: { id: "stage-X" } }, "Dispatching too early.", "run-1"),
      stubTool("plan_set_current", { stage_id: "stage-X" }, "Repairing current stage.", "set-1"),
      stubTool("run_manager", { stage: { id: "stage-X" } }, "Dispatching again.", "run-2"),
      stubTool("plan_done", { reason: "repaired" }, "Done.", "done-1"),
    ]);
    const runIdxs = calls.flatMap((c, i) => (c.name === "run_manager" ? [i] : []));
    const between = calls.slice(runIdxs[0] + 1, runIdxs[1]).map((c) => c.name);

    expect(between).toEqual(["plan_set_current"]);
  });
});

async function runPlannerCorrection(
  responses: ChatResponse[],
  code = "STAGE_MISMATCH",
): Promise<{
  result: AgentResult;
  calls: Array<{ name: string; args: unknown }>;
  modelCalls: ChatRequest[];
}> {
  const calls: Array<{ name: string; args: unknown }> = [];
  const model = makeStubModel(responses);
  const ctx = makePlannerContext(tmpDir, model, calls);
  let failedOnce = false;
  const planner = new PlannerAgent(
    ctx,
    async (role: DispatchableRole, input: unknown) => {
      calls.push({ name: `run_${role}`, args: input });
      if (!failedOnce) {
        failedOnce = true;
        return { kind: "failure", reason: { code, error: `${code} for stage-X` } };
      }
      return { kind: "success", data: { stage_id: "stage-X", result: "completed" } };
    },
    "Plan a recovery test project.",
    "",
  );

  const result = await planner.run();
  return { result, calls, modelCalls: model.calls };
}

function makePlannerContext(
  root: string,
  router: { chat: AgentContext["router"]["chat"] },
  calls: Array<{ name: string; args: unknown }>,
): AgentContext {
  const saivageDir = join(root, ".saivage");
  mkdirSync(join(saivageDir, "skills"), { recursive: true });

  return {
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
        stages: join(saivageDir, "stages"),
        notes: join(saivageDir, "notes"),
        inspections: join(saivageDir, "inspections"),
        skills: join(saivageDir, "skills"),
        tools: join(saivageDir, "tools"),
        research: join(root, "research"),
        tmp: join(saivageDir, "tmp"),
        runtimeState: join(saivageDir, "tmp", "state", "runtime.json"),
        chats: join(saivageDir, "tmp", "chats"),
        inspectorWorkspace: join(saivageDir, "tmp", "inspector-workspace"),
        work: join(saivageDir, "tmp", "work"),
      },
    },
    router: {
      getMaxContextTokens: () => 200_000,
      countTokens: () => 0,
      resetModelHealth: () => undefined,
      ...router,
    } as AgentContext["router"],
    mcpRuntime: {
      getAllTools: () => [
        { name: "plan_add_stage", description: "add", inputSchema: {}, service: "plan" },
        { name: "plan_set_current", description: "set", inputSchema: {}, service: "plan" },
        { name: "plan_done", description: "done", inputSchema: {}, service: "plan" },
      ],
      callTool: async (_service: string, name: string, args: unknown) => {
        calls.push({ name, args });
        return { ok: true };
      },
    } as AgentContext["mcpRuntime"],
    noteManager: new NoteManager(join(saivageDir, "notes")),
    agentId: "planner-1",
    role: "planner",
    modelSpec: "test/model",
    startupDirectives: [RECOVERY_PROMPT],
  };
}
