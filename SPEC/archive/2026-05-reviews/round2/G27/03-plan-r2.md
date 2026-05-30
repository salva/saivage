# G27 — Plan r2 (Option A: `started_at` on active Stage, stamped on `plan_set_current` / `plan_set_stages`)

Round-2 changes vs r1:

- Step 4 now uses the `preserveStartedAt` helper and stamps the
  new current stage only if it still has no timestamp (review
  change 1).
- Steps 6 and 7 use Vitest fake timers with explicit
  `vi.setSystemTime(...)` advances; strict `>` ordering is kept
  but is now deterministic (review change 2).
- The cross-finding section spells out the inverted-order
  contingency: G28's placeholder must be
  `started_at: z.string().optional()`, not bare `z.string()`, and
  G28's approved plan must be amended before any G28-first
  emergency ship (review change 3).
- The rollback section is split into "pre-G28" and "post-G28"
  branches; the one-commit revert is valid only in the pre-G28
  branch (review change 4).

## Steps

1. **Extend `StageSchema`** in
   [src/types.ts](../../../../src/types.ts#L32-L43):

   ```ts
   export const StageSchema = z.object({
     id: z.string().min(1),
     objective: z.string().min(1).max(1000),
     starting_points: z.array(z.string()),
     expected_outcomes: z.array(z.string()).min(1),
     acceptance_criteria: z.array(z.string()).min(1),
     references: z.array(z.string()),
     tags: z.array(z.string()),
     started_at: z.string().optional(),
   });
   ```

   `CompletedStageSchema` at
   [src/types.ts#L54-L75](../../../../src/types.ts#L54-L75) stays
   exactly as it is — `started_at: z.string()` remains required
   there.

2. **Add the two helpers** to `PlanService` in
   [src/mcp/plan-server.ts](../../../../src/mcp/plan-server.ts),
   as private methods just below the constructor:

   ```ts
   private stampStarted(stage: Stage): Stage {
     return stage.started_at
       ? stage
       : { ...stage, started_at: new Date().toISOString() };
   }

   private preserveStartedAt(
     incoming: readonly Stage[],
     existing: readonly Stage[],
   ): Stage[] {
     const existingById = new Map(existing.map((s) => [s.id, s]));
     return incoming.map((s) => {
       if (s.started_at !== undefined) return s;
       const prev = existingById.get(s.id);
       return prev?.started_at ? { ...s, started_at: prev.started_at } : s;
     });
   }
   ```

3. **Stamp `started_at` in `plan_set_current`** at
   [src/mcp/plan-server.ts#L181-L196](../../../../src/mcp/plan-server.ts#L181-L196).
   After cloning `nextPlan`, if `stageId !== null`, locate the
   stage in `nextPlan.stages` by id and replace it with
   `this.stampStarted(stage)` before writing.

4. **Stamp `started_at` in `plan_set_stages`** at
   [src/mcp/plan-server.ts#L113-L137](../../../../src/mcp/plan-server.ts#L113-L137):

   - After the per-stage `StageSchema.parse` loop and the
     `currentStageId` membership check, compute
     `const merged = this.preserveStartedAt(stages, this.plan.stages);`.
     The caller's `stages` array is **not** mutated; `merged` is a
     new array.
   - If `currentStageId !== null`, find the index `i` of the
     stage with id === `currentStageId` in `merged` and replace
     `merged[i]` with `this.stampStarted(merged[i])`.
   - Build `nextPlan.stages = merged` and continue with the
     existing write path.

5. **Consume the recorded `started_at` in
   `plan_complete_stage`** at
   [src/mcp/plan-server.ts#L198-L246](../../../../src/mcp/plan-server.ts#L198-L246):

   - Delete the line `started_at: now,` at
     [#L231](../../../../src/mcp/plan-server.ts#L231).
   - Before building `completedStage`, check `stage.started_at`.
     If it is `undefined`, return
     `planError("VALIDATION_ERROR", \`Stage '${args.stage_id}' has no started_at; plan_set_current was never called\`)`.
   - Set `started_at: stage.started_at` in the `completedStage`
     literal.
   - Keep `const now = new Date().toISOString();` at
     [#L222](../../../../src/mcp/plan-server.ts#L222) —
     `completed_at` and `nextPlan.updated_at` still need it.

6. **Update plan-server tests** in
   [src/runtime/runtime.test.ts](../../../../src/runtime/runtime.test.ts).
   Add `beforeEach(() => vi.useFakeTimers())` and
   `afterEach(() => vi.useRealTimers())` to the plan-server
   describe block (or wrap the new tests in their own describe
   with these hooks if the existing block already does
   wall-clock work). All timestamps below are produced by
   `vi.setSystemTime(new Date(N))`-driven `new Date().toISOString()`
   calls inside `PlanService`.

   - Rewrite "plan_complete_stage moves to history" at
     [#L482-L510](../../../../src/runtime/runtime.test.ts#L482-L510):

     ```ts
     vi.setSystemTime(new Date(1_700_000_000_000));
     await planService.plan_init({ stages: [stg1] });
     await planService.plan_set_current({ stage_id: "stg-1" });
     const capturedStartedAt = (await planService.plan_get_current_stage({})).stage!.started_at;
     vi.setSystemTime(new Date(1_700_000_001_000));
     const result = await planService.plan_complete_stage({ ... });
     expect(result.completed_stage.started_at).toBe(capturedStartedAt);
     expect(result.completed_stage.completed_at > capturedStartedAt!).toBe(true);
     ```

   - Update the test at
     [#L561-L580](../../../../src/runtime/runtime.test.ts#L561-L580)
     the same way — switch to fake timers, prepend
     `plan_set_current`, advance the clock by 1 second before
     `plan_complete_stage`.

   - Add: **"plan_set_current stamps started_at exactly once"** —
     `vi.setSystemTime(T0)`; `plan_init` with two stages;
     `plan_set_current("stg-1")`; capture
     `plan.stages[0].started_at`. `vi.setSystemTime(T1)`;
     `plan_set_current("stg-1")` again; assert unchanged.
     `vi.setSystemTime(T2)`; `plan_set_current(null)`.
     `vi.setSystemTime(T3)`; `plan_set_current("stg-1")`; assert
     still equal to the `T0` value.

   - Add: **"plan_set_stages preserves existing started_at and
     stamps the new current stage"** —
     `vi.setSystemTime(T0)`; `plan_init([])`;
     `plan_set_stages([stg-1, stg-2], "stg-1")`; capture
     `plan.stages[0].started_at` (== `T0` ISO). Assert
     `plan.stages[1].started_at` is `undefined`.
     `vi.setSystemTime(T1)`;
     `plan_set_stages([stg-1, stg-2], "stg-2")` — re-send both
     stages **without** `started_at` on either. Assert:
     - `plan.stages[0].started_at === T0`-ISO (preserved by
       `preserveStartedAt`),
     - `plan.stages[1].started_at === T1`-ISO (stamped because
       it is the new current and had no prior value).

   - Add: **"plan_set_stages honours caller-supplied
     started_at"** — `vi.setSystemTime(T0)`; `plan_init([])`;
     `plan_set_stages([{ ...stg-1, started_at: "T-FIXED" }], "stg-1")`;
     assert `plan.stages[0].started_at === "T-FIXED"` (caller
     wins over both preserve and stamp).

   - Add: **"plan_complete_stage rejects when started_at
     missing"** — `vi.setSystemTime(T0)`; `plan_init([stg-1])`;
     directly `plan_complete_stage({ stage_id: "stg-1", ... })`
     without `plan_set_current`. Assert the returned object has
     `code: "VALIDATION_ERROR"` and the message includes
     `"stg-1"` and either `"started_at"` or
     `"plan_set_current"`.

7. **Run the targeted sweep** for any other `Stage` literal in
   the suite that might break — every fixture builds the seven
   existing required fields; `started_at` is optional so no
   literal needs updating. Sanity-check with:

   ```bash
   cd /home/salva/g/ml/saivage
   rg -n "StageSchema\.parse\b|: Stage\s*=" src/ web/src/
   ```

   No structural updates are expected; if any consumer treats
   `started_at` as required on an active `Stage`, fix it to the
   optional contract.

## Validation

Run in order from `/home/salva/g/ml/saivage`:

```bash
npx tsc --noEmit
npx vitest run src/runtime/runtime.test.ts src/store/documents.test.ts
npx vitest run
npm run build
```

- `tsc` and the two targeted vitest commands must pass cleanly.
- The full `vitest run` must show no regressions in plan-server,
  runtime, store, agents, or chat suites.
- `npm run build` must produce `dist/cli.js` without warnings
  related to `StageSchema`.

## Rollback (operator-gated, dependency-aware)

Two rollback regimes apply depending on whether G28 has landed in
the same code line as G27. Operators must determine which regime
they are in **before** executing any revert.

### Regime A — G27 deployed, G28 not yet merged or deployed

This is the safe, one-commit revert. It applies only while G28 is
strictly downstream of G27 (G28 is not in the running daemon's
`dist/`, and the on-disk shape is still the split
`plan.json` + `plan-history.json` model).

1. Stop the change at the git layer with a single
   `git revert <merge sha>` on the feature branch — do not
   hand-edit reverted code.
2. Rebuild and redeploy the three live daemons (each bind-mounts
   `/home/salva/g/ml/saivage`):
   - `saivage` 10.0.3.111 —
     `ssh root@10.0.3.111 systemctl restart saivage.service`.
   - `diedrico` 10.0.3.113 —
     `ssh root@10.0.3.113 systemctl restart saivage.service`.
   - `saivage-v3` 10.0.3.112 —
     `ssh root@10.0.3.112 systemctl restart saivage.service`.
3. Existing `plan.json` files on disk written by the G27-enabled
   code contain `started_at` on the current stage. The reverted
   code tolerates the field as unknown only because Zod's default
   `.object()` strips unknown keys at parse time; verify with a
   quick `node -e` snippet against `PlanSchema` before declaring
   rollback complete. If the legacy `PlanSchema` was switched to
   `.strict()` in the interim, the revert must also remove that.
   Operator-only step — ask before executing.
4. `saivage-v3-getrich-v2` 10.0.3.170 runs a different code path
   and is **not** in scope for this rollout — do not touch.

### Regime B — G28 has merged or deployed alongside G27

Once G28 is in the same code line, G27 is no longer an isolated
patch. G28's `PlanDocumentSchema` embeds the G27-extended
`StageSchema` and the on-disk shape collapses to a single
`PlanDocument`
([../G28/03-plan-r2.md#L45-L66](../G28/03-plan-r2.md#L45-L66))
with no separate `plan-history.json`
([../G28/03-plan-r2.md#L45-L66](../G28/03-plan-r2.md#L45-L66)).
Reverting only G27 against a post-G28 daemon would leave the
code expecting a required `started_at` on every completed stage
embedded in the single document while the source no longer
stamps it, and the unified-document writer would still need a
schema that knows the field.

In this regime:

1. **A single-commit G27 revert is forbidden.** Do not
   `git revert <G27 sha>` while G28 is in the build.
2. The supported recoveries are, in operator-priority order:
   - **Forward-fix.** Diagnose and fix forward in a new commit.
     This is preferred for any regression that is not a data
     corruption.
   - **Coordinated G28 + G27 revert.** Revert G28 first
     (restoring the split-document model per
     [../G28/03-plan-r2.md](../G28/03-plan-r2.md)'s own
     rollback section), redeploy, confirm the daemons read the
     restored split layout, then revert G27, redeploy again.
     This is the only revert path that leaves code and on-disk
     shape in phase.
3. The host list and bind-mount layout are the same as Regime
   A; `saivage-v3-getrich-v2` 10.0.3.170 is still out of scope.
4. The live deployment section below carries the same
   boundary: any operator runbook that points at "the G27
   rollback" must explicitly call out which regime applies
   **before** the revert is run.

## Cross-finding coordination

- **G28 (single `PlanDocument`, APPROVED)** —
  [../G28/APPROVED.md](../G28/APPROVED.md) and
  [../G28/03-plan-r2.md#L1-L13](../G28/03-plan-r2.md#L1-L13)
  mandate that **G27 lands first**. G28 then embeds the
  extended `StageSchema` (with `started_at?: string`) directly
  into `PlanDocumentSchema` with no schema work on G28's side.

  Inverted-order contingency (review change 3): G28's current
  approved contingency text spells the placeholder as
  `started_at: z.string()` (required). That is incompatible with
  G27 because queued stages have no start time and a required
  field would reject every ordinary plan. G27 r2 therefore
  declares the inverted-order path **explicit and gated**:

  1. The recommended and default order is unchanged: **G27 →
     G28 → G29**. No schema amendment is needed on either
     approved spec along this path.
  2. If operations needs G28 to ship before G27, the G28
     approved plan must be amended **before** G28 ships:
     replace the placeholder `started_at: z.string()` at
     [../G28/03-plan-r2.md#L5-L13](../G28/03-plan-r2.md#L5-L13)
     and
     [../G28/03-plan-r2.md#L287-L290](../G28/03-plan-r2.md#L287-L290)
     with `started_at: z.string().optional()`, re-circulate the
     change for approval, ship G28, then ship G27 as a
     behavioural-only patch (helpers + `plan_set_current` /
     `plan_set_stages` stamping + `plan_complete_stage`
     reject).
  3. G27 must **not** ship on top of a required-`started_at`
     placeholder. Doing so would reject every queued stage in
     every existing project tree on the very next
     `plan_set_stages` call. The CI gate for this is the new
     "plan_set_stages preserves existing started_at" test (step
     6) — it constructs queued stages without `started_at` and
     would fail to even reach the assertion under a required
     placeholder.

- **F34 (round-1 plan-server cache)** — unaffected; the cache
  already round-trips the full `Stage` shape so the new field
  flows through unchanged.
- **G29 (read-bypass)** — unaffected; `started_at` is only
  written by `plan_set_current` / `plan_set_stages`, both of
  which stay on the op queue.

## Live deployment coordination

Three live daemons keep real `plan.json` state on disk inside
their respective project trees. `saivage-v3-getrich-v2`
10.0.3.170 runs a different code path and **must not** be
touched as part of this rollout. For each of the three in-scope
hosts, in order, with operator approval:

- `saivage` 10.0.3.111 — project at `/home/salva/g/ml/getrich`,
  service `saivage.service` in the `saivage` container.
- `diedrico` 10.0.3.113 — project at `/work/diedrico`, service
  `saivage.service`.
- `saivage-v3` 10.0.3.112 — project at `/work/saivage-v3`,
  service `saivage.service`.

Per host:

1. Confirm with the operator that the planner is between stages
   (otherwise see step 4 below) **and** that the daemon does
   not yet have G28 in its build (otherwise the rollback
   regime changes — see the Regime A / B split above).
2. Build + deploy (the standard saivage v2 build/deploy flow;
   bind mounts mean the new `dist/` is visible inside the
   container).
3. Restart the service:
   `ssh root@<host_ip> systemctl restart saivage.service`.
4. **In-flight stage at upgrade time.** If `plan.json` has a
   `current_stage_id` and the corresponding stage has no
   `started_at`, the next `plan_complete_stage` will reject
   with `VALIDATION_ERROR`. Two operator-only remediation
   options, chosen by the operator:
   - **Re-stamp**: ask the planner (via the chat surface) to
     call `plan_set_current(<same id>)`. The handler stamps the
     current wall-clock time as `started_at`. The reported
     stage duration for that one stage will be artificially
     short, but every subsequent stage is honest.
   - **Hand-edit**: with the service stopped, set
     `stages[i].started_at` in `.saivage/plan.json` to the
     actual known start time from operator notes / logs, then
     restart. Do not touch any other field. Do not script this
     in the repo.
5. Health check: `curl -fsS http://<host_ip>:8080/health || true`
   and `curl -fsS http://<host_ip>:8080/api/plan` to confirm
   the plan parses against the new schema.
6. The rollback runbook the operator carries must explicitly
   record which regime (A or B above) is in effect for each
   host at the moment of any revert. An unconditional
   "revert G27" instruction is unsafe in Regime B.

No file contents from `.saivage/auth-profiles.json` or provider
configs are read, printed, or copied by any step.
