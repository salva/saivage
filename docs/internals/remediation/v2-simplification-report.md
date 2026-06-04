# Saivage v2 Architecture Simplification Report

**Date**: 2026-06-04
**Scope**: `/home/salva/g/ml/saivage/src/` — 25,291 lines across 157 source files

---

## Executive Summary

Saivage v2 has 64 classes, 2 abstract classes, 199 interfaces, and 65 type aliases spread across 10 modules. The architecture is *not* over-abstracted in the traditional sense — most interfaces serve real decoupling needs. The real complexity is **concentration**: a handful of large classes each carry 5–7 distinct responsibilities, and one god-context interface (`SaivageRuntime`) couples 16 subsystems together.

The simplification opportunity is not "remove abstractions" but **extract cohesive responsibilities from oversized classes** and **narrow the interfaces between modules**.

---

## 1. Problem Areas

### 1.1 `BaseAgent` — 6 responsibilities in one class (973 lines)

The class does conversation-loop orchestration, retry/backoff, compaction, large-result stashing, activity tracking, and dispatch schema data. Each is independently testable but currently inseparable.

**Specific extractions:**

| What to extract | Lines saved | Target location |
|---|---:|---|
| Dispatch tool schemas (9 JSON Schema definitions + factory + role map) | ~173 | `src/agents/dispatch-schemas.ts` |
| `callLLM` retry/backoff/state-tracking loop | ~110 | `src/agents/llm-call-loop.ts` or inline into `RetryPolicy` |
| `runPlannerCompactionHook` (5-turn planner memory window) | ~62 | `src/agents/planner-compaction-hook.ts` |
| `BaseAgentConfig` (14-field config interface) | ~36 | `src/agents/types.ts` (already exists) |

After extraction, `BaseAgent` itself drops to ~590 lines with a clear single-responsibility: **conversation loop orchestration**.

### 1.2 `ModelRouter` — 7 responsibilities in one class (947 lines)

Routing, failover, health tracking, auth/key resolution, usage inspection, equivalence discovery, and provider lifecycle are all interleaved. The `chat()` method directly mutates health state and sticky failover state while walking the candidate chain.

**Specific extractions:**

| What to extract | Lines saved | Target location |
|---|---:|---|
| Health tracking (`getHealth`, `recordFailure`, `resetHealth`, `resetModelHealth`, `modelHealth` map) | ~60 | `src/providers/health-tracker.ts` |
| Sticky failover state (`stickyFailovers` map, `clearStickyFailover`, sticky logic in `chat()`) | ~40 | `src/providers/sticky-failover.ts` |
| Usage snapshot management (`usageSnapshots`, `inspectUsageAtStartup`, `getUsageSnapshot`, etc.) | ~80 | `src/providers/usage-tracker.ts` |
| File-level utility functions (`describeRequestedModel`, `tryParseModelId`, etc.) | ~103 | `src/providers/router-utils.ts` |
| Model equivalence discovery (`discoverModelEquivalents`, `buildModelEquivalenceIndex`, `mergeEquivalenceIndexes`) | ~47 | Already partly in `candidate-planner.ts`; move remainder there |

After extraction, `ModelRouter` becomes ~620 lines focused exclusively on **candidate chain building and chat request routing**.

### 1.3 `PlanService` — 4 responsibilities in one class (637 lines)

CRUD, serialization queue, git commit integration, and 114 lines of inline JSON Schema.

**Specific extractions:**

| What to extract | Lines saved | Target location |
|---|---:|---|
| `getToolSchemas()` (12 tool schema definitions) | ~114 | `src/mcp/plan-schemas.ts` |
| `handleToolCall` + `handleToolCallInner` (MCP dispatch) | ~70 | Thin adapter `src/mcp/plan-mcp-adapter.ts` |
| `serializeOp` concurrency wrapper | ~5 | General `src/runtime/serialized-queue.ts` or inline |

After extraction, `PlanService` drops to ~250 lines: a document CRUD class with init/read/write/archive.

### 1.4 `SaivageRuntime` — god context (16 fields)

The interface in `bootstrap.ts` carries config, router, routing, MCP, events, plan, notes, project, tracker, planner control, directives, registry, supervisor, RAG, knowledge, and shutdown. Almost every module depends on a subset but receives the full object.

**Approach**: Don't break the interface yet — instead, create **narrow read-only facades** that modules actually need:

- `AgentContext` (already exists, 13 fields) — already narrower
- `RouteContext` with just `projectStore`, `mcpRuntime`, `eventBus` — for route modules
- `ChatContext` with just `apiToken`, `chatCommands` — for WebSocket routes

Over time, modules should receive these narrow contexts instead of the full `SaivageRuntime`.

### 1.5 `roster.ts` — data/logic hybrid (474 lines)

~65% is the `ROSTER` declarative array. ~35% is derived indexes, lookups, and prompt builders. The `workerInit` metadata for stage-scoped workers (reviewer, designer, critic) contains prompt-template strings that don't belong in a routing data file.

**Specific extractions:**

| What to extract | Lines saved | Target location |
|---|---:|---|
| `workerInit` prompt content | ~80 | Per-role prompt modules (`prompts/`) |
| `renderRosterSummary` prompt builder | ~20 | `src/agents/prompt-builder.ts` or co-locate with other prompt assembly |

After extraction, `roster.ts` becomes ~370 lines of pure routing data and O(1) lookups — much easier to audit.

---

## 2. Abstractions That Are Correct

These are *not* over-abstracted and should be kept:

| Abstraction | Why it's justified |
|---|---|
| `Agent` interface | Leaf classes (CoderAgent, etc.) have zero methods — the interface is the real contract. Removing it means losing the type boundary. |
| `WorkerAgent` abstract class | 6 worker subtypes share identical task-report/final-response logic. Without it, that logic is duplicated 6 times. |
| `ChatChannel` interface | Two real implementations (Telegram, WebSocket) with different IO patterns. |
| `Chunker` / `EmbeddingProvider` / `VectorStore` interfaces | RAG subsystem uses strategy pattern; needed for testability and for swapping implementations. |
| `ModelProvider` interface | 6 provider implementations with genuine algorithmic differences. |
| `Error` class hierarchies (`RagError`, `ProviderError`) | Each subclass carries distinct error metadata and recovery semantics. |
| `ConversationState` / `CompactionController` / `RetryPolicy` | Recently extracted from `BaseAgent`; each has independent test surface. |
| `ProjectStore` | Centralized read/write for stage artifacts, plan, runtime state; real I/O boundary. |
| `EventBus` | Simple pub/sub with filtering; 194 lines, clear purpose. |
| `McpRuntime` | Manages service lifecycle, tool registration, role filtering; real coordination need. |

---

## 3. Abstractions That Should Be Simplified or Removed

### 3.1 Leaf worker classes with zero body (6 classes)

```
CoderAgent, ResearcherAgent, ReviewerAgent, DesignerAgent,
CriticAgent, DataAgent
```

Each is a 7–11 line file that extends `WorkerAgent` with no added behavior. They exist to give `createWorker<T>()` a concrete type and for the runtime to look up via `roster.ts`. They are *tag classes* — the real routing happens through `RosterEntry.workerInit` data, not through polymorphism.

**Recommendation**: Replace with a single `WorkerAgent` + `role` field plus a role-to-init-data map. Eliminate 6 files (~55 lines total). If tag classes are kept for prompt readability, at minimum remove the separate files and define them inline in `roster.ts`.

### 3.2 `InspectorAgent` and `LibrarianAgent` — minimal agents

`InspectorAgent` (160 lines) and `LibrarianAgent` (84 lines) override `run()` with single-purpose loops. They don't use `BaseAgent.runLoop()` at all. They could use the same `WorkerAgent` parameterization, or be standalone functions that construct an `AgentContext`. They are not wrong, but the class wrapper adds no value over a well-typed function.

**Recommendation**: Convert to factory functions that return `AgentResult` directly, eliminating 2 more agent subclasses.

### 3.3 `NoteChannel` — trivial `InputChannel` implementation

`NoteChannel` (in `runtime/notes.ts`) implements `InputChannel` with a simple promise-based `receiveMessage` interface. It's fine, but the `InputChannel` interface has only 2 implementors (tests use a mock), and the abstraction costs more than it saves.

**Recommendation**: Keep for now. It's small and the test interface is useful.

### 3.4 `rag/errors.ts` — 9 error subclasses

```
RagError, ConfigDriftError, EmbeddingDriftError, CorruptedStoreError,
ProviderUnavailableError, IngestLockedError, SecretDroppedError,
DatasetNotFoundError, InvalidQueryFilterError, WatcherUnavailableError
```

These are fine individually, but `RagError` is a catch-all base and several subclasses are never thrown differently (they carry a `kind` field that could just be a discriminated union). The class hierarchy gives no behavioral polymorphism.

**Recommendation**: Replace with a single `RagError` class + `kind: RagErrorKind` discriminated field. Each throw site sets `kind` instead of using `instanceof`. Reduces 9 classes to 1 class + 1 union type.

### 3.5 `ServerOptions` / narrow route dependency interfaces (36 interfaces)

`server/routes/` defines 11 one-off interfaces like `ConfigRouteDeps`, `DebugReads`, `HealthPlanStateReads`, `AgentConversationReads`, `FileReads`, `NotesReads`, `NotesCommands`, `InspectionsChatsReads`, `ChatCommands`, `RequestWithAuthBits`. Each has 1–4 fields. These are *correctly* narrow — they prevent route modules from importing the full `SaivageRuntime`.

**Recommendation**: Keep. These are the right pattern. The alternative (passing the god context everywhere) is worse.

---

## 4. Cross-Module Coupling Issues

### 4.1 `agents` imports from 9 other modules

The `agents` module is the most cross-cutting: it imports from `knowledge`, `runtime`, `providers`, `store`, `mcp`, `channels`, `events`, `server`, and `channels`. This makes `BaseAgent` and its subclasses hard to test in isolation.

**Key coupling points in `BaseAgent`:**
- `agents/base.ts` imports from 8 modules
- `AgentContext` (in `agents/types.ts`) depends on `McpRuntime`, `NoteManager`, `ModelRouter`

**Recommendation**: Replace direct imports with narrow interfaces injected at construction. For example, `BaseAgentConfig` should take a `chat: ChatFn` function type instead of a `ModelRouter` instance directly. This would allow `agents` to be tested with a single mock function instead of 8 module stubs.

### 4.2 `server` imports from everything

`server` is the natural top-level integrator, so this is expected. However, individual route modules currently receive `runtime` (the full `SaivageRuntime`) in two places. Over time, each route should receive only the specific narrow interface it needs.

### 4.3 `mcp` → `knowledge` (13 imports)

The MCP builtin services are the heaviest knowledge consumers. This is because the RAG and knowledge tools live inside MCP builtins. Consider whether these should be a separate `knowledge-tools` module that MCP registers, rather than embedding knowledge operations directly in builtin services.

---

## 5. Prioritized Simplification Plan

### Phase 1 — Low-risk extractions (no behavior change, pure file moves)

| Step | Action | Lines moved | Risk |
|---:|---|---:|---|
| 1.1 | Move dispatch schemas from `base.ts` to `dispatch-schemas.ts` | ~173 | Minimal — purely data |
| 1.2 | Move `getToolSchemas()` from `plan-server.ts` to `plan-schemas.ts` | ~114 | Minimal — purely data |
| 1.3 | Move `BaseAgentConfig` to `agents/types.ts` | ~36 | Minimal — type move |
| 1.4 | Move router utility functions to `router-utils.ts` | ~103 | Minimal — pure functions |
| 1.5 | Move model equivalence functions fully to `candidate-planner.ts` | ~47 | Minimal — already split |

**Total**: ~473 lines extracted, no behavior change.

### Phase 2 — Responsibility extraction (small behavior refactor)

| Step | Action | Lines moved | Risk |
|---:|---|---:|---|
| 2.1 | Extract `ModelHealthTracker` from `ModelRouter` | ~60 | Low — single-state capsule |
| 2.2 | Extract `StickyFailoverManager` from `ModelRouter` | ~40 | Low — single-state capsule |
| 2.3 | Extract `UsageTracker` from `ModelRouter` | ~80 | Low — read-heavy usage snapshot |
| 2.4 | Extract `PlanMcpAdapter` (dispatch + queue) from `PlanService` | ~75 | Low — thin adapter layer |
| 2.5 | Extract `LlmCallLoop` from `BaseAgent.callLLM` | ~110 | Medium — core change |

**Total**: ~365 lines extracted, small behavior refactor.

### Phase 3 — Leaf class consolidation (remove tag classes)

| Step | Action | Lines removed | Risk |
|---:|---|---:|---|
| 3.1 | Replace 6 leaf `WorkerAgent` subclasses with role-parameterized `WorkerAgent` | ~55 files | Medium — changes roster, prompt lookup, dispatcher |
| 3.2 | Convert `RagError` hierarchy to single class + discriminated union | ~80 | Low — callers already check `.kind` more than `instanceof` |
| 3.3 | Move `workerInit` prompt strings out of `roster.ts` into prompt modules | ~80 | Low — data move |

**Total**: ~215 lines removed/simplified.

### Phase 4 — Interface narrowing

| Step | Action | Risk |
|---:|---|---|
| 4.1 | Replace `SaivageRuntime` passing in route modules with narrow `RouteContext` interfaces | Low — already partially done |
| 4.2 | Replace `ModelRouter` dependency in `AgentContext` with `chat: ChatFn` function type | Medium — changes test harness |
| 4.3 | Extract `knowledge-tools` from MCP builtins into standalone module | Medium — changes registration |

---

## 6. What NOT to Simplify

- **The `Agent` → `BaseAgent` → `WorkerAgent` hierarchy**: This is the right depth. Removing `WorkerAgent` means duplicating task-report logic in 6 places. Removing `BaseAgent` means duplicating conversation-loop + retry + compaction logic in 7 places.
- **The `ModelProvider` → `BaseProvider` → `OpenAIProvider` hierarchy**: 6 real implementations with genuine algorithmic differences. The abstract base saves real code.
- **The `Chunker`, `EmbeddingProvider`, `VectorStore` interfaces**: Needed for testability and for the RAG module's composition approach.
- **`ProjectStore`**: Real I/O boundary that would be worse as scattered `fs` calls.
- **The narrow route-deps interfaces in `server/routes/`**: These are the correct antidote to the `SaivageRuntime` god context.
- **`EventBus`**: 194 lines, clear responsibility, no extraction needed.

---

## 7. Complexity Metrics Summary

| Metric | Current | After Phase 1–3 |
|---|---:|---:|
| Classes | 64 | 57 (-6 leaf workers, -9 RagError subclasses → +1) |
| Abstract classes | 2 | 2 |
| Interfaces | 199 | ~199 |
| Largest file (`base.ts`) | 973 lines | ~590 lines |
| Largest file (`router.ts`) | 947 lines | ~620 lines |
| Largest file (`plan-server.ts`) | 637 lines | ~250 lines |
| Total source lines | 25,291 | ~24,238 (~1,053 lines extracted/removed) |
| Cross-module imports from `agents` | 9 modules | 7–8 (knowledge deps reduced) |
| `SaivageRuntime` fields | 16 | 16 (interface narrowing deferred) |

The headline improvement: the 4 largest files drop from **3,557 lines** to **~1,460 lines** — a 59% reduction in the most complex modules. The total line reduction is modest (~4%), but the **conceptual density** of each file drops dramatically because each extracted piece is independently testable and readable.