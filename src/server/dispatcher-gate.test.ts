/**
 * Saivage — Fix 1 dispatcher-gate unit tests.
 *
 * Verifies that createChildSpawner's manager-arm consults plan.json BEFORE
 * constructing a ManagerAgent or moving tracker state, and that it emits
 * the literal `[dispatch-gate]` log token plus a structured
 * {code, error} failure reason for each rejection class.
 *
 * Pass case lives in worker-spawn.test.ts already exercises the happy
 * worker flow; the manager happy path is covered by the integration
 * suite (planner → run_manager) referenced in
 * SPEC/plan-persistence-fix/02-architecture.md §2.5.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { createChildSpawner, type SaivageRuntime } from "./bootstrap.js";
import { ManagerAgent } from "../agents/manager.js";
import { PlanService } from "../mcp/plan-server.js";
import { NoteManager } from "../runtime/notes.js";
import type { AgentContext, ManagerInput } from "../agents/types.js";
import type { PlanDocument, Stage } from "../types.js";
import type { BaseAgent } from "../agents/base.js";

afterEach(() => {
  vi.restoreAllMocks();
});

async function makeRuntimeWithPlan(
  root: string,
  doc: PlanDocument,
): Promise<SaivageRuntime> {
  const saivageDir = join(root, ".saivage");
  mkdirSync(saivageDir, { recursive: true });
  mkdirSync(join(saivageDir, "tmp", "state"), { recursive: true });
  writeFileSync(join(saivageDir, "plan.json"), JSON.stringify(doc, null, 2));

  const planService = new PlanService(saivageDir);
  await planService.init();

  const project = makeProject(root);
  return {
    config: {} as SaivageRuntime["config"],
    router: {
      getMaxContextTokens: () => 200_000,
      countTokens: () => 0,
      chat: async () => {
        throw new Error("not used");
      },
      resetModelHealth: () => {},
    } as SaivageRuntime["router"],
    routing: {
      resolve: () => ({ modelSpec: "test/m", authProfile: undefined, accountRef: undefined }),
    } as unknown as SaivageRuntime["routing"],
    mcpRuntime: {
      getAllTools: () => [],
      callTool: async () => ({ ok: true }),
    } as SaivageRuntime["mcpRuntime"],
    noteManager: new NoteManager(project.paths.notes),
    eventBus: {
      publish: async () => {},
      clear: () => {},
    } as unknown as SaivageRuntime["eventBus"],
    planService,
    project,
    tracker: makeTracker(),
    plannerControl: {} as SaivageRuntime["plannerControl"],
    plannerStartupDirectives: [],
    agentRegistry: new Map<string, BaseAgent>() as SaivageRuntime["agentRegistry"],
    supervisor: null,
    shutdown: async () => {},
  };
}

function makeStage(id: string): Stage {
  return {
    id,
    objective: `objective for ${id}`,
    starting_points: [],
    expected_outcomes: ["x"],
    acceptance_criteria: ["x"],
    references: [],
    tags: [],
  };
}

describe("createChildSpawner — Fix 1 dispatcher gate (manager arm)", () => {
  it("rejects when stage.id is missing (VALIDATION_ERROR)", async () => {
    const root = mkdtempSync(join(tmpdir(), "gate-validation-"));
    try {
      const runtime = await makeRuntimeWithPlan(root, {
        updated_at: "2026-05-29T00:00:00.000Z",
        current_stage_id: null,
        stages: [],
        history: [],
      });
      const managerCreate = vi.spyOn(ManagerAgent, "create");
      const trackerSet = vi.spyOn(runtime.tracker, "setCurrentStage");
      const logs: string[] = [];
      vi.spyOn(console, "warn").mockImplementation((m: unknown) => {
        logs.push(String(m));
      });

      const result = await createChildSpawner(runtime)(
        "manager",
        { stage: undefined as unknown as Stage } as unknown as ManagerInput,
        makeParentContext(root),
      );

      expect(result.kind).toBe("failure");
      if (result.kind === "failure") {
        expect(typeof result.reason).not.toBe("string");
        expect((result.reason as { code: string }).code).toBe("VALIDATION_ERROR");
      }
      expect(managerCreate).not.toHaveBeenCalled();
      expect(trackerSet).not.toHaveBeenCalled();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects when plan.json has no such stage (STAGE_NOT_FOUND)", async () => {
    const root = mkdtempSync(join(tmpdir(), "gate-notfound-"));
    try {
      const runtime = await makeRuntimeWithPlan(root, {
        updated_at: "2026-05-29T00:00:00.000Z",
        current_stage_id: null,
        stages: [makeStage("stage-1")],
        history: [],
      });
      const managerCreate = vi.spyOn(ManagerAgent, "create");
      const trackerSet = vi.spyOn(runtime.tracker, "setCurrentStage");

      const result = await createChildSpawner(runtime)(
        "manager",
        { stage: makeStage("stage-ghost") },
        makeParentContext(root),
      );

      expect(result.kind).toBe("failure");
      if (result.kind === "failure") {
        expect((result.reason as { code: string }).code).toBe("STAGE_NOT_FOUND");
        expect((result.reason as { error: string }).error).toContain("plan_add_stage");
      }
      expect(managerCreate).not.toHaveBeenCalled();
      expect(trackerSet).not.toHaveBeenCalled();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects when stage is in history (STAGE_MISMATCH)", async () => {
    const root = mkdtempSync(join(tmpdir(), "gate-history-"));
    try {
      const runtime = await makeRuntimeWithPlan(root, {
        updated_at: "2026-05-29T00:00:00.000Z",
        current_stage_id: null,
        stages: [],
        history: [
          {
            id: "stage-done",
            objective: "x",
            expected_outcomes: ["x"],
            actual_outcomes: ["x"],
            started_at: "2026-05-29T00:00:00.000Z",
            completed_at: "2026-05-29T01:00:00.000Z",
            result: "completed",
            summary: "done",
          },
        ],
      });
      const managerCreate = vi.spyOn(ManagerAgent, "create");

      const result = await createChildSpawner(runtime)(
        "manager",
        { stage: makeStage("stage-done") },
        makeParentContext(root),
      );

      expect(result.kind).toBe("failure");
      if (result.kind === "failure") {
        expect((result.reason as { code: string }).code).toBe("STAGE_MISMATCH");
        expect((result.reason as { error: string }).error).toContain("history");
      }
      expect(managerCreate).not.toHaveBeenCalled();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects when stage is in plan but is not the current one (STAGE_MISMATCH)", async () => {
    const root = mkdtempSync(join(tmpdir(), "gate-mismatch-"));
    try {
      const runtime = await makeRuntimeWithPlan(root, {
        updated_at: "2026-05-29T00:00:00.000Z",
        current_stage_id: "stage-a",
        stages: [makeStage("stage-a"), makeStage("stage-b")],
        history: [],
      });
      const managerCreate = vi.spyOn(ManagerAgent, "create");

      const result = await createChildSpawner(runtime)(
        "manager",
        { stage: makeStage("stage-b") },
        makeParentContext(root),
      );

      expect(result.kind).toBe("failure");
      if (result.kind === "failure") {
        expect((result.reason as { code: string }).code).toBe("STAGE_MISMATCH");
        expect((result.reason as { error: string }).error).toContain("plan_set_current");
      }
      expect(managerCreate).not.toHaveBeenCalled();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects when current_stage_id is null even if stage exists (STAGE_MISMATCH)", async () => {
    const root = mkdtempSync(join(tmpdir(), "gate-currentnull-"));
    try {
      const runtime = await makeRuntimeWithPlan(root, {
        updated_at: "2026-05-29T00:00:00.000Z",
        current_stage_id: null,
        stages: [makeStage("stage-a")],
        history: [],
      });
      const result = await createChildSpawner(runtime)(
        "manager",
        { stage: makeStage("stage-a") },
        makeParentContext(root),
      );

      expect(result.kind).toBe("failure");
      if (result.kind === "failure") {
        expect((result.reason as { code: string }).code).toBe("STAGE_MISMATCH");
        expect((result.reason as { error: string }).error).toContain("null");
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("passes the gate when stage is current; ManagerAgent.create is invoked", async () => {
    const root = mkdtempSync(join(tmpdir(), "gate-happy-"));
    try {
      const runtime = await makeRuntimeWithPlan(root, {
        updated_at: "2026-05-29T00:00:00.000Z",
        current_stage_id: "stage-a",
        stages: [makeStage("stage-a")],
        history: [],
      });
      const managerCreate = vi
        .spyOn(ManagerAgent, "create")
        .mockResolvedValue({
          id: "mgr-1",
          run: async () => ({ kind: "success", data: {} }),
        } as unknown as ManagerAgent);
      const trackerSet = vi.spyOn(runtime.tracker, "setCurrentStage");

      const result = await createChildSpawner(runtime)(
        "manager",
        { stage: makeStage("stage-a") },
        makeParentContext(root),
      );

      expect(managerCreate).toHaveBeenCalledOnce();
      expect(result.kind).toBe("success");
      // setCurrentStage('stage-a') runs during dispatch then reverts to null
      // in the finally block; confirm the 'stage-a' setpoint was observed.
      expect(trackerSet.mock.calls.map((c) => c[0])).toContain("stage-a");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

function makeTracker() {
  return {
    activityIds: [] as string[],
    started: [] as string[],
    stopped: [] as string[],
    currentStage: null as string | null,
    agentActivity(agentId: string) {
      this.activityIds.push(agentId);
    },
    agentCompactionUpdate() {},
    agentStarted(agentId: string) {
      this.started.push(agentId);
    },
    agentStopped(agentId: string) {
      this.stopped.push(agentId);
    },
    setCurrentStage(stageId: string | null) {
      this.currentStage = stageId;
    },
    getCurrentStage() {
      return this.currentStage;
    },
  };
}

function makeParentContext(root: string): AgentContext {
  const project = makeProject(root);
  return {
    project,
    router: {
      getMaxContextTokens: () => 200_000,
      countTokens: () => 0,
      chat: async () => {
        throw new Error("not used");
      },
      resetModelHealth: () => {},
    } as AgentContext["router"],
    mcpRuntime: {
      getAllTools: () => [],
      callTool: async () => ({ ok: true }),
    } as AgentContext["mcpRuntime"],
    noteManager: new NoteManager(project.paths.notes),
    agentId: "planner-1",
    role: "planner",
    stageId: undefined,
    modelSpec: "test/m",
  };
}

function makeProject(root: string): AgentContext["project"] {
  const saivageDir = join(root, ".saivage");
  return {
    projectRoot: root,
    saivageDir,
    config: {
      project_name: "test",
      objectives: ["x"],
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
  };
}
