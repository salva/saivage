# Saivage v2 Architecture and Data Cleanup Master Plan

**Date**: 2026-06-04
**Status**: Planned
**Follows**: [Stage run data model](./stage-run-data-model.md), commit `0b9230f`

## Purpose

This plan consolidates the architecture and data-structure review into one staged
cleanup program. The target is a simpler Saivage v2 architecture where runtime
state has clear ownership, workers share one generic execution path, and durable
data has fewer duplicate sources of truth.

This document is the current master sequencing document. Earlier narrower plans,
including [v2-simplification-plan.md](./v2-simplification-plan.md), remain useful
as implementation detail references where they describe already-reviewed local
extractions. If a narrower plan conflicts with this document, this document's
ordering and ownership decisions take precedence.

The earlier remediation packet already reduced several large classes and added a
first-class `StageRunStore`. The remaining complexity is now concentrated in:

- Multiple worker roles that share the same lifecycle but use separate internal
  branches. The LLM-facing tools may remain role-specific if that keeps prompts
  clearer; the implementation should be shared and parameterized.
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
- Do not preserve backwards compatibility for old local runtime artifacts unless
  there is a concrete current deployment need. Prefer clean contracts and simple
  migrations over compatibility branches.

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
2. Confirm which runtime paths are genuine product storage and which are
   accidental local execution artifacts. Repository-local `.saivage` state is not
   product source and should be removed from the working tree and repository
   history if it ever appears there.
3. Keep `research/` as an operator-visible project artifact path. Do not move it
   under `.saivage/`.
4. Make `ProjectContext.paths.events` required everywhere and remove the fallback
   in `StageRunStore.eventsPath`; this is a trivial path-contract cleanup and
   does not need a separate phase.
5. Update comments/docs if any current text implies `research/` is runtime state.
6. Add or update tests that pin current behavior for stage reads, plan completion,
   event reads, and API read models.

### Exit Criteria

- Current persisted files and read paths are documented.
- `ProjectContext` exposes one canonical event-log path.
- Every planned removal has either a test proving it is unused or a migration
  note explaining how current state should be regenerated.
- Full validation passes.

## Stage 1 - Low-Risk Data Contract Cleanup

**Goal**: Remove ambiguity in paths and schemas without changing runtime
behavior.

### Work

1. Audit schemas that use `.nullable().optional()` and choose one semantic per
   field:
   - Use `.optional()` when absence is enough.
   - Use `.nullable()` only when explicit `null` carries meaning.
2. Add `StageSummarySchema` validation for task counts:
   `tasks_completed + tasks_failed <= total_tasks`, with explicit handling for
   aborted/escalated stages if not every task receives a terminal report.
3. Normalize defaulted arrays and metadata fields in `TaskSchema` where safe,
   especially `tags`, `dependencies`, and checklist fields.

### Exit Criteria

- Schemas no longer allow unnecessary `undefined | null | value` triples.
- Stage summary inconsistencies fail validation early.
- Old malformed runtime artifacts may be rejected or regenerated; backwards
  compatibility with accidental historical `.saivage` state is not required.

## Stage 2 - Stage Execution Ownership Cleanup

**Goal**: Make `StageRunStore` the clear owner of stage execution data while
preserving the current compatibility file layout.

### Work

1. Remove `ProjectStore` path passthroughs that expose `StageRunStore` internals.
2. Rename or narrow `ProjectStore` to a read-model facade, for example
   `ProjectReadModel` or `StageRunReadModel`.
3. Ensure HTTP/API route handlers read stage execution data through the read model
   and do not reconstruct stage state directly from raw paths.
4. Keep stage artifact files as readability files for now:
   - `.saivage/stages/<stage-id>/tasks.json`
   - `.saivage/stages/<stage-id>/reports/<task-id>.json`
   - `.saivage/stages/<stage-id>/summary.json`
5. Classify events as either lifecycle facts or artifact mirrors. Make this
   enforceable by replacing broad event append inputs with a typed
   `StageRunEvent` discriminated union and routing all writes through explicit
   event helpers. Stop adding new mirrored event types unless a current reader
   needs them.
6. Add a reconciliation test for the partial-write case: artifact exists, event is
   missing. Reads should remain deterministic and explainable.

### Exit Criteria

- Stage execution reads have one public service boundary.
- Route handlers no longer know stage artifact path details unless they are file
  browsing endpoints.
- The artifact-plus-event split is documented as intentional current storage, not
  an accidental dual source of truth.

## Stage 3 - Plan History and Stage History Separation

**Goal**: Keep `plan.json` focused on planning queue state and make stage history
derivation explicit.

### Work

1. Define the canonical meaning of `plan.json`:
   - `stages`: planned/active queue.
   - `current_stage_id`: active pointer.
   - `history`: current projection for completed stages until the final storage
     ADR chooses whether to remove it.
2. Add `StageRunStore.listCompletedRuns()` coverage for all current completion
   paths: completed, failed, escalated, aborted, and knowledge archival.
3. Change API reads that need completed stage history to use a single read-model
   method. That method may still compose `plan.history`, events, and artifacts
   internally until the final storage ADR chooses a canonical model.
4. Prepare a regeneration/migration script only if the final ADR removes
   `plan.history` or changes the artifact layout.
5. Decide after implementation observation whether `plan.history` should be kept
   as the canonical projection or replaced by derived stage-run history.

### Exit Criteria

- New code reads completed history through one read-model method.
- Callers do not read `plan.history` directly; the read-model method owns any
  composition of `plan.history`, events, and artifacts.
- Old accidental local runtime state does not drive the design.
- `PlanService.plan_complete_stage()` has a documented ownership boundary:
  planning transition first, stage history projection second.

## Stage 4 - Shared Parameterized Worker Implementation

**Goal**: Collapse duplicate worker construction and lifecycle code into one
parameterized implementation while preserving role-specific LLM-facing tools when
they improve prompt clarity and role selection.

### Work

1. Introduce an internal `WorkerDispatchSpec` in `src/agents/` or
   `src/server/agent-orchestrator.ts`, derived from `ROSTER` metadata plus the
   relevant `TaskSchema` fields. It should have fields equivalent to:
   - `role`: one of the worker roles.
   - `stage_id`.
   - `task` or `task_id` plus task details.
   - Optional `context` or `expected_artifacts` fields.
2. Keep existing LLM-facing tools (`run_coder`, `run_researcher`,
   `run_data_agent`, `run_designer`, `run_critic`, `run_reviewer`) unless a later
   prompt test shows a single public `run_worker` tool is clearer.
3. Update `AgentOrchestrator` so every worker dispatch tool maps into
   `WorkerDispatchSpec` and then routes through one generic path using `ROSTER`
   metadata.
4. Update `WorkerAgent.createWorker()` so role differences come from roster
   metadata and worker prompt templates, not separate control flow.
5. Keep manager prompts role-specific by default; only change prompt wording where
   it helps explain the shared lifecycle.
6. Add tests that prove:
   - Each worker role maps to the same internal worker dispatch path.
   - Stage-scoped roles still preserve conversation state within a stage.
   - Ephemeral roles still start fresh per task.
   - Role-specific tools produce the expected `WorkerDispatchSpec`.
   - `WorkerDispatchSpec` remains compatible with the task/report schemas used by
     typed stage artifact tools.

### Exit Criteria

- Worker construction and lifecycle are shared internally.
- Role-specific tools remain available unless a later explicit decision removes
  them.
- There is one generic worker construction path.

## Stage 5 - Worker Dispatch Surface Decision

**Goal**: Decide whether to keep role-specific dispatch tools as the public
LLM-facing surface or replace them with a single `run_worker` tool after the
internal implementation has been unified.

### Work

1. Compare prompt clarity, schema duplication, tool-filter complexity, and test
   churn between the current role-specific tools and a possible `run_worker`
   tool.
2. If role-specific tools remain clearer, keep them and remove only duplicated
   implementation/schema-generation code.
3. If `run_worker` is simpler and prompt tests remain strong, replace the public
   role-specific tools with `run_worker` in one explicit semantic change.
4. Update tool-filter tests and prompt snapshots for the chosen surface.
5. Confirm manager prompt still communicates role choice clearly enough for the
   model to choose the right worker behavior.

### Decision

Keep the role-specific public worker dispatch tools (`run_coder`,
`run_researcher`, `run_data_agent`, `run_designer`, `run_critic`, and
`run_reviewer`). They make the Manager prompt and tool-choice surface explicit,
preserve existing prompt snapshots and tool-filter expectations, and avoid a
semantic public API change. Stage 4 removed the implementation duplication by
mapping every worker tool through one internal `WorkerDispatchSpec` and one
generic worker execution path, so a public `run_worker` tool would currently add
prompt/test churn without reducing runtime branching.

### Exit Criteria

- There is exactly one worker implementation path.
- The public worker dispatch surface is intentionally chosen and documented.
- `ROSTER` remains the source of truth for worker roles.
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
   Extract bottom-up by dependency order: persistence and config first, then tool
   runtime, then lifecycle, then agent runtime, then the final bootstrap wiring.
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

## Stage 8 - Config Simplification

**Goal**: Keep provider routing behavior stable while making the config schema
easier to read.

### Work

1. Split `SaivageConfigSchema` into imported sections while keeping one
   authoritative top-level Zod object for validation and error reporting:
   - provider accounts
   - model routing
   - MCP services
   - RAG
   - auth/channels/runtime settings
2. Preserve the exported `SaivageConfigSchema` shape and parsed output.
3. Do not redesign provider routing in this phase. Keep behavior changes out of
   scope unless a focused test exposes a bug during mechanical extraction.
4. Keep credential resolution separate; it is a real security/auth boundary.
5. Add config-schema tests around defaults and parsing to prove the split is
   mechanical.

### Exit Criteria

- Config schema sections can be read independently.
- Provider routing is behaviorally identical under existing tests.
- Config defaults and parsed output remain stable for current supported config.

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

1. If Stage 5 chose `run_worker`, remove role-specific worker dispatch aliases.
   If Stage 5 kept role-specific tools, remove only duplicated
   schema-generation or implementation code.
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
| Worker consolidation changes model behavior | Preserve role-specific LLM-facing tools by default; share only the internal implementation first. |
| Stage history reads regress after cleanup | Read through one read-model method and regenerate local runtime state when needed. |
| Event/artifact split remains confusing | Document canonical read order and add partial-state reconciliation tests. |
| Bootstrap extraction creates import cycles | Extract factories by dependency direction; use type-only imports where possible. |
| MCP split breaks tool listing or context propagation | Preserve facade until both in-process and external test suites pass. |
| Config split changes defaults | Keep one exported `SaivageConfigSchema`; move definitions without changing composed output. |

## Target End State

- Planner and Manager remain the primary orchestration roles.
- All worker roles execute through one shared parameterized implementation path.
- The public dispatch surface is either role-specific for prompt clarity or a
  single `run_worker` tool if tests prove that is cleaner.
- `ROSTER` defines worker capabilities, prompts, model slots, and conventions.
- Stage execution data has one public owner and one documented read model.
- `plan.json` is primarily a planning queue, not the main execution-history store.
- Built-in MCP tools are independent from external MCP subprocess lifecycle.
- Bootstrap is an ordered composition script, not the only place to understand the
  runtime.
- Schemas express clear contracts without ambiguous optional/null triples.
- Compatibility code is either removed or tied to a current deployment need.
