# Event and History Canonicalization Decision

Status: accepted on 2026-06-04.

## Context

The v2 cleanup split stage execution data into clearer owners:

- `StageRunStore` owns stage execution artifacts under `.saivage/stages/<stage-id>/`.
- `plan.json` is the planning queue plus a current compatibility projection of completed history.
- Event files are operational timelines used for debugging, recovery evidence, and UI activity views.

Stage 9 of the architecture/data cleanup plan asked whether to migrate to a heavier canonical store, such as per-stage `run.json`, a full event-sourced log, or SQLite.

## Decision

Keep the current compatibility layout as the supported v2 storage model.

Stage artifacts remain canonical for stage execution outputs:

- `tasks.json` records the manager task list for a stage.
- `reports/*.json` records terminal worker reports.
- `summary.json` records the manager terminal stage summary.
- `events.jsonl` under the stage directory records lifecycle events for that stage.

Runtime-wide events remain a timeline/read-model aid, not the canonical source of stage truth. `plan.history` remains a compatibility projection for current planner/API reads, not the long-term execution-history owner.

No storage migration is required for this phase.

## Rationale

- The lower-risk cleanup stages removed the most confusing ownership edges without requiring data migration.
- Current readers can resolve completed-stage state through `StageRunStore` and `planHistoryView()` without ambiguity that justifies a new canonical store.
- A per-stage aggregate, event-sourced store, or SQLite index would add migration and recovery complexity before there is evidence that the current layout is too slow, ambiguous, or concurrency-limited.
- Keeping the layout stable avoids disrupting existing local runtime state while the rest of the legacy cleanup proceeds.

## Deferred Options

Reconsider a heavier store only if one of these triggers appears:

- Artifact/event partial states cause real recovery ambiguity.
- API/UI reads become slow or require complex cross-file scans.
- Multiple writers need stronger concurrency guarantees than atomic JSON files provide.
- Another breaking storage migration is already required.

If reconsidered, the preferred next evaluation order is:

1. Per-stage `run.json` aggregate with compatibility projections.
2. SQLite stage metadata/index for query-heavy reads.
3. Full event-sourced storage only if replay semantics become a product requirement.

## Consequences

- Stage 10 cleanup should remove undocumented compatibility bridges, not introduce a storage migration.
- Documentation should describe the current layout as intentional, not provisional.
- New readers should go through `StageRunStore` or shared read-model helpers instead of ad hoc raw file reads.
- Tests should continue to cover partial artifact behavior and projection reads rather than a new migration path.
