# G27 — Design r1

Two designs. Option A is recommended.

## Option A — Add `started_at` to active `Stage`; stamp on `plan_set_current` (RECOMMENDED)

The minimal change that removes the lie. `started_at` becomes a
first-class field of the active `Stage`, populated whenever the stage
becomes the current one, and consumed verbatim by
`plan_complete_stage`.

### Schema

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
becomes current. The invariant — "must be present once the stage is
the current one" — is enforced by `PlanService`, not Zod, because
that invariant is across two fields (`stages[i].started_at` and
`current_stage_id`) and cleaner as a service-level check than as a
`superRefine` that would block every benign plan edit.

`CompletedStageSchema` is unchanged. `started_at` remains required
there because completion is always preceded by start.

### `PlanService` behaviour

In [src/mcp/plan-server.ts](../../../../src/mcp/plan-server.ts):

- **`plan_set_current(stageId)`** at
  [#L181-L196](../../../../src/mcp/plan-server.ts#L181-L196): when
  `stageId !== null` and the target stage's `started_at` is
  `undefined`, set it to `new Date().toISOString()` on the cloned
  `nextPlan.stages[i]` before writing. If the stage already has a
  `started_at` (resuming after crash recovery, manual replay, or a
  no-op set-current to the same stage), leave it untouched.
  Idempotent.
- **`plan_set_stages(stages, currentStageId)`** at
  [#L113-L137](../../../../src/mcp/plan-server.ts#L113-L137): if
  `currentStageId !== null`, locate the matching stage in the
  incoming `stages` array; if its `started_at` is `undefined`, set
  it before validating and writing. Same idempotency rule.
- **`plan_init(stages?)`** at
  [#L266-L289](../../../../src/mcp/plan-server.ts#L266-L289):
  `current_stage_id` is hard-coded to `null` here, so no stamping is
  needed. Keep the null invariant; if the field is ever made
  configurable, route through the same helper.
- **`plan_complete_stage(args)`** at
  [#L198-L246](../../../../src/mcp/plan-server.ts#L198-L246): read
  `started_at` from `this.plan.stages[stageIdx]`. If absent, return
  `planError("VALIDATION_ERROR", "Stage '<id>' has no started_at;
  plan_set_current was never called")`. Delete the synthetic
  `const now = new Date().toISOString();` assignment to
  `started_at`. `completed_at` keeps its own fresh timestamp.

Factor the start stamp into a private helper:

```ts
private stampStarted(stage: Stage): Stage {
  return stage.started_at ? stage : { ...stage, started_at: new Date().toISOString() };
}
```

so the three writer paths above all funnel through one line.

### Files touched

- [src/types.ts](../../../../src/types.ts) — add `started_at?:
  string` to `StageSchema`.
- [src/mcp/plan-server.ts](../../../../src/mcp/plan-server.ts) —
  add `stampStarted`; call it in `plan_set_current`,
  `plan_set_stages`; rewrite `plan_complete_stage` to read the field
  and reject when missing; delete the synthetic `started_at: now`.
- Tests in
  [src/runtime/runtime.test.ts](../../../../src/runtime/runtime.test.ts)
  for the new behaviour (see plan step 4).

### Deletion list (architecture-first; no migration shim)

- The `started_at: now` line in `plan_complete_stage`
  ([src/mcp/plan-server.ts#L231](../../../../src/mcp/plan-server.ts#L231))
  — removed outright.
- The `const now = new Date().toISOString();` line at
  [src/mcp/plan-server.ts#L222](../../../../src/mcp/plan-server.ts#L222)
  is **kept**; `completed_at: now`
  ([#L232](../../../../src/mcp/plan-server.ts#L232)) and
  `nextPlan.updated_at = now`
  ([#L243](../../../../src/mcp/plan-server.ts#L243)) still need it.
- No on-disk format shim. Existing `plan.json` files have stages
  without `started_at`; the field is `optional` so they parse
  fine. The first `plan_set_current` after the upgrade stamps the
  field. If a stage is `current_stage_id` at upgrade time without a
  `started_at`, the very next `plan_complete_stage` call will reject
  it with `VALIDATION_ERROR`. That is the intended sharp edge: the
  operator should call `plan_set_current` once after upgrade on the
  current stage to record an honest start time (or accept that the
  stage in flight at the moment of upgrade was never properly
  timed). No silent fallback.

### Test impact

- New test in
  [src/runtime/runtime.test.ts](../../../../src/runtime/runtime.test.ts):
  "plan_set_current stamps started_at exactly once" — call
  `plan_set_current(stg-1)`, capture `started_at`; call again with
  the same id; assert the field is unchanged. Then
  `plan_set_current(null)`, then `plan_set_current(stg-1)`; assert
  `started_at` is still the original value (idempotent across
  re-entries).
- New test: "plan_set_stages stamps started_at on the current
  stage" — pass `currentStageId: "stg-1"`; assert
  `plan.stages[0].started_at` is set; then call with
  `currentStageId: "stg-2"`; assert `stg-2.started_at` is set and
  `stg-1.started_at` is unchanged.
- Rewrite "plan_complete_stage moves to history" at
  [src/runtime/runtime.test.ts#L482-L510](../../../../src/runtime/runtime.test.ts#L482-L510):
  insert a `plan_set_current` between init and complete; assert the
  completed-stage `started_at` matches the value stamped by
  `plan_set_current` (and is strictly less than `completed_at`).
- New test: "plan_complete_stage rejects when started_at missing"
  — `plan_init` with one stage, do **not** call
  `plan_set_current`, call `plan_complete_stage`; assert the result
  is a `VALIDATION_ERROR` with a message mentioning the stage id.
- Existing test at
  [src/runtime/runtime.test.ts#L561-L580](../../../../src/runtime/runtime.test.ts#L561-L580)
  — same fix: prepend a `plan_set_current` call.
- `src/store/documents.test.ts` fixtures
  ([#L292-L362](../../../../src/store/documents.test.ts#L292-L362))
  that hand-craft `Plan` records do not need `started_at` on active
  stages (it is optional). Leave them.

### Drawbacks

- The "stamp on `plan_set_current`" rule is enforced in two writers
  (`plan_set_current`, `plan_set_stages`); a future planner tool
  that makes a stage current without going through either would
  skip the stamp. Mitigation: those are the only two MCP write
  tools that can set `current_stage_id`; the test suite asserts the
  invariant from a `plan_complete_stage` perspective so any
  regression surfaces as a failed completion rather than silent
  fabrication.
- A stage that becomes current is never "uncurrent" with a
  preserved `started_at`. If `plan_set_current(null)` then
  `plan_set_current(sameStageId)` is meant to mean "started over",
  this design records the original start. That matches the
  semantics the planner already uses (the manager dispatcher
  resumes mid-flight rather than restarting), but operators who
  want to reset the clock must manually clear the field via a
  forthcoming admin tool. Out of scope here.

## Option B — Stage lifecycle timestamp log with explicit state machine

One conceptual level up. Replace the single `started_at`/`completed_at`
pair with an append-only `lifecycle` array of typed events on every
stage, validated as a state machine. Active and completed stages
share the same `lifecycle` shape, and the legacy `started_at` /
`completed_at` flat fields become projections derived from the array
at the boundary.

### Schema

In [src/types.ts](../../../../src/types.ts#L32-L75):

```ts
export const StageLifecycleEventSchema = z.object({
  event: z.enum(["created", "started", "completed", "cancelled"]),
  at: z.string(),
  reason: z.string().optional(),
});
export type StageLifecycleEvent = z.infer<typeof StageLifecycleEventSchema>;

export const StageSchema = z.object({
  id: z.string().min(1),
  objective: z.string().min(1).max(1000),
  starting_points: z.array(z.string()),
  expected_outcomes: z.array(z.string()).min(1),
  acceptance_criteria: z.array(z.string()).min(1),
  references: z.array(z.string()),
  tags: z.array(z.string()),
  lifecycle: z.array(StageLifecycleEventSchema).min(1),
}).superRefine((s, ctx) => {
  const events = s.lifecycle.map((e) => e.event);
  if (events[0] !== "created")
    ctx.addIssue({ code: "custom", message: `Stage '${s.id}' lifecycle must start with 'created'` });
  // State machine: created -> started -> (completed|cancelled)
  // Transitions enforced by index in `events`.
  ...
});
```

`CompletedStageSchema` keeps its current fields but their values are
populated from the lifecycle log at boundary time
(`plan_complete_stage` projects `started_at` / `completed_at` from
the `started` / `completed` events into the legacy fields, and also
embeds the full `lifecycle` for richer audit).

### Behavioural changes

- Every writer that creates a stage (`plan_init`, `plan_add_stage`,
  `plan_set_stages`) appends a `created` event with the current
  timestamp.
- `plan_set_current` appends a `started` event (idempotent: if the
  last `event` is already `started` for this stage, no-op).
- `plan_complete_stage` appends `completed` (or `cancelled` for
  `result === "aborted"`) and then projects the legacy timestamp
  fields into the resulting `CompletedStage`.
- The state-machine `superRefine` rejects: any event out of order;
  `started` without a preceding `created`; `completed`/`cancelled`
  without a preceding `started`; any event after a terminal one.

### Files touched

- [src/types.ts](../../../../src/types.ts) — add
  `StageLifecycleEventSchema`, replace `StageSchema` with the
  lifecycle-bearing version, add `superRefine`. Add a projection
  helper exported from the same file (e.g.
  `projectStageTimestamps(stage): { started_at?, completed_at? }`).
- [src/mcp/plan-server.ts](../../../../src/mcp/plan-server.ts) —
  every writer (`plan_init`, `plan_add_stage`, `plan_set_stages`,
  `plan_set_current`, `plan_complete_stage`) appends to
  `lifecycle`. The synthetic `started_at: now` is gone.
- [src/server/server.ts](../../../../src/server/server.ts) — the
  `/api/debug/timeline` handler at
  [#L609-L630](../../../../src/server/server.ts#L609-L630) is
  rewritten to iterate the richer lifecycle array per stage. The
  response shape gains a `cancelled_at` for aborted stages.
- [src/agents/planner.ts](../../../../src/agents/planner.ts),
  [src/agents/manager.ts](../../../../src/agents/manager.ts) — no
  direct change; they call MCP tools.
- Web SPA — no direct change. The lifecycle array is not currently
  rendered; only the projected `started_at` / `completed_at` are
  consumed.

### Deletion list

- The synthetic `started_at` write in `plan_complete_stage`.
- The flat `started_at` / `completed_at` fields on `CompletedStage`
  become **projected** rather than stored — but they survive on the
  wire so HTTP consumers keep working. The on-disk shape gains
  `lifecycle` and loses the flat fields on active stages (active
  stages never had them).

### Test impact

- Every existing plan-server test that builds a `Stage` literal
  must add `lifecycle: [{ event: "created", at: ... }]`. That is
  the bulk of `src/runtime/runtime.test.ts` plan section
  ([#L359-L580](../../../../src/runtime/runtime.test.ts#L359-L580))
  and `src/store/documents.test.ts`
  ([#L290-L410](../../../../src/store/documents.test.ts#L290-L410)).
- New tests for each state-machine rejection.
- New tests for the projection helper at the HTTP boundary.
- G28's `PlanDocumentSchema` superRefine
  ([../G28/03-plan-r2.md](../G28/03-plan-r2.md) step 2) gains
  another layer of validation interaction — minor but non-trivial.

### Drawbacks

- Adds a schema-level state machine plus a projection layer for
  data we have one consumer for (the SPA debug timeline). The only
  durable observable benefit beyond Option A is the `cancelled`
  event, which is already captured by `result === "aborted"` on
  the completed stage today.
- Touches every literal `Stage` in the test suite — a sprawling
  diff for one half-implementation fix.
- Couples with G28 more tightly: G28's `superRefine` plus this
  per-stage state machine must compose correctly. Bug surface
  grows.
- Speculative: nothing in the round-2 review or the existing
  consumers asks for `cancelled_at` or for an audit log of repeated
  `started` events.

## Recommendation

**Option A.** It deletes the lie, restores honest analytics, and
adds exactly one optional field plus one private helper. The
"architecture-first, no over-engineering" guideline applies — there
is no current consumer that justifies a per-stage lifecycle log, and
adding one would balloon the diff (every `Stage` fixture in the
tests) and the coupling with G28 (two interacting `superRefine`
layers). Option B is reachable later by extending `StageSchema`
again without disturbing the bytes Option A writes today, but it
should be motivated by a real consumer, not by speculation.
