# G27 — Design r2

Reviewer-approved shape is unchanged: Option A. Round-2 changes are
scoped to the three places the reviewer flagged:

- `plan_set_stages` now preserves an already-recorded `started_at`
  on existing stages and only stamps the (still-blank) current
  stage (review change 1).
- Test wording is tightened to use a deterministic clock; the
  strict `>` ordering between `started_at` and `completed_at` is
  preserved by advancing `vi.useFakeTimers()` between the two
  writes rather than relying on wall-clock millisecond
  resolution (review change 2).
- Option B (lifecycle log) is dropped from the recommendation
  surface — round-1 review already rejected it — and is summarised
  only as a future extension.

## Schema

In [src/types.ts](../../../../src/types.ts#L32-L43):

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

`optional` (not required) because a stage is created before it
becomes current. The invariant — "must be present once the stage
is the current one" — is enforced by `PlanService`, not Zod,
because that invariant spans two fields (`stages[i].started_at`
and `current_stage_id`) and is cleaner as a service-level check
than as a `superRefine` that would block every benign plan edit.

`CompletedStageSchema` is unchanged. `started_at` remains required
there because completion is always preceded by start.

## `PlanService` behaviour

Two private helpers added to `PlanService` in
[src/mcp/plan-server.ts](../../../../src/mcp/plan-server.ts), just
below the constructor:

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

Tool-by-tool behaviour:

- **`plan_set_current(stageId)`** at
  [#L181-L196](../../../../src/mcp/plan-server.ts#L181-L196): when
  `stageId !== null` and the target stage's `started_at` is
  `undefined`, set it to `new Date().toISOString()` on the cloned
  `nextPlan.stages[i]` via `stampStarted` before writing. If the
  stage already has a `started_at` (resumed after crash recovery,
  manual replay, or a no-op set-current to the same stage), leave
  it untouched. Idempotent.
- **`plan_set_stages(stages, currentStageId)`** at
  [#L113-L137](../../../../src/mcp/plan-server.ts#L113-L137):
  1. Validate every incoming stage with `StageSchema.parse` as
     today.
  2. Apply `preserveStartedAt(incoming, this.plan.stages)` to
     produce a new array `merged` in which any incoming stage
     without `started_at` inherits the value from the existing
     stage with the same id. Caller-supplied `started_at` always
     wins.
  3. If `currentStageId !== null`, locate the matching stage in
     `merged` and replace it with `stampStarted(stage)` so a
     newly-current stage that nobody has stamped yet is stamped
     here. (No-op when the carried-over value is already set.)
  4. Build `nextPlan` from `merged` and write.
  The caller's incoming `stages` array is never mutated in place;
  `merged` is a new array.
- **`plan_init(stages?)`** at
  [#L266-L289](../../../../src/mcp/plan-server.ts#L266-L289):
  `current_stage_id` is hard-coded to `null` here, so no stamping
  is needed. Keep the null invariant; if the field is ever made
  configurable, route through `stampStarted`.
- **`plan_complete_stage(args)`** at
  [#L198-L246](../../../../src/mcp/plan-server.ts#L198-L246): read
  `started_at` from `this.plan.stages[stageIdx]`. If absent,
  return
  `planError("VALIDATION_ERROR", "Stage '<id>' has no started_at; plan_set_current was never called")`.
  Delete the synthetic `started_at: now` assignment.
  `completed_at` keeps its own fresh `new Date().toISOString()`
  stamp; `nextPlan.updated_at` continues to reuse the same `now`.

## Files touched

- [src/types.ts](../../../../src/types.ts) — add `started_at?:
  string` to `StageSchema`.
- [src/mcp/plan-server.ts](../../../../src/mcp/plan-server.ts) —
  add `stampStarted` and `preserveStartedAt`; call them in
  `plan_set_current` and `plan_set_stages`; rewrite
  `plan_complete_stage` to read the field and reject when
  missing; delete the synthetic `started_at: now`.
- Tests in
  [src/runtime/runtime.test.ts](../../../../src/runtime/runtime.test.ts)
  (see plan steps 6 and 7).

## Deletion list (architecture-first; no migration shim)

- The `started_at: now` line in `plan_complete_stage`
  ([src/mcp/plan-server.ts#L231](../../../../src/mcp/plan-server.ts#L231))
  — removed outright.
- The `const now = new Date().toISOString();` line at
  [src/mcp/plan-server.ts#L222](../../../../src/mcp/plan-server.ts#L222)
  is **kept**; `completed_at: now`
  ([#L232](../../../../src/mcp/plan-server.ts#L232)) and
  `nextPlan.updated_at = now`
  ([#L243](../../../../src/mcp/plan-server.ts#L243)) still need
  it.
- No on-disk format shim. Existing `plan.json` files have stages
  without `started_at`; the field is `optional` so they parse
  fine. The first `plan_set_current` after the upgrade stamps the
  field. If a stage is `current_stage_id` at upgrade time without
  a `started_at`, the very next `plan_complete_stage` call will
  reject it with `VALIDATION_ERROR`. That is the intended sharp
  edge: the operator should call `plan_set_current` once after
  upgrade on the current stage to record an honest start time (or
  accept that the stage in flight at the moment of upgrade was
  never properly timed). No silent fallback.

## Test impact

Tests use `vi.useFakeTimers()` (Vitest fake timers) to remove
wall-clock dependence from every assertion that compares two
timestamps. Each test that needs distinct timestamps explicitly
advances `vi.setSystemTime(...)` between the two writes; the
strict `<` / `>` ordering the round-1 review insisted on is
preserved by the advance, not by relying on millisecond
resolution. `vi.useRealTimers()` is restored in `afterEach`.

Concrete cases (full assertions are in
[03-plan-r2.md](03-plan-r2.md#L99-L168)):

- **"plan_set_current stamps started_at exactly once"** — fake
  clock at `T0`; `plan_set_current("stg-1")`; capture
  `started_at`; advance to `T1`; `plan_set_current("stg-1")`
  again; assert unchanged. Advance to `T2`;
  `plan_set_current(null)`; advance to `T3`;
  `plan_set_current("stg-1")`; assert still the `T0` value.
- **"plan_set_stages preserves existing started_at and stamps the
  new current stage"** — fake clock at `T0`;
  `plan_init([])`; `plan_set_stages([stg-1, stg-2], "stg-1")`;
  capture `plan.stages[0].started_at` (== `T0`). Advance to
  `T1`; `plan_set_stages([stg-1, stg-2], "stg-2")` re-sending
  both stages **without** `started_at`. Assert
  `plan.stages[0].started_at === T0` (preserved across the
  rewrite by `preserveStartedAt`) and
  `plan.stages[1].started_at === T1` (stamped by
  `stampStarted`).
- **"plan_set_stages honours caller-supplied started_at"** —
  fake clock at `T0`; `plan_init([])`;
  `plan_set_stages([{...stg-1, started_at: "T-FIXED"}], "stg-1")`;
  assert `plan.stages[0].started_at === "T-FIXED"` (caller wins
  over both preserve and stamp).
- **"plan_complete_stage uses the recorded started_at"** —
  rewrite of the existing test at
  [src/runtime/runtime.test.ts#L482-L510](../../../../src/runtime/runtime.test.ts#L482-L510):
  fake clock at `T0`; `plan_init([stg-1])`;
  `plan_set_current("stg-1")`; capture
  `plan.stages[0].started_at` as `capturedStartedAt`. Advance
  to `T1` (strictly later than `T0`);
  `plan_complete_stage(...)`. Assert
  `result.completed_stage.started_at === capturedStartedAt` and
  `result.completed_stage.completed_at > capturedStartedAt`. The
  ordering assertion is now deterministic because `T1 > T0` by
  construction.
- **"plan_complete_stage rejects when started_at missing"** —
  fake clock; `plan_init([stg-1])`; directly
  `plan_complete_stage({ stage_id: "stg-1", ... })` without
  `plan_set_current`. Assert the result has
  `code: "VALIDATION_ERROR"` and the message includes `"stg-1"`
  and `"started_at"` or `"plan_set_current"`.
- **Existing test at
  [src/runtime/runtime.test.ts#L561-L580](../../../../src/runtime/runtime.test.ts#L561-L580)** —
  same fix: switch to fake timers, prepend a
  `plan_set_current` call, advance the clock between
  `plan_set_current` and `plan_complete_stage`.
- `src/store/documents.test.ts` fixtures
  ([#L292-L362](../../../../src/store/documents.test.ts#L292-L362))
  that hand-craft `Plan` records do not need `started_at` on
  active stages (it is optional). Leave them.

## Drawbacks (Option A)

- The "stamp on `plan_set_current` / `plan_set_stages`" rule is
  enforced in two writers; a future planner tool that makes a
  stage current without going through either would skip the
  stamp. Mitigation: those are the only two MCP write tools that
  can set `current_stage_id`; the test suite asserts the
  invariant from the `plan_complete_stage` side so any
  regression surfaces as a failed completion rather than silent
  fabrication.
- A stage that becomes current is never "uncurrent" with a
  preserved `started_at`. If
  `plan_set_current(null)` then `plan_set_current(sameStageId)`
  is meant to mean "started over", this design records the
  original start. That matches the semantics the planner
  already uses (the manager dispatcher resumes mid-flight rather
  than restarting); operators who want to reset the clock must
  send an explicit `started_at` through `plan_set_stages` (the
  caller-wins path).

## Option B (summary only, not adopted)

A per-stage lifecycle event log (`created` / `started` /
`completed` / `cancelled` with a schema-level state machine) was
considered in r1 and rejected by the round-1 review on
proportionality grounds. It is not adopted in r2. The full r1
text remains available in
[02-design-r1.md#L150-L295](02-design-r1.md#L150-L295) if a
future finding ever needs a richer per-stage audit; nothing in
the current consumer set justifies it. Listing it here only so
the rejection is explicit and not re-litigated each round.

## Cross-cutting design notes

- The deterministic-clock pattern (`vi.useFakeTimers()` +
  `vi.setSystemTime(...)`) is local to the new and rewritten
  tests; no other suite is touched. The plan-server itself
  continues to call `new Date().toISOString()` in production
  paths.
- The `preserveStartedAt` helper is intentionally an
  array-in/array-out pure function. It is exercised by
  `plan_set_stages` only; `plan_set_current` does not need it
  because it operates on a single existing stage already in
  `this.plan.stages`.
