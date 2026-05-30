# G28 — Analysis r1

## Functional analysis

`plan_complete_stage` mutates two files in succession with two separate
`writeDoc` calls and an in-memory cache write that follows them
([src/mcp/plan-server.ts](../../../../src/mcp/plan-server.ts#L243-L257)):

1. `writeDoc(planPath, nextPlan, PlanSchema)` — removes the stage from
   the active plan, nulls `current_stage_id` if it pointed at the
   completed stage, bumps `updated_at`.
2. `writeDoc(historyPath, nextHistory, PlanHistorySchema)` — appends a
   freshly built `CompletedStage` to the history array.
3. `this.plan = nextPlan; this.history = nextHistory;` — refreshes the
   F34 cache.
4. `archiveStage(...)` — best-effort knowledge archival; failure is
   logged and swallowed.

Each `writeDoc` call is per-file atomic (tmp + fsync + rename + parent
fsync, [src/store/documents.ts](../../../../src/store/documents.ts#L73-L102)),
but there is no cross-file primitive. A crash, SIGKILL, power loss, or
unhandled rejection between steps 1 and 2 leaves on-disk state in one
of three observable shapes:

| When the crash lands | `plan.json` on disk | `plan-history.json` on disk | Observable failure on restart |
| --- | --- | --- | --- |
| After step 1, before step 2 | stage removed, `current_stage_id` may be `null` | unchanged (no completion record) | The stage silently vanishes. `PlanService.init()` rehydrates a plan without it and a history that never recorded it; the planner may re-add and re-run the same objective, or worse, the operator-facing dashboard loses the stage from both panes. |
| During step 2 (tmp written, rename not yet executed) | already advanced | unchanged | Same as above plus a stale `plan-history.json.<pid>.<ts>.<rand>.tmp` file (eventually swept by `sweepStaleTempFiles`). |
| During step 1 cache update only relevant after success | advanced | appended (atomically) | Consistent — this is the success path. |

The cache write in step 3 is not the failure mode; the failure mode is
**disk divergence**. The acknowledging comment on
[src/mcp/plan-server.ts](../../../../src/mcp/plan-server.ts#L248-L253)
admits this is "out of scope for F34" — i.e. the cache fix did not try
to close the cross-doc gap.

### Concrete failure scenarios

- **Re-run of completed work.** Stage removed, history never updated.
  On restart the planner sees a plan with N−1 stages, loads
  `survivors` from the history that lacks the completion record, and
  may either generate a duplicate stage with the same objective or
  treat the just-finished stage as cancelled. Workers will redo the
  acceptance criteria; any side effects already committed to git from
  the original run get re-attempted.
- **Lost audit trail.** The completion summary, `actual_outcomes`, and
  any `escalation`/`abort_reason` are never persisted. Supervisor
  dashboards and post-mortems show a zero-row gap. Telegram
  notifications that fired before the second write happened cannot be
  reconstructed from history.
- **Knowledge archival drift.** `archiveStage` runs only on the
  success path; if step 2 fails the stage is half-removed from plan
  but its scoped skills/memory remain "live", linked to a stage id no
  document references.
- **Reader divergence between cache and disk.** While the process is
  alive the F34 cache is updated only after both writes succeed
  ([line 254-255](../../../../src/mcp/plan-server.ts#L254-L255)). But
  every non-PlanService reader of these files bypasses the cache:
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
  crash involved. Because `writeDoc` for the plan does fsync the
  parent directory, the window is small but non-zero, and G29 makes
  it worse by serialising all plan reads behind that same op queue
  while the writes are in flight.

### Why the in-memory cache does not save this

`PlanService` is the only writer of these two files but it is one of
many readers. The cache merely speeds up future reads from the same
service instance; on process restart it is reloaded from disk by
`init()`. If disk diverged before the crash, the reload is silently
inconsistent and the planner moves on with broken state.

## Affected code

- [src/mcp/plan-server.ts](../../../../src/mcp/plan-server.ts#L66-L77)
  — `init()` rehydrates `plan` and `history` independently; no
  recovery for half-completed transactions.
- [src/mcp/plan-server.ts](../../../../src/mcp/plan-server.ts#L194-L260)
  — `plan_complete_stage` itself.
- [src/store/documents.ts](../../../../src/store/documents.ts#L73-L172)
  — `writeDoc` (per-file only), `sweepStaleTempFiles` (cleans orphan
  tmp files but knows nothing about cross-doc intent).
- [src/store/project.ts](../../../../src/store/project.ts#L72-L75) —
  `paths.plan` and `paths.planHistory` (two separate sibling files).
- [src/types.ts](../../../../src/types.ts#L45-L80) — `PlanSchema` and
  `PlanHistorySchema` defined as independent top-level documents.
- [src/agents/roster.ts](../../../../src/agents/roster.ts#L50) —
  planner `writeTerritory` declares both files.
- All readers that consult both files independently and so can observe
  half-applied state (listed above).

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
  real plan + plan-history files. The change has to land cleanly on
  fresh project trees because the architecture-first guideline
  forbids one-shot migration shims, but the operator path for the
  three already-running deployments needs to be spelled out in the
  plan.
- G27 patches the same handler (`started_at` source), G29 patches the
  serialisation gate. Whatever shape `plan_complete_stage` ends up
  with after G28 must leave room for both follow-ups.

## Open questions

1. Is there any consumer that genuinely needs `plan.json` and
   `plan-history.json` as separate files (e.g. external tooling, git
   commit hooks, web UI URLs)? The repo-internal scan above shows
   only Saivage code reading them; no operator-facing doc treats
   them as a public contract.
2. `plan_commit` git-commits both files together
   ([src/mcp/plan-server.ts](../../../../src/mcp/plan-server.ts#L284-L317)).
   If we collapse to a single doc, the commit becomes simpler. Are
   there git-history expectations (e.g. external dashboards diffing
   `plan-history.json` alone)? The metaplan is silent on this; we
   assume no.
3. Should the recovery path on `init()` be hard-fail or
   best-effort-log if it detects an impossible state (e.g. a stage in
   both arrays)? Recommend hard-fail — the cache is the source of
   truth at runtime and a corrupted disk doc means the planner can't
   safely proceed.
