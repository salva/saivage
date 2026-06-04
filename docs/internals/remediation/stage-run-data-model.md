# Saivage v2 Stage Run Data Model

**Date**: 2026-06-04
**Status**: Proposed design
**Follows**: [v2-architecture-cleanup-plan.md](./v2-architecture-cleanup-plan.md), commit `8abd147`

## Purpose

Saivage v2 now has cleaner runtime, provider-routing, tool-schema, and
persistence seams. The remaining structural friction is not primarily caused by
large classes. It comes from the shape of persisted runtime data.

The current data layout splits one logical stage execution across several files
and services:

- `.saivage/plan.json` stores active stages, the current stage pointer, and
  completed stage history.
- `.saivage/stages/<stage-id>/tasks.json` stores manager-created tasks.
- `.saivage/stages/<stage-id>/reports/<task-id>.json` stores worker evidence.
- `.saivage/stages/<stage-id>/summary.json` stores manager stage closure.
- `.saivage/tmp/state/runtime.json` stores the current process snapshot and
  active agents.
- Debug and recovery code reconstruct timeline, errors, and stage state by
  reading several of those files and inferring relationships.

Those files are individually understandable, but the aggregate they represent is
not explicit. The codebase repeatedly reconstructs the same implicit aggregate:
the lifecycle state of a stage run.

This document proposes making that aggregate explicit with a `StageRunStore` and
event-backed lifecycle model. The initial implementation should preserve the
existing on-disk layout so the refactor is low risk. A later migration can change
the physical storage once callers depend on the explicit model instead of raw
paths.

## Goals

- Make the stage execution lifecycle a first-class data model.
- Keep `plan.json` focused on planning and queue state, not execution history.
- Stop requiring runtime, recovery, UI, and debug code to stitch together stage
  state from unrelated files.
- Move core artifact persistence behind validated runtime-owned methods.
- Preserve agent autonomy: agents decide content and tactics, while the runtime
  owns state integrity and artifact contracts.
- Avoid a large storage migration as the first step.
- Keep every phase independently shippable and testable.

## Non-Goals

- Do not replace the knowledge SQLite sidecar. It is already closer to the
  desired ownership model.
- Do not redesign RAG vector storage. RAG may later align its registry/catalog
  story, but it is not the main source of lifecycle complexity.
- Do not introduce an enterprise event-sourcing framework.
- Do not centralize every project file into one database in the first pass.
- Do not remove agent discretion by making the runtime prescribe exact task
  decomposition or implementation tactics.

## Current Data Model

### Project Context

`ProjectContext` resolves the important `.saivage` paths:

- `paths.plan`: `.saivage/plan.json`
- `paths.stages`: `.saivage/stages`
- `paths.runtimeState`: `.saivage/tmp/state/runtime.json`
- `paths.chats`: `.saivage/tmp/chats`
- `paths.inspections`: `.saivage/inspections`

This is a path registry, not a domain model. It is appropriate as composition
infrastructure, but higher-level services should avoid encoding lifecycle logic
directly against these paths.

### Plan Document

`PlanDocument` currently contains:

- `updated_at`
- `current_stage_id`
- `stages`: active stages
- `history`: completed stages

The active plan is useful for planner and dispatcher decisions. The embedded
history is convenient for simple reads, but it mixes queue state and execution
state. Completion requires moving data out of `stages` into `history`, while
separate stage artifacts remain under `.saivage/stages/<stage-id>`.

This creates two sources of stage truth:

- The stage definition and completion summary in `plan.json` history.
- The concrete execution evidence in the stage artifact directory.

### Stage Artifacts

Each stage directory currently contains:

- `tasks.json`: manager-created task list.
- `reports/*.json`: task reports written by workers.
- `summary.json`: stage summary written by the manager.

These files are useful as operator-readable artifacts, but they are not exposed
through one lifecycle owner. Recovery, debug timeline generation, dispatcher
checks, manager prompts, worker prompts, and tests all know pieces of the same
layout.

### Runtime State

`RuntimeState` stores a process snapshot:

- `status`
- `current_stage_id`
- `active_agents`
- `started_at`
- `updated_at`
- `pid`

`RuntimeTracker` rewrites this snapshot on agent start/stop/activity and stage
changes. This is adequate for a dashboard snapshot, but weak as historical
evidence. Debug timeline and crash recovery need event-like facts but receive a
latest-state file and must infer the rest from plan/stage artifacts.

### Knowledge And RAG

Knowledge is already backed by a SQLite sidecar and lifecycle APIs. That shape
fits the usage better than the old JSON tree did.

RAG is split between configured datasets, `.saivage/rag/registry.json`, and
per-dataset SQLite/vector stores. The registry is explicitly documented as an
operator-visible cache, while provider stamps are authoritative in each store.
That split is acceptable for now. It may later benefit from a canonical dataset
catalog, but it is not the highest-leverage simplification.

## Problems With The Current Shape

### 1. Stage State Is An Implicit Aggregate

The runtime treats a stage as a lifecycle entity, but persistence treats it as
several files plus part of `plan.json`.

Current readers often need to answer questions like:

- Is this stage pending, running, summarized, completed, failed, escalated, or
  aborted?
- Which tasks belong to the stage?
- Which reports satisfy which tasks?
- Was the summary written but not archived into plan history?
- Are there failed task reports that should surface in debug state?
- Can recovery safely reset a task to pending?

Those questions are about one aggregate, but no type represents the aggregate.

### 2. `plan.json` Has Mixed Responsibilities

`plan.json` is doing three jobs:

- Planner queue: what should happen next.
- Current pointer: what stage is active.
- Execution history: what completed.

The first two belong to planning. The third belongs to execution history. Mixing
them forces Plan MCP tools to own some stage lifecycle behavior that would be
better owned by a stage-run service.

### 3. Agents Write Core State Files Directly

The manager prompt instructs the LLM to write `tasks.json` and `summary.json`.
Worker prompts instruct workers to write task reports under `reports/`.

This preserves autonomy over content, but it lets the LLM become the low-level
persistence client for core runtime state. The runtime then needs compliance
checks and repair prompts to detect missing, malformed, or mismatched artifacts.

The better boundary is:

- Agents decide content.
- Agents call narrow artifact tools or submit typed terminal artifacts.
- Runtime validates and persists those artifacts.
- Runtime can still nudge and repair behavioral drift.

### 4. Runtime State Is Snapshot-Only

The dashboard needs a snapshot, but recovery and debug need facts. A snapshot can
say which agents are currently active, but it cannot explain how the system got
there. As a result, debug timeline generation scans plan history and report files
instead of reading lifecycle events.

### 5. UI And Debug Reads Encode Storage Layout

`ProjectStore.stageDetails()`, `debugErrors()`, and `debugTimeline()` encode
knowledge of the stage artifact tree. These are useful read models, but their
current inputs are raw files rather than a domain-level stage-run view. Any
future storage change would ripple through UI/debug code unless a stage-run model
becomes the seam.

## Target Conceptual Model

### Planning Aggregate

`PlanDocument` should describe intended work, not completed execution evidence.

Target responsibilities:

- Active stage queue.
- Current stage pointer.
- Planner update timestamp.

Possible target shape:

```ts
interface PlanDocumentVNext {
  updated_at: string;
  current_stage_id: string | null;
  stages: Stage[];
}
```

History should eventually be a read model derived from stage runs, not embedded
in the planning document. During transition, `PlanService` must continue
maintaining embedded history because `plan_complete_stage()` is part of the
Planner contract and currently owns stage archival. The first stage-run work
must not move that ownership. It should only add a stage-run record/event at the
same boundary.

The intended ownership sequence is:

- Phase 1 and Phase 2: `plan_complete_stage()` remains the archival tool and
  continues to call knowledge archival.
- Phase 3: typed artifact tools write tasks, reports, and summaries through
  `StageRunStore`, but `plan_complete_stage()` still closes the stage.
- Phase 4A: `plan_complete_stage()` writes embedded plan history and attempts
  knowledge archival as it does today, then calls
  `StageRunStore.markStageCompleted()` to record the completed stage-run event
  and archival outcome.
- Phase 4B: history views are derived from completed stage runs and embedded
  history is removed only after a planned format migration.

### Stage Run Aggregate

A stage run is the lifecycle record for executing one stage definition.

Conceptual shape:

```ts
type StageRunStatus =
  | "planned"
  | "running"
  | "tasks_ready"
  | "summarized"
  | "completed"
  | "failed"
  | "escalated"
  | "aborted";

interface StageRun {
  stage_id: string;
  definition: Stage;
  status: StageRunStatus;
  tasks: TaskList | null;
  reports: TaskReport[];
  summary: StageSummary | null;
  started_at: string | null;
  completed_at: string | null;
  updated_at: string;
  events: StageRunEvent[];
}
```

The exact persisted shape can differ. The important point is that consumers ask
for a `StageRun` or `StageRunView`, not for unrelated files.

`tasks_ready` means the stage has a valid `TaskList` artifact. It is produced by
the `tasks_written` event and is distinct from task execution status.

### Stage Run Events

Events should be small append-only records, not a framework.

Example event types:

```ts
type StageRunEvent =
  | { type: "stage_started"; stage_id: string; at: string; agent_id?: string }
  | { type: "tasks_written"; stage_id: string; at: string; task_count: number; agent_id?: string }
  | { type: "task_started"; stage_id: string; task_id: string; at: string; agent_id: string }
  | { type: "task_report_written"; stage_id: string; task_id: string; at: string; status: "completed" | "failed"; agent_id?: string }
  | { type: "stage_summary_written"; stage_id: string; at: string; result: StageSummary["result"]; agent_id?: string }
  | { type: "stage_completed"; stage_id: string; at: string; result: StageSummary["result"]; agent_id?: string }
  | { type: "knowledge_archived"; stage_id: string; at: string; outcome: "ok" | "failed" }
  | { type: "stage_recovered"; stage_id: string; at: string; action: string };
```

Events should initially live in one project-wide `.saivage/events.jsonl` file.
That choice keeps debug timeline reads simple, avoids scanning every historical
stage directory, and matches the timeline-oriented read model the UI already
wants. The event records carry `stage_id`, so per-stage views can still be
derived cheaply enough for v2's expected scale.

The event log is not a separate public write surface. Public artifact methods
append the corresponding event internally after a successful artifact write.
Callers should not be able to write a task report and forget its event.

### Runtime Snapshot

Keep `runtime.json` as a snapshot for process liveness and dashboard state:

```ts
interface RuntimeSnapshot {
  status: "idle" | "running" | "suspended" | "error";
  current_stage_id: string | null;
  active_agents: AgentState[];
  started_at: string;
  updated_at: string;
  pid: number;
}
```

Do not make this file responsible for historical facts. Historical facts belong
in stage-run events and stage artifacts.

## Proposed `StageRunStore`

### Responsibility

`StageRunStore` owns stage execution persistence and views. It is the only
service that should know how stage tasks, reports, summaries, and events are
stored on disk.

It should not own planner strategy, agent construction, provider routing,
knowledge, RAG, or HTTP response formatting. It should return domain objects
such as `StageRun` and `StageRunSummary`; `ProjectStore` remains responsible for
mapping those objects into API/read-model shapes such as `StageDetailsView`.

### Initial API

The first pass should be intentionally small:

```ts
interface StageRunStore {
  getStageRun(stageId: string): Promise<StageRun | null>;
  listStageRuns(): Promise<StageRunSummary[]>;

  markStageStarted(stage: Stage, opts: { agentId: string; at?: string }): Promise<void>;
  writeTaskList(taskList: TaskList, opts?: { agentId?: string; at?: string }): Promise<void>;
  writeTaskReport(report: TaskReport, opts?: { agentId?: string; at?: string }): Promise<void>;
  writeStageSummary(summary: StageSummary, opts?: { agentId?: string; at?: string }): Promise<void>;
  markStageCompleted(args: {
    stageId: string;
    result: StageSummary["result"];
    agentId?: string;
    knowledgeArchiveOutcome?: "ok" | "failed";
    at?: string;
  }): Promise<void>;

  readEvents(filter?: { stageId?: string }): Promise<StageRunEvent[]>;
}
```

`at` defaults to `new Date().toISOString()` for every write method. Callers only
provide it in tests, migrations, or recovery paths that need to preserve an
existing timestamp.

The first implementation can still write:

- `tasks.json`
- `reports/<task-id>.json`
- `summary.json`
- `.saivage/events.jsonl`

This gives the architecture a stable seam before changing physical storage.

`StageRunStore` should serialize write operations with a small in-process
operation queue, matching the `PlanService` approach. This keeps JSONL appends
ordered and prevents concurrent report writes from interleaving event writes in a
surprising order. Cross-process writes remain guarded by the existing runtime
lock policy; this store is a runtime-owned service, not a multi-writer database.

### Validation Rules

`StageRunStore` should enforce invariants now spread across compliance checks,
recovery, and read models:

- `TaskList.stage_id` must match the target stage directory.
- Every task ID in a task list must be unique within the stage.
- `TaskReport.stage_id` must match the stage.
- `TaskReport.task_id` must match an existing task when a task list exists, or
  match a `task_started` event during migration/recovery of older stages.
- `TaskReport.agent` must match the task's `assigned_to` when the task exists.
- `StageSummary.stage_id` must match the stage.
- Terminal summaries must include internally consistent task counts. The current
  `StageSummarySchema` does not enforce cross-field count consistency, so
  `StageRunStore` must add this check when enough task/report evidence exists.
- Writes must be atomic.
- Events must be appended by the same public method that writes the artifact.
  If the artifact write succeeds and the event append fails, the method must
  retry the event append once and then throw a typed persistence error that makes
  the partial state explicit.

These are state-integrity rules. They fit the runtime's hard-boundary role and
do not reduce agent autonomy over task content.

### Read Models

`ProjectStore.stageDetails()` can call `StageRunStore.getStageRun()` and map the
domain object to the existing `StageDetailsView` API shape.

`debugErrors()` and `debugTimeline()` should eventually read stage runs and
events instead of scanning raw stage directories. During transition, they can use
the store's compatibility view, which is backed by the current files.

For existing stages that predate `.saivage/events.jsonl`, `StageRunStore` should
derive a compatibility event view from plan history, `tasks.json`, reports, and
`summary.json`. The compatibility view is read-only; new writes should always
append real events.

### Task Status Semantics

`tasks.json` should remain the manager's planning-time task contract. It records
the intended work, assignment, dependencies, attempts, and manager-provided
status hints. Runtime task status should move toward being derived from events
and reports:

- A task with a `task_started` event and no terminal report is running or
  interrupted.
- A task with a valid `task_report_written` event and report has the report's
  terminal status.
- A task with neither event nor report keeps its planning-time status, usually
  `pending`.

Recovery should read derived status first. For old stages with no events, it
should fall back to the current report-scan behavior and may still patch
`tasks.json` to preserve compatibility.

## Tool And Agent Boundary Changes

### Current Boundary

Current prompts instruct agents to write JSON artifacts directly to fixed paths.
The runtime validates after the fact.

### Target Boundary

Provide narrow artifact tools or terminal submission tools:

- `stage_write_tasks`
- `task_write_report`
- `stage_write_summary`
- `stage_get_run`
- `stage_list_reports`

The exact MCP names can follow existing Plan/RAG tool registry conventions and
the single-source schema guidance in
[tool-schema-and-persistence-unification.md](./tool-schema-and-persistence-unification.md).
The first implementation should add the tools beside Plan MCP rather than
inventing another framework; a later split into a dedicated `StageRunService` is
only justified if the tool set grows or Plan MCP becomes unclear.

Agents still receive prompts explaining expected behavior and where artifacts are
visible. But core persistence should go through tools that call `StageRunStore`.

Example prompt shift:

- Old: "Write `.saivage/stages/<stage>/tasks.json`."
- New: "Call `stage_write_tasks` with a valid `TaskList`. The runtime will
  persist it under the stage run."

This keeps the runtime as an observer and contract validator, not a tactical
workflow controller.

## Storage Options

### Option A: Compatibility Files With `StageRunStore`

Keep the current files and add a central owner.

Pros:

- Lowest migration risk.
- Preserves operator-readable artifacts.
- Lets code migrate to the new API incrementally.
- Easy to validate with existing tests.

Cons:

- Physical duplication remains.
- Some reconstruction still happens inside `StageRunStore`.

Recommendation: implement this first.

### Option B: Per-Stage `run.json`

Create `.saivage/stages/<stage-id>/run.json` containing the aggregate, while
keeping reports as separate files if desired.

Pros:

- One canonical per-stage lifecycle record.
- Simple manual inspection.
- Easier recovery than scanning multiple files.

Cons:

- Larger rewrite on every report if reports are embedded.
- Requires migration or dual-write during transition.
- Risk of conflicts if several workers write reports concurrently.

Use only after Option A proves the aggregate API.

### Option C: SQLite Stage Store

Store stage runs, tasks, reports, summaries, and events in SQLite.

Pros:

- Strong query model for UI/debug/history.
- Better concurrency control.
- Natural append-only event table.
- Avoids repeated directory scans.

Cons:

- Larger operational change.
- Less transparent than JSON files for operators.
- Requires backup/export story for human-readable artifacts.

This may be the best long-term shape if v2 continues growing, but it should not
be the first step.

## Migration Plan

### Phase 1: Introduce `StageRunStore` Over Existing Files

Actions:

- Add `src/store/stage-run-store.ts` or `src/stage-runs/store.ts`.
- Move stage artifact path helpers from `ProjectStore` into this store.
- Move task-report and summary validation into the store.
- Add `.saivage/events.jsonl` read/write helpers, but keep event appends
  internal to artifact-writing methods.
- Add a small operation queue for stage-run writes.
- Keep `ProjectStore` as a read-model facade that maps `StageRun` domain objects
  to existing API/read-model shapes.
- Add compatibility reconstruction for stages that have artifacts but no events.

Validation:

- Focused unit tests for valid/missing/invalid task reports and summaries.
- Recovery tests proving behavior is unchanged.
- Route/read-model tests proving API responses are unchanged.
- Regression tests proving old-file reconstruction returns the same timeline and
  error views as the current `ProjectStore` logic for representative fixtures.

### Phase 2: Route Runtime Writes Through `StageRunStore`

Actions:

- Replace direct `ProjectStore.writeStageTaskReport()` and
  `writeStageSummary()` paths with `StageRunStore` calls.
- Update manager failure/abort summary paths to use the store.
- Add event writes for stage start, task report write, and summary write inside
  the corresponding store methods.
- Keep prompts unchanged in this phase if that makes the refactor safer.

Validation:

- `npm test -- src/agents/agents.test.ts src/runtime/runtime.test.ts src/store/project.test.ts`
- A regression proving `needsArchival: true` behavior is unchanged when a
  `summary.json` exists for an active stage.
- A regression proving prompt snapshots remain unchanged in Phase 2.
- Full `npm test` before committing.

### Phase 3: Add Typed Artifact Tools

Actions:

- Add MCP tools for task list, task report, and stage summary submission.
- Generate schemas from the existing Zod contracts or a single registry, matching
  the recent Plan/RAG registry cleanup pattern.
- Place the first tool registry beside Plan MCP so `plan_complete_stage()` and
  stage artifact submission share one obvious planning/execution tool surface.
- Change manager and worker prompts to call these tools instead of writing raw
  JSON files.
- Keep repair prompts for drift, but treat malformed artifacts as tool validation
  failures where possible.

Validation:

- Tool schema tests.
- Agent prompt snapshot tests.
- Worker/manager integration tests with stub tool calls.

### Phase 4: Derive History From Stage Runs

Actions:

- Add `StageRunStore.listCompletedRuns()` or equivalent.
- Build plan history views from stage runs.
- Add `StageRunStore.markStageCompleted()` and call it from
  `PlanService.plan_complete_stage()` after the plan history write and knowledge
  archival attempt. The event should record the knowledge archival outcome.
- Keep `PlanService` as the stage-closing tool until planner contracts and
  prompt snapshots have been migrated.
- Narrow `PlanService` to active queue and current pointer only in a later
  format-migration step after derived history is proven.
- Keep a temporary history compatibility writer only if a live deployment needs
  it; otherwise remove embedded history in a planned format migration.

Validation:

- Plan MCP tests for active queue behavior.
- Debug timeline/history tests.
- Crash recovery tests for summarized-but-not-archived stages.
- A test proving `archiveStage()` still runs exactly once per stage close.

### Phase 5: Reconsider Physical Storage

Actions:

- Decide between continued compatibility files, per-stage `run.json`, or SQLite.
- If changing storage, migrate behind `StageRunStore` without changing callers.
- Preserve operator-visible export files if SQLite becomes canonical.

Validation:

- Migration tests from current `.saivage/stages` layout.
- Recovery tests across pre- and post-migration layouts if compatibility is kept.

## Expected Architecture After Phase 3

- Planner owns plan intent through Plan MCP tools.
- Manager owns task decomposition and summary content, but submits them through
  validated tools.
- Workers own task evidence content, but submit reports through validated tools.
- `StageRunStore` owns stage execution persistence and lifecycle events.
- `ProjectStore` owns API/read-model composition only.
- Runtime recovery reads one stage-run abstraction instead of manually stitching
  plan, tasks, reports, and summary files.
- Debug timeline reads lifecycle events plus derived stage-run views.

## Open Questions

- How much history compatibility is required for deployed v2 instances?
- If SQLite becomes canonical later, what human-readable export should operators
  get by default?

Resolved decisions from this design:

- Stage-run events start as one project-wide `.saivage/events.jsonl` file.
- `plan_complete_stage()` remains the archival and stage-close tool through the
  first implementation phases.
- `tasks.json` remains the planning-time task contract; runtime status is
  progressively derived from events and reports.

## Recommendation

Start with Phase 1 only: introduce `StageRunStore` over the existing files.

This is the smallest change that creates the right architectural seam. It does
not require a data migration, does not change agent behavior, and does not force
a physical storage decision. Once the runtime, recovery, and read models depend
on the explicit stage-run aggregate, deeper cleanup becomes much safer.
