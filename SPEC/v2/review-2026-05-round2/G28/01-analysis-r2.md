# G28 — Analysis r2

## Functional analysis

`plan_complete_stage` mutates two on-disk documents in succession with two
separate `writeDoc` calls plus an in-memory cache write that follows them
([src/mcp/plan-server.ts](../../../../src/mcp/plan-server.ts#L243-L257),
[src/store/documents.ts](../../../../src/store/documents.ts#L75-L101)):

1. `writeDoc(planPath, nextPlan, PlanSchema)` — removes the stage from
   the active plan, nulls `current_stage_id` if it pointed at the
   completed stage, bumps `updated_at`.
2. `writeDoc(historyPath, nextHistory, PlanHistorySchema)` — appends a
   freshly built `CompletedStage` to the history array.
3. `this.plan = nextPlan; this.history = nextHistory;` — refreshes the
   F34 cache.
4. `archiveStage(...)` — best-effort knowledge archival; failure logged.

Each `writeDoc` call is per-file atomic (tmp + fsync + rename + parent
fsync). There is no cross-file primitive. A crash, SIGKILL, power loss,
or unhandled rejection between steps 1 and 2 leaves on-disk state in one
of three observable shapes:

| When the crash lands | `plan.json` on disk | `plan-history.json` on disk | Observable failure on restart |
| --- | --- | --- | --- |
| After step 1, before step 2 | stage removed, `current_stage_id` may be `null` | unchanged (no completion record) | The stage silently vanishes. `PlanService.init()` rehydrates a plan without it and a history that never recorded it; the planner may re-add and re-run the same objective, or the operator dashboard loses the stage from both panes. |
| During step 2 (tmp written, rename not yet executed) | already advanced | unchanged | Same as above, plus a stale `plan-history.json.<pid>.<ts>.<rand>.tmp` file eventually swept by `sweepStaleTempFiles`. |
| Steps 1 and 2 both succeed | advanced | appended (atomically) | Consistent — this is the success path. |

The cache write in step 3 is not the failure mode; the failure mode is
**disk divergence**. The acknowledging comment on
[src/mcp/plan-server.ts](../../../../src/mcp/plan-server.ts#L248-L253)
admits this is "out of scope for F34" — i.e. the cache fix did not try
to close the cross-doc gap.

### Concrete failure scenarios

- **Re-run of completed work.** Stage removed, history never updated.
  On restart the planner sees a plan with N−1 stages and a history that
  lacks the completion record, and may either generate a duplicate
  stage with the same objective or treat the just-finished stage as
  cancelled. Workers will redo the acceptance criteria; any side
  effects already committed to git from the original run get
  re-attempted.
- **Lost audit trail.** The completion summary, `actual_outcomes`, and
  any `escalation`/`abort_reason` are never persisted. Supervisor
  dashboards and post-mortems show a zero-row gap. Telegram
  notifications that fired before the second write happened cannot be
  reconstructed from history.
- **Knowledge archival drift.** `archiveStage` runs only on the
  success path; if step 2 fails the stage is half-removed from plan
  but its scoped skills/memory remain "live", linked to a stage id no
  document references.
- **Reader divergence (inter-process, not intra-queue).** Inside
  `PlanService`, `handleToolCall` funnels every tool call through
  `serializeOp`
  ([src/mcp/plan-server.ts](../../../../src/mcp/plan-server.ts#L347-L357)),
  so MCP tool reads cannot interleave with the two-write sequence —
  queued MCP reads see a consistent cached view. The inconsistent
  surface is in **direct file readers** that bypass the
  `PlanService` queue entirely:
  - [src/server/server.ts](../../../../src/server/server.ts#L144-L145)
    (status/plan API),
  - [src/server/server.ts](../../../../src/server/server.ts#L480-L481)
    (plan-history endpoint),
  - [src/agents/handoff.ts](../../../../src/agents/handoff.ts#L22-L23),
  - [src/agents/chat.ts](../../../../src/agents/chat.ts#L312-L336),
  - [src/runtime/shutdown-handoff.ts](../../../../src/runtime/shutdown-handoff.ts#L39-L40),
  - [src/server/cli.ts](../../../../src/server/cli.ts#L122).

  Between the two writes, a concurrent HTTP read of `/api/plan` and
  `/api/plan-history` returns inconsistent snapshots even with no
  crash involved. `writeDoc` for the plan does fsync the parent
  directory, so the window is small but non-zero.

### Why the in-memory cache does not save this

`PlanService` is the only writer of these two files but it is one of
many readers. The cache merely speeds up future reads from the same
service instance; on process restart it is reloaded from disk by
`init()`. If disk diverged before the crash, the reload is silently
inconsistent and the planner moves on with broken state.

## Affected code

- [src/mcp/plan-server.ts](../../../../src/mcp/plan-server.ts#L48-L77)
  — `PlanService` declares two paths and two cache fields
  (`plan`, `history`); `init()` rehydrates them independently with no
  recovery for half-completed transactions.
- [src/mcp/plan-server.ts](../../../../src/mcp/plan-server.ts#L89-L194)
  — active-plan readers and mutators that all depend on the two-field
  split: `plan_get`, `plan_get_stage` (reads both `plan` and
  `history`), `plan_get_current_stage`, `plan_set_stages`,
  `plan_add_stage`, `plan_remove_stage`, `plan_set_current`.
- [src/mcp/plan-server.ts](../../../../src/mcp/plan-server.ts#L194-L260)
  — `plan_complete_stage` (the two-write sequence).
- [src/mcp/plan-server.ts](../../../../src/mcp/plan-server.ts#L262-L295)
  — `plan_get_history`, `plan_init` (writes only `plan.json` but the
  current contract leaves history file absent until
  `plan_complete_stage` first runs).
- [src/mcp/plan-server.ts](../../../../src/mcp/plan-server.ts#L297-L335)
  — `plan_commit` git-commits both files (`[this.planPath,
  this.historyPath]`).
- [src/store/documents.ts](../../../../src/store/documents.ts#L73-L172)
  — `writeDoc` (per-file only), `sweepStaleTempFiles` (cleans orphan
  tmp files but knows nothing about cross-doc intent).
- [src/store/project.ts](../../../../src/store/project.ts#L30-L74) —
  `paths.plan` and `paths.planHistory` (two separate sibling files).
- [src/types.ts](../../../../src/types.ts#L45-L80) — `PlanSchema` and
  `PlanHistorySchema` defined as independent top-level documents.
- [src/index.ts](../../../../src/index.ts#L6-L25) — barrel re-exports
  `Plan` and `PlanHistory`.
- [src/agents/roster.ts](../../../../src/agents/roster.ts#L50) —
  planner `writeTerritory` declares both files.
- Spec docs that pin the two-file shape as authoritative:
  [SPEC/v2/01-DATA-MODEL.md](../../01-DATA-MODEL.md#L97-L102),
  [SPEC/v2/03-PLAN-MCP-SERVICE.md](../../03-PLAN-MCP-SERVICE.md#L7-L40),
  [SPEC/v2/05-MCP-SERVICES.md](../../05-MCP-SERVICES.md#L237).
- Operator docs that document the two-file shape:
  [docs/internals/plan-mcp.md](../../../../docs/internals/plan-mcp.md#L32-L40),
  [docs/internals/on-disk-layout.md](../../../../docs/internals/on-disk-layout.md#L13-L59).
- Generated TypeDoc output under `docs/api/` that re-emits
  `PlanSchema`/`PlanHistorySchema` symbols (regenerated by
  `npm run docs`; will go away on the next rebuild).
- All non-PlanService readers listed above plus any tests pinning the
  two-file layout: [src/agents/conversation-snapshot.test.ts](../../../../src/agents/conversation-snapshot.test.ts#L62)
  and the suites enumerated in `03-plan-r2.md` step 6.

## Constraints

- Architecture-first, no migration shims, no backward compat: the fix
  is allowed to change the on-disk layout and delete old code rather
  than adding a recovery sidecar on top of the current design.
- v2 harness writes to `.saivage/plan.json` and
  `.saivage/plan-history.json` are referenced by tests
  ([src/runtime/runtime.test.ts](../../../../src/runtime/runtime.test.ts#L83-L84),
  [src/runtime/shutdown-handoff.test.ts](../../../../src/runtime/shutdown-handoff.test.ts#L46-L47),
  [src/agents/chat.lifecycle.test.ts](../../../../src/agents/chat.lifecycle.test.ts#L79-L80),
  [src/agents/agents.test.ts](../../../../src/agents/agents.test.ts#L586-L587),
  [src/agents/base.compaction.test.ts](../../../../src/agents/base.compaction.test.ts#L57-L58),
  [src/agents/planner.nudge.test.ts](../../../../src/agents/planner.nudge.test.ts#L46-L47)).
  Any path change has to update them.
- Live daemons (`saivage` 10.0.3.111, `diedrico` 10.0.3.113,
  `saivage-v3` 10.0.3.112) bind-mount the source tree and persist
  real plan + plan-history files. The architecture-first rule
  forbids one-shot migration shims, but the operator path for the
  three already-running deployments must be spelled out in the plan
  (see `03-plan-r2.md`). `saivage-v3-getrich-v2` 10.0.3.170 does
  **not** run this code path and is explicitly out of scope.
- G27 patches the same handler. G27's recommendation is to store
  `started_at` on the active `Stage` itself (set when
  `plan_set_current` activates it) instead of synthesising it from
  `completed_at`. That changes `StageSchema`, which becomes an
  element of `PlanDocument.stages`. G28 must therefore either land
  after G27 (so `PlanDocumentSchema` embeds the updated
  `StageSchema` directly) or land first with an explicit placeholder
  acknowledging the field will be added by G27. The plan picks one
  ordering and states it precisely.
- G29 patches the serialisation gate. G29's intent is to let reads
  bypass `serializeOp`. Even after that change, G28 still removes the
  cross-doc disk window for non-PlanService readers, so G29 lands
  cleanly after G28.

## Open questions

1. Is there any consumer that needs `plan.json` and
   `plan-history.json` as separate files (external tooling, git
   commit hooks, web UI URLs)? The repo-internal scan above shows
   only Saivage code reading them; no operator-facing doc treats
   them as a public contract.
2. `plan_commit` git-commits both files together
   ([src/mcp/plan-server.ts](../../../../src/mcp/plan-server.ts#L284-L317)).
   Collapsing to a single doc simplifies the commit. The metaplan is
   silent on git-history expectations; we assume no external diffing
   depends on `plan-history.json` as a separate file.
3. Should the recovery path on `init()` be hard-fail or
   best-effort-log if it detects an impossible state (e.g. a stage
   id present in both `stages` and `history`, or
   `current_stage_id` not in `stages`)? Recommendation: **hard-fail
   at `init()`**. The cache is the source of truth at runtime and a
   corrupted disk doc means the planner cannot safely proceed.
