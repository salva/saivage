/**
 * Saivage — Fix 2 backfill-plan-history smoke tests.
 *
 * Minimal hermetic coverage: confirms (a) the dry-run path produces
 * candidates from a synthetic fixture stage dir with summary.json, (b)
 * stages already in plan/history are skipped, (c) stages with neither
 * summary nor reports are skipped, (d) applyBackfill is idempotent, and
 * (e) PLAN_WRITER_TOOLS does NOT expose plan_append_history.
 *
 * Broader coverage (lock interlock, CLI exit codes, fallback-from-reports
 * variants) lands as a follow-up.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PlanService, PLAN_WRITER_TOOLS } from "../mcp/plan-server.js";
import { planBackfill, applyBackfill } from "./backfill-plan-history.js";
import type { PlanDocument, StageSummary } from "../types.js";

let tmpRoot: string;
let saivageDir: string;

function writePlan(doc: PlanDocument): void {
  writeFileSync(join(saivageDir, "plan.json"), JSON.stringify(doc, null, 2));
}

function makeSummary(stageId: string, completedAt = "2026-05-29T10:00:00.000Z"): StageSummary {
  return {
    stage_id: stageId,
    result: "completed",
    summary: `Synthetic summary for ${stageId}`,
    tasks_completed: 1,
    tasks_failed: 0,
    total_tasks: 1,
    outcomes_achieved: ["did the thing"],
    outcomes_missed: [],
    issues: [],
    started_at: "2026-05-29T09:00:00.000Z",
    completed_at: completedAt,
    duration_ms: 3_600_000,
  };
}

function writeStageDir(stageId: string, summary: StageSummary | null): string {
  const dir = join(saivageDir, "stages", stageId);
  mkdirSync(dir, { recursive: true });
  if (summary) {
    writeFileSync(join(dir, "summary.json"), JSON.stringify(summary, null, 2));
  }
  return dir;
}

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "saivage-backfill-test-"));
  saivageDir = join(tmpRoot, ".saivage");
  mkdirSync(saivageDir, { recursive: true });
  mkdirSync(join(saivageDir, "tmp", "state"), { recursive: true });
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe("backfill-plan-history", () => {
  it("plan_append_history is NOT in PLAN_WRITER_TOOLS (admin-only invariant)", () => {
    expect(PLAN_WRITER_TOOLS.has("plan_append_history")).toBe(false);
  });

  it("synthesises a candidate from a stage dir with summary.json", async () => {
    writePlan({
      updated_at: "2026-05-29T00:00:00.000Z",
      current_stage_id: null,
      stages: [],
      history: [],
    });
    writeStageDir("stage-001-foo", makeSummary("stage-001-foo"));

    const svc = new PlanService(saivageDir);
    await svc.init();
    const report = await planBackfill(saivageDir, svc);

    expect(report.candidates).toHaveLength(1);
    expect(report.candidates[0].stageId).toBe("stage-001-foo");
    expect(report.candidates[0].source).toBe("summary");
    expect(report.candidates[0].completedStage.result).toBe("completed");
  });

  it("skips stages already present in plan.history (idempotent)", async () => {
    const completed = makeSummary("stage-001-foo");
    writePlan({
      updated_at: "2026-05-29T00:00:00.000Z",
      current_stage_id: null,
      stages: [],
      history: [
        {
          id: completed.stage_id,
          objective: "prior",
          expected_outcomes: ["x"],
          actual_outcomes: ["x"],
          started_at: completed.started_at,
          completed_at: completed.completed_at,
          result: "completed",
          summary: "already there",
        },
      ],
    });
    writeStageDir("stage-001-foo", completed);

    const svc = new PlanService(saivageDir);
    await svc.init();
    const report = await planBackfill(saivageDir, svc);

    expect(report.candidates).toHaveLength(0);
    expect(report.skipped.find((s) => s.stageId === "stage-001-foo")).toBeDefined();
  });

  it("skips stages with neither summary.json nor reports/*.json", async () => {
    writePlan({
      updated_at: "2026-05-29T00:00:00.000Z",
      current_stage_id: null,
      stages: [],
      history: [],
    });
    writeStageDir("stage-002-empty", null);

    const svc = new PlanService(saivageDir);
    await svc.init();
    const report = await planBackfill(saivageDir, svc);

    expect(report.candidates).toHaveLength(0);
    expect(report.skipped.find((s) => s.stageId === "stage-002-empty")).toBeDefined();
  });

  it("orders candidates by (completed_at, id)", async () => {
    writePlan({
      updated_at: "2026-05-29T00:00:00.000Z",
      current_stage_id: null,
      stages: [],
      history: [],
    });
    writeStageDir("stage-002-b", makeSummary("stage-002-b", "2026-05-29T11:00:00.000Z"));
    writeStageDir("stage-001-a", makeSummary("stage-001-a", "2026-05-29T10:00:00.000Z"));

    const svc = new PlanService(saivageDir);
    await svc.init();
    const report = await planBackfill(saivageDir, svc);
    expect(report.candidates.map((c) => c.stageId)).toEqual([
      "stage-001-a",
      "stage-002-b",
    ]);
  });

  it("applyBackfill writes through plan_append_history; re-apply is a no-op", async () => {
    writePlan({
      updated_at: "2026-05-29T00:00:00.000Z",
      current_stage_id: null,
      stages: [],
      history: [],
    });
    writeStageDir("stage-001-foo", makeSummary("stage-001-foo"));

    const svc = new PlanService(saivageDir);
    await svc.init();
    const report = await planBackfill(saivageDir, svc);
    const r1 = await applyBackfill(svc, report);
    expect(r1.applied).toBe(1);
    expect(r1.errors).toEqual([]);

    // Re-running backfill now finds the stage in history → no candidates.
    const report2 = await planBackfill(saivageDir, svc);
    expect(report2.candidates).toHaveLength(0);
  });
});
