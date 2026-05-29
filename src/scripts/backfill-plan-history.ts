/**
 * Saivage — Plan history backfill script (Fix 2 / Stage B of
 * plan-persistence-fix).
 *
 * Walks <project>/.saivage/stages/ and synthesises a `CompletedStage`
 * entry for every directory whose id is not already in `plan.stages` or
 * `plan.history`. Writes through `PlanService.plan_append_history` so the
 * existing atomic tmp+rename guarantee applies.
 *
 * Usage:
 *   tsx src/scripts/backfill-plan-history.ts <project-saivage-dir> [--apply]
 *
 * Default mode is dry-run: prints JSON-Lines candidates + skipped entries
 * to stdout. With --apply, writes through PlanService.
 *
 * Exit codes:
 *   0 = clean,
 *   1 = error / lock held,
 *   2 = anomalies (duplicates / missing summaries) detected — operator review.
 *
 * See SPEC/plan-persistence-fix/03-plan.md §4 and
 * SPEC/plan-persistence-fix/02-architecture.md §3 for design.
 */

import { promises as fs } from "node:fs";
import { join } from "node:path";

import { PlanService } from "../mcp/plan-server.js";
import { acquireRuntimeLock } from "../runtime/recovery.js";
import {
  CompletedStageSchema,
  StageSummarySchema,
  TaskReportSchema,
  type CompletedStage,
  type StageSummary,
  type TaskReport,
} from "../types.js";

export interface BackfillCandidate {
  stageId: string;
  source: "summary" | "reports";
  completedStage: CompletedStage;
  anomalies: string[];
}

export interface BackfillReport {
  candidates: BackfillCandidate[];
  skipped: Array<{ stageId: string; reason: string }>;
}

function humaniseStageId(stageId: string): string {
  // "stage-362-c02-long-tail-discoverability-audit-slice" → human-ish objective text
  return stageId
    .replace(/^stage-\d+-?/i, "")
    .replace(/[-_]/g, " ")
    .trim() || stageId;
}

async function readJsonOrNull<T>(
  path: string,
  schema: { parse: (v: unknown) => T },
): Promise<T | null> {
  try {
    const raw = await fs.readFile(path, "utf8");
    return schema.parse(JSON.parse(raw));
  } catch {
    return null;
  }
}

async function loadSummary(stageDir: string): Promise<StageSummary | null> {
  return readJsonOrNull(join(stageDir, "summary.json"), StageSummarySchema);
}

async function loadReports(stageDir: string): Promise<TaskReport[]> {
  const reportsDir = join(stageDir, "reports");
  let entries: string[];
  try {
    entries = await fs.readdir(reportsDir);
  } catch {
    return [];
  }
  const reports: TaskReport[] = [];
  for (const name of entries) {
    if (!name.endsWith(".json")) continue;
    const r = await readJsonOrNull(join(reportsDir, name), TaskReportSchema);
    if (r) reports.push(r);
  }
  return reports;
}

function synthesiseFromSummary(s: StageSummary): CompletedStage {
  return {
    id: s.stage_id,
    objective: s.summary.slice(0, 1000) || humaniseStageId(s.stage_id),
    expected_outcomes: s.outcomes_achieved.length
      ? s.outcomes_achieved
      : ["[backfilled: no expected_outcomes recorded]"],
    actual_outcomes: s.outcomes_achieved,
    started_at: s.started_at,
    completed_at: s.completed_at,
    result: s.result,
    summary: s.summary,
    escalation: s.escalation,
    abort_reason: s.abort_reason,
  };
}

function synthesiseFromReports(
  stageId: string,
  reports: TaskReport[],
): CompletedStage | null {
  if (reports.length === 0) return null;
  const sorted = [...reports].sort((a, b) =>
    a.completed_at.localeCompare(b.completed_at),
  );
  const started = sorted[0].started_at;
  const completed = sorted[sorted.length - 1].completed_at;
  const allOk = reports.every((r) => r.status === "completed");
  const summaryText =
    "[backfilled from reports; no manager summary written]\n" +
    reports.map((r) => `- ${r.task_id} (${r.agent}/${r.status}): ${r.summary}`).join("\n");
  return {
    id: stageId,
    objective: humaniseStageId(stageId),
    expected_outcomes: ["[backfilled: no expected_outcomes recorded]"],
    actual_outcomes: reports.map((r) => `${r.task_id}: ${r.summary}`),
    started_at: started,
    completed_at: completed,
    result: allOk ? "completed" : "failed",
    summary: summaryText.slice(0, 8000),
  };
}

function sortCandidates(c: BackfillCandidate[]): BackfillCandidate[] {
  return [...c].sort((a, b) => {
    const t = a.completedStage.completed_at.localeCompare(
      b.completedStage.completed_at,
    );
    return t !== 0 ? t : a.stageId.localeCompare(b.stageId);
  });
}

/** Pure: read disk + PlanService current state → report. */
export async function planBackfill(
  saivageDir: string,
  planService: PlanService,
): Promise<BackfillReport> {
  const plan = await planService.plan_get();
  if ("code" in plan) {
    throw new Error(`plan_get failed: ${plan.code} ${plan.error}`);
  }
  const history = await planService.plan_get_history();
  if ("code" in history) {
    throw new Error(`plan_get_history failed: ${history.code} ${history.error}`);
  }
  const knownIds = new Set<string>([
    ...plan.stages.map((s) => s.id),
    ...history.stages.map((s) => s.id),
  ]);

  const stagesDir = join(saivageDir, "stages");
  let dirs: string[];
  try {
    dirs = await fs.readdir(stagesDir);
  } catch {
    return { candidates: [], skipped: [] };
  }

  const candidates: BackfillCandidate[] = [];
  const skipped: Array<{ stageId: string; reason: string }> = [];

  for (const name of dirs) {
    const stageDir = join(stagesDir, name);
    const st = await fs.stat(stageDir).catch(() => null);
    if (!st?.isDirectory()) continue;
    if (knownIds.has(name)) {
      skipped.push({ stageId: name, reason: "already in plan or history" });
      continue;
    }

    const summary = await loadSummary(stageDir);
    if (summary) {
      const completed = synthesiseFromSummary(summary);
      try {
        CompletedStageSchema.parse(completed);
      } catch (err) {
        skipped.push({
          stageId: name,
          reason: `summary schema mismatch: ${err instanceof Error ? err.message : String(err)}`,
        });
        continue;
      }
      candidates.push({
        stageId: name,
        source: "summary",
        completedStage: completed,
        anomalies: [],
      });
      continue;
    }

    const reports = await loadReports(stageDir);
    const completed = synthesiseFromReports(name, reports);
    if (!completed) {
      skipped.push({ stageId: name, reason: "no summary.json and no reports/*.json (presumed mid-flight)" });
      continue;
    }
    try {
      CompletedStageSchema.parse(completed);
    } catch (err) {
      skipped.push({
        stageId: name,
        reason: `reports synthesis failed schema: ${err instanceof Error ? err.message : String(err)}`,
      });
      continue;
    }
    candidates.push({
      stageId: name,
      source: "reports",
      completedStage: completed,
      anomalies: [
        "no summary.json",
        ...(completed.result === "failed" ? ["one or more tasks failed"] : []),
      ],
    });
  }

  return { candidates: sortCandidates(candidates), skipped };
}

/** Apply candidates through PlanService.plan_append_history. Idempotent. */
export async function applyBackfill(
  planService: PlanService,
  report: BackfillReport,
): Promise<{ applied: number; errors: Array<{ stageId: string; error: string }> }> {
  let applied = 0;
  const errors: Array<{ stageId: string; error: string }> = [];
  for (const c of report.candidates) {
    const r = await planService.plan_append_history(c.completedStage);
    if ("code" in r) {
      errors.push({ stageId: c.stageId, error: `${r.code}: ${r.error}` });
    } else {
      applied++;
    }
  }
  return { applied, errors };
}

export async function main(argv: string[]): Promise<number> {
  const args = argv.slice(2);
  const apply = args.includes("--apply");
  const positional = args.filter((a) => !a.startsWith("--"));
  if (positional.length !== 1) {
    process.stderr.write(
      "Usage: tsx src/scripts/backfill-plan-history.ts <project-saivage-dir> [--apply]\n",
    );
    return 1;
  }
  const saivageDir = positional[0];

  let lock;
  try {
    lock = await acquireRuntimeLock(saivageDir);
  } catch (err) {
    process.stderr.write(
      `runtime lock held — refusing to run while runtime is active: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return 1;
  }

  try {
    const planService = new PlanService(saivageDir);
    await planService.init();
    const report = await planBackfill(saivageDir, planService);

    for (const c of report.candidates) {
      process.stdout.write(
        JSON.stringify({ kind: "candidate", ...c }) + "\n",
      );
    }
    for (const s of report.skipped) {
      process.stdout.write(JSON.stringify({ kind: "skipped", ...s }) + "\n");
    }
    process.stdout.write(
      JSON.stringify({
        kind: "summary",
        candidates: report.candidates.length,
        skipped: report.skipped.length,
        will_apply: apply,
      }) + "\n",
    );

    const anomalies = report.candidates.some((c) => c.anomalies.length > 0);

    if (!apply) {
      return anomalies ? 2 : 0;
    }

    const result = await applyBackfill(planService, report);
    process.stdout.write(
      JSON.stringify({
        kind: "applied",
        applied: result.applied,
        errors: result.errors,
      }) + "\n",
    );
    if (result.errors.length > 0) return 2;
    return anomalies ? 2 : 0;
  } finally {
    if (lock) lock.release();
  }
}

// Direct CLI invocation guard. Works under both `tsx src/scripts/...` and
// `node dist/scripts/...` builds.
if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv).then(
    (code) => process.exit(code),
    (err) => {
      process.stderr.write(`fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
      process.exit(1);
    },
  );
}
