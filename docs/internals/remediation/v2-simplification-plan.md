# Saivage v2 Simplification Implementation Plan

**Date**: 2026-06-04
**Follows**: `v2-simplification-report.md`
**Status**: Planned — not yet started

---

## Overview

Four phases, ordered by risk and dependency. Each phase is independently committable and testable. Within each phase, steps are ordered by dependency (earlier steps unblock later ones).

**Validation gate after every step**: `npm run typecheck && npm run lint` plus focused tests for the new/changed file.

For behavior-affecting or public-API changes (notably 3.1, 3.2, 4.2, and 4.3), also run the affected broader suite immediately in the same step. Do not wait for the phase gate to catch class hierarchy, API, or registration-order regressions.

**Full validation gate after each phase**: `npm test && npm run build && npm run docs:build`

---

## Phase 1 — Pure Extractions (No Behavior Change)

These are file moves and re-exports. No logic changes. All existing tests must pass without modification.

---

### Step 1.1 — Extract dispatch tool schemas from `base.ts`

**Goal**: Move the 9 dispatch tool JSON Schema definitions, `makeWorkerDispatchSchema` factory, `ROLE_DISPATCH_TOOLS` map builder, `getDispatchToolsForRole`, and `TRIVIAL_EVIDENCE_TOOLS` constant from `src/agents/base.ts` lines ~800–973 to a new `src/agents/dispatch-tool-schemas.ts`.

**Current state**: These ~173 lines of purely declarative data live at the bottom of `base.ts`, after the class definition. They have no dependency on `BaseAgent` internals — they only reference `ROSTER` (from `./roster.js`) and `TaskReportSchema`-style type imports.

**What stays in `base.ts`**: The `responseSource()` helper (lines ~788–796) is **not** a dispatch schema — it normalizes `ChatResponse` metadata into `LlmResponseSource` for conversation state. It belongs with `BaseAgent` or `ConversationState`, not with declarative tool schemas. It stays in `base.ts`.

**Detailed actions**:

1. Create `src/agents/dispatch-tool-schemas.ts` with the following exports:
   - All 9 `*Schema` constants (`RUN_MANAGER_SCHEMA`, `RUN_CODER_SCHEMA`, etc.)
   - `makeWorkerDispatchSchema(role: string, description: string)`
   - `TRIVIAL_EVIDENCE_TOOLS: Set<string>`
   - `getDispatchToolsForRole(role: AgentRole): ToolSchema[]`
   - Optional test-only export: `ROLE_DISPATCH_TOOLS: Partial<Record<AgentRole, ToolSchema[]>>` if the new test needs direct map inspection

2. In `src/agents/base.ts`:
   - Remove the extracted code (lines ~800–973)
   - Add `export { getDispatchToolsForRole, TRIVIAL_EVIDENCE_TOOLS } from "./dispatch-tool-schemas.js";` (re-export for backward compatibility)
   - Add `import { getDispatchToolsForRole, TRIVIAL_EVIDENCE_TOOLS } from "./dispatch-tool-schemas.js";` for internal use
   - Keep `responseSource()` in `base.ts` — it is a `ChatResponse → LlmResponseSource` adapter, not a schema declaration.

3. Update any other file that directly imports these from `base.ts`:
   - Search for `ROLE_DISPATCH_TOOLS`, `TRIVIAL_EVIDENCE_TOOLS`, `getDispatchToolsForRole`, `RUN_MANAGER_SCHEMA`, etc. in `src/` and update import paths.
   - Based on reverse dependency scan: only `base.ts` internals and `roster.ts`-adjacent code use these; no external consumers beyond what's in `base.ts` itself.

4. Add test file `src/agents/dispatch-tool-schemas.test.ts` that:
   - Verifies `getDispatchToolsForRole("manager")` returns the expected dispatch tools
   - Verifies `TRIVIAL_EVIDENCE_TOOLS` contains expected tool names
   - Verifies every dispatchable role in `ROSTER` has exactly one schema entry, and asserts exact schema names

**Expected result**: `base.ts` drops from ~973 lines to ~800 lines. New file `dispatch-tool-schemas.ts` is ~175 lines. `responseSource()` remains in `base.ts`. All tests pass unchanged.

---

### Step 1.2 — Extract `getToolSchemas()` from `plan-server.ts`

**Goal**: Move the static `getToolSchemas()` method (~114 lines of JSON Schema definitions) from `PlanService` in `src/mcp/plan-server.ts` to a new `src/mcp/plan-schemas.ts`.

**Current state**: `getToolSchemas()` is a static method that returns an array of 12 MCP tool schema objects. It accesses no instance state — it builds schemas from constants and the plan schema imports.

**Detailed actions**:

1. Create `src/mcp/plan-schemas.ts` containing:
   - A standalone function `getPlanToolSchemas(): ToolSchema[]` (the static method body)
   - Import `PlanDocumentSchema`, `StageSchema`, `CompletedStageSchema` from `../types.js` (same imports `plan-server.ts` already uses)

2. In `src/mcp/plan-server.ts`:
   - Remove the `static getToolSchemas()` method
   - Add `import { getPlanToolSchemas } from "./plan-schemas.js";`
   - Replace any internal `PlanService.getToolSchemas()` calls with `getPlanToolSchemas()`
   - Update current internal consumers directly to call `getPlanToolSchemas()`; do not preserve `PlanService.getToolSchemas()` unless an implementation-time import cycle or ergonomics issue is discovered

3. Update consumers:
   - `src/runtime/runtime.test.ts` imports `PLAN_READER_TOOLS`, `PLAN_WRITER_TOOLS`, `PlanService`
   - `src/scripts/backfill-plan-history.ts` and its test import `PlanService`, `PLAN_WRITER_TOOLS`
   - `src/mcp/runtime.ts` registers plan tools using `PlanService.getToolSchemas()`
   - Change these to import `getPlanToolSchemas` from the new file

4. Add `src/mcp/plan-schemas.test.ts` verifying the 12 tool schemas are returned and each has required `name`, `description`, `inputSchema` fields.

**Expected result**: `plan-server.ts` drops from ~637 lines to ~523 lines. New file is ~114 lines.

---

### Step 1.3 — Move `BaseAgentConfig` to `agents/base-config.ts`

**Goal**: Move the `BaseAgentConfig` interface (lines ~56–92 of `base.ts`) to a new `agents/base-config.ts` file alongside its own import surface, avoiding a circular dependency with `agents/types.ts`.

**Why not `agents/types.ts`**: `BaseAgentConfig` references `ChildSpawner` (from `runtime/dispatcher.ts`) and `CompactionConfig` (from `runtime/compaction.ts`). `types.ts` is imported by `dispatcher.ts` and many other modules. Adding `BaseAgentConfig` to `types.ts` would create broader runtime↔agents coupling. A dedicated `base-config.ts` keeps the dependency surface narrow and avoids cycles.

**Detailed actions**:

1. Create `src/agents/base-config.ts`:
   - Add the `BaseAgentConfig` interface definition.
   - Import only the types it needs: `ChildSpawner` from `../runtime/dispatcher.js`, `CompactionConfig` from `../runtime/compaction.js`, `SkillMatchContext` from `../knowledge/loader.js`, `InputChannel` from `./types.js`.
   - `InputChannel` already lives in `types.ts` and is a simple interface — importing it one-way into `base-config.ts` is safe.

2. In `src/agents/base.ts`: Remove the `BaseAgentConfig` interface. Add `import type { BaseAgentConfig } from "./base-config.js";`. Re-export for backward compatibility: `export type { BaseAgentConfig } from "./base-config.js";`

3. Search for `BaseAgentConfig` imports in `src/` and verify they all resolve. Current consumers import from `./base.js` or `../agents/base.js`; the re-export in `base.ts` preserves backward compat. No consumer needs to change until a later cleanup step.

**Expected result**: ~36 lines moved to new file. `base.ts` is now ~764 lines. No test changes.

---

### Step 1.4 — Extract router utility functions to `router-utils.ts`

**Goal**: Move the file-level utility functions at the bottom of `src/providers/router.ts` (lines ~844–947, ~103 lines) to a new `src/providers/router-utils.ts`.

**Current state**: These are pure functions: `describeRequestedModel`, `tryParseModelId`, `isProviderName`, `firstModel`, `compareUsageSnapshots`, `compareNullableNumbersDesc`, `normalizeUsageSnapshot`, `unknownUsageSnapshot`, `finiteOrNull`, `clamp01`, `unique`. They have no dependency on `ModelRouter` state.

**Detailed actions**:

1. Create `src/providers/router-utils.ts` with all the utility functions listed above.

2. In `src/providers/router.ts`:
   - Remove the utility function definitions
   - Add `import { describeRequestedModel, tryParseModelId, isProviderName, firstModel, compareUsageSnapshots, compareNullableNumbersDesc, normalizeUsageSnapshot, unknownUsageSnapshot, finiteOrNull, clamp01, unique } from "./router-utils.js";`
   - Remove any utility function exports from `router.ts` (they were not exported before — they were file-private). If any were exported, re-export from `router-utils.ts` for compat.

3. Check whether `candidate-planner.ts` or any other file duplicates these utilities. `candidate-planner.ts` currently imports `parseModelId` and defines local helpers; consolidate duplicated helpers only if doing so reduces duplication without creating a router↔candidate-planner cycle.

4. Add `src/providers/router-utils.test.ts` for the pure functions (comparison, normalization, etc.).

**Expected result**: `router.ts` drops from ~947 lines to ~844 lines. New file is ~103 lines.

---

### Step 1.5 — Consolidate model equivalence into `candidate-planner.ts`

**Goal**: Move `discoverModelEquivalents`, `buildModelEquivalenceIndex`, `mergeEquivalenceIndexes` from `src/providers/router.ts` into `src/providers/candidate-planner.ts` where `buildCandidateChain` already lives.

**Current state**: `discoverModelEquivalents` (a method on `ModelRouter`) calls `this.listModels()` for each provider — it has a dependency on `ModelRouter` instance state. `buildModelEquivalenceIndex` and `mergeEquivalenceIndexes` are file-level functions.

**Detailed actions**:

1. Move `buildModelEquivalenceIndex` and `mergeEquivalenceIndexes` (pure functions) to `candidate-planner.ts`.

2. For `discoverModelEquivalents`: it's a method on `ModelRouter` that calls `this.listModels()`. Two options:
   - **Option A (preferred)**: Change it to a standalone function that takes a `listModels: (providerName: string) => Promise<ModelCapabilities[]>` callback. `ModelRouter` calls it with `this.listModels.bind(this)`.
   - **Option B**: Keep it as a method on `ModelRouter` but have it delegate to the moved pure functions.

3. Update `ModelRouter.init()` to call the moved `buildModelEquivalenceIndex` from `candidate-planner.ts` instead of the local function.

4. Update tests in `src/providers/router.ts` if any test directly calls `buildModelEquivalenceIndex`.

**Expected result**: ~47 lines of equivalence logic moves to `candidate-planner.ts`. `router.ts` drops to ~800 lines.

---

### Phase 1 Validation

After all Phase 1 steps:

```bash
npm test && npm run build && npm run docs:build
```

Expected: all green, no behavior changes, all existing tests pass unchanged except any new test files.

**Cumulative line movement**: `base.ts` ~973→800 (extracted), `plan-server.ts` ~637→523 (extracted), `router.ts` ~947→844 (extracted). Total extracted to new files: ~473 lines.

---

## Phase 2 — Responsibility Extraction (Small Behavior Refactor)

These steps extract cohesive state capsules from large classes. Each extraction creates a new class that `ModelRouter` or `BaseAgent` delegates to. Behavior stays identical; the delegation is the only change.

---

### Step 2.1 — Extract `ModelHealthTracker` from `ModelRouter`

**Goal**: Extract health tracking state and methods into `src/providers/health-tracker.ts`.

**What moves**:
- `modelHealth` private field (`Map<string, ModelHealth>`)
- `getHealth(spec: string)` method
- `recordFailure(spec: string, error: ProviderError)` method
- `resetHealth(spec: string)` method
- `resetModelHealth(spec: string)` method (calls `this.getHealth` for each model in failover chain)

**Detailed actions**:

1. Create `src/providers/health-tracker.ts` with class `ModelHealthTracker`:
   ```typescript
   export class ModelHealthTracker {
     private health = new Map<string, ModelHealth>();
     getHealth(spec: string): ModelHealth { ... }
     recordFailure(spec: string, error: ProviderError): void { ... }
     resetHealth(spec: string): void { ... }
     resetModelHealth(spec: string, failoverChain: string[]): void { ... }
   }
   ```

2. In `ModelRouter`:
   - Add `private healthTracker = new ModelHealthTracker();`
   - Delegate `getHealth`, `recordFailure`, `resetHealth`, `resetModelHealth` to `this.healthTracker`
   - `resetModelHealth` currently calls `this.getHealth` for each model in the failover chain — pass `failoverChains` or `getCandidateChain` result to `healthTracker.resetModelHealth`

3. Move `ModelHealth` interface to `health-tracker.ts` (or to `types.ts` if shared).

4. Add `src/providers/health-tracker.test.ts` with unit tests for health tracking logic (mark unhealthy, exponential backoff, reset, etc.).

**Expected result**: `router.ts` drops ~60 lines. `health-tracker.ts` is ~80 lines (including the interface). `ModelHealthTracker` is independently testable.

---

### Step 2.2 — Extract sticky failover state from `ModelRouter`

**Goal**: Extract sticky failover **state storage** and **delay calculation** from `ModelRouter` into a standalone class. Keep the chain-ordering logic in `candidate-planner.ts` where it already lives.

**Important**: `buildCandidateChain` in `candidate-planner.ts` already handles sticky ordering via the `sticky` option and the `onPrimaryRetryAfterStickyCooldown` callback. This step must **not** duplicate that logic. Instead, extract only the state map and timing decisions.

**What moves**:
- `stickyFailovers` private field (`Map<string, StickyFailoverState>`)
- `clearStickyFailover(spec: string)` method
- State read/write: `getSticky(spec)` / `setSticky(spec, state)`

**What stays in `ModelRouter.chat()`**:
- The sticky apply logic that calls `buildCandidateChain({ sticky: ..., onPrimaryRetryAfterStickyCooldown: ... })` — this is already in `candidate-planner.ts` and must not be duplicated in `StickyFailoverManager`.

**Detailed actions**:

1. Create `src/providers/sticky-failover.ts` with class `StickyFailoverManager`:
   ```typescript
   export class StickyFailoverManager {
     private stickyFailovers = new Map<string, StickyFailoverState>();
     getSticky(spec: string): StickyFailoverState | undefined { ... }
     setSticky(spec: string, state: StickyFailoverState): void { ... }
     clearStickyFailover(spec: string): void { ... }
     shouldPreferSticky(primarySpec: string, now: number): boolean { ... }
   }
   ```

2. In `ModelRouter.chat()`:
   - Replace direct `stickyFailovers` map access with `this.stickyFailover.getSticky()` / `setSticky()`
   - Keep the existing `buildCandidateChain({ sticky: this.stickyFailover.getSticky(spec), onPrimaryRetryAfterStickyCooldown: ... })` call unchanged
   - Do **not** add `applyStickyToChain()` — chain ordering is already handled by `buildCandidateChain`

3. Move `StickyFailoverState` interface to `sticky-failover.ts` (or `types.ts` if shared).

4. Add `src/providers/sticky-failover.test.ts` testing state transitions and `shouldPreferSticky`.

**Expected result**: `router.ts` drops ~25 lines (state map + accessors). `sticky-failover.ts` is ~50 lines. Chain ordering stays in `candidate-planner.ts`.

---

### Step 2.3 — Extract usage snapshot types and pure helpers from `ModelRouter`

**Goal**: Extract `UsageSnapshot` and the pure usage snapshot comparison/normalization helpers into a dedicated `usage-types.ts` module for shared access.

**Revised scope for this step**: Move only the type and pure helpers. Do **not** extract startup inspection, provider/account resolution, or a `UsageTracker` class in this step — that coupling belongs in `ModelRouter` until a narrow dependency interface is designed.

**What moves**:
- `UsageSnapshot` interface (already in `router.ts`, needed by `router-utils.ts` comparison functions after Phase 1.4)
- `compareUsageSnapshots()`, `normalizeUsageSnapshot()`, `unknownUsageSnapshot()`, and their small numeric helpers if they are usage-specific rather than router-general

**What stays in `ModelRouter`**:
- `getProviderForRequest()` and `resolveApiKey()` — these need full `ModelRouter` state and config.
- `inspectUsageAtStartup()`, `inspectUsageCandidate()`, `usageFromConfig()`, `listUsageCandidateKeys()`, and the orchestration that loops over providers, resolves accounts, and compares snapshots.

**Detailed actions**:

1. Create `src/providers/usage-types.ts`:
   - Move `UsageSnapshot` interface from `router.ts`
   - Move or re-export `compareUsageSnapshots`, `normalizeUsageSnapshot`, `unknownUsageSnapshot`, and usage-specific numeric helpers from `router-utils.ts`

2. In `src/providers/router.ts`:
   - Import `UsageSnapshot` from `./usage-types.js`
   - Keep usage inspection orchestration in `ModelRouter`

3. Add `src/providers/usage-types.test.ts` for snapshot comparison and normalization tests (these move from `router-utils.test.ts` if they were added there in Phase 1.4).

**Expected result**: `UsageSnapshot` type and pure helpers are independently importable without pulling in `ModelRouter`. Total line change is small (~20-40 lines moved), but the dependency boundary becomes clearer.

---

### Step 2.4 — Extract plan tool dispatch function from `PlanService`

**Goal**: Separate the MCP tool dispatch switch into a standalone function while keeping serialization owned by `PlanService`.

**What moves**:
- `handleToolCallInner(toolName: string, args: Record<string, unknown>)` — the private switch dispatch that routes tool names to `PlanService` methods.

**What stays in `PlanService`**:
- `opQueue` and `serializeOp()` — serialization must remain owned by `PlanService` to guarantee that multiple callers sharing the same service instance get correct serialized ordering. Moving the op-queue to a separate class risks accidental duplication if multiple adapters are constructed around the same service.
- `handleToolCall()` — the public entry point that wraps writer tools in `serializeOp()` and delegates to the pure dispatch function otherwise.

**Rationale**: The original plan proposed a `PlanMcpAdapter` class owning both dispatch and the op-queue. That creates a lifetime coupling problem: if two adapters wrap one `PlanService`, serialized write safety breaks. The fixed design keeps serialization in the single-owner service and extracts only the routing logic.

**Detailed actions**:

1. Create `src/mcp/plan-dispatch.ts` with a standalone dispatch function:
   ```typescript
   export async function dispatchPlanToolCall(
     service: PlanService,
     toolName: string,
     args: Record<string, unknown>,
   ): Promise<{ content: unknown; isError: boolean }> { ... }
   ```

2. Move the `switch (toolName) { ... }` body from `PlanService.handleToolCallInner` into `dispatchPlanToolCall`. The function calls public `PlanService` methods (like `service.plan_get()`, `service.plan_get_stage()`, etc.).

3. In `PlanService.handleToolCall`:
   - Replace the call to `this.handleToolCallInner(toolName, args)` with `dispatchPlanToolCall(this, toolName, args)`.

4. Add `src/mcp/plan-dispatch.test.ts` verifying that each of the 12 tool names routes to the correct method.

**Expected result**: `plan-server.ts` drops ~50 lines (the switch body). `plan-dispatch.ts` is ~65 lines. `PlanService` keeps `opQueue`, `serializeOp`, and `handleToolCall`.

---

### Step 2.5 — Extract `callLLM` sub-concerns from `BaseAgent`

**Goal**: Reduce `BaseAgent.callLLM()` by extracting smaller, independently testable sub-concerns rather than moving the entire loop at once. The full `callLLM` method (~110 lines) depends on too many `BaseAgent` internals (pending call state, activity logging, abort/cancellation, compaction callback, `sleepWithCancellation`) for a clean single extraction.

**Approach**: Extract in two sub-steps. Each sub-step is independently committable and testable.

**Step 2.5a — Extract pending-call state transitions into `PendingCallTracker`**:

1. Create `src/agents/pending-call-tracker.ts`:
   ```typescript
    export class PendingCallTracker {
      private pendingCall: ActivityStatus["pending_call"] | null = null;
      startInFlight(attempt: number): void { ... }
      startBackoff(args: { attempt: number; reason: string; retryAt: string }): void { ... }
      clear(): void { ... }
      snapshot(): ActivityStatus["pending_call"] | null { ... }
    }
    ```

2. In `BaseAgent`, replace `private pendingCall: ...` with `private pendingCallTracker = new PendingCallTracker()`. Delegate pending-call transitions (`startInFlight`, `startBackoff`, `clear`) to the tracker.

3. Keep `getActivityStatus()` in `BaseAgent`; it still owns `lastActivityAt` and should combine that with `pendingCallTracker.snapshot()`.

4. Add `src/agents/pending-call-tracker.test.ts`.

**Step 2.5b — Add focused tests for existing `RetryPolicy` and keep retry logic centralized**:

1. Do **not** create a second `llm-retry.ts` module. `BaseAgent.callLLM()` already delegates retry decisions to `RetryPolicy.decide()`. Adding `shouldRetry()` or `nextRetryDelay()` elsewhere would duplicate behavior.

2. Add or expand `src/agents/retry-policy.test.ts` to cover:
   - retryable provider errors
   - non-retryable provider errors
   - context-repair decisions
   - retry cap behavior
   - retry-after / delay behavior already implemented by `RetryPolicy`

3. Keep `BaseAgent.callLLM()` calling `RetryPolicy.decide()` directly.

**Not extracted (for now)**: The context-overflow compaction callback, `sleepWithCancellation`, and the overall call loop structure remain in `BaseAgent` because they need deep access to instance state. A future extraction can revisit this once the pending-call and retry pieces are separated out and the method is smaller.

**Expected result**: `base.ts` drops ~20-30 lines from pending-call extraction. Retry behavior remains centralized in `RetryPolicy` with stronger focused tests. `BaseAgent.callLLM()` remains structurally similar but has less state-management noise.

---

### Phase 2 Validation

After all Phase 2 steps:

```bash
npm test && npm run build && npm run docs:build
```

**Cumulative line movement from Phases 1+2**:
- `base.ts`: 973 → ~750 (~23% reduction, smaller because callLLM extraction is split into two sub-steps)
- `router.ts`: 947 → ~820 (~13% reduction, narrower extractions than originally planned)
- `plan-server.ts`: 637 → ~590 (~7% reduction, dispatch function only, not adapter class)

---

## Phase 3 — Leaf Class Consolidation

These steps change the class hierarchy and data structures. More invasive but well-scoped.

---

### Step 3.1 — Replace 6 leaf `WorkerAgent` subclasses with role-parameterized `WorkerAgent`

**Goal**: Eliminate `CoderAgent`, `ResearcherAgent`, `ReviewerAgent`, `DesignerAgent`, `CriticAgent`, `DataAgent` as separate files. Keep `WorkerAgent` as the single concrete worker class parameterized by role.

**Current state**: Each leaf class is 7–11 lines:
```typescript
export class CoderAgent extends WorkerAgent {}
registerWorkerCtor("coder", CoderAgent);
```
They exist only to register a role-specific constructor as a module side effect. The type parameter `T` in `createWorker<T>(ctx, input, "coder")` is only used for the return type — no methods differ.

**Detailed actions**:

1. In `src/agents/worker.ts`:
    - Make `WorkerAgent` fully concrete (remove `abstract`). The role is already passed as a constructor parameter.
    - Replace the registry-backed static factory with direct construction:
      ```typescript
      static async createWorker(
        ctx: AgentContext,
        input: WorkerInput,
        role: WorkerRole,
        config?: Partial<BaseAgentConfig>,
      ): Promise<WorkerAgent> { ... }
      ```
    - The `role` string determines behavior via `roster.ts` lookup, not via class override.
    - Remove `WorkerCtor`, `WORKER_CTORS`, `registerWorkerCtor`, `hasWorkerCtor`, and `getWorkerCtor`.

2. Remove the 6 leaf class files:
   - `src/agents/coder.ts`
   - `src/agents/researcher.ts`
   - `src/agents/reviewer.ts`
   - `src/agents/designer.ts`
   - `src/agents/critic.ts`
   - `src/agents/data-agent.ts`

3. In `src/agents/roster.ts`:
   - No class-file references should remain; verify the `workerInit` data carries all role-specific configuration.

4. In `src/server/agent-factory.ts`:
   - Remove side-effect imports of `../agents/coder.js`, `../agents/researcher.js`, `../agents/data-agent.js`, `../agents/reviewer.js`, `../agents/designer.js`, and `../agents/critic.js`.
   - Keep calls to `WorkerAgent.createWorker(ctx, input, role, config)`.

5. Update `src/agents/agents.test.ts` and `src/agents/worker-spawn.test.ts`:
    - Replace `WorkerAgent.createWorker<CoderAgent>(...)` with `WorkerAgent.createWorker(...)`
    - Remove imports of deleted worker leaf classes

6. Search for any `instanceof CoderAgent` or similar and replace class assertions with role assertions.

**Public API impact**: `src/index.ts` currently exports the 6 leaf classes (lines 57–62: `CoderAgent`, `ResearcherAgent`, `DataAgent`, `ReviewerAgent`, `DesignerAgent`, `CriticAgent`). Removing these is a public API break. Two options:
- **Option A (recommended)**: Remove the 6 named exports from `src/index.ts`. Replace with a single `export { WorkerAgent } from "./agents/worker.js";` and add `WorkerRole` type export. Document in the commit message that named worker class exports are removed.
- **Option B**: Keep re-exports as type aliases pointing to `WorkerAgent` for one release cycle, then remove. This is unnecessary complexity for a project that doesn't maintain a stable external API.

**Test assertion migration**: `src/agents/worker-spawn.test.ts` lines 38 and 64 assert `instanceof CoderAgent` and `instanceof ReviewerAgent`. These must become assertions on the public `BaseAgent.role`, e.g. `expect(agent.role).toBe("coder")`. Do not assert `agent.workerRole`; it is currently protected. Replace all `instanceof <Role>Agent` patterns across test files similarly. Search for `instanceof CoderAgent`, `instanceof ReviewerAgent`, etc. before deleting.

**Risk**: Medium — changes dispatcher, agent factory, public exports, and test assertions. Each change is mechanical but touches multiple files.

**Expected result**: 6 files deleted (~55 lines total). `WorkerAgent` becomes the single worker entry point. 6 named exports removed from `src/index.ts`.

---

### Step 3.2 — Convert `RagError` hierarchy to discriminated union

**Goal**: Replace 9 `RagError` subclasses with a single `RagError` class + `kind: RagErrorKind` discriminated field. Use constructor calls (`new RagError("config_drift", ...)`) as the primary call-site pattern, not static factory methods.

**Current state**: `src/rag/errors.ts` defines `RagError` and 8 subclasses. The subclasses add a `kind` field and override `name` but provide no behavioral differences. The `server/rag/errors.ts` re-export maps each subclass to an HTTP error code.

**Detailed actions**:

1. In `src/rag/errors.ts`:
   - Keep `RagError` as the single class, add `kind: RagErrorKind` field
   - Add `RagErrorKind` type union:
     ```typescript
     export type RagErrorKind =
       | "config_drift"
       | "embedding_drift"
       | "corrupted_store"
       | "provider_unavailable"
       | "ingest_locked"
       | "secret_dropped"
       | "dataset_not_found"
       | "invalid_query_filter"
       | "watcher_unavailable";
     ```
   - Modify `RagError` constructor to take `(kind: RagErrorKind, message: string, detail?: unknown)` and set `this.kind = kind`
   - Remove all 8 subclasses
   - Optionally preserve kind-specific property bags (`datasetId`, `field`, `previous`, `current`, etc.) via a `detail?: unknown` parameter, or as typed extras per kind through a `RagErrorDetail` discriminated union if callers need them. For now, keep `detail` as `unknown` and let callers cast as needed during migration.
   - **Do not add static factory methods** like `RagError.configDrift(...)`. The goal is simplification; named constructors recreate the per-kind surface we're removing. Direct `new RagError("config_drift", message)` is clearer and shorter.

2. In `src/server/rag/errors.ts`:
   - Update the error-to-code mapping to check `error.kind` instead of `instanceof ConfigDriftError` etc.

3. In all throw sites across `src/rag/`:
   - Replace `throw new ConfigDriftError(...)` with `throw new RagError("config_drift", ...)`, etc.

4. In tests (`src/rag/errors.test.ts`, `src/server/rag/handler.test.ts`):
   - Replace `instanceof ConfigDriftError` checks with `error.kind === "config_drift"`

**Risk**: Low — callers already check `.kind` more than `instanceof`.

**Expected result**: ~80 lines removed from `rag/errors.ts`. 9 classes reduced to 1 class + 1 type union.

---

### Step 3.3 — Move `workerInit` prompt strings out of `roster.ts`

**Goal**: Move the `workerInit.instruction` and `workerInit.systemPrompt` template strings from `ROSTER` entries to the prompt modules that own them.

**Current state**: `src/agents/roster.ts` lines ~71–370 contain `ROSTER` array entries. Each worker-role entry includes a `workerInit` field with `instruction` (prompt template string) and `systemPrompt` (prompt template reference). These are long multi-line strings that double the roster's visual size.

**Detailed actions**:

1. Create `src/agents/worker-init-templates.ts`:
   - Export a `Map<WorkerRole, WorkerInitMeta>` that maps each worker role to its prompt template data
   - Move the `instruction` and `systemPrompt` content from `ROSTER` entries to this map

2. In `src/agents/roster.ts`:
   - Replace the inline `workerInit` content with a reference to the map:
     ```typescript
     workerInit: workerInitTemplates.get("coder")!,
     ```
   - Or remove `workerInit` from `RosterEntry` entirely and have `getWorkerInitMeta(role)` look up from the map

3. Update `src/agents/worker.ts` (which calls `getWorkerInitMeta`):
   - Ensure it imports `workerInitTemplates` from the new file

**Expected result**: `roster.ts` drops ~80 lines. New file is ~85 lines. The roster becomes pure routing data + lookups.

---

### Phase 3 Validation

After all Phase 3 steps:

```bash
npm test && npm run build && npm run docs:build
```

**Cumulative reduction**: 6 files deleted, ~9 classes eliminated, ~215 lines net removed.

---

## Phase 4 — Interface Narrowing (Gradual)

These steps reduce coupling between modules. They are lower priority and can be done incrementally over time.

---

### Step 4.1 — Narrow `SaivageRuntime` in route modules

**Goal**: Replace `runtime: SaivageRuntime` parameter in route registration functions with narrow interfaces.

**Current state**: `registerConfigRoutes` and `registerWebSocketRoutes` receive the full `SaivageRuntime`. Other routes already use narrow deps interfaces.

**Detailed actions**:

1. Define `RouteContext` interface in `src/server/routes/types.ts`:
   ```typescript
   export interface RouteContext {
     projectStore: ProjectStore;
     mcpRuntime: McpRuntime;
     eventBus: EventBus;
   }
   ```

2. Refactor `registerConfigRoutes` to accept `{ projectStore, mcpRuntime, eventBus, config }` instead of `runtime`.

3. Refactor `registerWebSocketRoutes` to accept `{ apiToken, chatCommands }` instead of `runtime`.

4. Update `src/server/server.ts` to pass the narrow objects.

**Risk**: Low — these are already almost narrow.

---

### Step 4.2 — Replace `ModelRouter` dependency in `AgentContext` with `ChatFn`

**Goal**: Remove the direct `ModelRouter` type dependency from `AgentContext`, replacing it with a minimal `chat: ChatFn` function type.

**Current state**: `AgentContext` has `router: AgentContext["router"]` which is `ModelRouter`-typed. `BaseAgent.callLLM()` calls `this.ctx.router.chat(...)` and `this.ctx.router.getMaxContextTokens(...)` and `this.ctx.router.countTokens(...)`.

**Detailed actions**:

1. Define `ChatFn` in `src/agents/types.ts`:
   ```typescript
   export interface LlmClient {
     chat(request: ChatRequest): Promise<ChatResponse>;
     getMaxContextTokens(modelSpec: string): number;
     countTokens(modelSpec: string, messages: Message[], system?: string, tools?: ToolSchema[]): Promise<number>;
   }
   ```

2. Change `AgentContext.router` from `ModelRouter` to `LlmClient`.

3. Update all test factories to provide a minimal `LlmClient` mock instead of full `ModelRouter`.

4. In production code (`bootstrap.ts`, `agent-factory.ts`), pass the actual `ModelRouter` which satisfies `LlmClient`.

**Risk**: Medium — changes the test harness in many files. CI will catch regressions.

---

### Step 4.3 — Extract knowledge-tools from MCP builtins

**Goal**: Move RAG and knowledge MCP tool registrations out of `src/mcp/builtins/` into a standalone `src/knowledge/mcp-tools.ts` that registers via `McpRuntime`.

**Current state**: `src/mcp/builtins/knowledge.ts` and the RAG-related tool wiring in `registerBuiltinServices` is tightly coupled to the knowledge module. MCP builtins import 13 symbols from `knowledge/`.

**Detailed actions**:

1. Create `src/knowledge/mcp-tools.ts`:
   - Move `rag_*` and `knowledge_*` tool schemas and handlers from `src/mcp/builtins/knowledge.ts` and `src/server/rag/`

2. In `registerBuiltinServices`: Remove knowledge/rag tool registration

3. In `bootstrap.ts`: Register knowledge tools separately after `registerBuiltinServices`

4. Reduce `mcp` → `knowledge` imports from 13 to ~3 (only type imports and data-path configuration)

**Risk**: Medium — changes registration order and initialization sequence.

---

### Phase 4 Validation

After each step:

```bash
npm test && npm run build && npm run docs:build
```

---

## Risk Matrix

| Step | Dependencies | Test Impact | Can be done independently? |
|---|---|---|---|
| 1.1 Dispatch tool schemas | None | New test file | Yes |
| 1.2 Plan schemas | None | New test file | Yes |
| 1.3 BaseAgentConfig move | None | No changes | Yes |
| 1.4 Router utils | None | New test file | Yes |
| 1.5 Equivalence consolidation | 1.4 complete | Update router tests | No — needs 1.4 first |
| 2.1 HealthTracker | None | New test file | Yes |
| 2.2 Sticky failover state | None | New test file | Yes |
| 2.3 Usage snapshot types | 1.4 complete | New test file | No — needs 1.4 first |
| 2.4 Plan dispatch function | 1.2 complete | Update plan tests | No — needs 1.2 first |
| 2.5a Pending-call tracker | None | New test file | Yes |
| 2.5b RetryPolicy tests | 2.5a complete | Focused retry-policy tests | No — best after 2.5a |
| 3.1 Leaf worker removal | None | Update agent factory, spawn tests, public exports | Yes (medium risk: public API + test assertions) |
| 3.2 RagError conversion | None | Update rag error tests | Yes |
| 3.3 workerInit extraction | 3.1 complete | Update roster + worker tests | No — best after 3.1 |
| 4.1 Route context narrowing | None | Minimal | Yes |
| 4.2 ChatFn extraction | None | Extensive test harness changes | Yes (high effort) |
| 4.3 Knowledge-tools extraction | None | Update bootstrap + mcp registration | Yes |

---

## Recommended Execution Order

Execute and validate each step individually (or at most group tightly related pure moves). Commit after each step passes its validation gate. This makes bisection and rollback straightforward.

**Suggested commit sequence** (each commit = one step, unless noted):

**Commits 1–5** (Phase 1 pure extractions, all independent):
- 1.1 → validate → commit
- 1.2 → validate → commit
- 1.3 → validate → commit
- 1.4 → validate → commit
- 1.5 → validate → commit (depends on 1.4)

**Commits 6–10** (Phase 2 responsibility extractions):
- 2.1 → validate → commit
- 2.2 → validate → commit
- 2.3 → validate → commit (depends on 1.4)
- 2.4 → validate → commit (depends on 1.2)
- 2.5a → validate → commit
- 2.5b → validate → commit

**Commits 11–13** (Phase 3 class consolidation):
- 3.1 → validate → commit
- 3.2 → validate → commit (RagError conversion — separate from Phase 1 changes for clean bisection)
- 3.3 → validate → commit (best after 3.1)

**Commits 14–16** (Phase 4, lower priority, any time after Phase 2):
- 4.1 → validate → commit
- 4.2 → validate → commit
- 4.3 → validate → commit

After each phase, run full validation (`npm test && npm run build && npm run docs:build`).

---

## Success Metrics

| Metric | Before | After Phases 1-3 | After Phase 4 |
|---|---:|---:|---:|
| Largest file | 973 (`base.ts`) | ~750 (`base.ts`) | ~750 |
| 2nd largest file | 947 (`router.ts`) | ~820 (`router.ts`) | ~700 |
| 3rd largest file | 637 (`plan-server.ts`) | ~590 (`plan-server.ts`) | ~590 |
| Classes | 64 | 57 | 57 |
| God-context fields (`SaivageRuntime`) | 16 | 16 | ~12 |
| `agents` module cross-module imports | 9 | 9 | 7-8 |
| Files > 500 lines | 7 | measure after phase | measure after phase |
| Public API named worker exports (`src/index.ts`) | 6 | 0 (or 1: `WorkerAgent`) | 0 |
| `RagError` subclasses | 8 | 0 | 0 |
| Import edges into `base.ts` and `router.ts` | measure before | -2 to -4 each | further reduction |

The primary outcome is **not** line reduction but **conceptual density reduction**: each file has 1–2 responsibilities instead of 5–7, making the codebase easier to navigate, test, and modify independently. Line counts in the "largest file" column are approximate and will be measured after each phase.
