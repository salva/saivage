# Saivage v2 Architecture Cleanup Plan

**Date**: 2026-06-04
**Status**: Draft for implementation
**Follows**: `v2-simplification-plan.md`, commit `9705346`

## Purpose

This plan turns the post-simplification architecture review into an ordered cleanup program. The ordering starts with deeper structural changes because they determine the seams for later small cleanups. The only exceptions are prerequisite edits that remove misleading coupling before a deeper refactor starts.

## Priority Rules

- Prefer changes that reduce lifecycle and dependency ambiguity before local file-size cleanup.
- Avoid introducing framework objects unless they replace scattered ownership already present in code.
- Keep public facades stable during each phase; delete compatibility glue at phase boundaries.
- Every phase must be independently shippable and validated.
- Do not mix behavior changes with pure boundary extraction unless the old boundary makes a behavior bug unavoidable.

## Design Documents

| Area | Design Doc | Covers |
| --- | --- | --- |
| Runtime/lifecycle/orchestration | [Runtime lifecycle and orchestration](./runtime-lifecycle-and-orchestration.md) | Bootstrap split, runtime facades, signal ownership, agent orchestration, stage-scoped worker reuse, planner compaction hook. |
| Provider routing | [Provider routing unification](./provider-routing-unification.md) | Canonical provider/account route objects, router decomposition, credential/registry boundaries. |
| Tool schemas, RAG, persistence | [Tool schema and persistence unification](./tool-schema-and-persistence-unification.md) | Plan/RAG tool registries, generated MCP schemas, RAG provider config ownership, atomic JSON write consolidation. |

## Phase 0 — Prerequisite Encapsulation Fixes

These are small changes that simplify later deep work and reduce misleading coupling.

### 0.1 Use `WorkerAgent.runNext()` for cached workers

**Problem**: `AgentFactory` mutates cached worker input through a cast before calling `run()`.

**Action**:

- Replace the cast-and-mutate path with an explicit cached-worker execution path that calls `cached.agent.runNext(workerInput)`.
- Keep tracker registration and event handling unchanged.
- Add/adjust a focused test proving follow-up dispatch increments the worker turn and receives the new task.

**Validation**: `npm test -- src/agents/worker-spawn.test.ts src/agents/agents.test.ts`

### 0.2 Move planner-specific compaction hook out of `BaseAgent`

**Problem**: `BaseAgent` contains planner-only memory hook policy.

**Action**:

- Add an optional `beforeCompaction` callback to `BaseAgentConfig` or `CompactionController` deps.
- Move the pre-compaction memory hook body into `PlannerAgent` or `planner-compaction-hook.ts`.
- Keep `BaseAgent` responsible only for invoking the hook before compaction.

**Validation**: `npm test -- src/agents/base.compaction.test.ts src/agents/planner*.test.ts`

## Phase 1 — Runtime Lifecycle And Agent Orchestration

This is the highest-value deep refactor because current lifecycle behavior is spread across bootstrap, planner runner, CLI, and agents.

### 1.1 Introduce narrow runtime facades

**Action**:

- Define interfaces for current consumers before moving code:
  - `RuntimeLifecycleDeps`: shutdown, cancellation, lock/tracker/fatal-state dependencies.
  - `AgentOrchestratorDeps`: project, routing, router, MCP, notes, tracker, event bus, plan service, agent registry.
  - `ServerReadDeps`: read models and safe command surfaces exposed to HTTP routes.
- Migrate server route registration and chat command creation to receive narrow deps where possible.

**Expected result**: Fewer modules import the full `SaivageRuntime` type.

### 1.2 Create `AgentOrchestrator`

**Action**:

- Move agent creation, tracker start/stop, registry mutation, event publication, and stage-scoped worker cache out of `AgentFactory` into an orchestrator with one primary child-execution method: `run(role, input, parentCtx)`. The orchestrator may also expose planner execution and agent lookup methods as described in the design doc.
- Keep `createChildSpawner()` as a thin adapter over `orchestrator.run()` while call sites migrate.
- Move planner lifecycle registration from `runPlanner()` into the same orchestrator path if it reduces duplication without confusing planner recovery policy.
- Define cache lifetime before moving stage-scoped workers to a runtime-wide owner: evict on stage completion, stage failure/escalation, manager end, abort/shutdown, and any worker failure that leaves the conversation unusable.
- Add focused cache tests for follow-up reuse and eviction on the important terminal paths.

**Expected result**: `Dispatcher` only requests child execution; it does not know construction details. `BaseAgent` still owns the LLM/tool loop, but lifecycle registration is centralized.

### 1.3 Create `RuntimeLifecycle`

**Action**:

- Centralize process signal handling, fatal handling, planner cancellation, server shutdown hooks, supervisor stop, MCP shutdown, knowledge/RAG closure, final runtime-state write, and lock release.
- Use one runtime cancellation token or `AbortController`-like object.
- Propagate the shared lifecycle cancellation token into every agent config, not only Planner, or explicitly cancel all active agents through the orchestrator/registry on shutdown and restart.
- Remove direct signal listeners from `PlannerRunner` and `runPlanner()` once the lifecycle token is available.

**Expected result**: CLI/server entry points signal lifecycle; they do not own shutdown mechanics.

### 1.4 Slim `bootstrap()` into composition

**Action**:

- Extract provider/tool/project service startup helpers only after lifecycle and orchestrator seams exist.
- Keep `bootstrap()` as the place that wires services together and returns the runtime facade.
- Delete obsolete `SaivageRuntime` fields once all consumers use narrow facades.

**Validation Gate**:

- `npm run typecheck`
- `npm test -- src/server/bootstrap.test.ts src/server/planner-runner.test.ts src/server/dispatcher-gate.test.ts src/agents/worker-spawn.test.ts src/agents/librarian.e2e.test.ts src/mcp/toolContext.test.ts src/runtime/runtime*.test.ts`
- Add a lifecycle/bootstrap regression test or grep check for duplicate/stale `process.on("SIGINT")`, `process.on("SIGTERM")`, `uncaughtException`, and `unhandledRejection` handlers; handlers must be removable or delegate to the current lifecycle instance.
- Add a shutdown/restart test proving an active child agent observes cancellation or is explicitly cancelled.
- Full `npm test` before committing the phase.

## Phase 2 — Provider Routing Unification

This phase should start after runtime facades are narrower so provider changes do not amplify existing coupling.

### 2.1 Add canonical route objects

**Action**:

- Have `ModelRoutingResolver` return a typed `ResolvedModelRoute` that includes model spec, provider, model, optional auth profile, and optional account selection.
- Stop re-parsing account refs in multiple router methods where a resolved route is already available.

### 2.2 Extract provider registry and credential resolver

**Action**:

- Move provider descriptors, provider/account instance cache, and provider creation into `ProviderRegistry`.
- Move OAuth/static/API-key/header lookup into `CredentialResolver`.
- Keep `ModelRouter` as the public facade.
- Preserve startup ordering: register providers, run usage/credential inspection that may call `setApiKey()`, warm model caches, then expose synchronous capability/model-eligibility lookups.

### 2.3 Extract candidate execution policy

**Action**:

- Isolate provider-call timeout/error-classification into `ProviderCaller`.
- Keep candidate planning pure and testable.
- Keep health/sticky/usage policy behind small collaborators.
- Add an immutable provider/account model-eligibility snapshot after cache warmup and use it for candidate planning instead of callbacks that inspect provider instances.
- Rebuild model-equivalence discovery after warmup or derive it from the post-warmup eligibility snapshot, so async/cache-backed provider model lists are represented.

**Validation Gate**:

- Existing provider/router/candidate tests.
- Add route-object tests for explicit account, default account, auth profile, provider-independent model, and failover chain cases.
- Add tests that explicit auth profile suppresses account expansion and produces one provider/model candidate with provider/model health key.
- Add tests that pure candidate planning uses an eligibility snapshot and does not call provider instances.
- `npm run typecheck && npm test -- src/providers src/routing`

## Phase 3 — Tool Registry And Schema Unification

This phase removes drift-prone parallel definitions.

### 3.1 Replace Plan MCP parallel definitions with one registry

**Action**:

- Define one `PLAN_TOOL_REGISTRY` mapping tool names to schema, access kind, and handler adapter.
- Derive `getPlanToolSchemas()`, reader/writer sets, and dispatch from the registry.
- Keep `PlanService` as the owner of plan document state and serialized writes.

### 3.2 Replace RAG tool schema duplication with one metadata table

**Action**:

- Define RAG tool metadata with Zod input schemas and tool descriptions.
- Generate MCP JSON schemas from the Zod schemas or keep a single adjacent generated/static JSON schema field verified by tests.
- Ensure handler validation and MCP schema names cannot drift.

### 3.3 Unify planner prompt contract fragments

**Action**:

- Extract shared plan mutation contract text used by planner startup, recovery, continuous improvement, and nudges.
- Keep role-specific prompt content in role prompts or prompt builders; avoid runtime policy hidden in unrelated files.

**Validation Gate**:

- `npm test -- src/mcp/plan*.test.ts src/server/rag/*.test.ts src/server/prompt-snapshots.test.ts`
- `npm run docs:build` if API docs change.

## Phase 4 — RAG Config And Persistence Ownership

This phase should follow schema registry work so RAG config/tool changes have one source of truth.

### 4.1 Make RAG provider config ownership canonical

**Action**:

- Decide whether per-dataset provider `baseUrl`/`apiKey` are supported runtime config.
- If supported, carry provider options through `Dataset.open()` and treat API keys as sensitive in every read model.
- If unsupported, remove the fields from config and docs.

### 4.2 Move mutable RAG dataset config behind an owner

**Action**:

- Stop relying on shared mutable dataset arrays between `RagService` and `RagManager`.
- Add `RagManager.addDatasetConfig/removeDatasetConfig` or a dedicated config repository.
- Preserve the public `sources` array shape. Either implement multiple-source ingest or document/enforce exactly one source in the schema, handler, and tests. Do not rename the public field to `source_root` unless a separate breaking API migration is explicitly approved.

### 4.3 Consolidate atomic JSON persistence helpers

**Action**:

- Extract a shared atomic JSON read/write/read-modify-write helper.
- Support schema validation, fsync options, redaction-sensitive error handling, and config-specific env interpolation bypass.
- Migrate plan, RAG registry, and RAG config persistence incrementally.

### 4.4 Generate SQLite metadata mapping from descriptors

**Action**:

- Define RAG chunk metadata columns once.
- Generate select lists, DDL snippets, row hydration, and insert bindings from that descriptor.

**Validation Gate**:

- RAG manager/store/register/drop tests.
- Drift/e2e RAG tests.
- `npm run typecheck && npm test -- src/rag src/server/rag tests/rag`

## Phase 5 — Final Runtime Surface Cleanup

This phase deletes temporary adapters left by earlier phases.

### 5.1 Delete old broad runtime wiring exports

**Action**:

- Remove `SaivageRuntime` fields no longer consumed.
- Replace remaining full-runtime imports in routes/read models with narrow interfaces.

### 5.2 Re-audit compatibility debt

**Action**:

- Grep for `legacy`, `compat`, `deprecated`, `TODO`, and stale transition comments.
- Delete obsolete compatibility paths that are not required by persisted data or active deployments.

### 5.3 Update remediation index and docs statuses

**Action**:

- Mark completed simplification docs as implemented.
- Add links to the new cleanup plan and designs.
- Record residual risks and validation gaps.

**Validation Gate**:

- `npm run typecheck`
- Focused route/runtime tests for any remaining facade changes.
- Grep check that no server route imports the full runtime when a narrow facade exists.
- Grep check for remaining `legacy`, `compat`, `deprecated`, and `TODO` markers; each remaining marker must be intentional.
- `npm run docs:build`
- `git diff --check`

## Global Validation

Run before the final cleanup commit:

```bash
npm run typecheck
npm run lint
npm test
npm run build
npm run docs:build
git diff --check
```

## Success Criteria

- Runtime lifecycle has one owner.
- Agent lifecycle/registry/tracker updates are centralized.
- Server routes do not need full mutable runtime internals.
- Provider account/auth/model route concepts have one canonical representation.
- Plan and RAG tool schemas cannot drift from handlers.
- RAG provider config has explicit runtime ownership.
- Atomic JSON persistence is shared, not reimplemented per subsystem.
