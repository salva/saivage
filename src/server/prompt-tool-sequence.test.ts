import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PlannerAgent } from "../agents/planner.js";
import { makeStubModel, stubTool } from "./test-helpers/stub-model.js";
import { NoteManager } from "../runtime/notes.js";
import type { AgentContext, AgentResult } from "../agents/types.js";
import type { DispatchableRole } from "../agents/roster.js";
import type { ChatResponse } from "../providers/types.js";
import {
  CONTINUOUS_IMPROVEMENT_PROMPT,
  RECOVERY_PROMPT,
} from "./bootstrap.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "saivage-planner-loop-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("planner prompt tool sequence", () => {
  it("emits plan_add_stage -> plan_set_current -> run_manager under RECOVERY_PROMPT", async () => {
    const { calls, result } = await runPlannerWithStub(RECOVERY_PROMPT);

    expect(result.kind).toBe("success");
    expect(calls.slice(0, 3).map((c) => c.name)).toEqual([
      "plan_add_stage",
      "plan_set_current",
      "run_manager",
    ]);
  });

  it("emits plan_add_stage -> plan_set_current -> run_manager under CONTINUOUS_IMPROVEMENT_PROMPT", async () => {
    const { calls, result } = await runPlannerWithStub(CONTINUOUS_IMPROVEMENT_PROMPT);

    expect(result.kind).toBe("success");
    expect(calls.slice(0, 3).map((c) => c.name)).toEqual([
      "plan_add_stage",
      "plan_set_current",
      "run_manager",
    ]);
  });

  it("treats a successful plan_done call as terminal", async () => {
    const { result, modelCalls } = await runPlannerWithStub("terminal check", [
      stubTool("plan_get", {}, "checking plan", "get-1"),
      stubTool("plan_done", { reason: "all objectives complete" }, "done", "done-1"),
    ]);

    expect(result).toEqual({
      kind: "success",
      data: { completion: "plan_done", summary: "all objectives complete" },
    });
    expect(modelCalls).toHaveLength(2);
  });
});

async function runPlannerWithStub(
  directive: string,
  responses: ChatResponse[] = defaultPlannerResponses(),
): Promise<{
  result: AgentResult;
  calls: Array<{ name: string; args: unknown }>;
  modelCalls: unknown[];
}> {
  const calls: Array<{ name: string; args: unknown }> = [];
  const model = makeStubModel(responses);
  const ctx = makePlannerContext(tmpDir, directive, model, calls);
  const planner = new PlannerAgent(
    ctx,
    async (role: DispatchableRole, input: unknown) => {
      calls.push({ name: `run_${role}`, args: input });
      return { kind: "success", data: { stage_id: "stage-X", result: "completed" } };
    },
    "Plan a test project.",
    "",
  );

  const result = await planner.run();
  return { result, calls, modelCalls: model.calls };
}

function defaultPlannerResponses(): ChatResponse[] {
  return [
    stubTool("plan_add_stage", { stage: { id: "stage-X" } }, "Adding a stage.", "add-1"),
    stubTool("plan_set_current", { stage_id: "stage-X" }, "Setting current stage.", "set-1"),
    stubTool("run_manager", { stage: { id: "stage-X" } }, "Dispatching manager.", "run-1"),
    stubTool("plan_done", { reason: "test complete" }, "Completing plan.", "done-1"),
  ];
}

function makePlannerContext(
  root: string,
  directive: string,
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
        { name: "plan_get", description: "get", inputSchema: {}, service: "plan" },
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
    startupDirectives: [directive],
  };
}
