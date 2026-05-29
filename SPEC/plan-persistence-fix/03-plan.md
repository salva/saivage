# Saivage Plan-Persistence Drift — Implementation Plan

> Round 2 plan document for the plan-persistence-fix workstream.
> Builds on [01-analysis.md](saivage/SPEC/plan-persistence-fix/01-analysis.md) and [02-architecture.md](saivage/SPEC/plan-persistence-fix/02-architecture.md).
> Scope: the file-by-file, sequenced executable plan the orchestrator will follow. No new design.

---

## 1. Summary

This plan implements the three coordinated fixes from [02-architecture.md §1](saivage/SPEC/plan-persistence-fix/02-architecture.md) — a dispatcher invariant (Fix 1), a history backfill script (Fix 2), and a planner prompt rewrite (Fix 3) — and ships them in the safe order set by [02-architecture.md §5.1](saivage/SPEC/plan-persistence-fix/02-architecture.md): **Stage A = Fix 3 (prompt)**, **Stage B = Fix 2 (backfill)**, **Stage C = Fix 1 (gate)**. Stage A is the smallest change (two string constants plus structural, behavioural, and self-correction tests), Stage B is the most procedurally involved (a new admin-only `PlanService` method, a new in-tree script, a new test fixture set, and an offline run against the live codemacs project), and Stage C is the highest-blast-radius change (touches the dispatch hot path, adds a `PlanErrorCode`, and ships scripted-planner integration tests). Each stage is independently deployable, independently testable, and independently revertible.

---

## 2. Prerequisites

Before any stage starts:

1. **Clean git tree on both saivage checkouts.** `git -C /home/salva/g/salva/ml/saivage status` and `ssh saivage 'git -C /opt/saivage status'` both report nothing to commit.
2. **Approved precursor docs in place.** [01-analysis.md](saivage/SPEC/plan-persistence-fix/01-analysis.md) and [02-architecture.md](saivage/SPEC/plan-persistence-fix/02-architecture.md) committed on the working branch.
3. **Runtime is stoppable.** `ssh saivage 'systemctl status saivage.service'` shows the service running and there are no in-flight `plan_*` MCP calls that would lose work to a restart (check journal for the last 60 s).
4. **Plan-document backup committed.** Before Stage B touches [codemacs/.saivage/plan.json](codemacs/.saivage/plan.json), commit its current contents under the workspace repo so the file is recoverable via `git checkout`:
   ```bash
   cd /home/salva/g/salva/ml/codemacs
   git add .saivage/plan.json .saivage/plan-history.json
   git commit -m "[plan-persistence-fix] backup plan.json/plan-history.json before backfill"
   ```
   (If those paths are gitignored, copy to `.saivage/tmp/backup/plan-YYYYMMDD.json` instead and note the path. The legacy `plan-history.json` mirror is read-only today — Stage B writes only `plan.json`'s embedded `history`.)
5. **Baseline test run is green.** `npm test` and `npm run typecheck` pass on the saivage checkout before any change lands. Record the elapsed time so post-stage runs can be compared.

---

## 3. Stage A — Fix 3: Planner Prompt Update

### 3.1 Files touched

| File | What changes |
| --- | --- |
| [saivage/src/server/bootstrap.ts](saivage/src/server/bootstrap.ts#L575-L599) | Rewrite the `RECOVERY_PROMPT` and `CONTINUOUS_IMPROVEMENT_PROMPT` string constants per [02-architecture.md §4.2](saivage/SPEC/plan-persistence-fix/02-architecture.md); add `export` to both constants so the new test files can import them. |
| [saivage/src/server/prompt-snapshots.test.ts](saivage/src/server/prompt-snapshots.test.ts) | NEW. Vitest snapshot + structural content guards for the two prompt constants. |
| [saivage/src/server/prompt-tool-sequence.test.ts](saivage/src/server/prompt-tool-sequence.test.ts) | NEW. Behavioural test using a stubbed LLM driver to assert the planner's first three tool calls under each prompt follow `plan_add_stage` → `plan_set_current` → `run_manager`. |
| [saivage/src/server/prompt-self-correction.test.ts](saivage/src/server/prompt-self-correction.test.ts) | NEW. Stubbed dispatcher returns `STAGE_MISMATCH` on the first `run_manager`; asserts the planner's next tool call is `plan_set_current` (or `plan_add_stage` when the stage is also absent), not a re-dispatch. |

All three test files are placed alongside their target (the repo convention is colocated `*.test.ts`, e.g. [saivage/src/server/bootstrap.test.ts](saivage/src/server/bootstrap.test.ts) — there is no `__tests__/` subdirectory in `src/`). Vitest already picks them up via `src/**/*.test.ts` in [saivage/vitest.config.ts](saivage/vitest.config.ts#L13-L17).

### 3.2 Edit — `RECOVERY_PROMPT` ([bootstrap.ts L575-L585](saivage/src/server/bootstrap.ts#L575-L585))

The existing constant has steps 1-5. Insert a **"Plan-mutation contract"** block between step 2 (read history) and step 3 (assess) per [02-architecture.md §4.3](saivage/SPEC/plan-persistence-fix/02-architecture.md). Shape:

```text
export const RECOVERY_PROMPT =
  "SYSTEM RECOVERY: ...\n\n" +
  "1. Call plan_get() ...\n" +
  "2. Call plan_get_history() ...\n\n" +
  "PLAN-MUTATION CONTRACT (mandatory before any run_manager call):\n" +
  "  a. The stage must exist in plan.stages (use plan_add_stage if new).\n" +
  "  b. plan.current_stage_id must equal the stage id (use plan_set_current).\n" +
  "  c. Only then call run_manager(stage).\n" +
  "  d. When the manager returns, call plan_complete_stage with the result.\n" +
  "If run_manager rejects with STAGE_NOT_FOUND, STAGE_MISMATCH, or PLAN_NOT_FOUND,\n" +
  "the dispatcher is telling you a precondition tool was skipped. Call the missing\n" +
  "tool and retry the SAME stage — do not invent a different stage and do not escalate.\n\n" +
  "3. Assess what work remains ...\n" +
  "4. If escalated stages exist ...\n" +
  "5. Following the contract above, call plan_set_current() on the next stage and dispatch with run_manager().\n\n" +
  "DO NOT call plan_done unless ...";
```

The `plan_add_stage` reminder is the substantive change in `RECOVERY_PROMPT`; today's text mentions only `plan_set_current` ([02-architecture.md §4.2](saivage/SPEC/plan-persistence-fix/02-architecture.md)).

### 3.3 Edit — `CONTINUOUS_IMPROVEMENT_PROMPT` ([bootstrap.ts L587-L599](saivage/src/server/bootstrap.ts#L587-L599))

Same contract block, plus a worked example. Shape:

```text
export const CONTINUOUS_IMPROVEMENT_PROMPT =
  "SYSTEM CONTINUOUS IMPROVEMENT: ...\n\n" +
  "PLAN-MUTATION CONTRACT (mandatory before any run_manager call):\n" +
  "  1) plan_add_stage(stage)        // register the stage in plan.json\n" +
  "  2) plan_set_current(stage.id)   // mark it active; stamps started_at\n" +
  "  3) run_manager(stage)           // dispatch — dispatcher enforces 1 & 2\n" +
  "  4) plan_complete_stage(...)     // move to history with the result\n" +
  "Skipping any of (1)-(2) causes run_manager to reject with STAGE_NOT_FOUND or\n" +
  "STAGE_MISMATCH. On rejection, run the missing tool and retry the SAME stage.\n\n" +
  "On this cycle:\n" +
  "1. Call plan_get() and plan_get_history() ...\n" +
  "2. Re-read the project objectives ...\n" +
  "3. If the project is an ML/research project ...\n" +
  "4. Once the data foundation is credible ...\n" +
  "5. Only create maintenance, QA, documentation, or hardening stages ...\n" +
  "6. Because plan.json already exists in continuous-improvement cycles, DO NOT call plan_init().\n" +
  "   Create at least one concrete, bounded next stage with plan_add_stage(). (plan_set_stages is\n" +
  "   also acceptable but plan_add_stage is preferred for single-stage additions.)\n" +
  "7. Following the contract above, call plan_set_current(stage.id) and then run_manager(stage).\n\n" +
  "Only call plan_done if continuous-improvement mode has been disabled ...";
```

Preserve every existing strategic-heuristic bullet verbatim; only insert the contract block at the top and update steps 6-7 to reference it.

### 3.4 Tests — structural ([prompt-snapshots.test.ts](saivage/src/server/prompt-snapshots.test.ts))

```ts
import { describe, it, expect } from "vitest";
import { RECOVERY_PROMPT, CONTINUOUS_IMPROVEMENT_PROMPT } from "./bootstrap.js";

describe("planner prompt contract (Fix 3) — structural", () => {
  it("RECOVERY_PROMPT names the four-call mutation contract", () => {
    for (const tool of ["plan_add_stage", "plan_set_current", "run_manager", "plan_complete_stage"]) {
      expect(RECOVERY_PROMPT).toContain(tool);
    }
  });
  it("RECOVERY_PROMPT teaches recovery from STAGE_MISMATCH/STAGE_NOT_FOUND/PLAN_NOT_FOUND", () => {
    for (const code of ["STAGE_MISMATCH", "STAGE_NOT_FOUND", "PLAN_NOT_FOUND"]) {
      expect(RECOVERY_PROMPT).toContain(code);
    }
  });
  it("CONTINUOUS_IMPROVEMENT_PROMPT names plan_add_stage AND plan_set_current before run_manager", () => {
    const addIdx = CONTINUOUS_IMPROVEMENT_PROMPT.indexOf("plan_add_stage");
    const setIdx = CONTINUOUS_IMPROVEMENT_PROMPT.indexOf("plan_set_current");
    const runIdx = CONTINUOUS_IMPROVEMENT_PROMPT.indexOf("run_manager");
    expect(addIdx).toBeGreaterThan(-1);
    expect(setIdx).toBeGreaterThan(addIdx);
    expect(runIdx).toBeGreaterThan(setIdx);
  });
  it("CONTINUOUS_IMPROVEMENT_PROMPT still forbids plan_init", () => {
    expect(CONTINUOUS_IMPROVEMENT_PROMPT).toMatch(/DO NOT call\s+plan_init/);
  });
  it("RECOVERY_PROMPT snapshot", () => { expect(RECOVERY_PROMPT).toMatchSnapshot(); });
  it("CONTINUOUS_IMPROVEMENT_PROMPT snapshot", () => { expect(CONTINUOUS_IMPROVEMENT_PROMPT).toMatchSnapshot(); });
});
```

These cover the snapshot-regression check + content guards from [02-architecture.md §4.5](saivage/SPEC/plan-persistence-fix/02-architecture.md).

### 3.5 Tests — behavioural ([prompt-tool-sequence.test.ts](saivage/src/server/prompt-tool-sequence.test.ts))

This file exercises the requirement from [02-architecture.md §4.5](saivage/SPEC/plan-persistence-fix/02-architecture.md) that "under both `RECOVERY_PROMPT` and `CONTINUOUS_IMPROVEMENT_PROMPT` the model's first three tool calls follow the `plan_add_stage` → `plan_set_current` → `run_manager` order." Uses a deterministic stub LLM driver injected into `runPlanner` via the `runtime.router` seam already used in [saivage/src/server/bootstrap.test.ts](saivage/src/server/bootstrap.test.ts):

```ts
describe("planner prompt tool sequence (Fix 3)", () => {
  it("emits plan_add_stage → plan_set_current → run_manager under RECOVERY_PROMPT", async () => {
    const calls: string[] = [];
    const runtime = await makeStubRuntime({
      directives: [RECOVERY_PROMPT],
      onToolCall: (name) => calls.push(name),
      // Stub LLM: pattern-match the prompt for the contract block, then
      // emit the four tool calls in order; first three are the assertion.
      stubLLM: contractCompliantPlanner(),
    });
    await runPlanner(runtime);
    expect(calls.slice(0, 3)).toEqual(["plan_add_stage", "plan_set_current", "run_manager"]);
  });

  it("emits plan_add_stage → plan_set_current → run_manager under CONTINUOUS_IMPROVEMENT_PROMPT", async () => {
    /* same shape, directives:[CONTINUOUS_IMPROVEMENT_PROMPT] */
  });
});
```

`makeStubRuntime`, `contractCompliantPlanner`, and the directive-injection helper are added as test-only utilities at the top of the file — no production code is added beyond the `export` keywords from §3.2/§3.3.

### 3.6 Tests — self-correction ([prompt-self-correction.test.ts](saivage/src/server/prompt-self-correction.test.ts))

Asserts the §4.4 self-recovery clause from [02-architecture.md](saivage/SPEC/plan-persistence-fix/02-architecture.md): when the dispatcher rejects `run_manager` with `STAGE_MISMATCH`, the planner's *next* tool call is the missing precondition tool, not a re-dispatch or a `plan_done`.

```ts
describe("planner self-correction (Fix 3)", () => {
  it("on STAGE_MISMATCH, next call is plan_set_current for the same stage", async () => {
    const calls: { name: string; args: unknown }[] = [];
    const runtime = await makeStubRuntime({
      directives: [RECOVERY_PROMPT],
      onToolCall: (name, args) => calls.push({ name, args }),
      stubLLM: planComplyingReader(),                      // emits plan_get → plan_get_history → run_manager(stage-X)
      stubDispatcher: rejectFirstWith("STAGE_MISMATCH", "stage-X exists but not current"),
    });
    await runPlanner(runtime);
    const runIdx = calls.findIndex((c) => c.name === "run_manager");
    expect(calls[runIdx + 1]?.name).toBe("plan_set_current");
    expect((calls[runIdx + 1]?.args as { stage_id: string }).stage_id).toBe("stage-X");
  });

  it("on STAGE_NOT_FOUND, next call is plan_add_stage for the same stage", async () => { /* … */ });
  it("does NOT re-emit run_manager before the missing precondition tool runs", async () => { /* … */ });
});
```

`rejectFirstWith(code, msg)` is a tiny harness around the `ChildSpawner` interface returning an `AgentResult` of kind `failure` with `reason: { code, error: msg }` — the same shape Fix 1 introduces (Stage C §5.3). The test depends on the structured-reason carry-through; if it lands before Stage C ships, gate the assertion on the planner-side serialiser landing first (commit Stage A's test in `it.skip` and re-enable in Stage C). The orchestrator should not skip these.

### 3.7 Validation

- `npm run typecheck` — confirms the new exports type-check.
- `npm test -- prompt-snapshots prompt-tool-sequence prompt-self-correction` — new tests pass.
- `npm test` — full suite still green.
- `npm run lint` — no new lint errors.
- Spot-check: open the rendered prompt and read it as if you were the planner; ensure the contract block is the first thing after the read calls.

---

## 4. Stage B — Fix 2: History Replay Script

### 4.1 Files touched / added

| File | Purpose |
| --- | --- |
| [saivage/src/mcp/plan-server.ts](saivage/src/mcp/plan-server.ts#L48-L290) | Add a new admin-only public method `plan_append_history(stage: CompletedStage)` on `PlanService`. **Not** added to `PLAN_WRITER_TOOLS` and **not** returned by `PlanService.getToolSchemas()` — it is a class method called only by the Stage B script, never exposed over MCP. |
| [saivage/src/scripts/backfill-plan-history.ts](saivage/src/scripts/backfill-plan-history.ts) | NEW. The script. Importable as a module **and** runnable as a CLI via `tsx`. |
| [saivage/src/scripts/backfill-plan-history.test.ts](saivage/src/scripts/backfill-plan-history.test.ts) | NEW. Unit + integration tests. |
| [saivage/src/scripts/__fixtures__/](saivage/src/scripts) | NEW directory. Minimal sanitised stage-dir fixtures (one `summary.json`-bearing stage, one `reports/`-only stage, one empty). |
| [saivage/package.json](saivage/package.json#L11-L25) | Add `"backfill-history": "tsx src/scripts/backfill-plan-history.ts"` to `scripts`. |

The script lives under [saivage/src/scripts/](saivage/src) deliberately:

- [saivage/tsconfig.json](saivage/tsconfig.json) declares `include: ["src/**/*.ts"]` — the script and its tests are covered by `npm run typecheck` automatically.
- [saivage/package.json](saivage/package.json#L20) declares `"lint": "eslint src/"` — covered by `npm run lint` automatically.
- Vitest already includes `src/**/*.test.ts` per [vitest.config.ts](saivage/vitest.config.ts#L13-L17) — no config change required.
- `tsup` builds from `src/` so the script lands in `dist/` for production deploys too (the deployed runtime can invoke it via `node dist/scripts/backfill-plan-history.js`); during the Stage B operational run we use `tsx` against source for simplicity.

`tsx` is already a devDependency in [package.json](saivage/package.json#L73), so the new npm script needs no new deps.

### 4.2 Edit — `PlanService.plan_append_history` ([plan-server.ts](saivage/src/mcp/plan-server.ts#L48-L290))

Public method, validation-gated, idempotent on the duplicate-id case. Sketch:

```ts
/**
 * Admin-only: append a synthesised CompletedStage directly to history.
 * NOT exposed as an MCP tool; intended exclusively for the offline backfill
 * script at src/scripts/backfill-plan-history.ts. Writes via writeDoc so the
 * atomic tmp+rename guarantee and in-memory cache invalidation still apply.
 */
async plan_append_history(stage: CompletedStage): Promise<{ history_len: number } | PlanError> {
  if (!this.doc) return planError("PLAN_NOT_FOUND", "plan.json does not exist.");
  try {
    CompletedStageSchema.parse(stage);
  } catch (err) {
    return planError("VALIDATION_ERROR", err instanceof Error ? err.message : String(err));
  }
  if (this.doc.stages.some((s) => s.id === stage.id)) {
    return planError("STAGE_EXISTS", `Stage '${stage.id}' is in active plan.stages; refusing to append to history.`);
  }
  if (this.doc.history.some((s) => s.id === stage.id)) {
    return planError("STAGE_EXISTS", `Stage '${stage.id}' already in history; refusing to duplicate.`);
  }
  const nextDoc = structuredClone(this.doc);
  nextDoc.history.push(stage);
  nextDoc.updated_at = new Date().toISOString();
  await this.writeDoc(nextDoc);
  return { history_len: nextDoc.history.length };
}
```

Why a new method instead of the existing `plan_init` + `plan_complete_stage` path: `plan_complete_stage` requires the stage to first be present in `plan.stages` with a non-null `started_at` ([plan-server.ts L262-L275](saivage/src/mcp/plan-server.ts#L262-L275)). Synthesising that interim state from disk would round-trip every stage through the active-plan list and the `archiveStage` side effect at [plan-server.ts L290-L295](saivage/src/mcp/plan-server.ts#L290-L295), neither of which is appropriate for a historical backfill.

Why not expose it as an MCP tool: every entry in `PLAN_WRITER_TOOLS` ([plan-server.ts L29-L37](saivage/src/mcp/plan-server.ts#L29-L37)) becomes callable by the planner, broadening its capacity to corrupt history. Keeping `plan_append_history` as a TypeScript-only public method confines its blast radius to the backfill script. A unit test in the existing plan-server suite (or a new colocated `src/mcp/plan-server.test.ts` if one does not yet exist) asserts `PLAN_WRITER_TOOLS` does **not** contain `"plan_append_history"` to prevent accidental exposure.

### 4.3 Module structure — [src/scripts/backfill-plan-history.ts](saivage/src/scripts/backfill-plan-history.ts)

Exported surface (signatures only — exact implementation per [02-architecture.md §3](saivage/SPEC/plan-persistence-fix/02-architecture.md)):

```ts
import { PlanService } from "../mcp/plan-server.js";
import type { CompletedStage } from "../types.js";

export interface BackfillCandidate {
  stageId: string;
  source: "summary" | "reports";
  completedStage: CompletedStage;       // synthesised, validates against CompletedStageSchema
  anomalies: string[];                  // e.g. "no summary.json", "2 of 3 tasks failed"
}

export interface BackfillReport {
  candidates: BackfillCandidate[];      // ordered by (completed_at, id)
  skipped: Array<{ stageId: string; reason: string }>;
  resultingHistorySha256: string;       // SHA over JSON.stringify(history.concat(candidates))
}

/** Pure: read stage dirs + current PlanService; produce the report. */
export async function planBackfill(
  saivageDir: string,
  planService: PlanService,
): Promise<BackfillReport>;

/** Apply the report through PlanService.plan_append_history (§4.2). Idempotent. */
export async function applyBackfill(
  planService: PlanService,
  report: BackfillReport,
): Promise<{ applied: number; finalSha256: string }>;

/** CLI entrypoint. */
export async function main(argv: string[]): Promise<number>;
```

CLI semantics, per [02-architecture.md §3.5](saivage/SPEC/plan-persistence-fix/02-architecture.md):

```
Usage: tsx src/scripts/backfill-plan-history.ts <project-saivage-dir> [--apply]
   or: npm run backfill-history -- <project-saivage-dir> [--apply]

Default mode: dry-run. Prints JSON-Lines of candidates + skipped entries to stdout.
With --apply: acquires the runtime lock, writes via PlanService.plan_append_history,
              prints final sha256.
Exit codes: 0 = clean, 2 = anomalies present (script suggests review), 1 = error/lock-held.
```

Helpers inside the module (not exported):

- `readStageDirs(saivageDir): Promise<string[]>` — list `saivage/stages/`.
- `loadSummary(stageDir): Promise<StageSummary | null>` — read `summary.json` if present.
- `loadReports(stageDir): Promise<TaskReport[]>` — read all `reports/*.json`.
- `synthesiseFromSummary(summary): CompletedStage` — maps `StageSummary` → `CompletedStage` per [02-architecture.md §3.1](saivage/SPEC/plan-persistence-fix/02-architecture.md).
- `synthesiseFromReports(stageId, tasks, reports): CompletedStage` — fallback path; sets `summary` field to `"[backfilled from reports; no manager summary written]"`.
- `sortCandidates(c): BackfillCandidate[]` — sort by `(completed_at, id)`.

Lock-acquisition reuses `acquireRuntimeLock` from [saivage/src/server/bootstrap.ts](saivage/src/server/bootstrap.ts#L207-L213) (it must be `export`ed if not already — verify with a grep before the edit; if internal, expose it via a new export).

### 4.4 Tests — [src/scripts/backfill-plan-history.test.ts](saivage/src/scripts/backfill-plan-history.test.ts)

One file, matching the [02-architecture.md §3.6](saivage/SPEC/plan-persistence-fix/02-architecture.md) outline:

```ts
describe("backfill-plan-history", () => {
  it("synthesises a valid CompletedStage from a real summary.json fixture", …);
  it("falls back to reports/*.json when summary.json is absent", …);
  it("classifies as 'failed' when any task report has status!=completed and no summary", …);
  it("skips empty stage directories (no tasks.json, no reports)", …);
  it("skips stages already present in plan.stages", …);
  it("skips stages already present in plan.history (duplicate-id guard)", …);
  it("orders candidates deterministically by (completed_at, id)", …);
  it("is idempotent: second apply on the same fixture is a no-op", …);
  it("refuses to run when the runtime lock is held", …);
  it("rejects when PlanService.plan_append_history returns STAGE_EXISTS (defence in depth)", …);

  describe("CLI", () => {
    it("--dry-run (default) writes JSON-Lines to stdout and never touches plan.json", …);
    it("--apply writes through PlanService and prints final sha256", …);
    it("exits 2 when anomalies (duplicates / missing summaries) are present", …);
  });
});
```

Fixtures live in [saivage/src/scripts/__fixtures__/](saivage/src/scripts). Build minimal stage-dir trees in `beforeEach` using `mkdtempSync` (mirroring [bootstrap.test.ts L24-L29](saivage/src/server/bootstrap.test.ts#L24-L29)). For the "real summary" test, copy a single sanitised summary from [codemacs/.saivage/stages/stage-362-c02-long-tail-discoverability-audit-slice/](codemacs/.saivage/stages/stage-362-c02-long-tail-discoverability-audit-slice/) into the fixtures directory at commit time so the test is hermetic.

### 4.5 Operational steps against the live codemacs project

Run from the saivage LXC against the bind-mounted codemacs project (per repo memory at `/memories/repo/saivage-runtime-state.md` the bind mount is `/work/codemacs`). The runtime must be stopped first per [02-architecture.md §5.3](saivage/SPEC/plan-persistence-fix/02-architecture.md).

```bash
# 0. On the host, deploy the script to /opt/saivage
ssh saivage 'systemctl stop saivage.service'
ssh saivage 'git -C /opt/saivage pull --ff-only && cd /opt/saivage && npm ci && npm run build'

# 1. Dry-run — never writes
ssh saivage 'cd /opt/saivage && npx tsx src/scripts/backfill-plan-history.ts /work/codemacs/.saivage' | tee /tmp/backfill-dry.jsonl

# 2. Operator review: open /tmp/backfill-dry.jsonl. Confirm:
#    - candidate count matches the on-disk evidence (stage-341..362 minus any
#      already in history; analysis cites stage-348..362 as the visible window).
#    - no unexpected "duplicate" or "missing summary + incomplete reports" anomalies.

# 3. Apply
ssh saivage 'cd /opt/saivage && npx tsx src/scripts/backfill-plan-history.ts /work/codemacs/.saivage --apply'

# 4. Verify on disk
ssh saivage 'jq ".history | length, (.history[-1] | {id, completed_at, result})" /work/codemacs/.saivage/plan.json'

# 5. Restart
ssh saivage 'systemctl start saivage.service'

# 6. Verify via HTTP that the dashboard now reflects history
ssh saivage 'curl -sf http://127.0.0.1:8080/api/plan | jq ".history.stages | length"'
```

If step 4 or 6 disagrees with the dry-run count, **stop** and consult the rollback plan (§7).

### 4.6 Validation

- `npm run typecheck` — covers the script and its tests via `src/**/*.ts`.
- `npm run lint` — covers `src/scripts/` via `eslint src/`.
- `npm test -- backfill-plan-history` passes.
- Operational steps 4 and 6 above both report a non-empty, monotonically-non-decreasing history.

---

## 5. Stage C — Fix 1: Dispatcher Invariant

### 5.1 Files touched

| File | What changes |
| --- | --- |
| [saivage/src/mcp/plan-server.ts](saivage/src/mcp/plan-server.ts#L48-L54) | Add `"STAGE_MISMATCH"` to the `PlanErrorCode` union. |
| [saivage/src/server/bootstrap.ts](saivage/src/server/bootstrap.ts#L329-L385) | New helper `assertStageDispatchable` inside `createChildSpawner` closure; call it at the top of the `case "manager":` arm before `ManagerAgent.create`; log + publish on rejection. |
| [saivage/src/agents/types.ts](saivage/src/agents/types.ts) | Widen `AgentResult.reason` to accept `{ code: string; error: string }` (see §5.3). |
| [saivage/src/agents/planner.ts](saivage/src/agents/planner.ts#L72-L101) | Serialise the structured `reason` into the tool-result string returned to the model. |
| [saivage/src/server/dispatcher-gate.test.ts](saivage/src/server/dispatcher-gate.test.ts) | NEW. Unit tests for the four pass/fail cases per [02-architecture.md §2.5](saivage/SPEC/plan-persistence-fix/02-architecture.md). |
| [saivage/src/server/dispatcher-gate-integration.test.ts](saivage/src/server/dispatcher-gate-integration.test.ts) | NEW. Scripted-planner integration: happy path (compliant tool sequence ⇒ manager runs) and skip-precondition path (planner omits `plan_set_current` ⇒ gate rejects, manager never constructed, planner self-corrects). |

### 5.2 Edit — [plan-server.ts L48-L54](saivage/src/mcp/plan-server.ts#L48-L54)

Single-line addition to the union:

```ts
export type PlanErrorCode =
  | "PLAN_NOT_FOUND"
  | "STAGE_NOT_FOUND"
  | "STAGE_EXISTS"
  | "STAGE_MISMATCH"      // NEW (Fix 1): stage exists but is not current_stage_id
  | "VALIDATION_ERROR"
  | "IO_ERROR";
```

No new tool, no new method on `PlanService`; the dispatcher constructs the `PlanError` shape directly using the existing `planError` factory pattern from [plan-server.ts L62-L64](saivage/src/mcp/plan-server.ts#L62-L64) (replicated locally in the dispatcher — `planError` is not exported and we keep it that way to avoid coupling).

### 5.3 Edit — [bootstrap.ts L329-L385](saivage/src/server/bootstrap.ts#L329-L385)

Inside `createChildSpawner` (after the `cacheStageWorker` helper at [L341-L350](saivage/src/server/bootstrap.ts#L341-L350)), add the gate helper:

```ts
async function assertStageDispatchable(
  stage: { id?: string } | undefined,
): Promise<{ ok: true } | { ok: false; failure: AgentResult }> {
  const id = stage?.id?.trim();
  if (!id) {
    return { ok: false, failure: buildGateFailure("VALIDATION_ERROR",
      "run_manager: stage.id is required") };
  }

  const planView = await runtime.planService.plan_get();
  if ("code" in planView) {
    return { ok: false, failure: buildGateFailure(planView.code, planView.error) };
  }

  if (planView.current_stage_id !== id) {
    const known = planView.stages.some((s) => s.id === id);
    const code = known ? "STAGE_MISMATCH" : "STAGE_NOT_FOUND";
    const msg = known
      ? `run_manager: stage '${id}' exists but current_stage_id is '${planView.current_stage_id ?? "null"}'. Call plan_set_current('${id}') first.`
      : `run_manager: stage '${id}' is not in plan.stages. Call plan_add_stage(...) and plan_set_current('${id}') first.`;
    return { ok: false, failure: buildGateFailure(code, msg) };
  }

  const stageEntry = planView.stages.find((s) => s.id === id);
  if (!stageEntry?.started_at) {
    return { ok: false, failure: buildGateFailure("VALIDATION_ERROR",
      `run_manager: stage '${id}' has no started_at; plan_set_current was never called`) };
  }

  return { ok: true };
}

function buildGateFailure(code: PlanErrorCode, message: string): AgentResult {
  log.warn(`[dispatch-gate] rejected run_manager: ${code} — ${message}`);
  void runtime.eventBus.publish({
    type: "plan_updated",
    summary: `Dispatch rejected (${code}): ${message}`,
    timestamp: new Date().toISOString(),
  });
  return {
    kind: "failure",
    reason: { code, error: message },
  } as AgentResult;
}
```

Then modify the manager arm at [L373-L383](saivage/src/server/bootstrap.ts#L373-L383):

```ts
case "manager": {
  const managerInput = input as import("../agents/types.js").ManagerInput;
  const gate = await assertStageDispatchable(managerInput.stage);
  if (!gate.ok) return gate.failure;     // ← NEW: rejection short-circuits

  const managerSpawner = createChildSpawner(runtime);
  ctx.stageId = managerInput.stage?.id;
  agent = await ManagerAgent.create(ctx, managerInput, managerSpawner, {
    onActivity: (agentId) => tracker.agentActivity(agentId),
    onCompactionUpdate: tracker.agentCompactionUpdate.bind(tracker),
  });
  tracker.setCurrentStage(managerInput.stage?.id ?? null);
  break;
}
```

Per [02-architecture.md §2.2](saivage/SPEC/plan-persistence-fix/02-architecture.md), the gate runs **before** `tracker.setCurrentStage` and **before** `ManagerAgent.create`. Per [02-architecture.md §2.4](saivage/SPEC/plan-persistence-fix/02-architecture.md), the worker arm is **not** modified except for an optional warning log; defer that warning to a follow-up if it complicates the diff.

`AgentResult`'s `failure` variant must accept the structured `{code, error}` payload. Read its current shape in [src/agents/types.ts](saivage/src/agents/types.ts) before editing; if `reason` is currently typed as `string`, widen it to `string | { code: string; error: string }` and update the planner-side consumer at [planner.ts L72-L101](saivage/src/agents/planner.ts#L72-L101) to serialise the structured form into the tool result before re-displaying to the model (e.g. `typeof reason === "string" ? reason : `${reason.code}: ${reason.error}``). This is the "structured payload" requirement from [02-architecture.md §2.3](saivage/SPEC/plan-persistence-fix/02-architecture.md).

Import additions at the top of [bootstrap.ts](saivage/src/server/bootstrap.ts):

```ts
import type { PlanErrorCode } from "../mcp/plan-server.js";
```

### 5.4 Tests — unit ([dispatcher-gate.test.ts](saivage/src/server/dispatcher-gate.test.ts))

New file, expanding the existing tmpdir fixture pattern at [bootstrap.test.ts L24-L29](saivage/src/server/bootstrap.test.ts#L24-L29). Use a real `PlanService` against the tmp `.saivage/` (cheaper than stubbing — `PlanService` has no network deps).

```ts
describe("dispatcher manager-gate (Fix 1)", () => {
  it("rejects with PLAN_NOT_FOUND when plan.json does not exist", …);
  it("rejects with STAGE_NOT_FOUND when stage id is not in plan.stages", …);
  it("rejects with STAGE_MISMATCH when stage exists but is not current_stage_id", …);
  it("rejects with VALIDATION_ERROR when current stage has no started_at", …);
  it("rejects with VALIDATION_ERROR when stage.id is missing/empty", …);
  it("does not call tracker.setCurrentStage on any rejection", …);
  it("does not construct a ManagerAgent on any rejection", …);
  it("admits the dispatch when plan_init+plan_add_stage+plan_set_current have all run", …);
  it("publishes a plan_updated event on rejection (Fix 1 observability)", …);
});
```

The "does not construct ManagerAgent" assertion uses `vi.spyOn(ManagerAgent, "create")` — preferred over running the real manager which would need an LLM stub. Mirrors the librarian-branch test pattern already in place in [bootstrap.test.ts](saivage/src/server/bootstrap.test.ts).

### 5.5 Tests — integration ([dispatcher-gate-integration.test.ts](saivage/src/server/dispatcher-gate-integration.test.ts))

Covers the scripted-planner cases required by [02-architecture.md §2.5](saivage/SPEC/plan-persistence-fix/02-architecture.md): happy path and skip-precondition path. Reuses the `makeStubRuntime` / `stubLLM` harness introduced in Stage A's [prompt-tool-sequence.test.ts](saivage/src/server/prompt-tool-sequence.test.ts) (factor a shared helper into [src/server/test-helpers.ts](saivage/src/server/test-helpers.ts) when the second test consumer lands; both Stage A and Stage C test files import from it).

```ts
describe("dispatcher gate — scripted planner (Fix 1 integration)", () => {
  it("happy path: planner emits plan_init → plan_add_stage → plan_set_current → run_manager; manager runs once", async () => {
    const events: string[] = [];
    const runtime = await makeStubRuntime({
      stubLLM: contractCompliantPlanner({ stageId: "stage-A" }),
      onToolCall: (name) => events.push(`tool:${name}`),
      onManagerCreate: () => events.push("manager:create"),
    });
    await runPlanner(runtime);
    expect(events).toContain("manager:create");
    expect(events.filter((e) => e === "manager:create")).toHaveLength(1);
  });

  it("skip-precondition path: planner emits run_manager without plan_set_current; gate rejects with STAGE_MISMATCH, manager never created, next tool call is plan_set_current", async () => {
    const events: { name: string; result?: string }[] = [];
    const runtime = await makeStubRuntime({
      stubLLM: skipsPlanSetCurrent({ stageId: "stage-B" }),
      onToolCall: (name, _args, result) => events.push({ name, result }),
      onManagerCreate: () => events.push({ name: "manager:create" }),
    });
    await runPlanner(runtime);
    expect(events.find((e) => e.name === "manager:create")).toBeUndefined();
    const firstRun = events.findIndex((e) => e.name === "run_manager");
    expect(events[firstRun].result).toMatch(/STAGE_MISMATCH/);
    expect(events[firstRun + 1].name).toBe("plan_set_current");
  });
});
```

### 5.6 Validation

- `npm run typecheck` — confirms the widened `AgentResult.reason` type compiles across all consumers.
- `npm test -- dispatcher-gate` — both new gate test files pass.
- `npm test` — full suite green (this catches incidental breakage in planner / manager tests that depend on the old `reason: string` shape).
- `npm run lint` — clean.
- Smoke on the saivage LXC after deploy (see §6).

---

## 6. Deployment Steps

All deployment commands assume host = workstation, target = saivage LXC. Per repo memory at `/memories/repo/saivage-runtime-state.md`: the deployed source lives at `/opt/saivage` (separate git checkout from the host workspace), the service is `saivage.service`, it binds `0.0.0.0:8080`, and codemacs is bind-mounted at `/work/codemacs`. Each stage push uses the same primitive:

```bash
# Stage <X> deploy primitive
git -C /home/salva/g/salva/ml/saivage push origin <branch>
ssh saivage 'git -C /opt/saivage fetch && git -C /opt/saivage checkout <branch> && git -C /opt/saivage pull --ff-only'
ssh saivage 'cd /opt/saivage && npm ci && npm run build'
ssh saivage 'systemctl restart saivage.service'
```

### 6.1 Stage A deploy (Fix 3)

```bash
# 1. Commit Fix 3 locally
cd /home/salva/g/salva/ml/saivage
git checkout -b plan-persistence-fix/03-stage-a-prompt
# (edits as per §3)
npm run lint && npm run typecheck && npm test
git add src/server/bootstrap.ts \
        src/server/prompt-snapshots.test.ts \
        src/server/prompt-tool-sequence.test.ts \
        src/server/prompt-self-correction.test.ts \
        src/server/__snapshots__
git commit -m "[plan-persistence-fix] Stage A: planner prompt contract (Fix 3)"
git push origin plan-persistence-fix/03-stage-a-prompt

# 2. Deploy
ssh saivage 'git -C /opt/saivage fetch && git -C /opt/saivage checkout plan-persistence-fix/03-stage-a-prompt && git -C /opt/saivage pull --ff-only'
ssh saivage 'cd /opt/saivage && npm ci && npm run build'
ssh saivage 'systemctl restart saivage.service'

# 3. Verify the new planner session picked up the directive
ssh saivage 'systemctl is-active saivage.service'
ssh saivage 'curl -sf http://127.0.0.1:8080/api/plan | jq ".plan.current_stage_id // \"none\""'
# Wait ~30s for first planner restart cycle, then confirm the planner is
# emitting the expected READ-phase tools (acceptance text below):
ssh saivage 'journalctl -u saivage.service --since "1 minute ago" | grep -E "plan_get|plan_get_history|plan_add_stage|plan_set_current" | head -20'
```

Acceptance for Stage A: HTTP returns 200, journal shows the planner invoking `plan_get` + `plan_get_history` on restart (existing behaviour preserved). The full effect of the prompt is not visible until Stage B has reseeded history, so do not gate on plan mutation here.

### 6.2 Stage B deploy (Fix 2)

```bash
# 1. Commit Fix 2
cd /home/salva/g/salva/ml/saivage
git checkout -b plan-persistence-fix/03-stage-b-backfill
# (add src/mcp/plan-server.ts plan_append_history method,
#  src/scripts/backfill-plan-history.ts + test + fixtures,
#  package.json scripts entry)
npm run lint && npm run typecheck && npm test
git add src/mcp/plan-server.ts src/scripts package.json
git commit -m "[plan-persistence-fix] Stage B: backfill-plan-history script + plan_append_history (Fix 2)"
git push origin plan-persistence-fix/03-stage-b-backfill

# 2. Stop runtime
ssh saivage 'systemctl stop saivage.service'

# 3. Deploy
ssh saivage 'git -C /opt/saivage fetch && git -C /opt/saivage checkout plan-persistence-fix/03-stage-b-backfill && git -C /opt/saivage pull --ff-only'
ssh saivage 'cd /opt/saivage && npm ci && npm run build'

# 4. Dry-run
ssh saivage 'cd /opt/saivage && npx tsx src/scripts/backfill-plan-history.ts /work/codemacs/.saivage' | tee /tmp/backfill-dry.jsonl
# REVIEW /tmp/backfill-dry.jsonl manually. Confirm candidate count and absence of anomalies before proceeding.

# 5. Apply
ssh saivage 'cd /opt/saivage && npx tsx src/scripts/backfill-plan-history.ts /work/codemacs/.saivage --apply'

# 6. Restart and verify
ssh saivage 'systemctl start saivage.service'
ssh saivage 'systemctl is-active saivage.service'
ssh saivage 'curl -sf http://127.0.0.1:8080/api/plan | jq "{history_len: (.history.stages | length), latest_in_history: (.history.stages[-1] | {id, result})}"'
ssh saivage 'stat -c "%y %n" /work/codemacs/.saivage/plan.json'
```

Acceptance for Stage B: `history.stages` length jumps from 1 (today's stage-340-only) to ≥15 (covering stage-348..362 plus any earlier stages from stage-341..347 that have artefacts on disk). `plan.json` mtime is fresh.

### 6.3 Stage C deploy (Fix 1)

```bash
# 1. Commit Fix 1
cd /home/salva/g/salva/ml/saivage
git checkout -b plan-persistence-fix/03-stage-c-gate
# (edits per §5)
npm run lint && npm run typecheck && npm test
git add src/mcp/plan-server.ts src/server/bootstrap.ts \
        src/server/dispatcher-gate.test.ts \
        src/server/dispatcher-gate-integration.test.ts \
        src/agents/types.ts src/agents/planner.ts
git commit -m "[plan-persistence-fix] Stage C: dispatcher gate + STAGE_MISMATCH (Fix 1)"
git push origin plan-persistence-fix/03-stage-c-gate

# 2. Deploy (runtime can stay up; restart triggers new gate)
ssh saivage 'git -C /opt/saivage fetch && git -C /opt/saivage checkout plan-persistence-fix/03-stage-c-gate && git -C /opt/saivage pull --ff-only'
ssh saivage 'cd /opt/saivage && npm ci && npm run build'
ssh saivage 'systemctl restart saivage.service'

# 3. Verify gate is live
ssh saivage 'systemctl is-active saivage.service'
ssh saivage 'curl -sf http://127.0.0.1:8080/api/plan | jq ".plan.current_stage_id"'
# 4. Wait one planner cycle (~ time for the planner to pick a new stage). Then:
#    (grep -F so the literal brackets in "[dispatch-gate]" are not parsed as a char class.)
ssh saivage "journalctl -u saivage.service --since '5 minutes ago' | grep -F -e '[dispatch-gate]' -e 'STAGE_MISMATCH' -e 'plan_add_stage' -e 'plan_set_current'"
# 5. Mtime invariant: plan.json should advance shortly after a stage is dispatched
ssh saivage 'stat -c "%y %n" /work/codemacs/.saivage/plan.json'
```

Acceptance for Stage C: either no `[dispatch-gate]` warnings (planner is now compliant, Fix 3 working) **or** a small number of `[dispatch-gate]` warnings each followed within 60 s by a `plan_set_current` / `plan_add_stage` call for the same stage id (planner self-correcting). The failure mode to watch for is repeated `[dispatch-gate]` warnings with no corrective tool call between them — that would indicate the planner has not absorbed Fix 3 and needs the prompt revisited.

---

## 7. Rollback Plan

Per [02-architecture.md §5.5](saivage/SPEC/plan-persistence-fix/02-architecture.md), each fix is independently revertible.

### 7.1 Stage A (prompt) rollback

```bash
ssh saivage 'git -C /opt/saivage revert <stage-A-commit-sha> && cd /opt/saivage && npm run build && systemctl restart saivage.service'
```

The two prompt constants revert to their prior text. No data effect.

### 7.2 Stage B (backfill) rollback

```bash
# 1. Stop runtime
ssh saivage 'systemctl stop saivage.service'

# 2. Restore plan.json from the §2 backup, then validate it parses before restart
cd /home/salva/g/salva/ml/codemacs
git checkout <pre-backfill-commit-sha> -- .saivage/plan.json .saivage/plan-history.json
jq -e '.updated_at and (.stages | type == "array") and (.history | type == "array")' .saivage/plan.json \
  || { echo "restored plan.json failed jq validation"; exit 1; }

# 3. Optional: revert the script + plan_append_history commit if you want them off the deploy
ssh saivage 'git -C /opt/saivage revert <stage-B-commit-sha> && cd /opt/saivage && npm ci && npm run build'

# 4. Restart
ssh saivage 'systemctl start saivage.service'
```

The script only ever calls `PlanService.plan_append_history` (§4.2), which writes through `writeDoc` ([plan-server.ts L118-L121](saivage/src/mcp/plan-server.ts#L118-L121)) atomically; restoring `plan.json` is a full rollback.

### 7.3 Stage C (gate) rollback

```bash
ssh saivage 'git -C /opt/saivage revert <stage-C-commit-sha> && cd /opt/saivage && npm run build && systemctl restart saivage.service'
```

`STAGE_MISMATCH` becomes dead code in the union — harmless per [02-architecture.md §5.5](saivage/SPEC/plan-persistence-fix/02-architecture.md). The planner returns to its pre-gate behaviour. If Fix 3 stays deployed, the drift may still be suppressed by prompt alone (the analysis baseline).

---

## 8. Acceptance Criteria

The workstream is **done** when **all** of the following hold simultaneously on the saivage LXC:

1. **Plan reflects reality.** `curl -sf http://127.0.0.1:8080/api/plan` returns a `plan.current_stage_id` that matches `runtime.json`'s `current_stage_id` (or both are `null`) — the divergence enumerated in [01-analysis.md "Runtime is in fact executing stage-362 today"](saivage/SPEC/plan-persistence-fix/01-analysis.md) is gone.
2. **History is recovered.** `plan.json` `history` contains every stage directory under [codemacs/.saivage/stages/](codemacs/.saivage/stages/) that has a `summary.json` or complete `reports/`. Count matches the dry-run preview.
3. **Plan-mutation tools are firing.** Over any rolling 24 h of `journalctl -u saivage.service`, the regex `plan_add_stage|plan_set_current|plan_complete_stage` matches at least once per completed stage (vs. the **0 matches in 6 h** baseline from [01-analysis.md](saivage/SPEC/plan-persistence-fix/01-analysis.md)).
4. **Gate stays quiet — quantified.** Over 24 h of `saivage.service` journal collected post-Stage-C deploy: **0 uncorrected dispatch-gate rejections.** A rejection is "corrected" if the planner's next tool call (within 60 seconds of the `[dispatch-gate]` log line) is `plan_add_stage` or `plan_set_current` for the same stage id named in the rejection message. Operationally, this is computed as:
   ```bash
   ssh saivage "journalctl -u saivage.service --since '24 hours ago' -o short-iso \
     | awk '/\\[dispatch-gate\\] rejected/ {rej_ts=\$1; rej_stage=\$NF; next}
            rej_ts && /plan_set_current|plan_add_stage/ && \$0 ~ rej_stage \
              {dt=systime_diff(\$1, rej_ts); if (dt<=60) {corrected++; rej_ts=\"\"}}
            END {print \"uncorrected:\", (rejections - corrected)}'"
   ```
   (operators may use any equivalent journal-walk; the threshold is the number, not the script.)
5. **Plan file advances.** `stat -c %Y /work/codemacs/.saivage/plan.json` advances at least once per stage dispatched.
6. **All new tests pass in CI.** Specifically: the Fix 3 snapshot, tool-sequence, and self-correction tests; the Fix 2 backfill suite (including the `plan_append_history` defence-in-depth case); and the Fix 1 dispatcher-gate unit + integration tests are part of `npm test` and green.
7. **No regressions.** Full `npm test`, `npm run typecheck`, `npm run lint` are green on the merged branch.
8. **Three commits on `main`.** One per stage, each with the `[plan-persistence-fix] Stage X: …` prefix used in §6, so the deployment history is traceable.
9. **Backup is recorded.** The pre-backfill `plan.json` is recoverable from git (commit cited in §2 still reachable).
