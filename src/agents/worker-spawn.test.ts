import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { createChildSpawner, type SaivageRuntime } from "../server/bootstrap.js";
import { WorkerAgent } from "./worker.js";
import { CoderAgent } from "./coder.js";
import { ReviewerAgent } from "./reviewer.js";
import type { AgentContext, WorkerInput } from "./types.js";
import type { Task } from "../types.js";
import type { BaseAgent } from "./base.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("createChildSpawner worker dispatch", () => {
  it("spawns a normal worker through WorkerAgent.createWorker", async () => {
    const root = mkdtempSync(join(tmpdir(), "saivage-worker-spawn-"));
    try {
      const runtime = makeRuntime(root);
      const runLoop = vi.spyOn(WorkerAgent.prototype as any, "runLoop").mockResolvedValue({
        text: JSON.stringify(makeTaskReport("coder")),
        finishReason: "end_turn",
      });

      const result = await createChildSpawner(runtime)(
        "coder",
        makeInput("coder", { type: undefined }),
        makeParentContext(root),
      );

      expect(result.kind).toBe("success");
      expect(runLoop).toHaveBeenCalledOnce();
      expect(runtime.agentRegistry.lastSet).toBeInstanceOf(CoderAgent);
      expect((runtime.agentRegistry.lastSet as any).input.task.type).toBe("code");
      expect(runtime.tracker.activityIds).toContain((runtime.agentRegistry.lastSet as BaseAgent).id);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("dispatches reviewer via review(), not run()", async () => {
    const root = mkdtempSync(join(tmpdir(), "saivage-worker-spawn-"));
    try {
      const runtime = makeRuntime(root);
      vi.spyOn(WorkerAgent.prototype as any, "runLoop").mockResolvedValue({
        text: JSON.stringify(makeTaskReport("reviewer")),
        finishReason: "end_turn",
      });
      const reviewSpy = vi.spyOn(ReviewerAgent.prototype, "review");
      const runSpy = vi.spyOn(ReviewerAgent.prototype, "run");

      const result = await createChildSpawner(runtime)(
        "reviewer",
        makeInput("reviewer"),
        makeParentContext(root),
      );

      expect(result.kind).toBe("success");
      expect(runtime.agentRegistry.lastSet).toBeInstanceOf(ReviewerAgent);
      expect(reviewSpy).toHaveBeenCalledOnce();
      expect(runSpy).not.toHaveBeenCalled();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reuses a reviewer for the same stage and injects the follow-up message", async () => {
    const root = mkdtempSync(join(tmpdir(), "saivage-worker-spawn-"));
    try {
      const runtime = makeRuntime(root);
      vi.spyOn(WorkerAgent.prototype as any, "runLoop").mockResolvedValue({
        text: JSON.stringify(makeTaskReport("reviewer")),
        finishReason: "end_turn",
      });
      const spawner = createChildSpawner(runtime);

      await spawner("reviewer", makeInput("reviewer", { id: "review-1" }), makeParentContext(root));
      const firstAgent = runtime.agentRegistry.lastSet as ReviewerAgent;
      await spawner("reviewer", makeInput("reviewer", { id: "review-2" }), makeParentContext(root));
      const secondAgent = runtime.agentRegistry.lastSet as ReviewerAgent;

      expect(secondAgent).toBe(firstAgent);
      expect((secondAgent as any).reviewCount).toBe(2);
      const snapshot = secondAgent.getConversationSnapshot();
      expect(snapshot.some((entry) => entry.content.includes("Follow-up Review 2"))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

class CapturingRegistry extends Map<string, BaseAgent> {
  lastSet: BaseAgent | undefined;

  override set(key: string, value: BaseAgent): this {
    this.lastSet = value;
    return super.set(key, value);
  }
}

function makeRuntime(root: string): SaivageRuntime & {
  agentRegistry: CapturingRegistry;
  tracker: ReturnType<typeof makeTracker>;
} {
  const agentRegistry = new CapturingRegistry();
  const tracker = makeTracker();
  const project = makeProject(root);
  return {
    config: {} as SaivageRuntime["config"],
    router: {
      getMaxContextTokens: () => 200_000,
      countTokens: () => 0,
      chat: async () => {
        throw new Error("runLoop is mocked in this test");
      },
      resetModelHealth: () => {},
    } as SaivageRuntime["router"],
    routing: {
      resolve: () => ({ modelSpec: "test/model", authProfile: undefined, accountRef: undefined }),
    } as unknown as SaivageRuntime["routing"],
    mcpRuntime: {
      getAllTools: () => [],
      callTool: async () => ({ ok: true }),
    } as SaivageRuntime["mcpRuntime"],
    eventBus: {
      publish: async () => {},
      clear: () => {},
    } as unknown as SaivageRuntime["eventBus"],
    planService: {} as SaivageRuntime["planService"],
    project,
    tracker,
    plannerControl: {} as SaivageRuntime["plannerControl"],
    plannerStartupDirectives: [],
    agentRegistry,
    supervisor: null,
    shutdown: async () => {},
  };
}

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
  return {
    project: makeProject(root),
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
    agentId: "manager-1",
    role: "manager",
    stageId: "stage-1",
    modelSpec: "test/model",
  };
}

function makeProject(root: string): AgentContext["project"] {
  const saivageDir = join(root, ".saivage");
  return {
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

function makeInput(
  role: WorkerInput["task"]["assigned_to"],
  opts: { id?: string; type?: Task["type"] } = {},
): WorkerInput {
  return {
    stageId: "stage-1",
    task: {
      id: opts.id ?? `${role}-task`,
      type: opts.type ?? (role === "reviewer" ? "review" : "code"),
      assigned_to: role,
      description: `Complete ${role} work`,
      checklist: [{ description: "done", required: true }],
      dependencies: [],
      status: "pending",
      tags: [],
      attempt: 1,
      max_attempts: 3,
    },
  };
}

function makeTaskReport(role: WorkerInput["task"]["assigned_to"]) {
  return {
    task_id: `${role}-task`,
    stage_id: "stage-1",
    agent: role,
    status: "completed",
    summary: "done",
    checklist_results: [],
    files_modified: [],
    files_created: [],
    tests_added: [],
    tests_run: [],
    commits: [],
    issues_found: [],
    started_at: new Date().toISOString(),
    completed_at: new Date().toISOString(),
    duration_ms: 1,
  };
}
