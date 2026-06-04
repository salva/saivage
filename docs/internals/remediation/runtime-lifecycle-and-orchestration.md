# Runtime Lifecycle And Agent Orchestration Design

## Problem

The runtime still has unclear ownership after the first simplification pass:

- `bootstrap()` constructs almost every subsystem and owns shutdown details.
- `PlannerRunner`, `runPlanner()`, CLI paths, and bootstrap each register process-level lifecycle behavior.
- Agent lifecycle tracking is split between planner startup and child dispatch.
- Stage-scoped worker reuse mutates internal worker state from the factory.
- `BaseAgent` still contains planner-specific compaction policy.

These are architectural coupling problems, not just file-size problems. They make later provider, MCP, and server cleanup harder because too many modules depend on the full runtime object.

## Goals

- One owner for process/runtime lifecycle.
- One owner for agent lifecycle registration, tracking, registry mutation, and child execution.
- Narrow facades for server and agent consumers.
- `BaseAgent` remains a generic LLM/tool conversation loop.
- Bootstrap becomes wiring, not orchestration policy.

## Non-Goals

- Do not replace all runtime code with a large framework.
- Do not change agent role behavior or prompts except where moving existing text is required.
- Do not change plan semantics or dispatch gates in this design.
- Do not redesign provider routing in this phase.

## Proposed Components

### `RuntimeLifecycle`

Owns process-local lifecycle state and shutdown order.

Responsibilities:

- Install and remove process signal/fatal handlers.
- Expose a runtime cancellation token.
- Cancel active planner/agents on shutdown or explicit restart.
- Stop supervisor.
- Shut down MCP runtime.
- Close knowledge/RAG resources.
- Write final runtime state.
- Release runtime lock exactly once.

Initial shape:

```ts
interface RuntimeLifecycle {
  readonly signal: { aborted: boolean };
  requestShutdown(reason: string): void;
  requestPlannerRestart(reason: string, requestedBy: string): PlannerRestartRequest;
  shutdown(): Promise<void>;
}
```

Implementation detail: start with the existing boolean abort-signal shape to avoid broad churn. Move to `AbortController` only after call sites are centralized.

### `AgentOrchestrator`

Owns agent construction and lifecycle registration.

Responsibilities:

- Build `AgentContext` for a role.
- Resolve model route for a role.
- Create Planner, Manager, Worker, Inspector, and Librarian agents.
- Own stage-scoped worker cache.
- Start/stop tracker entries.
- Add/remove active agents from the registry.
- Publish manager/inspector result events.

Initial shape:

```ts
interface AgentOrchestrator {
  run(role: DispatchableRole, input: unknown, parentCtx: AgentContext): Promise<AgentResult>;
  runPlanner(options?: { abortSignal?: { aborted: boolean } }): Promise<AgentResult>;
  getAgent(agentId: string): BaseAgent | undefined;
}
```

`run()` is the primary child-execution method used by dispatch. `runPlanner()` and `getAgent()` are allowed on the same orchestrator only because they share lifecycle registration and active-agent registry ownership. If implementation shows these methods pull in unrelated dependencies, split them into `PlannerSessionRunner` and `AgentRegistryView` while keeping one owner for tracker/registry mutation.

`createChildSpawner()` becomes:

```ts
const createChildSpawner = (orchestrator: AgentOrchestrator): ChildSpawner =>
  (role, input, parentCtx) => orchestrator.run(role, input, parentCtx);
```

### Runtime Facades

Do not pass the full mutable runtime to every consumer.

Recommended facades:

- `AgentRuntimeDeps`: project, router, routing, MCP, notes, tracker, event bus, plan service, agent registry.
- `ServerRuntimeReads`: safe config read model, provider list/model list, tool listing, agent snapshot lookup, project read store.
- `RuntimeLifecycleDeps`: shutdown, restart, signal, final-state write, closable services.

Keep the old `SaivageRuntime` type during migration, but make new modules accept the smaller interfaces.

## Migration Plan

### Step 1 — Encapsulate worker reuse

- Replace direct cached-worker input mutation with `runNext()`.
- Exact current-code change: when a cached stage-scoped worker exists, call `cached.agent.runNext(workerInput)` instead of assigning through a cast and then calling `agent.run()`.
- Keep the cache inside the existing factory until the orchestrator exists.

### Step 2 — Move planner compaction hook

- Add `beforeCompaction?: () => Promise<void>` to `BaseAgentConfig` or `CompactionController` construction deps.
- Move `runPlannerCompactionHook()` into `PlannerAgent` or a helper imported only by `PlannerAgent`.
- `BaseAgent` should only call `beforeCompaction` when provided.

### Step 3 — Introduce `AgentOrchestrator`

- Move current `AgentFactory` logic into the orchestrator class.
- Keep `AgentFactory` as a compatibility alias or delete it if all imports can change in one commit.
- Move `runPlanner()` lifecycle registration into the orchestrator if that reduces duplication.
- Pass the lifecycle cancellation token into every agent config, not just Planner. Existing child agents do not receive the planner abort signal, so shutdown/restart centralization must either inject the shared token or explicitly cancel all active registry entries.
- Define stage-scoped worker cache lifetime before moving it to a runtime-wide orchestrator: evict on stage completion, stage failure/escalation, manager end, abort, shutdown, and any worker failure that leaves the conversation unusable.

### Step 4 — Introduce `RuntimeLifecycle`

- Move shutdown body from `bootstrap()` into lifecycle.
- Move fatal handlers into lifecycle.
- Replace the current module-global fatal handler guard with either removable per-lifecycle handlers or one process-global handler that delegates to the current lifecycle instance. A handler must not close over a stale runtime or lock after repeated bootstrap in one process.
- Move signal listeners out of `PlannerRunner`/`runPlanner()` and into lifecycle coordination.
- Keep `PlannerControl` only for semantic planner restarts, not process lifecycle.

### Step 5 — Slim `bootstrap()`

- Extract service creation helpers only where they remove real complexity.
- Return a runtime object composed of narrow facades.
- Update server/chat modules to accept facades instead of the broad runtime.

## Shutdown Order

The lifecycle owner should shut down in this order:

1. Mark lifecycle as shutting down and abort new work.
2. Freeze tracker or close it through an explicit `tracker.close()` API.
3. Write shutdown summary.
4. Stop supervisor and active agent loops.
5. Stop accepting MCP/tool work and shut down MCP services.
6. Close knowledge store.
7. Close RAG manager.
8. Clear event bus listeners.
9. Write final runtime state.
10. Release runtime lock.

The final implementation should make repeated shutdown calls idempotent.

## Risks

- Moving signal handling can accidentally leave duplicate listeners. Add tests or grep checks for `process.on("SIGINT"` and `process.on("SIGTERM"`.
- Centralizing agent lifecycle can change tracker ordering. Preserve current event order in focused tests.
- Stage-scoped worker cache may retain failed/cancelled agents. Add explicit eviction rules once orchestrator owns the cache.

## Validation

- Focused worker-spawn tests for cached worker reuse.
- Planner runner tests for explicit restart and recovery loops.
- Bootstrap tests for child spawner behavior.
- Runtime shutdown tests for close order and idempotence.
- Full `npm test` before deleting old lifecycle glue.

## Expected Result

The runtime can be explained as:

- `bootstrap()` wires services.
- `RuntimeLifecycle` owns start/stop/cancel.
- `AgentOrchestrator` owns agent execution lifecycle.
- Agents own conversation behavior.
- Server routes consume narrow read/command facades.
