/**
 * Tests for Phase 2: Runtime Core
 * Plan MCP service, crash recovery, notes, self-check, compaction, dispatcher.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  mkdtempSync,
  rmSync,
  existsSync,
  writeFileSync,
  mkdirSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { PlanService } from "../mcp/plan-server.js";
import { NoteService } from "../mcp/notes-server.js";
import { NoteManager } from "./notes.js";
import { Dispatcher } from "./dispatcher.js";
import { writeDoc, readDoc, ensureDir } from "../store/documents.js";
import {
  PlanSchema,
  PlanHistorySchema,
  UserNoteSchema,
  TaskListSchema,
  TaskReportSchema,
  RuntimeStateSchema,
  StageSummarySchema,
  type UserNote,
  type RuntimeState,
} from "../types.js";
import {
  createSelfCheckState,
  recordToolCallRound,
  selfCheckMessage,
} from "./self-check.js";
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
  createRuntimeState,
  writeRuntimeState,
  RuntimeTracker,
} from "./recovery.js";
import type { ProjectContext } from "../store/project.js";
import { RuntimeSupervisor } from "./supervisor.js";
import { log } from "../log.js";
import type { SaivageConfig } from "../config.js";

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

// ─── Runtime Supervisor ────────────────────────────────────────────────────

describe("RuntimeSupervisor", () => {
  it("uses a no-tool log-only model request and does not cancel before threshold", async () => {
    log.warn("supervisor test synthetic retry loop warning");
    const requests: any[] = [];
    const router = {
      chat: vi.fn(async (request: any) => {
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
    const agentRegistry = new Map<string, any>([
      ["coder-1", { role: "coder", cancel }],
    ]);
    const supervisor = new RuntimeSupervisor(makeSupervisorConfig(), { router: router as any, agentRegistry });

    await supervisor.checkOnce();
    await supervisor.checkOnce();

    expect(cancel).not.toHaveBeenCalled();
    expect(router.chat).toHaveBeenCalledTimes(2);
    expect(requests[0].modelSpec).toBe("github-copilot/gpt-5-mini");
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
    const agentRegistry = new Map<string, any>([
      ["manager-1", { role: "manager", cancel: managerCancel }],
      ["coder-1", { role: "coder", cancel: coderCancel }],
    ]);
    const supervisor = new RuntimeSupervisor(makeSupervisorConfig(), { router: router as any, agentRegistry });

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
    const agentRegistry = new Map<string, any>([
      ["coder-1", { role: "coder", cancel }],
    ]);
    const supervisor = new RuntimeSupervisor(makeSupervisorConfig(), { router: router as any, agentRegistry });

    await supervisor.checkOnce();
    await supervisor.checkOnce();
    await supervisor.checkOnce();
    await supervisor.checkOnce();

    expect(cancel).not.toHaveBeenCalled();
  });

  it("does not cancel agents when the only reported problem is provider throttling", async () => {
    log.warn("Provider \"github-copilot\" rate-limited, trying next");
    const router = {
      chat: vi.fn(async () => ({
        content: JSON.stringify({
          stuck: true,
          confidence: 0.95,
          reason: "GitHub Copilot is returning 429 rate limit responses",
          evidence: ["provider throttling"],
        }),
        toolCalls: [],
        finishReason: "end_turn",
        usage: { inputTokens: 1, outputTokens: 1 },
      })),
    };
    const cancel = vi.fn();
    const agentRegistry = new Map<string, any>([
      ["coder-1", { role: "coder", cancel }],
    ]);
    const supervisor = new RuntimeSupervisor(makeSupervisorConfig(), { router: router as any, agentRegistry });

    await supervisor.checkOnce();
    await supervisor.checkOnce();
    await supervisor.checkOnce();

    expect(cancel).not.toHaveBeenCalled();
  });

  it("does not cancel agents when the only reported problem is long-running external work", async () => {
    log.info("shell run_command external process still running for training experiment");
    const router = {
      chat: vi.fn(async () => ({
        content: JSON.stringify({
          stuck: true,
          confidence: 0.9,
          reason: "A long-running shell command is still running for a training job",
          evidence: ["external process in progress", "benchmark command still running"],
        }),
        toolCalls: [],
        finishReason: "end_turn",
        usage: { inputTokens: 1, outputTokens: 1 },
      })),
    };
    const cancel = vi.fn();
    const agentRegistry = new Map<string, any>([
      ["coder-1", { role: "coder", cancel }],
    ]);
    const supervisor = new RuntimeSupervisor(makeSupervisorConfig(), { router: router as any, agentRegistry });

    await supervisor.checkOnce();
    await supervisor.checkOnce();
    await supervisor.checkOnce();

    expect(cancel).not.toHaveBeenCalled();
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
      injectionScanner: true,
      injectionModel: "github-copilot/gpt-5-mini",
      maxScanLengthBytes: 100_000,
    },
    supervisor: {
      enabled: true,
      model: "github-copilot/gpt-5-mini",
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

  beforeEach(() => {
    saivageDir = join(tmpDir, ".saivage");
    ensureDir(saivageDir);
    planService = new PlanService(saivageDir);
  });

  it("plan_init creates a new plan", () => {
    const result = planService.plan_init([
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
    expect((result as any).stages).toHaveLength(1);
  });

  it("plan_init rejects if plan already exists", () => {
    planService.plan_init([]);
    const result = planService.plan_init([]);
    expect(result).toHaveProperty("code", "STAGE_EXISTS");
  });

  it("plan_get returns the plan", () => {
    planService.plan_init([
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
    const plan = planService.plan_get();
    expect(plan).not.toHaveProperty("code");
    expect((plan as any).stages).toHaveLength(1);
  });

  it("plan_get returns error when not initialized", () => {
    const result = planService.plan_get();
    expect(result).toHaveProperty("code", "PLAN_NOT_FOUND");
  });

  it("plan_set_current sets current stage", () => {
    planService.plan_init([
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
    const result = planService.plan_set_current("stg-1");
    expect(result).not.toHaveProperty("code");
    expect((result as any).current_stage_id).toBe("stg-1");
  });

  it("plan_set_current rejects missing stage", () => {
    planService.plan_init([]);
    const result = planService.plan_set_current("stg-999");
    expect(result).toHaveProperty("code", "STAGE_NOT_FOUND");
  });

  it("plan_add_stage appends a stage", () => {
    planService.plan_init([]);
    const result = planService.plan_add_stage({
      id: "stg-new",
      objective: "New stage",
      starting_points: [],
      expected_outcomes: ["something"],
      acceptance_criteria: ["test"],
      references: [],
      tags: [],
    });
    expect(result).not.toHaveProperty("code");
    expect((result as any).stages).toHaveLength(1);
  });

  it("plan_add_stage rejects duplicate ID", () => {
    planService.plan_init([
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
    const result = planService.plan_add_stage({
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

  it("plan_remove_stage removes a stage", () => {
    planService.plan_init([
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
    const result = planService.plan_remove_stage("stg-1");
    expect(result).not.toHaveProperty("code");
    expect((result as any).stages).toHaveLength(0);
  });

  it("plan_complete_stage moves to history", () => {
    planService.plan_init([
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
    planService.plan_set_current("stg-1");

    const result = planService.plan_complete_stage({
      stage_id: "stg-1",
      result: "completed",
      summary: "All done",
      actual_outcomes: ["done"],
    });

    expect(result).not.toHaveProperty("code");
    const res = result as { completed_stage: any; plan: any };
    expect(res.completed_stage.id).toBe("stg-1");
    expect(res.plan.stages).toHaveLength(0);
    expect(res.plan.current_stage_id).toBeNull();

    // Verify history
    const history = planService.plan_get_history();
    expect((history as any).stages).toHaveLength(1);
  });

  it("plan_set_stages replaces all stages", () => {
    planService.plan_init([]);
    const result = planService.plan_set_stages(
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
      "stg-a",
    );
    expect(result).not.toHaveProperty("code");
    expect((result as any).stages).toHaveLength(2);
    expect((result as any).current_stage_id).toBe("stg-a");
  });

  it("plan_get_stage finds from active and history", () => {
    planService.plan_init([
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

    const active = planService.plan_get_stage("stg-1");
    expect((active as any).source).toBe("active");

    // Move to history
    planService.plan_complete_stage({
      stage_id: "stg-1",
      result: "completed",
      summary: "Done",
      actual_outcomes: ["x"],
    });

    const fromHistory = planService.plan_get_stage("stg-1");
    expect((fromHistory as any).source).toBe("history");
  });

  it("handleToolCall routes correctly", async () => {
    planService.plan_init([]);
    const result = await planService.handleToolCall("plan_get", {});
    expect(result.isError).toBe(false);
    expect((result.content as any).stages).toEqual([]);
  });
});

// ─── Note Lifecycle ──────────────────────────────────────────────────────────

describe("NoteManager", () => {
  let notesDir: string;
  let noteManager: NoteManager;

  beforeEach(() => {
    notesDir = join(tmpDir, "notes");
    ensureDir(notesDir);
    noteManager = new NoteManager(notesDir);
  });

  function writeNote(note: UserNote) {
    writeDoc(join(notesDir, `${note.id}.json`), note, UserNoteSchema);
  }

  it("getUnacknowledgedNotes returns unacknowledged notes", () => {
    writeNote({
      id: "note-1",
      channel: "test",
      session_id: "s1",
      content: "hello",
      created_at: new Date().toISOString(),
      permanent: false,
      urgent: false,
    });
    writeNote({
      id: "note-2",
      channel: "test",
      session_id: "s1",
      content: "acknowledged",
      created_at: new Date().toISOString(),
      permanent: false,
      urgent: false,
      acknowledged_at: new Date().toISOString(),
    });

    const notes = noteManager.getUnacknowledgedNotes();
    expect(notes).toHaveLength(1);
    expect(notes[0].id).toBe("note-1");
  });

  it("does not inject Planner-authored self notes", () => {
    writeNote({
      id: "note-planner-self",
      channel: "planner",
      session_id: "s1",
      content: "Stay blocked forever",
      created_at: new Date().toISOString(),
      permanent: true,
      urgent: true,
    });

    expect(noteManager.getUnacknowledgedNotes()).toHaveLength(0);
    expect(noteManager.getPermanentNotes()).toHaveLength(0);
  });

  it("acknowledgeNotes sets acknowledged_at and deletes volatile", () => {
    writeNote({
      id: "note-1",
      channel: "test",
      session_id: "s1",
      content: "volatile",
      created_at: new Date().toISOString(),
      permanent: false,
      urgent: false,
    });
    writeNote({
      id: "note-2",
      channel: "test",
      session_id: "s1",
      content: "permanent",
      created_at: new Date().toISOString(),
      permanent: true,
      urgent: false,
    });

    noteManager.getUnacknowledgedNotes(); // sets pending
    noteManager.acknowledgeNotes();

    // Volatile note should be deleted
    expect(existsSync(join(notesDir, "note-1.json"))).toBe(false);

    // Permanent note should still exist with acknowledged_at
    const remaining = readDoc(
      join(notesDir, "note-2.json"),
      UserNoteSchema,
    );
    expect(remaining.acknowledged_at).toBeDefined();
  });

  it("getPermanentNotes returns only permanent notes", () => {
    writeNote({
      id: "note-1",
      channel: "test",
      session_id: "s1",
      content: "volatile",
      created_at: new Date().toISOString(),
      permanent: false,
      urgent: false,
    });
    writeNote({
      id: "note-2",
      channel: "test",
      session_id: "s1",
      content: "permanent",
      created_at: new Date().toISOString(),
      permanent: true,
      urgent: false,
    });

    const notes = noteManager.getPermanentNotes();
    expect(notes).toHaveLength(1);
    expect(notes[0].id).toBe("note-2");
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

  it("cleanupStaleNotes removes acknowledged volatile notes", () => {
    writeNote({
      id: "note-stale",
      channel: "test",
      session_id: "s1",
      content: "stale",
      created_at: new Date().toISOString(),
      permanent: false,
      urgent: false,
      acknowledged_at: new Date().toISOString(),
    });

    const cleaned = noteManager.cleanupStaleNotes();
    expect(cleaned).toBe(1);
    expect(existsSync(join(notesDir, "note-stale.json"))).toBe(false);
  });

  it("peekUnacknowledgedNotes does not mark notes for acknowledgment", () => {
    writeNote({
      id: "note-1",
      channel: "test",
      session_id: "s1",
      content: "pending",
      created_at: new Date().toISOString(),
      permanent: false,
      urgent: false,
    });

    const notes = noteManager.peekUnacknowledgedNotes();
    noteManager.acknowledgeNotes();

    expect(notes).toHaveLength(1);
    expect(existsSync(join(notesDir, "note-1.json"))).toBe(true);
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
    expect(content.planner_pointer_pending).toBe(true);
    expect(content).not.toHaveProperty("planner_wakeup_requested");

    const note = readDoc(join(notesDir, `${content.id}.json`), UserNoteSchema);
    expect(note.content).toBe("please re-evaluate soon");
    expect(note.urgent).toBe(true);
    expect(note.permanent).toBe(true);
  });
});

describe("Dispatcher pending note pointers", () => {
  it("attaches pending note metadata to Planner tool results", async () => {
    const project = makeProjectContext(tmpDir);
    ensureDir(project.paths.notes);
    writeDoc(
      join(project.paths.notes, "note-1.json"),
      {
        id: "note-1",
        channel: "telegram",
        session_id: "telegram-1",
        content: "consider a slower refresh experiment",
        created_at: new Date().toISOString(),
        permanent: false,
        urgent: true,
      },
      UserNoteSchema,
    );

    const dispatcher = new Dispatcher({
      getAllTools: () => [{ name: "noop", description: "Noop", inputSchema: {}, service: "test" }],
      callTool: async () => ({ ok: true }),
    } as any);

    const result = await dispatcher.processToolCalls(
      [{ id: "tool-1", name: "noop", input: {} }],
      {
        project,
        router: {} as any,
        mcpRuntime: {} as any,
        agentId: "planner-1",
        role: "planner",
        modelSpec: "test/model",
      },
    );

    const content = JSON.parse(result.toolResults[0].content);
    expect(content.ok).toBe(true);
    expect(content.__saivage_pending_user_notes.count).toBe(1);
    expect(content.__saivage_pending_user_notes.urgent_count).toBe(1);
    expect(content.__saivage_pending_user_notes.notes[0].id).toBe("note-1");
  });
});

// ─── Self-Check ──────────────────────────────────────────────────────────────

describe("Self-Check", () => {
  it("triggers at correct frequency", () => {
    const state = createSelfCheckState("coder"); // frequency 15
    expect(state.frequency).toBe(15);

    for (let i = 0; i < 14; i++) {
      expect(recordToolCallRound(state)).toBe(false);
    }
    expect(recordToolCallRound(state)).toBe(true); // 15th round
    expect(state.roundsSinceCheck).toBe(0); // reset

    // Next cycle
    for (let i = 0; i < 14; i++) {
      expect(recordToolCallRound(state)).toBe(false);
    }
    expect(recordToolCallRound(state)).toBe(true);
  });

  it("respects custom frequency", () => {
    const state = createSelfCheckState("planner", 5);
    expect(state.frequency).toBe(5);

    for (let i = 0; i < 4; i++) {
      expect(recordToolCallRound(state)).toBe(false);
    }
    expect(recordToolCallRound(state)).toBe(true);
  });

  it("disabled for chat (frequency 0)", () => {
    const state = createSelfCheckState("chat");
    for (let i = 0; i < 100; i++) {
      expect(recordToolCallRound(state)).toBe(false);
    }
  });

  it("selfCheckMessage includes frequency", () => {
    const msg = selfCheckMessage(15);
    expect(msg).toContain("15 tool-call rounds");
  });
});

// ─── Compaction ──────────────────────────────────────────────────────────────

describe("Compaction", () => {
  it("shouldCompact triggers at threshold", () => {
    const config = {
      contextWindow: 100_000,
      thresholdPct: 80,
      maxCompactions: 3,
      summaryModelSpec: "test/model",
    };

    // Small messages — should not trigger
    const smallMsgs = [
      { role: "user" as const, content: "hello" },
    ];
    expect(shouldCompact(smallMsgs, config)).toBe(false);

    // Large messages — should trigger (>80k tokens = >320k chars)
    const largeContent = "x".repeat(400_000);
    const largeMsgs = [
      { role: "user" as const, content: largeContent },
    ];
    expect(shouldCompact(largeMsgs, config)).toBe(true);
  });

  it("isMaxCompactionsReached respects limit", () => {
    const config = {
      contextWindow: 100_000,
      thresholdPct: 80,
      maxCompactions: 3,
      summaryModelSpec: "test/model",
    };

    expect(
      isMaxCompactionsReached({ compactionCount: 2 }, config),
    ).toBe(false);
    expect(
      isMaxCompactionsReached({ compactionCount: 3 }, config),
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

  it("scanForUrgentNotes finds urgent unacknowledged notes", () => {
    const notesDir = join(tmpDir, "notes");
    ensureDir(notesDir);

    writeDoc(
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

    const note = scanForUrgentNotes(notesDir);
    expect(note).not.toBeNull();
    expect(note!.urgent).toBe(true);
  });

  it("scanForUrgentNotes ignores acknowledged urgent notes", () => {
    const notesDir = join(tmpDir, "notes");
    ensureDir(notesDir);

    writeDoc(
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

    expect(scanForUrgentNotes(notesDir)).toBeNull();
  });
});

// ─── Crash Recovery ──────────────────────────────────────────────────────────

describe("Crash Recovery", () => {
  it("writeRuntimeState mirrors the compatibility runtime-state path", () => {
    const statePath = join(tmpDir, ".saivage", "tmp", "state", "runtime.json");
    const legacyPath = join(tmpDir, ".saivage", "runtime", "runtime-state.json");
    const state: RuntimeState = {
      status: "running",
      current_stage_id: "stg-1",
      active_agents: [],
      started_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      pid: process.pid,
    };

    writeRuntimeState(statePath, state);

    expect(existsSync(statePath)).toBe(true);
    expect(existsSync(legacyPath)).toBe(true);
    expect(readDoc(legacyPath, RuntimeStateSchema).current_stage_id).toBe("stg-1");
  });

  it("RuntimeTracker can clear stale current stage after manager exit", () => {
    const statePath = join(tmpDir, "runtime.json");
    const tracker = new RuntimeTracker(statePath);

    tracker.setCurrentStage("stg-1");
    expect(readDoc(statePath, RuntimeStateSchema).current_stage_id).toBe("stg-1");

    tracker.setCurrentStage(null);

    expect(readDoc(statePath, RuntimeStateSchema).current_stage_id).toBeNull();
  });

  it("isAnotherInstanceRunning returns false for stale PID", () => {
    const statePath = join(tmpDir, "runtime.json");
    writeDoc(
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

    expect(isAnotherInstanceRunning(statePath)).toBe(false);
  });

  it("isAnotherInstanceRunning returns false for idle state", () => {
    const statePath = join(tmpDir, "runtime.json");
    writeDoc(
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

    expect(isAnotherInstanceRunning(statePath)).toBe(false);
  });

  it("recoverFromCrash resets in-progress tasks", () => {
    const project = makeProjectContext(tmpDir);
    ensureDir(project.paths.stages);
    ensureDir(join(project.paths.tmp, "state"));

    const saivageDir = project.saivageDir;
    const planService = new PlanService(saivageDir);
    planService.plan_init([
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
    planService.plan_set_current("stg-1");

    // Write stale runtime state
    writeRuntimeState(project.paths.runtimeState, {
      status: "running",
      current_stage_id: "stg-1",
      active_agents: [],
      started_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      pid: 999999999,
    });

    // Write tasks with one in-progress and one aborted
    const stageDir = join(project.paths.stages, "stg-1");
    ensureDir(stageDir);
    writeDoc(
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

    const result = recoverFromCrash(project, planService);
    expect(result.recovered).toBe(true);
    expect(result.stageId).toBe("stg-1");

    // Verify tasks were reset
    const tasks = readDoc(join(stageDir, "tasks.json"), TaskListSchema);
    expect(tasks.tasks[0].status).toBe("pending"); // was in-progress
    expect(tasks.tasks[1].status).toBe("pending"); // was aborted
    expect(tasks.tasks[2].status).toBe("completed"); // unchanged
  });

  it("recoverFromCrash detects unarchived summary", () => {
    const project = makeProjectContext(tmpDir);
    ensureDir(project.paths.stages);
    ensureDir(join(project.paths.tmp, "state"));

    const saivageDir = project.saivageDir;
    const planService = new PlanService(saivageDir);
    planService.plan_init([
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
    planService.plan_set_current("stg-1");

    // Write runtime state
    writeRuntimeState(project.paths.runtimeState, {
      status: "running",
      current_stage_id: "stg-1",
      active_agents: [],
      started_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      pid: 999999999,
    });

    // Write a summary.json (stage finished but wasn't archived)
    const stageDir = join(project.paths.stages, "stg-1");
    ensureDir(stageDir);
    writeDoc(
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

    const result = recoverFromCrash(project, planService);
    expect(result.recovered).toBe(true);
    expect(result.needsArchival).toBe(true);
    expect(result.summary).toBeDefined();
    expect(result.summary!.result).toBe("completed");
  });
});
