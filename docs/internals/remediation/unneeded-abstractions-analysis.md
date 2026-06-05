# Unneeded Abstractions Analysis

**Date**: 2026-06-05
**Status**: Analysis for later review; no implementation changes from this document.

This document records potential shallow and mid-level abstractions that may be
remnants from older Saivage v2 designs. The goal is not to remove these
immediately, but to provide a review queue for future cleanup. Items are grouped
by confidence and risk.

## Highest-Confidence Candidates

### 1. Dead or stale self-check layer

**Files/symbols**:

- `src/runtime/self-check.ts`
- `src/agents/roster.ts`: `RosterEntry.selfCheckFrequency`
- `src/agents/roster.test.ts`: self-check frequency assertion

**Why it may be unnecessary**: `createSelfCheckState`, `recordToolCallRound`,
and `selfCheckMessage` are not wired into agent or runtime execution. The roster
still carries per-role self-check frequencies, but production code does not
appear to consume them.

**Risk**: Low to medium. Confirm whether periodic self-check prompting is still
a product requirement before deleting it.

### 2. `BaseAgentConfig.skillContext`

**Files/symbols**:

- `src/agents/base-config.ts`
- Agent constructors that pass `skillContext`

**Why it may be unnecessary**: `BaseAgent` ignores `skillContext`. Agents now
pre-build `eagerSkillBlock` directly, so `skillContext` appears to be a remnant
from an older lazy skill-loading design.

**Risk**: Low to medium, mostly constructor and test churn.

### 3. `ProviderRegistry.providerMapForTests()` and `ModelRouter.providers`

**Files/symbols**:

- `src/providers/provider-registry.ts`: `providerMapForTests`
- `src/providers/router.ts`: `providers`

**Why it may be unnecessary**: Production router initialization calls a method
named for tests to set `this.providers`, but router behavior appears to use
`providerRegistry` directly.

**Risk**: Low to medium. Tests may need to use public registry/router methods
instead.

### 4. Unimplemented config knobs

**Files/symbols**:

- `src/config/schema/runtime.ts`: `maxServices`, `idleShutdownMs`
- `src/config/schema/mcp.ts`: `transport: "sse"`

**Why it may be unnecessary**: `maxServices` and `idleShutdownMs` appear only in
schema/default fixtures. `transport: "sse"` is accepted by config, but the MCP
client only constructs `StdioClientTransport`.

**Risk**: Medium. Removing strict config keys can break existing `saivage.json`
files. Prefer documenting or deprecating before removal.

### 5. Test-only exports

**Files/symbols**:

- `src/rag/chunker/tokens.ts`: `__resetTokenCache`
- `src/channels/ws-schema.ts`: `parseOutbound`

**Why it may be unnecessary**: These appear to be test-only, and
`__resetTokenCache` appears unused even by tests.

**Risk**: Low.

## Likely Over-Abstractions

### 6. `InputChannel` abstraction

**Files/symbols**:

- `src/agents/types.ts`: `InputChannel`
- `src/runtime/notes.ts`: `NoteChannel`
- `src/agents/base.ts`: `inputChannels`, `drainChannels`

**Why it may be unnecessary**: The only production implementation appears to be
`NoteChannel`, and only the Planner uses it. This puts Planner-specific note
draining and compaction reinjection plumbing into `BaseAgent` for every role.

**Risk**: Medium. Note lifecycle is active and persistence-adjacent.

### 7. `CompactionController`

**Files/symbols**:

- `src/agents/compaction-controller.ts`
- `src/agents/base.ts`

**Why it may be unnecessary**: It has one production owner, `BaseAgent`, and is
mostly configured by callbacks back into that owner. It may be clearer as a
function or folded into the agent compaction path.

**Risk**: Medium. Compaction is behaviorally sensitive.

### 8. Dispatch metadata spread across multiple layers

**Files/symbols**:

- `src/agents/roster.ts`
- `src/runtime/dispatcher.ts`
- `src/agents/dispatch-tool-schemas.ts`

**Why it may be unnecessary**: Dispatch role metadata, runtime dispatch maps,
and dispatch tool schemas are related but maintained in separate layers. Adding
a role still requires checking multiple places.

**Risk**: Medium. Simplify by deriving more from one source, not by removing the
dispatch boundary.

### 9. `PendingCallTracker`

**Files/symbols**:

- `src/agents/pending-call-tracker.ts`
- `src/agents/base.ts`

**Why it may be unnecessary**: It is a tiny one-owner class around nullable
pending-call state. The public boundary is the agent activity status, not the
tracker class.

**Risk**: Low.

### 10. `Agent` interface

**Files/symbols**:

- `src/agents/types.ts`: `Agent`
- Concrete agent classes implementing it

**Why it may be unnecessary**: It is very thin over concrete `BaseAgent`
subclasses. Some orchestration code types an object as `Agent`, then casts back
to `BaseAgent` for registry storage.

**Risk**: Low to medium if internal; higher if it is considered public API.

### 11. Duplicate LLM client interfaces

**Files/symbols**:

- `src/agents/types.ts`: `LlmClient`
- `src/runtime/compaction.ts`: `CompactionLlmClient`

**Why it may be unnecessary**: Both describe slices of the same router behavior.
A single shared minimal interface may be clearer.

**Risk**: Medium. Provider routing and auth boundaries are sensitive.

## Server, MCP, Store, and Config

### 12. `/api/mcp/tools` read model

**Files/symbols**:

- `src/server/routes/config.ts`: `GET /api/mcp/tools`
- `src/mcp/runtime.ts`: `listAllToolsForApi`
- `src/mcp/in-process-registry.ts`: `listAllToolsForApi`
- `src/mcp/external-runtime.ts`: `listAllToolsForApi`

**Why it may be unnecessary**: It looks like an inspector/debug endpoint and no
current web UI consumer was found. It duplicates some `getAllTools()` projection
behavior.

**Risk**: Medium. It may be an operator/public API even if not used by the web
UI.

### 13. `ProjectStore` as server read facade

**Files/symbols**:

- `src/store/project-store.ts`
- `src/server/server.ts`
- `src/store/stage-run-store.ts`

**Why it may be unnecessary**: Only the server and tests construct it. It creates
its own `StageRunStore` instead of reusing the runtime's `stageRuns`, and mixes
HTTP read models, debug aggregation, chat-log discovery, and lenient JSON reads.

**Risk**: Medium. Consider rename/split/reuse before removal.

### 14. `runtime-facades.ts`

**Files/symbols**:

- `src/server/runtime-facades.ts`

**Why it may be unnecessary**: The file contains type-only dependency
interfaces. These may improve tests, but the separate "facades" module may be
more architectural weight than needed.

**Risk**: Low to medium.

### 15. `config.ts` re-exporting RAG persistence

**Files/symbols**:

- `src/config.ts`
- `src/server/rag/persist.ts`

**Why it may be unnecessary**: Core config re-exports server/RAG persistence
helpers, while production RAG code imports persistence directly. This creates a
reverse dependency from core config to server/RAG code.

**Risk**: Low if internal; medium if `src/config.ts` is public API.

### 16. Bootstrap wrapper exports

**Files/symbols**:

- `src/server/bootstrap.ts`: wrappers for planner/orchestrator functions

**Why it may be unnecessary**: Some exports delegate to newer dedicated modules
and may now exist only as compatibility barrels.

**Risk**: Medium. Tests and scripts may import these paths.

### 17. `ChatCommandService`

**Files/symbols**:

- `src/server/chat-command-service.ts`
- `src/server/routes/websocket.ts`

**Why it may be unnecessary**: It is a one-command facade for WebSocket chat
startup.

**Risk**: Low to medium. It does keep route modules thin.

## RAG, Providers, Channels, and Knowledge

### 18. EventBus offline buffering

**Files/symbols**:

- `src/events/bus.ts`: `pause`, `resume`, `getBufferSize`, subscription buffer

**Why it may be unnecessary**: Production code appears to use publish/subscribe,
while pause/resume buffering appears test-only.

**Risk**: Medium if offline delivery is still a planned channel requirement.

### 19. RAG single-implementation factories

**Files/symbols**:

- `src/rag/store/index.ts`: `VectorStore`, `createVectorStore`
- `src/rag/provider/index.ts`: `EmbeddingProvider`, `createEmbeddingProvider`

**Why it may be unnecessary**: Only one vector store (`sqlite-vec`) and one
embedding provider kind (`openai`) exist today. The factory style may be planned
pluggability rather than needed runtime flexibility.

**Risk**: Medium to high. These are persistence and provider boundaries.

### 20. RAG internal WeakMap lookup seam

**Files/symbols**:

- `src/rag/internal/datasetAccess.ts`
- `src/rag/manager.ts`
- `src/knowledge/recovery.ts`

**Why it may be unnecessary**: This is an internal backchannel to access a
cached `Dataset` without making it part of `RagManager`'s public API. It may
indicate the public manager abstraction is missing a `getIfOpen()`-style method.

**Risk**: Medium. Boot recovery semantics may rely on not opening datasets.

### 21. Generic channel interface uses WebSocket-specific event type

**Files/symbols**:

- `src/channels/types.ts`: `ChatChannel.sendEvent(event: WsOutbound)`
- `src/channels/telegram.ts`
- `src/channels/ws-schema.ts`

**Why it may be unnecessary**: `ChatChannel` is transport-generic, but its
structured event type is WebSocket-specific. Telegram silently discards event
types it cannot represent.

**Risk**: Medium. The channel abstraction is active with multiple
implementations.

### 22. `OpenAIProvider` naming and role drift

**Files/symbols**:

- `src/providers/openai.ts`
- `src/providers/provider-registry.ts`

**Why it may be unnecessary or misleading**: The registry routes direct
`"openai"` through `PiAiProvider`; `OpenAIProvider` now mostly supports
OpenAI-compatible subclasses such as Ollama and NVIDIA NIM.

**Risk**: Medium to high. Prefer rename/split over deletion.

### 23. Router helper classes

**Files/symbols**:

- `src/providers/provider-caller.ts`
- `src/providers/sticky-failover.ts`
- `src/providers/health-tracker.ts`
- `src/providers/candidate-planner.ts`

**Why it may be unnecessary**: These are mostly one-owner helpers for
`ModelRouter`. Some improve testability, but smaller map wrappers may be
over-extracted.

**Risk**: Medium. Routing behavior is important and already tested.

### 24. Knowledge `store.ts` name no longer matches contents

**Files/symbols**:

- `src/knowledge/store.ts`

**Why it may be unnecessary or misleading**: The file now appears to hold error
taxonomy, guards, and schema re-exports rather than the actual store. Actual
persistence lives in sidecar/init modules.

**Risk**: Low to medium. Guards should remain; naming/placement is the issue.

### 25. Knowledge boot facade

**Files/symbols**:

- `src/knowledge/init.ts`: `KnowledgeStore`, `initKnowledgeStore`,
  `reingestKind`

**Why it may be unnecessary**: `KnowledgeStore` is a context object with a
self-capturing `reingestKind` method. It may be clearer as data context plus
standalone functions.

**Risk**: Medium. This is an active boundary used by bootstrap, MCP, lifecycle,
and shutdown paths.

### 26. Duplicate knowledge type names

**Files/symbols**:

- `src/knowledge/types.ts`
- `src/knowledge/sidecar.ts`

**Why it may be unnecessary or confusing**: Domain/Zod types and sidecar row
types overlap names such as `AuditEntry`. Some duplication is legitimate, but
the names can obscure whether a value is domain-shaped or DB-row-shaped.

**Risk**: Low to medium. Renaming row types is safer than merging layers.

## Review Findings (2026-06-05)

Each point was verified against the current codebase. Findings below flag
errors in the original claims, confirm accurate points, and add nuance where
needed.

### Errors Found

**Point 3 (providerMapForTests)** claims the method is test-only, but it is
called once in production (in the `ModelRouter` constructor, line 71 of
`router.ts`). The `providers` field it initializes is then never read by
production code — all provider access goes through `this.providerRegistry`.
The method name is misleading, not the usage scope. The conclusion (remove
`providers` field and the method) remains valid, but the reason is "redundant
field," not "test-only escape hatch."

**Point 5 (test-only exports)** contains a factual error. `parseOutbound` is
**not** test-only — it is used in production at `web/src/composables/useWebSocket.ts`
line 81, where it validates every incoming WebSocket message from the server.
Only `__resetTokenCache` is truly unused (not even called by tests). The
suggested review order item 1 should remove `parseOutbound` from the
"test-only remnants" list.

**Point 8 (dispatch metadata spread)** overstates the maintenance burden. The
investigation shows that `DISPATCH_ROLE_MAP` and `DISPATCH_TOOLS` in
`dispatcher.ts` are **auto-derived from ROSTER at load time**. `ROLE_DISPATCH_TOOLS`
in `dispatch-tool-schemas.ts` is also derived from ROSTER with a runtime guard
that crashes immediately if a dispatch tool lacks a schema. The only
genuinely manual step is writing each role's unique input schema in
`DISPATCH_SCHEMA_BY_TOOL`, which is inherently necessary because each role has
a different input shape. Adding a new role requires changes in 6-8 files, but
most are architectural registration points (agent class, prompt file, knowledge
type enum), not redundant metadata duplication. The separation is largely
intentional and well-structured.

**Point 11 (duplicate LLM client interfaces)** labels `LlmClient` and
`CompactionLlmClient` as "duplicate," but they are not true duplicates.
`CompactionLlmClient` has a narrower `chat` signature (simpler request shape,
returns only `{ content: string }`) and lacks `getMaxContextTokens` and
`resetModelHealth`. However, `LlmClient` is structurally assignable to
`CompactionLlmClient`, so `CompactionLlmClient` is redundant in practice
even though the signatures diverge. The recommendation (replace
`CompactionLlmClient` with `LlmClient` in `compactConversation`) is still
valid, but the reason is "redundant narrow interface," not "duplicate."

**Point 15 (config.ts re-exporting RAG persistence)** understates the problem.
The re-exports create a real **circular dependency**: `config.ts` imports from
`./server/rag/persist.js`, and `persist.ts` imports `SaivageConfigSchema`,
`configPath`, and `type SaivageConfig` back from `../../config.js`. Zero
consumers import these symbols through `config.ts` — all import directly from
`persist.js`. The circular dependency is the real harm, not just the
architectural inversion.

**Point 17 (ChatCommandService)** gets the name wrong. No symbol named
`ChatCommandService` exists. The actual exports are `ChatCommands` (interface)
and `createChatCommands` (factory). More importantly, the analysis underplays
the complexity: the single `startWebSocketChat` method orchestrates 7+ steps
(ID generation, channel creation, model routing, context assembly, agent
creation, registry management, protocol handshake). It is not a simple
one-command facade — it is a coordination point between transport and runtime
layers.

### Confirmed Points

Points confirmed as described in the original analysis:

- **Point 1 (self-check layer)**: All 5 exports are dead in production. The
  `roster.test.ts` parity assertion is the only consumer, and it is circular.
- **Point 2 (skillContext)**: Written by 6 agent constructors, never read by
  `BaseAgent`. The field comment already acknowledges this.
- **Point 4 (unimplemented config knobs)**: All three are confirmed
  unimplemented. `maxServices` is never enforced, `idleShutdownMs` is
  explicitly documented as ignored, and `McpClient` always uses
  `StdioClientTransport` regardless of the `transport` config value.
- **Point 6 (InputChannel)**: The mechanism exists in `BaseAgent` for all
  agents, but only `PlannerAgent` wires in a `NoteChannel`. Other agents get
  an empty `inputChannels` array, making `drainChannels()` a no-op for them.
- **Point 7 (CompactionController)**: One-owner class with 4 public methods
  and 5 callbacks. Can be folded into `BaseAgent` as a simple mechanical
  refactor (~110 line net reduction) with no behavioral change.
- **Point 9 (PendingCallTracker)**: 35-line one-owner class wrapping one
  nullable field with 4 trivial methods. No external consumers.
- **Point 10 (Agent interface)**: 4-member interface that every implementor
  also gets from `extends BaseAgent`. The sole `Agent`-typed variable is
  immediately cast to `BaseAgent`. It is a documentation marker, not a real
  decoupling boundary. The re-export in `src/index.ts` is vestigial.
- **Point 12 (/api/mcp/tools)**: Truly unused by any frontend. Documented as
  "no current SPA panel."
- **Point 13 (ProjectStore)**: Creates its own `StageRunStore` instead of
  reusing the runtime's. Two additional ephemeral `StageRunStore` instances
  are created in `worker.ts` and `manager.ts`. Functionally harmless (read-only
  access to the same filesystem), but architecturally messy.
- **Point 14 (runtime-facades.ts)**: Strictly type-only (two `export interface`
  declarations, zero runtime values). Two consumers, both using `import type`.
  Easy to inline.
- **Point 16 (bootstrap wrappers)**: 6 of 10 exports are pure delegation or
  re-exports. 3 are bare re-exports from `planner-runner.ts`, 3 are type-adapter
  wrappers. Also creates a circular type dependency (`PlannerRestartRequest`
  defined in `bootstrap.ts` but imported by `planner-runner.ts`).
- **Point 18 (EventBus buffering)**: `pause/resume/getBufferSize` have zero
  production callers. All 13 call sites are in `bus.test.ts`. Dead code in
  production.
- **Point 19 (RAG factories)**: Single implementation each. `sqlite-vec` for
  `VectorStore`, `openai` for `EmbeddingProvider`. The `kind` discriminants
  are single string literals, not unions. The exhaustive `default: never`
  ensures future extensibility.
- **Point 20 (WeakMap seam)**: Intentional, documented, tested internal seam.
  Exists because `RagManager` lacks a `getIfOpen()` method. Can be cleanly
  replaced with a public `getIfOpen()` method.
- **Point 21 (channel event typing)**: Confirmed. `ChatChannel.sendEvent`
  accepts `WsOutbound`, forcing non-WebSocket channels to import a
  WebSocket-specific type. Telegram discards 4 of 5 event types silently.
  The dependency arrow points the wrong way — abstract interface depends on
  concrete transport type.
- **Point 22 (OpenAIProvider naming)**: Confirmed real naming drift. The
  `OpenAIProvider` class is never used for the `"openai"` registry entry
  (`PiAiProvider` handles that). It now serves exclusively as a base class
  for OpenAI-compatible providers (Ollama, NVIDIA NIM, llama.cpp).
- **Point 23 (Router helper classes)**: Confirmed mostly single-owner. Of the
  four helpers, `StickyFailoverManager` (23 lines, no tests) is clearly
  over-extracted. `ModelHealthTracker` (54 lines, no tests) is borderline.
  `ProviderCaller` (67 lines) and `CandidatePlanner` (130 lines, with tests)
  are justified extractions.
- **Point 24 (knowledge store.ts naming)**: Confirmed. The file contains error
  taxonomy, guards, and schema re-exports only. No store logic.
- **Point 25 (knowledge boot facade)**: Confirmed. `KnowledgeStore` is a
  context object with a self-capturing `reingestKind` closure.
- **Point 26 (duplicate knowledge type names)**: Only 1 collision exists
  (`AuditEntry`), but it is genuinely confusing — the domain type and the
  sidecar row type have completely different shapes. A minor additional
  duplication: `RecordKind` appears in both `init.ts` and `sidecar.ts`.

### Revised Suggested Review Order

1. **Remove inert remnants**: self-check layer, `__resetTokenCache`. Remove
   `parseOutbound` from the "test-only" list — it is production code.
2. **Remove redundant production fields**: `ModelRouter.providers` and
   `ProviderRegistry.providerMapForTests()`. Refactor the 13 test accesses to
   use `ModelRouter.listProviders()` or `ProviderRegistry.entries()`.
3. **Remove unused config fields or deprecate them**: `maxServices`,
   `idleShutdownMs`, `transport: "sse"`. Document as no-ops before removal.
4. **Break circular dependency**: Remove `config.ts` re-exports of
   `SaivagePersistError`/`saveSaivageConfig`/`SaivagePersistStage`. Remove the
   dedicated test that verifies these re-exports. This eliminates the
   `config.ts` <-> `persist.ts` circular import.
5. **Collapse small one-owner abstractions**: `PendingCallTracker`, `skillContext`,
   `StickyFailoverManager` (23 lines, no tests). Consider folding
   `CompactionController` (higher value but straightforward mechanical refactor).
6. **Remove the `Agent` interface**: Replace `implements Agent` with nothing
   (already covered by `extends BaseAgent`). Change the orchestrator's
   `let agent: Agent` to `BaseAgent` and remove the `as unknown as BaseAgent`
   cast. Make `Agent` a type alias if needed for the public barrel export.
7. **Replace `CompactionLlmClient` with `LlmClient`**: The narrow interface is
  structurally satisfied by `LlmClient` and adds no decoupling value.
8. **Add `RagManager.getIfOpen()`**: Replaces the internal WeakMap backchannel
   in `datasetAccess.ts`, eliminating the cross-package import in `recovery.ts`.
9. **Medium-risk seams** (design review each): `ProjectStore` duplicate
   `StageRunStore`, `ChatChannel.sendEvent` typing, `InputChannel` in
   `BaseAgent`, channel event generic, `store.ts` naming.
10. **Leave high-risk boundaries**: RAG factories (extensibility design),
    provider naming (rename risk), `EventBus` buffering (until channels need
    it), knowledge boot facade (touching bootstrap/lifecycle/shutdown),
    `dispatch-tool-schemas` manual schemas (inherently necessary).
