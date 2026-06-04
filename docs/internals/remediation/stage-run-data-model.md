# Saivage v2 Stage Run Data Model

**Date**: 2026-06-04
**Status**: Proposed design
**Follows**: `v2-architecture-cleanup-plan.md`, commit `8abd147`

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
"what is the lifecycle state of this stage run?"

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

`ProjectStore.stageDetails()`, `debugErrors()`, and `debugTimeline()` know the
stage artifact tree. These are useful read models, but their current inputs are
raw files rather than a domain-level stage-run view. Any future storage change
would ripple through UI/debug code unless a stage-run model becomes the seam.

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

History should be a read model derived from stage runs, not embedded in the
planning document. During transition, `PlanService` can continue maintaining
embedded history while `StageRunStore` becomes the primary read/write seam for
new code.

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

### Stage Run Events

Events should be small append-only records, not a framework.

Example event types:

```ts
type StageRunEvent =
  | { type: "stage_started"; stage_id: string; at: string; agent_id: string }
  | { type: "tasks_written"; stage_id: string; at: string; task_count: number }
  | { type: "task_started"; stage_id: string; task_id: string; at: string; agent_id: string }
  | { type: "task_report_written"; stage_id: string; task_id: string; at: string; status: "completed" | "failed" }
  | { type: "stage_summary_written"; stage_id: string; at: string; result: StageSummary["result"] }
  | { type: "stage_archived"; stage_id: string; at: string; result: StageSummary["result"] }
  | { type: "stage_recovered"; stage_id: string; at: string; action: string };
```

These events can initially live in `.saivage/stages/<stage-id>/events.jsonl` or
in a single `.saivage/events.jsonl`. A per-stage file keeps the transition local;
a single global file makes timeline reads cheaper. Either is acceptable if the
writer API is centralized.

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
knowledge, RAG, or HTTP response formatting.

### Initial API

The first pass should be intentionally small:

```ts
interface StageRunStore {
  getStageRun(stageId: string): Promise<StageRun | null>;
  listStageRuns(): Promise<StageRunSummary[]>;
  getStageDetails(stageId: string): Promise<StageDetailsView>;

  markStageStarted(stage: Stage, opts: { agentId: string; at?: string }): Promise<void>;
  writeTaskList(taskList: TaskList, opts?: { agentId?: string; at?: string }): Promise<void>;
  writeTaskReport(report: TaskReport, opts?: { agentId?: string; at?: string }): Promise<void>;
  writeStageSummary(summary: StageSummary, opts?: { agentId?: string; at?: string }): Promise<void>;

  appendEvent(event: StageRunEvent): Promise<void>;
  readEvents(stageId: string): Promise<StageRunEvent[]>;
}
```

The first implementation can still write:

- `tasks.json`
- `reports/<task-id>.json`
- `summary.json`
- `events.jsonl`

This gives the architecture a stable seam before changing physical storage.

### Validation Rules

`StageRunStore` should enforce invariants now spread across compliance checks,
recovery, and read models:

- `TaskList.stage_id` must match the target stage directory.
- Every task ID in a task list must be unique within the stage.
- `TaskReport.stage_id` must match the stage.
- `TaskReport.task_id` must match an existing task when a task list exists.
- `TaskReport.agent` must match the task's `assigned_to` when the task exists.
- `StageSummary.stage_id` must match the stage.
- Terminal summaries must include internally consistent task counts.
- Writes must be atomic.
- Events must be appended after successful artifact writes, not before.

These are state-integrity rules. They fit the runtime's hard-boundary role and
do not reduce agent autonomy over task content.

### Read Models

`ProjectStore.stageDetails()` can delegate to `StageRunStore.getStageDetails()`.

`debugErrors()` and `debugTimeline()` should eventually read stage runs and
events instead of scanning raw stage directories. During transition, they can use
the store's compatibility view, which is backed by the current files.

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

The exact MCP names can follow existing Plan/RAG tool registry conventions.

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
- Add event append/read helpers, initially per-stage `events.jsonl`.
- Keep `ProjectStore` as a read-model facade that delegates to `StageRunStore`.

Validation:

- Focused unit tests for valid/missing/invalid task reports and summaries.
- Recovery tests proving behavior is unchanged.
- Route/read-model tests proving API responses are unchanged.

### Phase 2: Route Runtime Writes Through `StageRunStore`

Actions:

- Replace direct `ProjectStore.writeStageTaskReport()` and
  `writeStageSummary()` paths with `StageRunStore` calls.
- Update manager failure/abort summary paths to use the store.
- Add event writes for stage start, task report write, and summary write.
- Keep prompts unchanged in this phase if that makes the refactor safer.

Validation:

- `npm test -- src/agents/agents.test.ts src/runtime/recovery.test.ts src/store/project.test.ts`
- Full `npm test` before committing.

### Phase 3: Add Typed Artifact Tools

Actions:

- Add MCP tools for task list, task report, and stage summary submission.
- Generate schemas from the existing Zod contracts or a single registry, matching
  the recent Plan/RAG registry cleanup pattern.
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
- Narrow `PlanService` to active queue and current pointer.
- Keep a temporary history compatibility writer only if a live deployment needs
  it; otherwise remove embedded history in a planned format migration.

Validation:

- Plan MCP tests for active queue behavior.
- Debug timeline/history tests.
- Crash recovery tests for summarized-but-not-archived stages.

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

- Should stage-run events be per-stage files or one project-wide event log?
- Should `plan_complete_stage` remain the archival tool, or should a stage-run
  tool complete the stage and then update the plan queue?
- Should task status remain mutable in `tasks.json`, or should task status be
  derived from events and reports?
- How much history compatibility is required for deployed v2 instances?
- If SQLite becomes canonical later, what human-readable export should operators
  get by default?

## Recommendation

Start with Phase 1 only: introduce `StageRunStore` over the existing files.

This is the smallest change that creates the right architectural seam. It does
not require a data migration, does not change agent behavior, and does not force
a physical storage decision. Once the runtime, recovery, and read models depend
on the explicit stage-run aggregate, deeper cleanup becomes much safer.
