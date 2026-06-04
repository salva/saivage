import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { createChildSpawner, type SaivageRuntime } from "../server/bootstrap.js";
import { WorkerAgent } from "./worker.js";
import type { AgentContext, WorkerInput } from "./types.js";
import type { Task } from "../types.js";
import type { BaseAgent } from "./base.js";
import { NoteManager } from "../runtime/notes.js";
import type { RuntimeCancellationSignal } from "../runtime/lifecycle.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("createChildSpawner worker dispatch", () => {
  it("spawns a normal worker through WorkerAgent.createWorker", async () => {
    const root = mkdtempSync(join(tmpdir(), "saivage-worker-spawn-"));
    try {
      const runtime = makeRuntime(root);
      writeTaskReport(root, makeTaskReport("coder"));
      const runLoop = vi.spyOn(WorkerAgent.prototype as unknown as Record<string, () => unknown>, "runLoop").mockResolvedValue({
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
      expect(runtime.agentRegistry.lastSet?.role).toBe("coder");
      expect((runtime.agentRegistry.lastSet as unknown as { input: { task: { type: string } } }).input.task.type).toBe("code");
      expect(runtime.tracker.activityIds).toContain((runtime.agentRegistry.lastSet as BaseAgent).id);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("dispatches stage-scoped workers through WorkerAgent.run()", async () => {
    const root = mkdtempSync(join(tmpdir(), "saivage-worker-spawn-"));
    try {
      const runtime = makeRuntime(root);
      writeTaskReport(root, makeTaskReport("reviewer"));
      vi.spyOn(WorkerAgent.prototype as unknown as Record<string, () => unknown>, "runLoop").mockResolvedValue({
        text: JSON.stringify(makeTaskReport("reviewer")),
        finishReason: "end_turn",
      });
      const runSpy = vi.spyOn(WorkerAgent.prototype, "run");

      const result = await createChildSpawner(runtime)(
        "reviewer",
        makeInput("reviewer"),
        makeParentContext(root),
      );

      expect(result.kind).toBe("success");
      expect(runtime.agentRegistry.lastSet?.role).toBe("reviewer");
      expect(runSpy).toHaveBeenCalledOnce();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.each([
    { role: "reviewer" as const, banner: "Follow-up 2" },
    { role: "designer" as const, banner: "Follow-up 2" },
    { role: "critic" as const, banner: "Follow-up 2" },
  ])("reuses a $role for the same stage and injects the follow-up banner", async ({ role, banner }) => {
    const root = mkdtempSync(join(tmpdir(), "saivage-worker-spawn-"));
    try {
      const runtime = makeRuntime(root);
      writeTaskReport(root, makeTaskReport(role, `${role}-1`));
      writeTaskReport(root, makeTaskReport(role, `${role}-2`));
      vi.spyOn(WorkerAgent.prototype as unknown as Record<string, () => unknown>, "runLoop").mockResolvedValue({
        text: JSON.stringify(makeTaskReport(role)),
        finishReason: "end_turn",
      });
      const spawner = createChildSpawner(runtime);
      const runNextSpy = vi.spyOn(WorkerAgent.prototype, "runNext");

      await spawner(role, makeInput(role, { id: `${role}-1` }), makeParentContext(root));
      const firstAgent = runtime.agentRegistry.lastSet as WorkerAgent;
      await spawner(role, makeInput(role, { id: `${role}-2` }), makeParentContext(root));
      const secondAgent = runtime.agentRegistry.lastSet as WorkerAgent;

      expect(secondAgent).toBe(firstAgent);
      expect(runNextSpy).toHaveBeenCalledOnce();
      expect(runNextSpy).toHaveBeenCalledWith(expect.objectContaining({
        stageId: "stage-1",
        task: expect.objectContaining({ id: `${role}-2` }),
      }));
      expect((secondAgent as unknown as { turnCount: number }).turnCount).toBe(2);
      const snapshot = secondAgent.getConversationSnapshot();
      expect(snapshot.some((entry) => entry.content.includes(banner))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("evicts a stage-scoped worker after a failed follow-up", async () => {
    const root = mkdtempSync(join(tmpdir(), "saivage-worker-spawn-"));
    try {
      const runtime = makeRuntime(root);
      writeTaskReport(root, makeTaskReport("reviewer", "reviewer-1"));
      writeTaskReport(root, makeTaskReport("reviewer", "reviewer-3"));
      vi.spyOn(WorkerAgent.prototype as unknown as Record<string, () => unknown>, "runLoop")
        .mockResolvedValueOnce({
          text: JSON.stringify(makeTaskReport("reviewer", "reviewer-1")),
          finishReason: "end_turn",
        })
        .mockResolvedValueOnce({ text: "reviewer failed", finishReason: "error" })
        .mockResolvedValueOnce({
          text: JSON.stringify(makeTaskReport("reviewer", "reviewer-3")),
          finishReason: "end_turn",
        });
      const spawner = createChildSpawner(runtime);

      const first = await spawner("reviewer", makeInput("reviewer", { id: "reviewer-1" }), makeParentContext(root));
      const firstAgent = runtime.agentRegistry.lastSet as WorkerAgent;
      const failed = await spawner("reviewer", makeInput("reviewer", { id: "reviewer-2" }), makeParentContext(root));
      const failedAgent = runtime.agentRegistry.lastSet as WorkerAgent;
      const third = await spawner("reviewer", makeInput("reviewer", { id: "reviewer-3" }), makeParentContext(root));
      const thirdAgent = runtime.agentRegistry.lastSet as WorkerAgent;

      expect(first.kind).toBe("success");
      expect(failed.kind).toBe("failure");
      expect(third.kind).toBe("success");
      expect(failedAgent).toBe(firstAgent);
      expect(thirdAgent).not.toBe(firstAgent);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("cancels child agents through the lifecycle signal", async () => {
    const root = mkdtempSync(join(tmpdir(), "saivage-worker-spawn-"));
    try {
      const runtime = makeRuntime(root);
      const signal = makeSignal();
      runtime.lifecycle = { signal } as SaivageRuntime["lifecycle"];
      let capturedAbortSignal: { aborted: boolean } | undefined;
      const cancel = vi.fn();
      vi.spyOn(WorkerAgent, "createWorker").mockImplementation(async (_ctx, _input, _role, config) => {
        capturedAbortSignal = config?.abortSignal;
        return {
          id: "worker-1",
          role: "coder",
          run: async () => {
            signal.abort();
            return { kind: "abort", reason: "shutdown" };
          },
          cancel,
        } as unknown as WorkerAgent;
      });

      const result = await createChildSpawner(runtime)(
        "coder",
        makeInput("coder"),
        makeParentContext(root),
      );

      expect(result.kind).toBe("abort");
      expect(capturedAbortSignal?.aborted).toBe(true);
      expect(cancel).toHaveBeenCalledOnce();
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
    noteManager: new NoteManager(project.paths.notes),
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
  const defaultType: Record<string, Task["type"]> = {
    coder: "code",
    researcher: "research",
    data_agent: "data",
    reviewer: "review",
    designer: "design",
    critic: "critique",
  };
  return {
    stageId: "stage-1",
    task: {
      id: opts.id ?? `${role}-task`,
      type: opts.type ?? defaultType[role] ?? "code",
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

function makeTaskReport(role: WorkerInput["task"]["assigned_to"], taskId = `${role}-task`) {
  return {
    task_id: taskId,
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

function makeSignal(): RuntimeCancellationSignal & { abort: () => void } {
  let aborted = false;
  const listeners = new Set<() => void>();
  return {
    get aborted() {
      return aborted;
    },
    onAbort(listener: () => void) {
      if (aborted) {
        listener();
        return () => {};
      }
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    abort() {
      if (aborted) return;
      aborted = true;
      for (const listener of listeners) listener();
    },
  };
}

function writeTaskReport(root: string, report: ReturnType<typeof makeTaskReport>): void {
  const dir = join(root, ".saivage", "stages", report.stage_id, "reports");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${report.task_id}.json`), JSON.stringify(report), "utf-8");
}
