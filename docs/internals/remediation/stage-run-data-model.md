# Saivage v2 Stage Run Data Model

**Date**: 2026-06-04
**Status**: Phases 1-4 implemented; Phase 5 storage decision recorded
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

This document originally proposed making that aggregate explicit with a
`StageRunStore` and event-backed lifecycle model. Phases 1-4 are now implemented:
Saivage v2 has a `StageRunStore`, stage lifecycle events in
`.saivage/events.jsonl`, typed stage artifact MCP tools, stage-start/task-start
events from the orchestrator, and stage-completion events from Plan MCP.

Phase 5 has been resolved as a storage decision: keep the compatibility files and
project-wide event log for now. Do not migrate to per-stage `run.json` or SQLite
until there is a concrete performance, concurrency, migration, or operations need
that outweighs the current readability and compatibility benefits.

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
- `paths.events`: `.saivage/events.jsonl`
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

History may eventually become a read model derived from stage runs, not embedded
in the planning document. For the current v2 format, `PlanService` continues
maintaining embedded history because `plan_complete_stage()` is part of the
Planner contract and owns stage archival. The implemented stage-run work records
events at the same boundary instead of moving that ownership.

The implemented ownership sequence is:

- Phases 1 and 2: `plan_complete_stage()` remains the archival tool and
  continues to call knowledge archival.
- Phase 3: typed artifact tools write tasks, reports, and summaries through
  `StageRunStore`, but `plan_complete_stage()` still closes the stage.
- Phase 4: `plan_complete_stage()` writes embedded plan history and attempts
  knowledge archival as it did before, then calls
  `StageRunStore.markStageCompleted()` to record the completed stage-run event
  and archival outcome.
- Phase 5: embedded `plan.json.history` remains in place; deriving and removing
  it is deferred until a separate format-migration need is proven.

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
  | { event_id: string; type: "stage_started"; stage_id: string; at: string; agent_id?: string }
  | { event_id: string; type: "tasks_written"; stage_id: string; at: string; task_count: number; agent_id?: string }
  | { event_id: string; type: "task_started"; stage_id: string; task_id: string; at: string; agent_id: string }
  | { event_id: string; type: "task_report_written"; stage_id: string; task_id: string; at: string; status: "completed" | "failed"; agent_id?: string }
  | { event_id: string; type: "stage_summary_written"; stage_id: string; at: string; result: StageSummary["result"]; agent_id?: string }
  | { event_id: string; type: "stage_completed"; stage_id: string; at: string; result: StageSummary["result"]; agent_id?: string }
  | { event_id: string; type: "knowledge_archived"; stage_id: string; at: string; outcome: "ok" | "failed" }
  | { event_id: string; type: "stage_recovered"; stage_id: string; at: string; action: string };
```

Events live in one project-wide `.saivage/events.jsonl` file. That choice keeps
timeline reads simple, avoids scanning every historical stage directory for new
lifecycle facts, and matches the timeline-oriented read model the UI already
wants. The event records carry `stage_id`, so per-stage views can still be
derived cheaply enough for v2's expected scale.

The event log is not a separate public write surface. Public artifact methods
append the corresponding event internally after a successful artifact write.
Callers should not be able to write a task report and forget its event.

Each event needs a stable `event_id`. JSONL append failures can be ambiguous: a
write may reach disk before the caller sees an error. Retried appends therefore
must be deduplicated by `event_id` when reading, and recovery/backfill code must
not treat duplicated lines as multiple lifecycle facts.

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

## Implemented `StageRunStore`

### Responsibility

`StageRunStore` owns stage execution persistence and views. It is the only
service that should know how stage tasks, reports, summaries, and events are
stored on disk.

It should not own planner strategy, agent construction, provider routing,
knowledge, RAG, or HTTP response formatting. It should return domain objects
such as `StageRun` and `StageRunSummary`; `ProjectStore` remains responsible for
mapping those objects into API/read-model shapes such as `StageDetailsView`.

### Implemented API

The implemented API is intentionally small:

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
existing timestamp. The implementation also includes `markTaskStarted()` so the
orchestrator can record runtime-observed worker dispatch facts that artifact
submission methods cannot see.

The implementation writes:

- `tasks.json`
- `reports/<task-id>.json`
- `summary.json`
- `.saivage/events.jsonl`

This gives the architecture a stable seam without changing physical storage.

`StageRunStore` serializes write operations with a small in-process operation
queue, matching the `PlanService` approach. This keeps JSONL appends ordered and
prevents concurrent report writes from interleaving event writes in a surprising
order. Cross-process writes remain guarded by the existing runtime lock policy;
this store is a runtime-owned service, not a multi-writer database.

### Validation Rules

`StageRunStore` enforces the schema-level artifact invariants that were spread
across compliance checks, recovery, and read models, and centralizes the artifact
paths used by those callers. The implemented checks include stage/task/agent
identity validation for expected artifact reads and Zod validation for submitted
task lists, task reports, summaries, and events.

The original target remains useful for future tightening:

- `TaskList.stage_id` must match the target stage directory.
- Every task ID in a task list must be unique within the stage.
- `TaskReport.stage_id` must match the stage.
- Normal task-report writes must match an existing task in `tasks.json`; reports
  for stages without a task list are compatibility reads, not valid new writes.
- `TaskReport.agent` must match the task's `assigned_to` when the task exists.
- `StageSummary.stage_id` must match the stage.
- Terminal summaries must include internally consistent task counts. The current
  `StageSummarySchema` does not enforce cross-field count consistency, so
  `StageRunStore` must add this check when enough task/report evidence exists.
- Individual artifact writes must remain atomic, matching the existing tmp-plus-
  rename `writeDoc()` behavior. The combined artifact-plus-event operation is
  not fully atomic while storage remains split, so partial states must be
  explicit and recoverable.
- Events must be appended by the same public method that writes the artifact.
  If the artifact write succeeds and the event append fails, the method must
  retry the event append using the same `event_id` and then throw a typed
  persistence error that makes the partial state explicit if the retry still
  fails.

These are state-integrity rules. They fit the runtime's hard-boundary role and
do not reduce agent autonomy over task content.

### Read Models

`ProjectStore.stageDetails()` now calls `StageRunStore.getStageRun()` and maps the
domain object to the existing `StageDetailsView` API shape.

`debugErrors()` and `debugTimeline()` should eventually read stage runs and
events instead of scanning raw stage directories. They still use compatibility
raw-file scans for lenient debug/error handling, so this remains the main
read-model cleanup left after Phases 1-4.

For existing stages that predate `.saivage/events.jsonl`, `StageRunStore`
derives a compatibility event view from plan history, `tasks.json`, reports, and
`summary.json`. The compatibility view is read-only; new writes append real
events.

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

### Implemented Boundary

Manager, worker, reviewer, and compliance prompts now direct agents to submit
core stage artifacts through typed tools instead of writing raw JSON as the main
contract. The compatibility file paths remain visible so operators and agents can
inspect the persisted artifacts.

### Tool Surface

The implemented Plan MCP tool surface includes:

- `stage_write_tasks`
- `task_write_report`
- `stage_write_summary`
- `stage_get_run`
- `stage_list_reports`

The MCP names follow existing Plan/RAG tool registry conventions and the
single-source schema guidance in
[tool-schema-and-persistence-unification.md](./tool-schema-and-persistence-unification.md).
The tools live beside Plan MCP rather than in a separate framework. A later split
into a dedicated `StageRunService` is only justified if the tool set grows or
Plan MCP becomes unclear.

Agents still receive prompts explaining expected behavior and where artifacts are
visible. Core persistence goes through tools that call `StageRunStore`.

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

Decision: keep this as the current canonical physical storage shape. The
canonical service seam is `StageRunStore`; the canonical operator-visible files
remain `tasks.json`, `reports/*.json`, `summary.json`, and
`.saivage/events.jsonl`.

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

Defer. Do not introduce per-stage `run.json` unless the compatibility-file
layout creates a concrete recovery or performance problem that cannot be solved
inside `StageRunStore`.

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

Defer. SQLite may become the right shape if v2 needs stronger concurrent writes,
indexed history/debug queries, or a larger event stream, but the current runtime
lock and expected v2 scale do not justify the migration cost.

## Implementation Status And Remaining Work

### Phase 1: Introduce `StageRunStore` Over Existing Files

Status: implemented.

Implemented outcomes:

- `src/store/stage-run-store.ts` exists and owns stage artifact paths.
- `ProjectContext.paths.events` resolves `.saivage/events.jsonl`.
- `StageRunStore` reads/writes the project-wide event log and keeps event appends
  internal to store methods.
- Stage-run writes are serialized through a small in-process queue.
- `ProjectStore.stageDetails()` maps `StageRun` back to the existing API shape.
- Existing stages without real events receive read-only compatibility events from
  plan history, task lists, reports, and summaries.

Validation:

- `src/store/stage-run-store.test.ts`

### Phase 2: Route Runtime Writes Through `StageRunStore`

Status: implemented.

Implemented outcomes:

- `ProjectStore.writeStageTaskReport()` and `writeStageSummary()` delegate to
  `StageRunStore`.
- Artifact writes append `tasks_written`, `task_report_written`, and
  `stage_summary_written` events.
- The orchestrator records `stage_started` and `task_started` events at runtime
  boundaries that observe those transitions.

Validation:

- `src/server/dispatcher-gate.test.ts`
- `src/store/project.test.ts`
- runtime/orchestrator coverage that exercises manager and worker dispatch

### Phase 3: Add Typed Artifact Tools

Status: implemented.

Implemented outcomes:

- Plan MCP includes `stage_write_tasks`, `task_write_report`,
  `stage_write_summary`, `stage_get_run`, and `stage_list_reports`.
- The tool registry remains beside Plan MCP.
- Manager, worker, reviewer, and compliance prompts now point agents to the typed
  submission tools.

Validation:

- `src/mcp/plan-stage-artifacts.test.ts`
- `src/agents/manager-initial-message.test.ts`
- `src/agents/tool-filters.test.ts`

### Phase 4: Record Stage Completion; Keep Embedded History

Status: implemented for the current v2 format; completion is recorded in the
stage-run event log, and history remains embedded in `plan.json` for
compatibility.

Implemented outcomes:

- `StageRunStore.markStageCompleted()` records `stage_completed` and optional
  `knowledge_archived` events.
- `PlanService.plan_complete_stage()` writes embedded plan history, attempts
  knowledge archival, then records the stage-run completion event and archival
  outcome.
- `StageRunStore.listCompletedRuns()` can list completed runs from real or
  compatibility events.
- `PlanService` remains the stage-closing tool and `plan.json.history` remains
  maintained.

Validation:

- `src/mcp/plan-stage-completion.test.ts`
- `src/store/stage-run-store.test.ts`

### Phase 5: Reconsider Physical Storage

Status: resolved for now.

Decision:

- Continue with compatibility files plus `.saivage/events.jsonl`.
- Do not add `.saivage/stages/<stage-id>/run.json` now.
- Do not migrate stage-run storage to SQLite now.
- Reopen this only if there is a concrete performance/concurrency need, a proven
  recovery defect caused by split JSON files, or an operator requirement that the
  current files cannot satisfy.

Validation:

- No migration validation is required because no physical migration is being
  performed.
- Continue covering the compatibility-file layout in `StageRunStore` and Plan MCP
  tests.

## Architecture After Phase 5 Decision

- Planner owns plan intent through Plan MCP tools.
- Manager owns task decomposition and summary content, but submits them through
  validated tools.
- Workers own task evidence content, but submit reports through validated tools.
- `StageRunStore` owns stage execution persistence and lifecycle events.
- `ProjectStore` owns API/read-model composition only.
- Runtime orchestration records stage-start and task-start facts through
  `StageRunStore` while preserving the existing runtime lock model.
- Stage details read through one stage-run abstraction instead of manually
  stitching plan, tasks, reports, and summary files at the API boundary.
- Debug error and timeline views still include lenient compatibility scans over
  raw files; migrating those reads fully to stage-run events remains optional
  cleanup, not a storage-migration prerequisite.

## Open Questions

- When, if ever, should `plan.json.history` become a derived view instead of an
  embedded compatibility field?
- If SQLite becomes canonical later, what human-readable export should operators
  get by default?

## Risks And Mitigations

- Event-log corruption or a truncated final JSONL line could break debug and
  recovery reads. Readers should skip invalid trailing lines with a diagnostic,
  while strict tests cover malformed middle lines.
- Retried event appends can duplicate lifecycle facts. Stable `event_id` values
  and read-time deduplication are required before events drive decisions.
- Event timestamps can be non-monotonic if callers supply `at` or the system
  clock moves. Ordering-sensitive views should prefer file order as the durable
  sequence and `event_id` for deduplication, using timestamps for display.
- Moving artifact writes behind tools caused prompt and snapshot churn, but the
  implemented prompt tests now cover the intended tool instructions.
- Deriving plan history too early would conflict with the current Planner
  contract. `plan_complete_stage()` must keep writing embedded history and
  running knowledge archival until a separate format migration proves the new
  read model.
- The current physical layout is not fully atomic across artifact write plus
  event append. The operation queue keeps in-process ordering, but recovery and
  read models must continue tolerating artifact/event skew.
- The compatibility-file layout is intentionally not optimized for high-volume
  event queries or multi-process stage writers. Reconsider SQLite only when that
  becomes an observed bottleneck.

Resolved decisions from this design:

- Stage-run events start as one project-wide `.saivage/events.jsonl` file.
- `plan_complete_stage()` remains the archival and stage-close tool for the
  current v2 format.
- `tasks.json` remains the planning-time task contract; runtime status is
  progressively derived from events and reports.
- Phase 5 keeps compatibility files plus `.saivage/events.jsonl`; no per-stage
  `run.json` or SQLite migration is planned without a concrete need.

## Recommendation

Keep the implemented `StageRunStore` seam and compatibility-file storage. Future
work should tighten read models and validation behind that seam before revisiting
physical storage. A per-stage `run.json` or SQLite migration should be justified
by measured performance, observed concurrency pressure, or a concrete recovery or
operator-readability requirement.
