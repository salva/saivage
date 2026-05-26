# G27 — Plan r1 (Option A: `started_at` on active Stage, stamped on `plan_set_current`)

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

2. **Add the `stampStarted` helper** to `PlanService` in
   [src/mcp/plan-server.ts](../../../../src/mcp/plan-server.ts), as a
   private method just below the constructor:

   ```ts
   private stampStarted(stage: Stage): Stage {
     return stage.started_at
       ? stage
       : { ...stage, started_at: new Date().toISOString() };
   }
   ```

3. **Stamp `started_at` in `plan_set_current`** at
   [src/mcp/plan-server.ts#L181-L196](../../../../src/mcp/plan-server.ts#L181-L196).
   After cloning `nextPlan`, if `stageId !== null`, locate the stage
   in `nextPlan.stages` by id and replace it with
   `this.stampStarted(stage)` before writing.

4. **Stamp `started_at` in `plan_set_stages`** at
   [src/mcp/plan-server.ts#L113-L137](../../../../src/mcp/plan-server.ts#L113-L137).
   After the per-stage `StageSchema.parse` loop and the
   `currentStageId` membership check, if `currentStageId !== null`
   replace the matching stage in the local `stages` array with
   `this.stampStarted(stages[i])` before building `nextPlan`. The
   array passed in by the caller is not mutated in place — build a
   new array.

5. **Consume the recorded `started_at` in `plan_complete_stage`** at
   [src/mcp/plan-server.ts#L198-L246](../../../../src/mcp/plan-server.ts#L198-L246):

   - Delete the line `started_at: now,` at
     [#L231](../../../../src/mcp/plan-server.ts#L231).
   - Before building `completedStage`, check `stage.started_at`. If
     it is `undefined`, return
     `planError("VALIDATION_ERROR", \`Stage '${args.stage_id}' has no started_at; plan_set_current was never called\`)`.
   - Set `started_at: stage.started_at` in the `completedStage`
     literal.
   - Keep `const now = new Date().toISOString();` at
     [#L222](../../../../src/mcp/plan-server.ts#L222) — `completed_at`
     and `nextPlan.updated_at` still need it.

6. **Update plan-server tests** in
   [src/runtime/runtime.test.ts](../../../../src/runtime/runtime.test.ts):

   - Rewrite "plan_complete_stage moves to history" at
     [#L482-L510](../../../../src/runtime/runtime.test.ts#L482-L510):
     after `plan_init`, call `await planService.plan_set_current("stg-1")`,
     capture the resulting `plan.stages[0].started_at`, then call
     `plan_complete_stage`; assert
     `result.completed_stage.started_at === capturedStartedAt` and
     `result.completed_stage.completed_at > capturedStartedAt`.
   - Update the test at
     [#L561-L580](../../../../src/runtime/runtime.test.ts#L561-L580)
     the same way — prepend a `plan_set_current` call before
     `plan_complete_stage`.
   - Add: "plan_set_current stamps started_at exactly once" — init
     with two stages, `plan_set_current("stg-1")`, capture
     `started_at`; call `plan_set_current("stg-1")` again; assert
     unchanged. Call `plan_set_current(null)`, then
     `plan_set_current("stg-1")`; assert still unchanged.
   - Add: "plan_set_stages stamps started_at on the current stage" —
     `plan_init([])`, then `plan_set_stages([stg-1, stg-2], "stg-1")`;
     assert `plan.stages[0].started_at` is defined and
     `plan.stages[1].started_at` is `undefined`. Then
     `plan_set_stages([stg-1, stg-2], "stg-2")` (re-issuing both
     stages without a `started_at` on either); assert `stg-2.started_at`
     is now defined and `stg-1.started_at` is **not** preserved
     (because the caller passed in a fresh stage object without it —
     this is the documented "caller-replaces" semantics of
     `plan_set_stages`). If preserving across `plan_set_stages` is
     desired later, that is a separate finding.
   - Add: "plan_complete_stage rejects when started_at missing" —
     `plan_init([stg-1])`, then directly `plan_complete_stage({
     stage_id: "stg-1", ... })` without `plan_set_current`. Assert
     the returned object has `code: "VALIDATION_ERROR"` and the
     message includes `"stg-1"` and `"started_at"` or
     `"plan_set_current"`.

7. **Run the targeted sweep** for any other `Stage` literal in the
   suite that might break — every fixture builds the seven existing
   required fields; `started_at` is optional so no literal needs
   updating. Sanity-check with:

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

## Rollback (operator-gated)

If validation fails or a runtime regression appears after deploy:

1. Stop the change at the git layer with a single
   `git revert <merge sha>` on the feature branch — do not hand-edit
   reverted code.
2. Rebuild and redeploy the three live daemons (each bind-mounts
   `/home/salva/g/ml/saivage`):
   - `saivage` 10.0.3.111 —
     `ssh root@10.0.3.111 systemctl restart saivage.service`.
   - `diedrico` 10.0.3.113 —
     `ssh root@10.0.3.113 systemctl restart saivage.service`.
   - `saivage-v3` 10.0.3.112 —
     `ssh root@10.0.3.112 systemctl restart saivage.service`.
3. Existing `plan.json` files on disk written by the new code will
   contain `started_at` on the current stage. The reverted code
   tolerates the field as unknown only because Zod's default
   `.object()` strips unknown keys at parse time; verify with a
   quick `node -e` snippet against `PlanSchema` before declaring
   rollback complete. If the legacy `PlanSchema` was set to
   `.strict()` in the interim, the revert must also remove that.
   Operator-only step — ask before executing.
4. `saivage-v3-getrich-v2` 10.0.3.170 runs a different code path
   and is **not** in scope for this rollout — do not touch.

## Cross-finding coordination

- **G28 (single `PlanDocument`, APPROVED)** —
  [../G28/APPROVED.md](../G28/APPROVED.md) and
  [../G28/03-plan-r2.md#L1-L13](../G28/03-plan-r2.md#L1-L13)
  mandate that **G27 lands first**. G28 then embeds the extended
  `StageSchema` (with `started_at?: string`) directly into
  `PlanDocumentSchema` with no schema work on G28's side. If for
  any reason G28 lands first instead, G28 must add `started_at:
  z.string().optional()` to `StageSchema` as a placeholder in the
  same commit (per G28's own contingency at
  [../G28/03-plan-r2.md#L7-L13](../G28/03-plan-r2.md#L7-L13))
  and this finding then becomes a one-line source change plus the
  `stampStarted` helper plus the `plan_complete_stage` reject.
- **F34 (round-1 plan-server cache)** — unaffected; the cache
  already round-trips the full `Stage` shape so the new field
  flows through unchanged.
- **G29 (read-bypass)** — unaffected; `started_at` is only written
  by `plan_set_current` / `plan_set_stages`, both of which stay on
  the op queue.

## Live deployment coordination

Three live daemons keep real `plan.json` state on disk inside their
respective project trees. `saivage-v3-getrich-v2` 10.0.3.170 runs a
different code path and **must not** be touched as part of this
rollout. For each of the three in-scope hosts, in order, with
operator approval:

- `saivage` 10.0.3.111 — project at `/home/salva/g/ml/getrich`,
  service `saivage.service` in the `saivage` container.
- `diedrico` 10.0.3.113 — project at `/work/diedrico`, service
  `saivage.service`.
- `saivage-v3` 10.0.3.112 — project at `/work/saivage-v3`, service
  `saivage.service`.

Per host:

1. Confirm with the operator that the planner is between stages
   (otherwise see step 4 below).
2. Build + deploy (the standard saivage v2 build/deploy flow; bind
   mounts mean the new `dist/` is visible inside the container).
3. Restart the service:
   `ssh root@<host_ip> systemctl restart saivage.service`.
4. **In-flight stage at upgrade time.** If `plan.json` has a
   `current_stage_id` and the corresponding stage has no
   `started_at`, the next `plan_complete_stage` will reject with
   `VALIDATION_ERROR`. Two operator-only remediation options,
   chosen by the operator:
   - **Re-stamp**: ask the planner (via the chat surface) to call
     `plan_set_current(<same id>)`. The handler stamps the current
     wall-clock time as `started_at`. The reported stage duration
     for that one stage will be artificially short, but every
     subsequent stage is honest.
   - **Hand-edit**: with the service stopped, set
     `stages[i].started_at` in `.saivage/plan.json` to the actual
     known start time from operator notes / logs, then restart. Do
     not touch any other field. Do not script this in the repo.
5. Health check: `curl -fsS http://<host_ip>:8080/health || true`
   and `curl -fsS http://<host_ip>:8080/api/plan` to confirm the
   plan parses against the new schema.

No file contents from `.saivage/auth-profiles.json` or provider
configs are read, printed, or copied by any step.
