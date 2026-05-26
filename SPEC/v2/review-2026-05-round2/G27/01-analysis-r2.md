# G27 — Analysis r2

Round-2 diff vs r1: same root-cause analysis (kept verbatim where
unchanged), with the `plan_set_stages` semantics tightened to
preserve already-recorded `started_at` by stage id (review change
1), and the G28 coupling note rewritten so the inverted-order
fallback uses `optional()` and requires an explicit G28 amendment
(review change 3). Test determinism and rollback dependency are
design/plan concerns and are addressed in r2 of those files.

## What the issue actually is

`plan_complete_stage` in
[src/mcp/plan-server.ts](../../../../src/mcp/plan-server.ts#L210-L235)
constructs the `CompletedStage` record by writing the same `now`
value into both `started_at` and `completed_at`:

```ts
const stage = this.plan.stages[stageIdx];
const now = new Date().toISOString();

const completedStage: CompletedStage = {
  id: stage.id,
  objective: stage.objective,
  expected_outcomes: stage.expected_outcomes,
  actual_outcomes: args.actual_outcomes,
  started_at: now,
  completed_at: now,
  ...
};
```

The active `Stage` schema in
[src/types.ts](../../../../src/types.ts#L32-L43) carries no
`started_at`. `CompletedStageSchema` at
[src/types.ts](../../../../src/types.ts#L54-L75) requires one, and
the handler closes that gap by fabricating it. The Zod parse
therefore succeeds and the file looks well-formed even though every
recorded duration is zero.

## All sites that produce the fabricated value

The fabrication happens in exactly one place. The two `now` write
sites are adjacent:

- [src/mcp/plan-server.ts#L222](../../../../src/mcp/plan-server.ts#L222)
  — `const now = new Date().toISOString();`
- [src/mcp/plan-server.ts#L231](../../../../src/mcp/plan-server.ts#L231)
  — `started_at: now,`
- [src/mcp/plan-server.ts#L232](../../../../src/mcp/plan-server.ts#L232)
  — `completed_at: now,`

There is no other code path that constructs a `CompletedStage`.
`PlanService` is the only writer of `plan-history.json`
([src/store/project.ts](../../../../src/store/project.ts#L72-L75)
lists both paths but only `PlanService` ever calls `writeDoc` on
`historyPath`).

## Where stage start actually happens at runtime

There is no recorded "stage start" event today. The planner flow is:

1. Planner agent calls `plan_add_stage` or `plan_set_stages` to
   create stages (no current pointer required).
   [src/mcp/plan-server.ts#L139-L177](../../../../src/mcp/plan-server.ts#L139-L177).
2. Planner calls `plan_set_current(stageId)` to mark the stage that
   the manager will execute.
   [src/mcp/plan-server.ts#L181-L196](../../../../src/mcp/plan-server.ts#L181-L196).
   This is the actual "stage starts now" event: it is gated by the
   planner choosing to dispatch, and it is the only point where the
   plan transitions from "queued" to "running this one".
3. `run_manager` is dispatched; `ManagerAgent.start` reads the
   current stage and announces it
   ([src/agents/manager.ts#L75](../../../../src/agents/manager.ts#L75)).
4. Eventually planner calls `plan_complete_stage`
   ([src/mcp/plan-server.ts#L198-L246](../../../../src/mcp/plan-server.ts#L198-L246)),
   which is where the fabricated `started_at` is written.

`plan_set_current` is the right hook for recording start time:

- It is the single transition where a stage moves from "queued in
  the active plan" to "executing now". Every other state change
  either precedes it (stage creation) or follows it (manager
  dispatch, completion).
- It is operator-/planner-driven and serialised by `serializeOp`
  ([src/mcp/plan-server.ts#L350-L357](../../../../src/mcp/plan-server.ts#L350-L357)),
  so there is no race between two concurrent "start" recordings for
  the same stage.
- The competing alternative — "first `plan_get_current_stage`
  access" — would mix a read with a write, make the read
  non-idempotent across crashes, and inflate the start time by the
  planner's MCP round-trip latency. It is the wrong hook.

Two non-`plan_set_current` paths can also make a stage current and
must therefore also stamp `started_at`:

- `plan_set_stages(stages, currentStageId)` at
  [src/mcp/plan-server.ts#L113-L137](../../../../src/mcp/plan-server.ts#L113-L137)
  — accepts a `currentStageId` directly. The semantics resolved in
  r2 are documented under "Contract for `plan_set_stages`
  timestamps" below.
- `plan_init(stages?)` at
  [src/mcp/plan-server.ts#L266-L289](../../../../src/mcp/plan-server.ts#L266-L289)
  — currently always writes `current_stage_id: null`, so it cannot
  start a stage today. The design must keep that invariant or
  stamp on the matching stage; the simpler choice is to keep
  `plan_init`'s null invariant and reject any future change that
  violates it.

## Contract for `plan_set_stages` timestamps (resolves review change 1)

`plan_set_stages(stages, currentStageId)` is the only writer that
can replace the entire `stages` array while also choosing a current
stage. Round-1 of this finding left a contradiction between the
design and the plan over whether an already-recorded `started_at`
on the existing `stg-1` survives when the caller submits a fresh
`stg-1` object without that field while moving `currentStageId` to
`stg-2`. The reviewer correctly notes this is not a detail: a
normal planner rewrite could otherwise silently erase or reset an
already-recorded start time and shorten every observed stage
duration.

Resolution adopted for r2:

1. `plan_set_stages` is treated as a stage-set update, **not** a
   timestamp-reset operation. For every incoming stage whose id
   matches an existing active `stages[i]`, if the incoming stage
   has `started_at === undefined` and the existing stage has a
   `started_at` already, the existing value is carried over into
   the new stage record before validation and write.
2. If the caller provides an explicit `started_at` on the incoming
   stage, the caller-provided value wins. This preserves the
   ability to do an operator-driven "reset the clock" by sending
   an explicit value (or to set an honest start time from operator
   notes during recovery).
3. After step 1, if `currentStageId !== null` and the matching
   stage still has `started_at === undefined`, stamp it with
   `new Date().toISOString()`. This is the same stamp rule
   `plan_set_current` uses, applied once per write at the same
   point in the pipeline.
4. Stages whose id is not in the existing `stages` array (newly
   added stages) start with `started_at: undefined` unless the
   caller provided one or that stage is the new `currentStageId`.

Result: switching `currentStageId` from `stg-1` to `stg-2` while
re-sending both stages without explicit timestamps preserves
`stg-1.started_at` (carried over from the existing record) and
stamps `stg-2.started_at` (newly current). A new caller-supplied
`started_at` on either stage wins outright. Tests in the plan are
rewritten to assert exactly this.

## Observable failure modes today

All consumers of `CompletedStage.started_at` see the synthesised
value and produce wrong output:

- HTTP `/api/debug/timeline` at
  [src/server/server.ts#L609-L630](../../../../src/server/server.ts#L609-L630)
  reads `stage.started_at` and `stage.completed_at` from plan
  history, emits a `stage_started` and a `stage_<result>` event
  with identical timestamps. Every stage in the SPA debug timeline
  collapses into a single instant.
- Any post-mortem or supervisor analytic that diffs `completed_at -
  started_at` reports zero duration for every historical stage.
  The data is silently wrong — schema parsing and timeline
  rendering both succeed.
- Operator tooling that ingests `plan-history.json` directly (for
  example for cycle-time reports) inherits the same lie. The file
  has no marker that the value is fabricated.

The web SPA does not currently render `Stage.started_at` for
active stages (no such field exists), so adding it cannot regress
any current UI. The active-plan timeline in
[web/src/components/StatusPanel.vue](../../../../web/src/components/StatusPanel.vue)
shows agent and runtime `started_at`, not stage `started_at`.

## Coupling with G28

G28 (APPROVED, see [../G28/APPROVED.md](../G28/APPROVED.md))
collapses `plan.json` and `plan-history.json` into one
`PlanDocument` whose `stages` field uses the same `StageSchema`
that this finding extends. The APPROVED landing order is **G27
first**, then G28
([../G28/APPROVED.md#L7](../G28/APPROVED.md#L7),
[../G28/03-plan-r2.md#L1-L13](../G28/03-plan-r2.md#L1-L13)). With
that order the shapes never diverge: G27 lands the
`started_at?: string` field on active `StageSchema`; G28 then
embeds the same schema by reference in `PlanDocumentSchema` with
no further schema work.

The inverted-order contingency is what r1 got wrong and r2 fixes
(review change 3):

- G28's own approved contingency text
  ([../G28/03-plan-r2.md#L7-L13](../G28/03-plan-r2.md#L7-L13))
  says that if G28 has to land first the placeholder is
  `started_at: z.string()` — i.e. **required**. That cannot be the
  contingency for G27 because queued (not-yet-current) stages have
  no start time and a required field would reject every ordinary
  plan written by `plan_add_stage` / `plan_init`.
- The shape G27 actually needs on the active `StageSchema` is
  `started_at: z.string().optional()`. Any G28-first emergency
  patch that wants to keep the door open for G27 must therefore
  use `optional()`, not the bare `z.string()` currently spelled in
  the approved G28 plan.
- G27 r2's coordination policy is:
  1. The recommended order is unchanged: **G27 first, then G28,
     then G29**. This is the only path that requires no schema
     amendment to either approved spec.
  2. If operations needs G28 to ship before G27 (e.g. an urgent
     planner-state corruption bug), G27 r2 declares this an
     **explicit contingency** that requires the G28 plan to be
     amended first: change the G28 placeholder to
     `started_at: z.string().optional()`, re-approve, then ship
     G28, then ship G27 as a behavioural-only patch (helper +
     `plan_set_current` / `plan_set_stages` stamping +
     `plan_complete_stage` reject). G27 must not ship on top of a
     required-`started_at` placeholder, because doing so would
     reject every queued stage in every existing project tree on
     the very next `plan_set_stages` call.

## Cross-links

- [G27 finding](../G27-plan-server-started-at-equals-completed-at.md)
- [G28 APPROVED](../G28/APPROVED.md)
- [G28 plan r2](../G28/03-plan-r2.md)
- [G27 round-1 review](04-review-r1.md)
- Round-1 F34 — plan-server in-memory cache.
- Round-1 F19 — runtime/plan coherence.
