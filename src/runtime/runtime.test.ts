/**
 * Tests for Phase 2: Runtime Core
 * Plan MCP service, crash recovery, notes, compaction, dispatcher.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  mkdtempSync,
  rmSync,
  existsSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { PLAN_READER_TOOLS, PLAN_WRITER_TOOLS, PlanService } from "../mcp/plan-server.js";
import { NoteService } from "../mcp/notes-server.js";
import { NoteManager, NoteChannel } from "./notes.js";
import { writeDoc, readDoc, ensureDir } from "../store/documents.js";
import {
  PlanDocumentSchema,
  UserNoteSchema,
  TaskListSchema,
  RuntimeStateSchema,
  StageSummarySchema,
  type UserNote,
} from "../types.js";
import {
  shouldCompact,
  isMaxCompactionsReached,
} from "./compaction.js";
import {
  createAbortSignal,
  triggerAbort,
  scanForUrgentNotes,
} from "./abort.js";
import {
  isAnotherInstanceRunning,
  recoverFromCrash,
  writeRuntimeState,
  RuntimeTracker,
} from "./recovery.js";
import type { ProjectContext } from "../store/project.js";
import { RuntimeSupervisor } from "./supervisor.js";
import { log } from "../log.js";
import type { SaivageConfig } from "../config.js";
import { waitForRecoveryDelay } from "../server/bootstrap.js";
import type { SupervisorRuntimeContext } from "./supervisor.js";
import type { ChatRequest } from "../providers/types.js";

type FakeAgent = { role: string; cancel: () => void };
type PlanLike = {
  stages: Array<{ id?: string; started_at?: string; [key: string]: unknown }>;
  current_stage_id?: string | null;
  source?: string;
  code?: string;
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "saivage-test-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function makeProjectContext(root: string): ProjectContext {
  const saivageDir = join(root, ".saivage");
  return {
    projectRoot: root,
    saivageDir,
    config: {
      project_name: "test",
      objectives: [],
      provider: "test",
      notifications: {
        channels: [],
        filters: { min_severity: "info", categories: [] },
      },
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

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

// ─── Runtime Supervisor ────────────────────────────────────────────────────

describe("RuntimeSupervisor", () => {
  it("uses a no-tool log-only model request and does not cancel before threshold", async () => {
    log.warn("supervisor test synthetic retry loop warning");
    const requests: Array<ChatRequest & { modelSpec: string }> = [];
    const router = {
      chat: vi.fn(async (request: ChatRequest & { modelSpec: string }) => {
        requests.push(request);
        return {
          content: JSON.stringify({ stuck: true, confidence: 0.9, reason: "retry loop", evidence: ["warning"] }),
          toolCalls: [],
          finishReason: "end_turn",
          usage: { inputTokens: 1, outputTokens: 1 },
        };
      }),
    };
    const cancel = vi.fn();
    const agentRegistry = new Map<string, FakeAgent>([
      ["coder-1", { role: "coder", cancel }],
    ]);
    const supervisor = new RuntimeSupervisor(makeSupervisorConfig(), { router, agentRegistry } as unknown as SupervisorRuntimeContext, "github-copilot/gpt-5.4");

    await supervisor.checkOnce();
    await supervisor.checkOnce();

    expect(cancel).not.toHaveBeenCalled();
    expect(router.chat).toHaveBeenCalledTimes(2);
    expect(requests[0].modelSpec).toBe("github-copilot/gpt-5.4");
    expect(requests[0].tools).toBeUndefined();
    expect(requests[0].messages[0].content).toContain("Recent Saivage logs");
    expect(requests[0].messages[0].content).toContain("supervisor test synthetic retry loop warning");
    expect(requests[0].messages[0].content).not.toContain("Runtime summary");
  });

  it("cancels the lowest-level running agent after three stuck verdicts", async () => {
    const router = {
      chat: vi.fn(async () => ({
        content: JSON.stringify({ stuck: true, confidence: 0.95, reason: "persistent retry loop", evidence: [] }),
        toolCalls: [],
        finishReason: "end_turn",
        usage: { inputTokens: 1, outputTokens: 1 },
      })),
    };
    const managerCancel = vi.fn();
    const coderCancel = vi.fn();
    const agentRegistry = new Map<string, FakeAgent>([
      ["manager-1", { role: "manager", cancel: managerCancel }],
      ["coder-1", { role: "coder", cancel: coderCancel }],
    ]);
    const supervisor = new RuntimeSupervisor(makeSupervisorConfig(), { router, agentRegistry } as unknown as SupervisorRuntimeContext, "github-copilot/gpt-5.4");

    await supervisor.checkOnce();
    await supervisor.checkOnce();
    await supervisor.checkOnce();

    expect(coderCancel).toHaveBeenCalledTimes(1);
    expect(managerCancel).not.toHaveBeenCalled();
  });

  it("resets the stuck counter on a not-stuck verdict", async () => {
    const verdicts = [true, true, false, true];
    const router = {
      chat: vi.fn(async () => ({
        content: JSON.stringify({ stuck: verdicts.shift() ?? true, confidence: 0.9, reason: "verdict", evidence: [] }),
        toolCalls: [],
        finishReason: "end_turn",
        usage: { inputTokens: 1, outputTokens: 1 },
      })),
    };
    const cancel = vi.fn();
    const agentRegistry = new Map<string, FakeAgent>([
      ["coder-1", { role: "coder", cancel }],
    ]);
    const supervisor = new RuntimeSupervisor(makeSupervisorConfig(), { router, agentRegistry } as unknown as SupervisorRuntimeContext, "github-copilot/gpt-5.4");

    await supervisor.checkOnce();
    await supervisor.checkOnce();
    await supervisor.checkOnce();
    await supervisor.checkOnce();

    expect(cancel).not.toHaveBeenCalled();
  });

  it("does not cancel agents when the LLM verdict is stuck=false for provider throttling", async () => {
    log.warn("Provider \"github-copilot\" rate-limited, trying next");
    const router = {
      chat: vi.fn(async () => ({
        content: JSON.stringify({
          stuck: false,
          confidence: 0.9,
          reason: "Only clear issue is provider throttling; Saivage should wait and retry",
          evidence: ["429 rate limit"],
        }),
        toolCalls: [],
        finishReason: "end_turn",
        usage: { inputTokens: 1, outputTokens: 1 },
      })),
    };
    const cancel = vi.fn();
    const agentRegistry = new Map<string, FakeAgent>([
      ["coder-1", { role: "coder", cancel }],
    ]);
    const supervisor = new RuntimeSupervisor(makeSupervisorConfig(), { router, agentRegistry } as unknown as SupervisorRuntimeContext, "github-copilot/gpt-5.4");

    await supervisor.checkOnce();
    await supervisor.checkOnce();
    await supervisor.checkOnce();

    expect(cancel).not.toHaveBeenCalled();
  });

  it("does not cancel agents when the LLM verdict is stuck=false for long-running external work", async () => {
    log.info("shell run_command external process still running for training experiment");
    const router = {
      chat: vi.fn(async () => ({
        content: JSON.stringify({
          stuck: false,
          confidence: 0.9,
          reason: "Only clear issue is a long-running training job; long-running work is not itself stuck",
          evidence: ["external process in progress"],
        }),
        toolCalls: [],
        finishReason: "end_turn",
        usage: { inputTokens: 1, outputTokens: 1 },
      })),
    };
    const cancel = vi.fn();
    const agentRegistry = new Map<string, FakeAgent>([
      ["coder-1", { role: "coder", cancel }],
    ]);
    const supervisor = new RuntimeSupervisor(makeSupervisorConfig(), { router, agentRegistry } as unknown as SupervisorRuntimeContext, "github-copilot/gpt-5.4");

    await supervisor.checkOnce();
    await supervisor.checkOnce();
    await supervisor.checkOnce();

    expect(cancel).not.toHaveBeenCalled();
  });

  it("aborts roles in roster priority order and never aborts non-abortable roles", async () => {
    const order = ["reviewer", "critic", "data_agent", "coder", "researcher", "designer", "manager"] as const;
    const cancels = Object.fromEntries(order.map((r) => [r, vi.fn()]));
    const agentRegistry = new Map<string, FakeAgent>(
      order.map((role) => [`${role}-1`, { role, cancel: cancels[role] }]),
    );
    const nonAbortable = ["planner", "inspector", "chat"] as const;
    const nonAbortableCancels = Object.fromEntries(nonAbortable.map((r) => [r, vi.fn()]));
    for (const role of nonAbortable) {
      agentRegistry.set(`${role}-1`, { role, cancel: nonAbortableCancels[role] });
    }
    const router = {
      chat: vi.fn(async () => ({
        content: JSON.stringify({ stuck: true, confidence: 0.95, reason: "persistent retry loop", evidence: [] }),
        toolCalls: [],
        finishReason: "end_turn",
        usage: { inputTokens: 1, outputTokens: 1 },
      })),
    };
    const supervisor = new RuntimeSupervisor(makeSupervisorConfig(), { router, agentRegistry } as unknown as SupervisorRuntimeContext, "github-copilot/gpt-5.4");

    for (const role of order) {
      cancels[role].mockClear();
      await supervisor.checkOnce();
      await supervisor.checkOnce();
      await supervisor.checkOnce();
      expect(cancels[role]).toHaveBeenCalledTimes(1);
      agentRegistry.delete(`${role}-1`);
    }

    for (const role of nonAbortable) {
      expect(nonAbortableCancels[role]).not.toHaveBeenCalled();
    }

    // Three more rounds with only non-abortable agents present: nothing is cancelled.
    await supervisor.checkOnce();
    await supervisor.checkOnce();
    await supervisor.checkOnce();
    for (const role of nonAbortable) {
      expect(nonAbortableCancels[role]).not.toHaveBeenCalled();
    }
  });

  it("never aborts chat or planner because both are non-abortable in the roster", async () => {
    const planner = { role: "planner", cancel: vi.fn() };
    const chat = { role: "chat", cancel: vi.fn() };
    const agentRegistry = new Map<string, FakeAgent>();
    agentRegistry.set("chat-1", chat);
    agentRegistry.set("planner-1", planner);

    const router = {
      chat: vi.fn(async () => ({
        content: JSON.stringify({ stuck: true, confidence: 0.95, reason: "...", evidence: [] }),
        toolCalls: [],
        finishReason: "end_turn",
        usage: { inputTokens: 1, outputTokens: 1 },
      })),
    };
    const supervisor = new RuntimeSupervisor(makeSupervisorConfig(), { router, agentRegistry } as unknown as SupervisorRuntimeContext, "github-copilot/gpt-5.4");

    for (let i = 0; i < 9; i++) {
      await supervisor.checkOnce();
    }
    expect(chat.cancel).not.toHaveBeenCalled();
    expect(planner.cancel).not.toHaveBeenCalled();
  });
});
function makeSupervisorConfig(overrides: Partial<SaivageConfig["supervisor"]> = {}): SaivageConfig {
  return {
    models: {},
    modelEquivalents: {},
    providers: {},
    failover: {},
    server: { port: 8080, host: "0.0.0.0" },
    agent: { maxConcurrentAgents: 3 },
    runtime: {
      maxServices: 50,
      restartOnCrash: true,
      continuousImprovement: true,
      healthCheckIntervalMs: 30_000,
      idleShutdownMs: 300_000,
    },
    security: {
      envScrubber: {
        credentialLexemes: ["API_KEY"],
        configPointerSuffixes: [],
      },
    },
    supervisor: {
      enabled: true,
      model: "github-copilot/gpt-5.4",
      intervalMs: 20 * 60 * 1000,
      consecutiveStuckVerdicts: 3,
      logLines: 400,
      ...overrides,
    },
    telegram: { botToken: "", allowedUserIds: [] },
    notifications: { channels: [], filters: { min_severity: "info", categories: [] } },
    mcpServers: {},
  };
}

// ─── Plan MCP Service ────────────────────────────────────────────────────────

describe("PlanService", () => {
  let planService: PlanService;
  let saivageDir: string;

  beforeEach(async () => {
    saivageDir = join(tmpDir, ".saivage");
    await ensureDir(saivageDir);
    planService = new PlanService(saivageDir);
    await planService.init();
  });

  it("plan_init creates a new plan", async () => {
    const result = await planService.plan_init([
      {
        id: "stg-1",
        objective: "Setup project",
        starting_points: ["bare repo"],
        expected_outcomes: ["project structure"],
        acceptance_criteria: ["npm test passes"],
        references: [],
        tags: ["init"],
      },
    ]);
    expect(result).not.toHaveProperty("code");
    expect((result as PlanLike).stages).toHaveLength(1);
  });

  it("plan_init rejects if plan already exists", async () => {
    await planService.plan_init([]);
    const result = await planService.plan_init([]);
    expect(result).toHaveProperty("code", "STAGE_EXISTS");
  });

  it("plan_get returns the plan", async () => {
    await planService.plan_init([
      {
        id: "stg-1",
        objective: "Test",
        starting_points: [],
        expected_outcomes: ["done"],
        acceptance_criteria: ["pass"],
        references: [],
        tags: [],
      },
    ]);
    const plan = await planService.plan_get();
    expect(plan).not.toHaveProperty("code");
    expect((plan as PlanLike).stages).toHaveLength(1);
  });

  it("plan_get returns error when not initialized", async () => {
    const result = await planService.plan_get();
    expect(result).toHaveProperty("code", "PLAN_NOT_FOUND");
  });

  it("plan_set_current sets current stage", async () => {
    const startedAt = new Date("2026-01-01T00:00:00.000Z");
    vi.useFakeTimers();
    vi.setSystemTime(startedAt);

    await planService.plan_init([
      {
        id: "stg-1",
        objective: "Test",
        starting_points: [],
        expected_outcomes: ["done"],
        acceptance_criteria: ["pass"],
        references: [],
        tags: [],
      },
    ]);
    try {
      const result = await planService.plan_set_current("stg-1");
      expect(result).not.toHaveProperty("code");
      expect((result as PlanLike).current_stage_id).toBe("stg-1");
      expect((result as PlanLike).stages[0].started_at).toBe(startedAt.toISOString());

      vi.setSystemTime(new Date("2026-01-01T01:00:00.000Z"));
      const second = await planService.plan_set_current("stg-1");
      expect((second as PlanLike).stages[0].started_at).toBe(startedAt.toISOString());
    } finally {
      vi.useRealTimers();
    }
  });

  it("plan_set_current rejects missing stage", async () => {
    await planService.plan_init([]);
    const result = await planService.plan_set_current("stg-999");
    expect(result).toHaveProperty("code", "STAGE_NOT_FOUND");
  });

  it("plan_add_stage appends a stage", async () => {
    await planService.plan_init([]);
    const result = await planService.plan_add_stage({
      id: "stg-new",
      objective: "New stage",
      starting_points: [],
      expected_outcomes: ["something"],
      acceptance_criteria: ["test"],
      references: [],
      tags: [],
    });
    expect(result).not.toHaveProperty("code");
    expect((result as PlanLike).stages).toHaveLength(1);
  });

  it("plan_add_stage rejects duplicate ID", async () => {
    await planService.plan_init([
      {
        id: "stg-1",
        objective: "Test",
        starting_points: [],
        expected_outcomes: ["done"],
        acceptance_criteria: ["pass"],
        references: [],
        tags: [],
      },
    ]);
    const result = await planService.plan_add_stage({
      id: "stg-1",
      objective: "Dupe",
      starting_points: [],
      expected_outcomes: ["x"],
      acceptance_criteria: ["y"],
      references: [],
      tags: [],
    });
    expect(result).toHaveProperty("code", "STAGE_EXISTS");
  });

  it("plan_remove_stage removes a stage", async () => {
    await planService.plan_init([
      {
        id: "stg-1",
        objective: "Test",
        starting_points: [],
        expected_outcomes: ["done"],
        acceptance_criteria: ["pass"],
        references: [],
        tags: [],
      },
    ]);
    const result = await planService.plan_remove_stage("stg-1");
    expect(result).not.toHaveProperty("code");
    expect((result as PlanLike).stages).toHaveLength(0);
  });

  it("plan_complete_stage moves to history", async () => {
    const startedAt = new Date("2026-01-01T00:00:00.000Z");
    const completedAt = new Date("2026-01-01T00:05:00.000Z");
    vi.useFakeTimers();
    vi.setSystemTime(startedAt);

    await planService.plan_init([
      {
        id: "stg-1",
        objective: "Test",
        starting_points: [],
        expected_outcomes: ["done"],
        acceptance_criteria: ["pass"],
        references: [],
        tags: [],
      },
    ]);
    try {
      await planService.plan_set_current("stg-1");
      vi.setSystemTime(completedAt);

      const result = await planService.plan_complete_stage({
        stage_id: "stg-1",
        result: "completed",
        summary: "All done",
        actual_outcomes: ["done"],
      });

      expect(result).not.toHaveProperty("code");
      const res = result as { completed_stage: { id: string; started_at: string; completed_at: string }; plan: PlanLike };
      expect(res.completed_stage.id).toBe("stg-1");
      expect(res.completed_stage.started_at).toBe(startedAt.toISOString());
      expect(res.completed_stage.completed_at).toBe(completedAt.toISOString());
      expect(res.plan.stages).toHaveLength(0);
      expect(res.plan.current_stage_id).toBeNull();

      const history = await planService.plan_get_history();
      expect((history as PlanLike).stages).toHaveLength(1);
      expect((history as PlanLike).stages[0].started_at).toBe(startedAt.toISOString());
    } finally {
      vi.useRealTimers();
    }
  });

  it("plan_complete_stage rejects stages that were never marked current", async () => {
    await planService.plan_init([
      {
        id: "stg-1",
        objective: "Test",
        starting_points: [],
        expected_outcomes: ["done"],
        acceptance_criteria: ["pass"],
        references: [],
        tags: [],
      },
    ]);

    const result = await planService.plan_complete_stage({
      stage_id: "stg-1",
      result: "completed",
      summary: "All done",
      actual_outcomes: ["done"],
    });

    expect(result).toHaveProperty("code", "VALIDATION_ERROR");
  });

  it("plan_set_stages replaces all stages", async () => {
    const firstStart = new Date("2026-01-01T00:00:00.000Z");
    const secondStart = new Date("2026-01-01T01:00:00.000Z");
    vi.useFakeTimers();
    vi.setSystemTime(firstStart);
    await planService.plan_init([]);
    try {
      await planService.plan_set_stages(
        [
          {
            id: "stg-a",
            objective: "A",
            starting_points: [],
            expected_outcomes: ["a"],
            acceptance_criteria: ["a"],
            references: [],
            tags: [],
          },
        ],
        "stg-a",
      );

      vi.setSystemTime(secondStart);
      const result = await planService.plan_set_stages(
        [
          {
            id: "stg-a",
            objective: "A revised",
            starting_points: [],
            expected_outcomes: ["a"],
            acceptance_criteria: ["a"],
            references: [],
            tags: [],
          },
          {
            id: "stg-b",
            objective: "B",
            starting_points: [],
            expected_outcomes: ["b"],
            acceptance_criteria: ["b"],
            references: [],
            tags: [],
          },
        ],
        "stg-b",
      );
      expect(result).not.toHaveProperty("code");
      expect((result as PlanLike).stages).toHaveLength(2);
      expect((result as PlanLike).current_stage_id).toBe("stg-b");
      expect((result as PlanLike).stages.find((s: { id: string }) => s.id === "stg-a").started_at).toBe(firstStart.toISOString());
      expect((result as PlanLike).stages.find((s: { id: string }) => s.id === "stg-b").started_at).toBe(secondStart.toISOString());
    } finally {
      vi.useRealTimers();
    }
  });

  it("plan_get_stage finds from active and history", async () => {
    await planService.plan_init([
      {
        id: "stg-1",
        objective: "Active",
        starting_points: [],
        expected_outcomes: ["x"],
        acceptance_criteria: ["y"],
        references: [],
        tags: [],
      },
    ]);

    const active = await planService.plan_get_stage("stg-1");
    expect((active as PlanLike).source).toBe("active");

    await planService.plan_set_current("stg-1");
    await planService.plan_complete_stage({
      stage_id: "stg-1",
      result: "completed",
      summary: "Done",
      actual_outcomes: ["x"],
    });

    const fromHistory = await planService.plan_get_stage("stg-1");
    expect((fromHistory as PlanLike).source).toBe("history");
  });

  it("handleToolCall routes correctly", async () => {
    await planService.plan_init([]);
    const result = await planService.handleToolCall("plan_get", {});
    expect(result.isError).toBe(false);
    expect((result.content as PlanLike).stages).toEqual([]);
  });

  it("plan_done with a valid reason returns ok", async () => {
    const result = await planService.plan_done({ reason: "objectives verified" });
    expect(result).toEqual({ ok: true });
  });

  it("plan_done rejects an empty reason", async () => {
    const result = await planService.plan_done({ reason: "  " });
    expect(result).toHaveProperty("code", "VALIDATION_ERROR");
  });

  it("handleToolCall rejects an empty plan_done reason", async () => {
    const result = await planService.handleToolCall("plan_done", { reason: "" });
    expect(result.isError).toBe(true);
    expect(result.content).toHaveProperty("code", "VALIDATION_ERROR");
  });

  it("handleToolCall plan_done with a valid reason returns ok and is not an error", async () => {
    const result = await planService.handleToolCall("plan_done", { reason: "all objectives verified" });
    expect(result.isError).toBe(false);
    expect(result.content).toEqual({ ok: true });
  });

  it("plan_init persists a single plan document with embedded history", async () => {
    await planService.plan_init([]);

    const persisted = await readDoc(join(saivageDir, "plan.json"), PlanDocumentSchema);
    expect(persisted.history).toEqual([]);
    const legacyHistoryPath = join(saivageDir, "plan-" + "history.json");
    expect(existsSync(legacyHistoryPath)).toBe(false);
  });

  it("active-plan mutators preserve embedded history", async () => {
    await planService.plan_init([
      {
        id: "stg-done",
        objective: "Done",
        starting_points: [],
        expected_outcomes: ["done"],
        acceptance_criteria: ["done"],
        references: [],
        tags: [],
      },
    ]);
    await planService.plan_set_current("stg-done");
    await planService.plan_complete_stage({
      stage_id: "stg-done",
      result: "completed",
      summary: "Done",
      actual_outcomes: ["done"],
    });

    await planService.plan_add_stage({
      id: "stg-next",
      objective: "Next",
      starting_points: [],
      expected_outcomes: ["next"],
      acceptance_criteria: ["next"],
      references: [],
      tags: [],
    });
    await planService.plan_set_current("stg-next");
    await planService.plan_set_stages([
      {
        id: "stg-next",
        objective: "Next revised",
        starting_points: [],
        expected_outcomes: ["next"],
        acceptance_criteria: ["next"],
        references: [],
        tags: [],
      },
    ], "stg-next");

    const history = await planService.plan_get_history();
    expect((history as PlanLike).stages.map((stage: { id: string }) => stage.id)).toEqual(["stg-done"]);
  });

  it("plan_commit commits only the single plan document", async () => {
    await planService.plan_init([]);
    let committedFiles: string[] | null = null;
    planService.setGitCommit(async (files) => {
      committedFiles = files;
      return { sha: "abc123" };
    });

    const result = await planService.plan_commit("commit plan");

    expect(result).toEqual({ sha: "abc123" });
    expect(committedFiles).toEqual([join(saivageDir, "plan.json")]);
  });

  it("serializes mutating tool calls across async boundaries", async () => {
    await planService.plan_init([]);
    const commitGate = deferred<{ sha: string }>();
    planService.setGitCommit(async () => commitGate.promise);

    const commit = planService.handleToolCall("plan_commit", { message: "commit first" });
    let addSettled = false;
    const add = planService.handleToolCall("plan_add_stage", {
      stage: {
        id: "stg-after-commit",
        objective: "After commit",
        starting_points: [],
        expected_outcomes: ["done"],
        acceptance_criteria: ["done"],
        references: [],
        tags: [],
      },
    }).then((result) => {
      addSettled = true;
      return result;
    });

    await Promise.resolve();
    expect(addSettled).toBe(false);

    commitGate.resolve({ sha: "abc123" });
    await expect(commit).resolves.toMatchObject({ isError: false });
    const addResult = await add;

    expect(addResult.isError).toBe(false);
    expect((await planService.plan_get() as PlanLike).stages.map((s: { id: string }) => s.id)).toEqual(["stg-after-commit"]);
  });

  // ─── F34: in-memory cache ──────────────────────────────────────────────

  it("F34: read-after-write — plan_set_stages then plan_get returns the new plan", async () => {
    await planService.plan_init();
    const stages = [
      {
        id: "stg-a",
        objective: "do a",
        starting_points: ["x"],
        expected_outcomes: ["y"],
        acceptance_criteria: ["z"],
        references: [],
        tags: [],
      },
    ];
    await planService.plan_set_stages(stages, "stg-a");
    const out = (await planService.plan_get()) as PlanLike;
    expect(out.current_stage_id).toBe("stg-a");
    expect(out.stages.map((s: { id: string }) => s.id)).toEqual(["stg-a"]);
  });

  it("F34: plan_get returns a clone — mutating it does not affect cache", async () => {
    await planService.plan_init([
      {
        id: "stg-a",
        objective: "do a",
        starting_points: ["x"],
        expected_outcomes: ["y"],
        acceptance_criteria: ["z"],
        references: [],
        tags: [],
      },
    ]);
    const first = (await planService.plan_get()) as PlanLike;
    first.stages.push({ id: "stg-injected" });
    first.current_stage_id = "stg-injected";
    const second = (await planService.plan_get()) as PlanLike;
    expect(second.stages.map((s: { id: string }) => s.id)).toEqual(["stg-a"]);
    expect(second.current_stage_id).toBe(null);
  });

  it("G29: reader tools bypass a slow writer in handleToolCall", async () => {
    await planService.plan_init();
    const commitGate = deferred<{ sha: string }>();
    planService.setGitCommit(async () => commitGate.promise);

    const commit = planService.handleToolCall("plan_commit", { message: "slow commit" });
    let commitSettled = false;
    commit.then(() => {
      commitSettled = true;
    });

    const get = await planService.handleToolCall("plan_get", {});
    expect(get.isError).toBe(false);
    expect((get.content as PlanLike).stages).toEqual([]);

    await Promise.resolve();
    expect(commitSettled).toBe(false);

    commitGate.resolve({ sha: "abc123" });
    await expect(commit).resolves.toMatchObject({ isError: false });
  });

  it("G29: plan tool partition matches the registered tool schemas", () => {
    const writers = new Set(PLAN_WRITER_TOOLS);
    const readers = new Set(PLAN_READER_TOOLS);
    const intersection = [...writers].filter((name) => readers.has(name));
    const classified = new Set([...writers, ...readers]);
    const registered = new Set(PlanService.getToolSchemas().map((tool) => tool.name));

    expect(intersection).toEqual([]);
    expect(classified).toEqual(registered);
  });

  it("F34: plan_init rejects when cache is already populated (no disk check)", async () => {
    const first = await planService.plan_init();
    expect((first as PlanLike).code).toBeUndefined();
    const second = await planService.plan_init();
    expect((second as PlanLike).code).toBe("STAGE_EXISTS");
  });
});

// ─── Note Lifecycle ──────────────────────────────────────────────────────────

describe("NoteManager", () => {
  let notesDir: string;
  let noteManager: NoteManager;

  beforeEach(async () => {
    notesDir = join(tmpDir, "notes");
    await ensureDir(notesDir);
    noteManager = new NoteManager(notesDir);
  });

  async function writeNote(note: UserNote) {
    await writeDoc(join(notesDir, `${note.id}.json`), note, UserNoteSchema);
  }

  it("pullDeliverables returns unacknowledged + permanent notes once until reset", async () => {
    await writeNote({
      id: "note-1",
      channel: "test",
      session_id: "s1",
      content: "hello",
      created_at: new Date().toISOString(),
      permanent: false,
      urgent: false,
    });
    await writeNote({
      id: "note-2",
      channel: "test",
      session_id: "s1",
      content: "acknowledged",
      created_at: new Date().toISOString(),
      permanent: false,
      urgent: false,
      acknowledged_at: new Date().toISOString(),
    });

    const notes = await noteManager.pullDeliverables();
    expect(notes).toHaveLength(1);
    expect(notes[0].id).toBe("note-1");
  });

  it("does not inject Planner-authored self notes", async () => {
    await writeNote({
      id: "note-planner-self",
      channel: "planner",
      session_id: "s1",
      content: "Stay blocked forever",
      created_at: new Date().toISOString(),
      permanent: true,
      urgent: true,
    });

    expect(await noteManager.pullDeliverables()).toHaveLength(0);
  });

  it("acknowledgeNotes sets acknowledged_at and deletes volatile", async () => {
    await writeNote({
      id: "note-1",
      channel: "test",
      session_id: "s1",
      content: "volatile",
      created_at: new Date().toISOString(),
      permanent: false,
      urgent: false,
    });
    await writeNote({
      id: "note-2",
      channel: "test",
      session_id: "s1",
      content: "permanent",
      created_at: new Date().toISOString(),
      permanent: true,
      urgent: false,
    });

    await noteManager.pullDeliverables(); // marks delivered
    await noteManager.acknowledgeNotes();

    // Volatile note should be deleted
    expect(existsSync(join(notesDir, "note-1.json"))).toBe(false);

    // Permanent note should still exist with acknowledged_at
    const remaining = await readDoc(
      join(notesDir, "note-2.json"),
      UserNoteSchema,
    );
    expect(remaining.acknowledged_at).toBeDefined();
  });

  it("pullDeliverables marks each note delivered until resetDelivered", async () => {
    await writeNote({
      id: "note-1",
      channel: "test",
      session_id: "s1",
      content: "volatile",
      created_at: new Date().toISOString(),
      permanent: false,
      urgent: false,
    });
    await writeNote({
      id: "note-2",
      channel: "test",
      session_id: "s1",
      content: "permanent",
      created_at: new Date().toISOString(),
      permanent: true,
      urgent: false,
    });

    expect(await noteManager.pullDeliverables()).toHaveLength(2);
    expect(await noteManager.pullDeliverables()).toHaveLength(0);

    noteManager.resetDelivered();
    const after = await noteManager.pullDeliverables();
    // volatile + permanent both eligible again
    expect(after).toHaveLength(2);
  });

  it("formatNotesForInjection formats correctly", () => {
    const notes: UserNote[] = [
      {
        id: "note-1",
        channel: "telegram",
        session_id: "s1",
        content: "Focus on tests",
        created_at: "2024-01-01T00:00:00Z",
        permanent: false,
        urgent: true,
      },
    ];

    const formatted = noteManager.formatNotesForInjection(notes);
    expect(formatted).toContain("ordered oldest to newest");
    expect(formatted).toContain("[URGENT]");
    expect(formatted).toContain("Focus on tests");
  });

  it("formatNotesForInjection places newer conflicting notes later", () => {
    const formatted = noteManager.formatNotesForInjection([
      {
        id: "new-note",
        channel: "telegram",
        session_id: "s1",
        content: "New specific docs request",
        created_at: "2026-05-02T11:00:00Z",
        permanent: true,
        urgent: true,
      },
      {
        id: "old-note",
        channel: "telegram",
        session_id: "s1",
        content: "Old broad research policy",
        created_at: "2026-05-01T11:00:00Z",
        permanent: true,
        urgent: false,
      },
    ]);

    expect(formatted.indexOf("Old broad research policy")).toBeLessThan(
      formatted.indexOf("New specific docs request"),
    );
    expect(formatted).toContain("newer and more specific user notes as overriding older, broader notes");
  });

  it("cleanupStaleNotes removes acknowledged volatile notes", async () => {
    await writeNote({
      id: "note-stale",
      channel: "test",
      session_id: "s1",
      content: "stale",
      created_at: new Date().toISOString(),
      permanent: false,
      urgent: false,
      acknowledged_at: new Date().toISOString(),
    });

    const cleaned = await noteManager.cleanupStaleNotes(2 * 60 * 60 * 1000);
    expect(cleaned).toBe(1);
    expect(existsSync(join(notesDir, "note-stale.json"))).toBe(false);
  });

  it("listNotes returns newest notes first", async () => {
    await writeNote({
      id: "note-old",
      channel: "test",
      session_id: "s1",
      content: "old",
      created_at: "2026-05-01T10:00:00Z",
      permanent: false,
      urgent: false,
    });
    await writeNote({
      id: "note-new",
      channel: "test",
      session_id: "s1",
      content: "new",
      created_at: "2026-05-02T10:00:00Z",
      permanent: true,
      urgent: true,
    });

    const notes = await noteManager.listNotes();
    expect(notes.map((note) => note.id)).toEqual(["note-new", "note-old"]);
  });

  it("acknowledgeNote keeps permanent notes and dismisses volatile notes", async () => {
    await writeNote({
      id: "note-volatile",
      channel: "test",
      session_id: "s1",
      content: "volatile",
      created_at: new Date().toISOString(),
      permanent: false,
      urgent: false,
    });
    await writeNote({
      id: "note-permanent",
      channel: "test",
      session_id: "s1",
      content: "permanent",
      created_at: new Date().toISOString(),
      permanent: true,
      urgent: false,
    });

    const volatileResult = await noteManager.acknowledgeNote("note-volatile");
    const permanentResult = await noteManager.acknowledgeNote("note-permanent");

    expect(volatileResult?.deleted).toBe(true);
    expect(existsSync(join(notesDir, "note-volatile.json"))).toBe(false);
    expect(permanentResult?.deleted).toBe(false);
    expect(permanentResult?.note.acknowledged_at).toBeDefined();
  });

  it("deleteNote and clearNotes remove notes from disk", async () => {
    await writeNote({
      id: "note-delete",
      channel: "test",
      session_id: "s1",
      content: "delete me",
      created_at: new Date().toISOString(),
      permanent: false,
      urgent: false,
    });
    await writeNote({
      id: "note-clear",
      channel: "test",
      session_id: "s1",
      content: "clear me",
      created_at: new Date().toISOString(),
      permanent: true,
      urgent: false,
    });

    expect(await noteManager.deleteNote("note-delete")).toBe(true);
    expect(existsSync(join(notesDir, "note-delete.json"))).toBe(false);
    expect(await noteManager.clearNotes()).toBe(1);
    expect(await noteManager.listNotes()).toHaveLength(0);
  });

  it("peekUnacknowledgedNotes does not mark notes for acknowledgment", async () => {
    await writeNote({
      id: "note-1",
      channel: "test",
      session_id: "s1",
      content: "pending",
      created_at: new Date().toISOString(),
      permanent: false,
      urgent: false,
    });

    const notes = await noteManager.peekUnacknowledgedNotes();
    await noteManager.acknowledgeNotes();

    expect(notes).toHaveLength(1);
    expect(existsSync(join(notesDir, "note-1.json"))).toBe(true);
  });
});

describe("NoteChannel", () => {
  let notesDir: string;
  let noteManager: NoteManager;
  let channel: NoteChannel;

  beforeEach(async () => {
    notesDir = join(tmpDir, "notes");
    await ensureDir(notesDir);
    noteManager = new NoteManager(notesDir);
    channel = new NoteChannel(noteManager);
  });

  async function writeNote(note: UserNote) {
    await writeDoc(join(notesDir, `${note.id}.json`), note, UserNoteSchema);
  }

  it("drain returns formatted message containing eligible notes and marks them delivered", async () => {
    await writeNote({
      id: "v1",
      channel: "test",
      session_id: "s",
      content: "volatile-content",
      created_at: "2024-01-01T00:00:00Z",
      permanent: false,
      urgent: false,
    });
    const first = await channel.drain();
    expect(first).not.toBeNull();
    expect(first?.message).toContain("volatile-content");
  });

  it("drain returns null on second call with no new volatile notes", async () => {
    await writeNote({
      id: "v1",
      channel: "test",
      session_id: "s",
      content: "x",
      created_at: "2024-01-01T00:00:00Z",
      permanent: false,
      urgent: false,
    });
    expect(await channel.drain()).not.toBeNull();
    expect(await channel.drain()).toBeNull();
  });

  it("drain returns permanent note once, null on second call within same context", async () => {
    await writeNote({
      id: "p1",
      channel: "test",
      session_id: "s",
      content: "perm",
      created_at: "2024-01-01T00:00:00Z",
      permanent: true,
      urgent: false,
    });
    expect(await channel.drain()).not.toBeNull();
    expect(await channel.drain()).toBeNull();
  });

  it("after acknowledgeNotes without onContextReset, drain still returns null for the same permanent note", async () => {
    await writeNote({
      id: "p1",
      channel: "test",
      session_id: "s",
      content: "perm",
      created_at: "2024-01-01T00:00:00Z",
      permanent: true,
      urgent: false,
    });
    await channel.drain();
    await noteManager.acknowledgeNotes();
    expect(await channel.drain()).toBeNull();
  });

  it("after acknowledgeNotes and onContextReset, drain returns the permanent note again", async () => {
    await writeNote({
      id: "p1",
      channel: "test",
      session_id: "s",
      content: "perm",
      created_at: "2024-01-01T00:00:00Z",
      permanent: true,
      urgent: false,
    });
    await channel.drain();
    await noteManager.acknowledgeNotes();
    channel.onContextReset();
    const again = await channel.drain();
    expect(again).not.toBeNull();
    expect(again?.message).toContain("perm");
  });

  it("drain returns a volatile note delivered but not acknowledged only once (no duplicate injection)", async () => {
    await writeNote({
      id: "v1",
      channel: "test",
      session_id: "s",
      content: "vol",
      created_at: "2024-01-01T00:00:00Z",
      permanent: false,
      urgent: false,
    });
    expect(await channel.drain()).not.toBeNull();
    expect(await channel.drain()).toBeNull();
    // even after a fake onContextReset, the volatile note (still on disk, unacknowledged)
    // should be eligible again — this is correct: a fresh post-compaction context.
    channel.onContextReset();
    expect(await channel.drain()).not.toBeNull();
  });
});

describe("NoteService", () => {
  it("creates urgent notes without interrupt side effects", async () => {
    const notesDir = join(tmpDir, "notes");
    const service = new NoteService(notesDir);

    const result = await service.handleToolCall("create_note", {
      content: "please re-evaluate soon",
      urgent: true,
      permanent: true,
      channel: "telegram",
      session_id: "telegram-1",
    });

    expect(result.isError).toBe(false);
    const content = result.content as Record<string, unknown>;
    expect(content.urgent).toBe(true);
    expect(content).not.toHaveProperty("planner_pointer_pending");
    expect(content).not.toHaveProperty("planner_wakeup_requested");

    const note = await readDoc(join(notesDir, `${content.id}.json`), UserNoteSchema);
    expect(note.content).toBe("please re-evaluate soon");
    expect(note.urgent).toBe(true);
    expect(note.permanent).toBe(true);
  });
});

// ─── Compaction ──────────────────────────────────────────────────────────────

describe("Compaction", () => {
  it("shouldCompact triggers at threshold", () => {
    const config = {
      contextWindow: 100_000,
      thresholdPct: 80,
      maxCompactions: 3,
      maxConsecutiveFallbacks: 3,
      summaryModelSpec: "test/model",
    };

    expect(shouldCompact(0, config)).toBe(false);
    expect(shouldCompact(50_000, config)).toBe(false);
    expect(shouldCompact(90_000, config)).toBe(true);
  });

  it("isMaxCompactionsReached respects limit", () => {
    const config = {
      contextWindow: 100_000,
      thresholdPct: 80,
      maxCompactions: 3,
      maxConsecutiveFallbacks: 3,
      summaryModelSpec: "test/model",
    };

    expect(
      isMaxCompactionsReached(
        {
          compactionCount: 2,
          summarizerFallbacks: 0,
          consecutiveFallbacks: 0,
          oversizedAtomicFallback: false,
        },
        config,
      ),
    ).toBe(false);
    expect(
      isMaxCompactionsReached(
        {
          compactionCount: 3,
          summarizerFallbacks: 0,
          consecutiveFallbacks: 0,
          oversizedAtomicFallback: false,
        },
        config,
      ),
    ).toBe(true);
  });
});

// ─── Abort ───────────────────────────────────────────────────────────────────

describe("Abort", () => {
  it("createAbortSignal starts unaborted", () => {
    const signal = createAbortSignal();
    expect(signal.aborted).toBe(false);
  });

  it("triggerAbort sets aborted state", () => {
    const signal = createAbortSignal();
    triggerAbort(signal, "User requested stop");
    expect(signal.aborted).toBe(true);
    expect(signal.reason).toBe("User requested stop");
  });

  it("scanForUrgentNotes finds urgent unacknowledged notes", async () => {
    const notesDir = join(tmpDir, "notes");
    await ensureDir(notesDir);

    await writeDoc(
      join(notesDir, "note-1.json"),
      {
        id: "note-1",
        channel: "test",
        session_id: "s1",
        content: "change direction",
        created_at: new Date().toISOString(),
        permanent: false,
        urgent: true,
      },
      UserNoteSchema,
    );

    const note = await scanForUrgentNotes(notesDir);
    expect(note).not.toBeNull();
    expect(note?.urgent).toBe(true);
  });

  it("scanForUrgentNotes ignores acknowledged urgent notes", async () => {
    const notesDir = join(tmpDir, "notes");
    await ensureDir(notesDir);

    await writeDoc(
      join(notesDir, "note-1.json"),
      {
        id: "note-1",
        channel: "test",
        session_id: "s1",
        content: "old",
        created_at: new Date().toISOString(),
        permanent: false,
        urgent: true,
        acknowledged_at: new Date().toISOString(),
      },
      UserNoteSchema,
    );

    expect(await scanForUrgentNotes(notesDir)).toBeNull();
  });
});

// ─── Crash Recovery ──────────────────────────────────────────────────────────

describe("Crash Recovery", () => {
  it("waitForRecoveryDelay removes signal listeners after timer elapses", async () => {
    vi.useFakeTimers();
    try {
      const sigintBefore = process.listenerCount("SIGINT");
      const sigtermBefore = process.listenerCount("SIGTERM");

      const waiting = waitForRecoveryDelay(10);
      expect(process.listenerCount("SIGINT")).toBe(sigintBefore + 1);
      expect(process.listenerCount("SIGTERM")).toBe(sigtermBefore + 1);

      await vi.advanceTimersByTimeAsync(10);
      await expect(waiting).resolves.toBe(false);
      expect(process.listenerCount("SIGINT")).toBe(sigintBefore);
      expect(process.listenerCount("SIGTERM")).toBe(sigtermBefore);
    } finally {
      vi.useRealTimers();
    }
  });

  it("RuntimeTracker can clear stale current stage after manager exit", async () => {
    const statePath = join(tmpDir, "runtime.json");
    const tracker = new RuntimeTracker(statePath);

    tracker.setCurrentStage("stg-1");
    await tracker.waitForIdle();
    expect((await readDoc(statePath, RuntimeStateSchema)).current_stage_id).toBe("stg-1");

    tracker.setCurrentStage(null);
    await tracker.waitForIdle();

    expect((await readDoc(statePath, RuntimeStateSchema)).current_stage_id).toBeNull();
  });

  it("isAnotherInstanceRunning returns false for stale PID", async () => {
    const statePath = join(tmpDir, "runtime.json");
    await writeDoc(
      statePath,
      {
        status: "running",
        current_stage_id: null,
        active_agents: [],
        started_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        pid: 999999999, // almost certainly not a real PID
      },
      RuntimeStateSchema,
    );

    expect(await isAnotherInstanceRunning(statePath)).toBe(false);
  });

  it("isAnotherInstanceRunning returns false for idle state", async () => {
    const statePath = join(tmpDir, "runtime.json");
    await writeDoc(
      statePath,
      {
        status: "idle",
        current_stage_id: null,
        active_agents: [],
        started_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        pid: process.pid,
      },
      RuntimeStateSchema,
    );

    expect(await isAnotherInstanceRunning(statePath)).toBe(false);
  });

  it("recoverFromCrash resets in-progress tasks", async () => {
    const project = makeProjectContext(tmpDir);
    await ensureDir(project.paths.stages);
    await ensureDir(join(project.paths.tmp, "state"));

    const saivageDir = project.saivageDir;
    const planService = new PlanService(saivageDir);
    await planService.init();
    await planService.plan_init([
      {
        id: "stg-1",
        objective: "Test",
        starting_points: [],
        expected_outcomes: ["x"],
        acceptance_criteria: ["y"],
        references: [],
        tags: [],
      },
    ]);
    await planService.plan_set_current("stg-1");

    // Write stale runtime state
    await writeRuntimeState(project.paths.runtimeState, {
      status: "running",
      current_stage_id: "stg-1",
      active_agents: [],
      started_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      pid: 999999999,
    });

    // Write tasks with one in-progress and one aborted
    const stageDir = join(project.paths.stages, "stg-1");
    await ensureDir(stageDir);
    await writeDoc(
      join(stageDir, "tasks.json"),
      {
        stage_id: "stg-1",
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        tasks: [
          {
            id: "tsk-1",
            type: "code",
            assigned_to: "coder",
            description: "Task 1",
            checklist: [],
            dependencies: [],
            status: "in-progress",
            attempt: 1,
            max_attempts: 3,
            started_at: new Date().toISOString(),
          },
          {
            id: "tsk-2",
            type: "code",
            assigned_to: "coder",
            description: "Task 2",
            checklist: [],
            dependencies: [],
            status: "aborted",
            attempt: 1,
            max_attempts: 3,
          },
          {
            id: "tsk-3",
            type: "code",
            assigned_to: "coder",
            description: "Task 3",
            checklist: [],
            dependencies: [],
            status: "completed",
            attempt: 1,
            max_attempts: 3,
            completed_at: new Date().toISOString(),
          },
        ],
      },
      TaskListSchema,
    );

    const result = await recoverFromCrash(project, planService);
    expect(result.recovered).toBe(true);
    expect(result.stageId).toBe("stg-1");

    // Verify tasks were reset
    const tasks = await readDoc(join(stageDir, "tasks.json"), TaskListSchema);
    expect(tasks.tasks[0].status).toBe("pending"); // was in-progress
    expect(tasks.tasks[1].status).toBe("pending"); // was aborted
    expect(tasks.tasks[2].status).toBe("completed"); // unchanged
  });

  it("recoverFromCrash ignores malformed task lists", async () => {
    const project = makeProjectContext(tmpDir);
    await ensureDir(project.paths.stages);
    await ensureDir(join(project.paths.tmp, "state"));

    const planService = new PlanService(project.saivageDir);
    await planService.init();
    await planService.plan_init([
      {
        id: "stg-1",
        objective: "Test stage",
        starting_points: [],
        expected_outcomes: [],
        acceptance_criteria: [],
        references: [],
        tags: [],
      },
    ]);
    await planService.plan_set_current("stg-1");

    await writeRuntimeState(project.paths.runtimeState, {
      status: "running",
      current_stage_id: "stg-1",
      active_agents: [],
      started_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      pid: 999999999,
    });

    const stageDir = join(project.paths.stages, "stg-1");
    await ensureDir(stageDir);
    writeFileSync(
      join(stageDir, "tasks.json"),
      JSON.stringify([{ id: "legacy-array-task", status: "planned" }], null, 2),
      "utf-8",
    );

    const result = await recoverFromCrash(project, planService);
    expect(result.recovered).toBe(true);
    expect(result.stageId).toBe("stg-1");
  });

  it("recoverFromCrash detects unarchived summary", async () => {
    const project = makeProjectContext(tmpDir);
    await ensureDir(project.paths.stages);
    await ensureDir(join(project.paths.tmp, "state"));

    const saivageDir = project.saivageDir;
    const planService = new PlanService(saivageDir);
    await planService.init();
    await planService.plan_init([
      {
        id: "stg-1",
        objective: "Test",
        starting_points: [],
        expected_outcomes: ["x"],
        acceptance_criteria: ["y"],
        references: [],
        tags: [],
      },
    ]);
    await planService.plan_set_current("stg-1");

    // Write runtime state
    await writeRuntimeState(project.paths.runtimeState, {
      status: "running",
      current_stage_id: "stg-1",
      active_agents: [],
      started_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      pid: 999999999,
    });

    // Write a summary.json (stage finished but wasn't archived)
    const stageDir = join(project.paths.stages, "stg-1");
    await ensureDir(stageDir);
    await writeDoc(
      join(stageDir, "summary.json"),
      {
        stage_id: "stg-1",
        result: "completed",
        summary: "All done",
        tasks_completed: 1,
        tasks_failed: 0,
        total_tasks: 1,
        outcomes_achieved: ["x"],
        outcomes_missed: [],
        issues: [],
        started_at: new Date().toISOString(),
        completed_at: new Date().toISOString(),
        duration_ms: 1000,
      },
      StageSummarySchema,
    );

    const result = await recoverFromCrash(project, planService);
    expect(result.recovered).toBe(true);
    expect(result.needsArchival).toBe(true);
    expect(result.summary).toBeDefined();
    expect(result.summary?.result).toBe("completed");
  });
});
