/**
 * Tests for Document Store, Project initializer, and ID generator.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { z } from "zod";

import {
  readDoc,
  readDocOrNull,
  writeDoc,
  listDir,
  deleteDoc,
} from "./documents.js";

import {
  stageId,
  taskId,
  noteId,
  inspectionId,
  chatSessionId,
  agentId,
} from "../ids.js";

import {
  PlanDocumentSchema,
  TaskSchema,
  TaskReportSchema,
  StageSummarySchema,
  UserNoteSchema,
  StageSchema,
} from "../types.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "saivage-test-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// ─── Document Store tests ────────────────────────────────────────────────────

describe("Document Store", () => {
  const TestSchema = z.object({
    name: z.string(),
    count: z.number(),
  });

  it("writes and reads a document atomically", async () => {
    const path = join(tmpDir, "test.json");
    const data = { name: "hello", count: 42 };

    await writeDoc(path, data, TestSchema);
    const result = await readDoc(path, TestSchema);

    expect(result).toEqual(data);
  });

  it("creates parent directories on write", async () => {
    const path = join(tmpDir, "a", "b", "c", "doc.json");
    await writeDoc(path, { name: "deep", count: 1 }, TestSchema);
    expect(existsSync(path)).toBe(true);
  });

  it("rejects invalid data on write", async () => {
    const path = join(tmpDir, "bad.json");
    await expect(
      writeDoc(path, { name: 123 } as unknown, TestSchema),
    ).rejects.toThrow();
    expect(existsSync(path)).toBe(false);
  });

  it("rejects invalid data on read", async () => {
    const path = join(tmpDir, "bad.json");
    writeFileSync(path, '{"name": 123}', "utf-8");
    await expect(readDoc(path, TestSchema)).rejects.toThrow();
  });

  it("no .tmp file left after successful write", async () => {
    const path = join(tmpDir, "clean.json");
    await writeDoc(path, { name: "ok", count: 0 }, TestSchema);
    expect(existsSync(path + ".tmp")).toBe(false);
  });

  it("readDocOrNull returns null for missing file", async () => {
    const result = await readDocOrNull(join(tmpDir, "nope.json"), TestSchema);
    expect(result).toBeNull();
  });

  it("readDocOrNull returns data for existing file", async () => {
    const path = join(tmpDir, "exists.json");
    await writeDoc(path, { name: "hi", count: 1 }, TestSchema);
    const result = await readDocOrNull(path, TestSchema);
    expect(result).toEqual({ name: "hi", count: 1 });
  });

  it("deleteDoc removes file", async () => {
    const path = join(tmpDir, "del.json");
    await writeDoc(path, { name: "bye", count: 0 }, TestSchema);
    expect(await deleteDoc(path)).toBe(true);
    expect(existsSync(path)).toBe(false);
  });

  it("deleteDoc returns false for missing file", async () => {
    expect(await deleteDoc(join(tmpDir, "nope.json"))).toBe(false);
  });

  it("listDir returns filenames", async () => {
    await writeDoc(join(tmpDir, "a.json"), { name: "a", count: 1 }, TestSchema);
    await writeDoc(join(tmpDir, "b.json"), { name: "b", count: 2 }, TestSchema);
    const entries = await listDir(tmpDir);
    expect(entries.sort()).toEqual(["a.json", "b.json"]);
  });

  it("listDir returns empty for missing directory", async () => {
    expect(await listDir(join(tmpDir, "nope"))).toEqual([]);
  });
});

// ─── ID Generator tests ─────────────────────────────────────────────────────

describe("ID Generator", () => {
  it("stageId has stg- prefix", () => {
    const id = stageId();
    expect(id).toMatch(/^stg-[a-z0-9]{12}$/);
  });

  it("taskId has tsk- prefix", () => {
    const id = taskId();
    expect(id).toMatch(/^tsk-[a-z0-9]{12}$/);
  });

  it("noteId has note- prefix", () => {
    const id = noteId();
    expect(id).toMatch(/^note-[a-z0-9]{12}$/);
  });

  it("inspectionId has insp- prefix", () => {
    const id = inspectionId();
    expect(id).toMatch(/^insp-[a-z0-9]{12}$/);
  });

  it("chatSessionId has chat- prefix", () => {
    const id = chatSessionId();
    expect(id).toMatch(/^chat-[a-z0-9]{12}$/);
  });

  it("agentId has agent- prefix", () => {
    const id = agentId();
    expect(id).toMatch(/^agent-[a-z0-9]{12}$/);
  });

  it("generates unique IDs", () => {
    const ids = new Set(Array.from({ length: 100 }, () => stageId()));
    expect(ids.size).toBe(100);
  });
});

// ─── Zod Schema validation tests ────────────────────────────────────────────

describe("Type schemas", () => {
  it("validates a PlanDocument", () => {
    const plan = {
      updated_at: new Date().toISOString(),
      current_stage_id: null,
      stages: [
        {
          id: "stg-abc",
          objective: "Build the thing",
          starting_points: ["nothing exists"],
          expected_outcomes: ["thing exists"],
          acceptance_criteria: ["tests pass"],
          references: ["README.md"],
          tags: ["setup"],
        },
      ],
      history: [],
    };
    expect(() => PlanDocumentSchema.parse(plan)).not.toThrow();
  });

  it("rejects a PlanDocument with missing stage fields", () => {
    const plan = {
      updated_at: new Date().toISOString(),
      current_stage_id: null,
      stages: [{ id: "stg-abc" }],
      history: [],
    };
    expect(() => PlanDocumentSchema.parse(plan)).toThrow();
  });

  it("rejects a Stage with empty objective", () => {
    expect(() =>
      StageSchema.parse({
        id: "stg-1",
        objective: "",
        starting_points: [],
        expected_outcomes: ["x"],
        acceptance_criteria: ["y"],
        references: [],
        tags: [],
      }),
    ).toThrow();
  });

  it("rejects a Stage with empty expected_outcomes", () => {
    expect(() =>
      StageSchema.parse({
        id: "stg-1",
        objective: "do something",
        starting_points: [],
        expected_outcomes: [],
        acceptance_criteria: ["y"],
        references: [],
        tags: [],
      }),
    ).toThrow();
  });

  it("validates a UserNote", () => {
    const note = {
      id: "note-abc",
      channel: "telegram",
      session_id: "chat-xyz",
      content: "do something different",
      created_at: new Date().toISOString(),
      permanent: false,
      urgent: true,
    };
    expect(() => UserNoteSchema.parse(note)).not.toThrow();
  });

  it("validates a TaskReport", () => {
    const report = {
      task_id: "tsk-1",
      stage_id: "stg-1",
      agent: "coder" as const,
      status: "completed" as const,
      summary: "Did the thing",
      checklist_results: [
        { description: "tests pass", passed: true },
      ],
      files_modified: ["src/main.ts"],
      files_created: [],
      tests_added: ["src/main.test.ts"],
      tests_run: [{ name: "basic", passed: true }],
      commits: ["abc123"],
      issues_found: [],
      started_at: new Date().toISOString(),
      completed_at: new Date().toISOString(),
      duration_ms: 5000,
    };
    expect(() => TaskReportSchema.parse(report)).not.toThrow();
  });

  it("validates reviewer tasks and reports", () => {
    const task = {
      id: "tsk-review",
      type: "review" as const,
      assigned_to: "reviewer" as const,
      description: "Review completed stage work",
      checklist: [{ description: "Acceptance criteria reviewed", required: true }],
      dependencies: ["tsk-code"],
      status: "pending" as const,
      attempt: 1,
      max_attempts: 3,
    };
    expect(() => TaskSchema.parse(task)).not.toThrow();

    const report = {
      task_id: "tsk-review",
      stage_id: "stg-1",
      agent: "reviewer" as const,
      status: "completed" as const,
      summary: "Stage work reviewed; one warning remains.",
      checklist_results: [
        { description: "Acceptance criteria reviewed", passed: true },
      ],
      files_modified: [],
      files_created: [".saivage/stages/stg-1/reviews/review.md"],
      tests_added: [],
      tests_run: [{ name: "review-json", passed: true }],
      commits: [],
      issues_found: [
        {
          severity: "warning" as const,
          description: "Experiment conclusion lacks confidence interval evidence",
          file: "results/leaderboard.json",
          root_cause: "Metrics were reported without uncertainty analysis",
          suggestion: "Run bootstrap confidence analysis before claiming improvement",
        },
      ],
      started_at: new Date().toISOString(),
      completed_at: new Date().toISOString(),
      duration_ms: 5000,
    };
    expect(() => TaskReportSchema.parse(report)).not.toThrow();
  });

  it("validates a StageSummary with escalation", () => {
    const summary = {
      stage_id: "stg-1",
      result: "escalated" as const,
      summary: "Could not complete",
      tasks_completed: 1,
      tasks_failed: 1,
      total_tasks: 2,
      outcomes_achieved: ["partial"],
      outcomes_missed: ["full"],
      issues: [],
      escalation: {
        stage_id: "stg-1",
        task_id: "tsk-2",
        reason: "repeatedly failing",
        attempted_remediations: ["modified description", "added context"],
        suggested_action: "split into smaller tasks",
        created_at: new Date().toISOString(),
      },
      started_at: new Date().toISOString(),
      completed_at: new Date().toISOString(),
      duration_ms: 60000,
    };
    expect(() => StageSummarySchema.parse(summary)).not.toThrow();
  });
});

// ─── Round-trip tests with Document Store + Schemas ──────────────────────────

describe("Document Store + Schema round-trip", () => {
  it("writes and reads a PlanDocument", async () => {
    const path = join(tmpDir, "plan.json");
    const plan = {
      updated_at: new Date().toISOString(),
      current_stage_id: "stg-1",
      stages: [
        {
          id: "stg-1",
          objective: "Setup",
          starting_points: ["bare repo"],
          expected_outcomes: ["project structure"],
          acceptance_criteria: ["npm test passes"],
          references: [],
          tags: ["init"],
        },
      ],
      history: [],
    };

    await writeDoc(path, plan, PlanDocumentSchema);
    const result = await readDoc(path, PlanDocumentSchema);
    expect(result).toEqual(plan);
  });

  it("writes and reads embedded plan history", async () => {
    const path = join(tmpDir, "plan.json");
    const entry = {
      id: "stg-1",
      objective: "Setup",
      expected_outcomes: ["structure"],
      actual_outcomes: ["structure created"],
      started_at: new Date().toISOString(),
      completed_at: new Date().toISOString(),
      result: "completed" as const,
      summary: "All done",
    };
    const plan = {
      updated_at: new Date().toISOString(),
      current_stage_id: null,
      stages: [],
      history: [] as typeof entry[],
    };

    await writeDoc(path, { ...plan, history: [entry] }, PlanDocumentSchema);

    const result = await readDoc(path, PlanDocumentSchema);
    expect(result.history).toHaveLength(1);
    expect(result.history[0].id).toBe("stg-1");
  });
});
