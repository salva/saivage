# G27 — Analysis r1

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
[src/types.ts](../../../../src/types.ts#L54-L75) requires one, and the
handler closes that gap by fabricating it. The Zod parse therefore
succeeds and the file looks well-formed even though every recorded
duration is zero.

## All sites that produce the fabricated value

The fabrication happens in exactly one place. The two `now`
write sites are adjacent:

- [src/mcp/plan-server.ts#L222](../../../../src/mcp/plan-server.ts#L222)
  — `const now = new Date().toISOString();`
- [src/mcp/plan-server.ts#L231](../../../../src/mcp/plan-server.ts#L231)
  — `started_at: now,`
- [src/mcp/plan-server.ts#L232](../../../../src/mcp/plan-server.ts#L232)
  — `completed_at: now,`

There is no other code path that constructs a `CompletedStage`.
`PlanService` is the only writer of `plan-history.json`
([src/store/project.ts](../../../../src/store/project.ts#L72-L75) lists
both paths but only `PlanService` ever calls `writeDoc` on
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

- It is the single transition where a stage moves from "queued in the
  active plan" to "executing now". Every other state change either
  precedes it (stage creation) or follows it (manager dispatch,
  completion).
- It is operator-/planner-driven and serialised by `serializeOp`
  ([src/mcp/plan-server.ts#L350-L357](../../../../src/mcp/plan-server.ts#L350-L357)),
  so there is no race between two concurrent "start" recordings for
  the same stage.
- The competing alternative — "first `plan_get_current_stage` access"
  — would mix a read with a write, make the read non-idempotent
  across crashes, and inflate the start time by the planner's MCP
  round-trip latency. It is the wrong hook.

Two non-`plan_set_current` paths can also make a stage current and
must therefore also stamp `started_at`:

- `plan_set_stages(stages, currentStageId)` at
  [src/mcp/plan-server.ts#L113-L137](../../../../src/mcp/plan-server.ts#L113-L137)
  — accepts a `currentStageId` directly.
- `plan_init(stages?)` at
  [src/mcp/plan-server.ts#L266-L289](../../../../src/mcp/plan-server.ts#L266-L289)
  — currently always writes `current_stage_id: null`, so it cannot
  start a stage today. The design must keep that invariant or stamp
  on the matching stage; the simpler choice is to keep `plan_init`'s
  null invariant and reject any future change that violates it.

## Observable failure modes today

All consumers of `CompletedStage.started_at` see the synthesised
value and produce wrong output:

- HTTP `/api/debug/timeline` at
  [src/server/server.ts#L609-L630](../../../../src/server/server.ts#L609-L630)
  reads `stage.started_at` and `stage.completed_at` from plan
  history, emits a `stage_started` and a `stage_<result>` event with
  identical timestamps. Every stage in the SPA debug timeline
  collapses into a single instant.
- Any post-mortem or supervisor analytic that diffs `completed_at -
  started_at` reports zero duration for every historical stage. The
  data is silently wrong — schema parsing and timeline rendering
  both succeed.
- Operator tooling that ingests `plan-history.json` directly (for
  example for cycle-time reports) inherits the same lie. The file
  has no marker that the value is fabricated.

The web SPA does not currently render `Stage.started_at` for active
stages (no such field exists), so adding it cannot regress any
current UI. The active-plan timeline in
[web/src/components/StatusPanel.vue](../../../../web/src/components/StatusPanel.vue)
shows agent and runtime `started_at`, not stage `started_at`.

## Coupling with G28

G28 (APPROVED, see
[../G28/APPROVED.md](../G28/APPROVED.md)) collapses `plan.json` and
`plan-history.json` into one `PlanDocument` whose `stages` field uses
the same `StageSchema` that this finding extends. The APPROVED
landing order is **G27 first**, then G28
([../G28/03-plan-r2.md](../G28/03-plan-r2.md) step 1). Whatever
field G27 adds to `StageSchema` is what G28 embeds in
`PlanDocumentSchema`. There is no shape conflict, but the order
matters: if G28 lands first it must include a placeholder
`started_at` to keep the schemas in sync.

## Cross-links

- [G27 finding](../G27-plan-server-started-at-equals-completed-at.md)
- [G28 APPROVED](../G28/APPROVED.md)
- [G28 design r2](../G28/02-design-r2.md)
- [G28 plan r2](../G28/03-plan-r2.md)
- Round-1 F34 — plan-server in-memory cache.
- Round-1 F19 — runtime/plan coherence.
