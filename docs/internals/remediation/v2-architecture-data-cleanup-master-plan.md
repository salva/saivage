# Saivage v2 Architecture and Data Cleanup Master Plan

**Date**: 2026-06-04
**Status**: Planned
**Follows**: [Stage run data model](./stage-run-data-model.md), commit `0b9230f`

## Purpose

This plan consolidates the architecture and data-structure review into one staged
cleanup program. The target is a simpler Saivage v2 architecture where runtime
state has clear ownership, workers share one generic execution path, and durable
data has fewer duplicate sources of truth.

The earlier remediation packet already reduced several large classes and added a
first-class `StageRunStore`. The remaining complexity is now concentrated in:

- Multiple worker roles that share the same lifecycle but use separate dispatch
  tools and branches.
- Split stage state across `plan.json`, stage artifact files, and
  `.saivage/events.jsonl`.
- Store/read-model abstractions that overlap or expose each other's paths.
- Large bootstrap, MCP runtime, provider-router, and config surfaces.
- Schemas with ambiguous optional/null semantics and incomplete cross-field
  validation.

## Principles

- Prefer mechanical, behavior-preserving refactors before semantic changes.
- Keep agent autonomy: prompts and conventions should guide tactics; runtime
  should validate artifacts and protect integrity boundaries.
- Make one service own each durable concern: plan queue, stage execution, notes,
  knowledge/RAG, runtime process state, provider routing.
- Avoid large storage migrations until there is a concrete operational need.
- Keep every phase independently shippable, testable, and commit-sized.
- Remove compatibility code only after current deployments and tests no longer
  need it.

## Validation Policy

For each step:

```bash
npm run typecheck
npm run lint
```

Also run focused tests for the touched files.

For each phase:

```bash
npm test
npm run build
npm run docs:build
git diff --check
```

If a step changes web/API behavior, also run the relevant web or API smoke tests.

## Stage 0 - Baseline and Ownership Audit

**Goal**: Freeze the current intent and identify active compatibility obligations
before removing or consolidating anything.

### Work

1. Record the current state of the architecture and data structures in this plan.
2. Confirm which compatibility paths are still needed by local deployments:
   `.saivage/plan.json.history`, `.saivage/stages/**` artifacts, old chat logs,
   and `research/` outside `.saivage/`.
3. Add or update tests that pin current behavior for stage reads, plan completion,
   event reads, and API read models.

### Exit Criteria

- Current persisted files and read paths are documented.
- Every planned removal has either a test proving it is unused or a migration
  note explaining why it is safe.
- Full validation passes.

## Stage 1 - Low-Risk Data Contract Cleanup

**Goal**: Remove ambiguity in paths and schemas without changing runtime
behavior.

### Work

1. Make `ProjectContext.paths.events` required everywhere and remove the fallback
   in `StageRunStore.eventsPath`.
2. Audit schemas that use `.nullable().optional()` and choose one semantic per
   field:
   - Use `.optional()` when absence is enough.
   - Use `.nullable()` only when explicit `null` carries meaning.
3. Add `StageSummarySchema` validation for task counts:
   `tasks_completed + tasks_failed <= total_tasks`, with explicit handling for
   aborted/escalated stages if not every task receives a terminal report.
4. Normalize defaulted arrays and metadata fields in `TaskSchema` where safe,
   especially `tags`, `dependencies`, and checklist fields.
5. Decide whether `research/` remains an operator-visible project artifact path
   or moves under `.saivage/research/`. If moved, introduce a short migration
   window and update role conventions.

### Exit Criteria

- `ProjectContext` exposes one canonical event-log path.
- Schemas no longer allow unnecessary `undefined | null | value` triples.
- Stage summary inconsistencies fail validation early.
- No behavior changes beyond rejecting malformed persisted documents.

## Stage 2 - Stage Execution Ownership Cleanup

**Goal**: Make `StageRunStore` the clear owner of stage execution data while
preserving the current compatibility file layout.

### Work

1. Remove `ProjectStore` path passthroughs that expose `StageRunStore` internals.
2. Rename or narrow `ProjectStore` to a read-model facade, for example
   `ProjectReadModel` or `StageRunReadModel`.
3. Ensure HTTP/API route handlers read stage execution data through the read model
   and do not reconstruct stage state directly from raw paths.
4. Keep stage artifact files as compatibility/readability files for now:
   - `.saivage/stages/<stage-id>/tasks.json`
   - `.saivage/stages/<stage-id>/reports/<task-id>.json`
   - `.saivage/stages/<stage-id>/summary.json`
5. Classify events as either lifecycle facts or artifact mirrors. Stop adding new
   mirrored event types unless a current reader needs them.
6. Add a reconciliation test for the partial-write case: artifact exists, event is
   missing. Reads should remain deterministic and explainable.

### Exit Criteria

- Stage execution reads have one public service boundary.
- Route handlers no longer know stage artifact path details unless they are file
  browsing endpoints.
- The artifact-plus-event split is documented as intentional compatibility, not
  an accidental dual source of truth.

## Stage 3 - Plan History and Stage History Separation

**Goal**: Keep `plan.json` focused on planning queue state and make stage history
derivation explicit.

### Work

1. Define the canonical meaning of `plan.json`:
   - `stages`: planned/active queue.
   - `current_stage_id`: active pointer.
   - `history`: compatibility projection only, not the preferred execution
     history source.
2. Add `StageRunStore.listCompletedRuns()` coverage for all current completion
   paths: completed, failed, escalated, aborted, and knowledge archival.
3. Change API reads that need completed stage history to prefer
   `StageRunStore.listCompletedRuns()` and fall back to `plan.history` only for
   legacy files.
4. Prepare a migration script that converts historical `plan.history` entries
   into lifecycle events or derived read-model rows, but do not run it by default.
5. Decide after deployment observation whether to remove `plan.history` writes or
   keep them as a compatibility projection.

### Exit Criteria

- New code does not rely on `plan.history` as the primary history source.
- Legacy projects still load and show completed stages.
- `PlanService.plan_complete_stage()` has a documented ownership boundary:
  planning transition first, stage history projection second.

## Stage 4 - Generic Worker Dispatch

**Goal**: Collapse duplicate worker dispatch paths into one generic worker
lifecycle while preserving role-specific prompts, models, and write conventions.

### Work

1. Introduce a `run_worker` dispatch tool with input:
   - `role`: one of the worker roles.
   - `stage_id`.
   - `task` or `task_id` plus task details.
   - Optional `context` or `expected_artifacts` fields.
2. Keep existing `run_coder`, `run_researcher`, `run_data_agent`, `run_designer`,
   `run_critic`, and `run_reviewer` as temporary compatibility aliases.
3. Update `AgentOrchestrator` to route all worker dispatch through one generic
   path using `ROSTER` metadata.
4. Update `WorkerAgent.createWorker()` so role differences come from roster
   metadata and worker prompt templates, not separate control flow.
5. Update manager prompts to prefer `run_worker`.
6. Add tests that prove:
   - Each worker role can be dispatched through `run_worker`.
   - Stage-scoped roles still preserve conversation state within a stage.
   - Ephemeral roles still start fresh per task.
   - Compatibility aliases produce the same child-spawner input as `run_worker`.

### Exit Criteria

- New manager behavior uses `run_worker`.
- Old role-specific tools still work for existing prompts/tests until the next
  cleanup stage.
- There is one generic worker construction path.

## Stage 5 - Remove Worker Dispatch Compatibility Aliases

**Goal**: Finish the worker simplification after prompts and tests no longer need
role-specific dispatch tools.

### Work

1. Remove role-specific dispatch schemas and prompt references.
2. Remove alias handling from dispatcher/orchestrator code.
3. Update `ROSTER` so dispatch metadata for worker roles is data for
   `run_worker`, not individual tool names.
4. Update tool-filter tests and prompt snapshots.
5. Confirm manager prompt still communicates role choice clearly enough for the
   model to choose the right worker role.

### Exit Criteria

- There is exactly one worker dispatch tool.
- `ROSTER` remains the source of truth for worker roles, but not for duplicated
  dispatch schemas.
- Worker prompt and report behavior remains unchanged.

## Stage 6 - MCP Runtime Split

**Goal**: Separate simple in-process tool registration from external MCP server
process management.

### Work

1. Extract an `InProcessServiceRegistry` responsible only for direct handler
   registration, lookup, listing, and invocation.
2. Keep external stdio MCP lifecycle in an `ExternalMcpRuntime` or similarly
   named class.
3. Make the existing `McpRuntime` a facade during the transition if that reduces
   churn.
4. Register built-in services with the in-process registry, not the external MCP
   process manager.
5. Add focused tests for:
   - In-process call context propagation.
   - External service cooldown/restart behavior.
   - API tool listing across both registries.

### Exit Criteria

- Built-in tools do not depend on external MCP lifecycle code.
- External service failures cannot affect in-process services.
- Existing public `McpRuntime` behavior is preserved or intentionally narrowed.

## Stage 7 - Bootstrap and Runtime Composition Cleanup

**Goal**: Make runtime startup readable and testable by extracting subsystem
composition.

### Work

1. Extract focused factories:
   - `createRoutingAndRouter()`
   - `createKnowledgeAndRag()`
   - `createToolRuntime()`
   - `createPersistenceServices()`
   - `createRuntimeLifecycle()`
   - `createAgentRuntime()`
2. Keep `bootstrap()` as the high-level composition script.
3. Narrow `SaivageRuntime` so fields are either public runtime services or route
   dependencies, not every intermediate object.
4. Remove optional fields that are always initialized, such as `stageRuns?`, once
   tests and construction paths prove they are required.

### Exit Criteria

- `bootstrap.ts` can be understood as ordered startup steps without reading every
  subsystem detail.
- Subsystem factories are independently unit-testable.
- Runtime dependencies have clear ownership and fewer optional fields.

## Stage 8 - Provider Routing and Config Simplification

**Goal**: Keep provider routing behavior while shrinking the router/config mental
model.

### Work

1. Split `SaivageConfigSchema` into imported sections:
   - provider accounts
   - model routing
   - MCP services
   - RAG
   - auth/channels/runtime settings
2. Preserve the exported `SaivageConfigSchema` shape for compatibility.
3. Move pure candidate-selection helpers into a focused module or absorb them into
   `ModelRouter` if a separate class no longer provides value.
4. Keep credential resolution separate; it is a real security/auth boundary.
5. Add tests for model fallback, sticky failover, quota usage sorting, and account
   resolution around any moved logic.

### Exit Criteria

- Config schema sections can be read independently.
- Provider routing is still behaviorally identical under existing tests.
- `ModelRouter` owns fewer unrelated responsibilities or delegates to clearly
  named policy modules.

## Stage 9 - Event and History Canonicalization Decision

**Goal**: Make a final storage decision after the lower-risk cleanups have made
the current layout easier to observe.

### Options

1. **Keep compatibility layout**: stage artifacts remain canonical, events are a
   lifecycle/debug timeline.
2. **Per-stage `run.json`**: one atomic stage aggregate becomes canonical, current
   artifact files become compatibility projections.
3. **Full event log**: append-only events are canonical, artifacts are derived or
   cached projections.
4. **SQLite stage store**: move stage run metadata into a queryable store if API
   and UI reads need stronger indexing or concurrency semantics.

### Recommended Decision Point

Do not choose a heavier storage model until one of these is true:

- Artifact/event partial states cause real recovery ambiguity.
- API/UI reads become slow or too complex.
- Multiple writers need stronger concurrency guarantees.
- A migration is already required for another breaking storage change.

### Exit Criteria

- A short architecture decision record captures the chosen model.
- If a migration is chosen, it includes a reversible dry-run and fixture coverage.
- If no migration is chosen, the current compatibility layout is explicitly
  documented as the supported model.

## Stage 10 - Final Legacy Cleanup

**Goal**: Remove temporary aliases, compatibility bridges, and stale docs once the
new architecture is stable.

### Work

1. Remove worker dispatch aliases after `run_worker` is established.
2. Remove unused path fallbacks and legacy plan-history assumptions.
3. Delete stale docs that conflict with the new ownership model, or mark them as
   historical provenance.
4. Update README/runbook references to point at the current architecture docs.
5. Run a dead-code scan for old helper exports kept only for transition.

### Exit Criteria

- No temporary compatibility code remains without a documented current consumer.
- The current docs describe the actual runtime and data model.
- Full validation passes.

## Risk Register

| Risk | Mitigation |
| --- | --- |
| Worker consolidation changes model behavior | Keep aliases first, update prompts gradually, snapshot prompts, and use focused dispatcher/orchestrator tests. |
| Stage history reads regress for old projects | Keep `plan.history` fallback until migration fixtures prove old projects load. |
| Event/artifact split remains confusing | Document canonical read order and add partial-state reconciliation tests. |
| Bootstrap extraction creates import cycles | Extract factories by dependency direction; use type-only imports where possible. |
| MCP split breaks tool listing or context propagation | Preserve facade until both in-process and external test suites pass. |
| Config split changes defaults | Keep one exported `SaivageConfigSchema`; move definitions without changing composed output. |

## Target End State

- Planner and Manager remain the primary orchestration roles.
- All worker roles execute through one generic worker dispatch path.
- `ROSTER` defines worker capabilities, prompts, model slots, and conventions.
- Stage execution data has one public owner and one documented read model.
- `plan.json` is primarily a planning queue, not the main execution-history store.
- Built-in MCP tools are independent from external MCP subprocess lifecycle.
- Bootstrap is an ordered composition script, not the only place to understand the
  runtime.
- Schemas express clear contracts without ambiguous optional/null triples.
- Compatibility code is either removed or tied to a current deployment need.
