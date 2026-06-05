# Unneeded Abstractions Simplification Plan

**Date**: 2026-06-05
**Status**: Proposed plan; not implemented.
**Source analysis**: `docs/internals/remediation/unneeded-abstractions-analysis.md`

This plan turns the verified unneeded-abstractions review into staged cleanup
work. It prioritizes low-risk dead code and circular dependency removal first,
then moves toward structural simplification. Riskier provider, RAG, channel, and
knowledge boundaries are left for targeted design passes.

## Goals

- Remove dead or misleading code without changing runtime behavior.
- Break unnecessary circular dependencies.
- Collapse one-owner wrappers where the wrapper no longer creates a useful
  abstraction boundary.
- Preserve behaviorally important extraction points that are tested or likely to
  grow.
- Keep public or scriptable API removals behind explicit deprecation decisions.

## Non-Goals

- Do not remove `parseOutbound`; it is used by the production web UI.
- Do not remove `/api/mcp/tools` without an operator API decision.
- Do not collapse all provider/RAG abstractions just because they currently have
  one implementation.
- Do not change channel semantics, provider routing semantics, or knowledge
  persistence schemas in the same pass as mechanical cleanup.

## Phase 1: Dead Code and Misleading Test Seams

**Risk**: Low

### 1. Remove the inert self-check layer

**Files**:

- `src/runtime/self-check.ts`
- `src/agents/roster.ts`
- `src/agents/roster.test.ts`
- `docs/internals/runtime/self-check.md`
- `docs/internals/runtime/details.md`
- `docs/.vitepress/config.ts`
- `docs/internals/agents/index.md`
- `docs/internals/architecture.md`
- `docs/internals/runtime/supervisor.md`
- `docs/internals/source-tree.md`

**Changes**:

- Delete `src/runtime/self-check.ts`.
- Remove `selfCheckFrequency` from `RosterEntry` and each `ROSTER` entry.
- Remove the `DEFAULT_SELF_CHECK_FREQUENCY` parity test block from
  `roster.test.ts` and the import from `self-check.js`.
- Delete `docs/internals/runtime/self-check.md`.
- Remove the "Self-Check & Loop Detection" sidebar entry from
  `docs/.vitepress/config.ts`.
- Update prose references in `details.md`, `agents/index.md`,
  `architecture.md`, `supervisor.md`, and `source-tree.md` that mention
  self-check or `selfCheckFrequency`.

**Validation**:

- `npm run typecheck && npm test -- src/agents/roster.test.ts`

### 2. Remove unused token-cache reset export

**Files**:

- `src/rag/chunker/tokens.ts`

**Changes**:

- Remove `__resetTokenCache()` and its `// Test-only` comment.
- Keep the encoder cache behavior unchanged.

**Validation**:

- `npm run typecheck && npm test -- src/rag/chunker/tokens.test.ts`

### 3. Remove redundant router provider backdoor

**Files**:

- `src/providers/router.ts`
- `src/providers/provider-registry.ts`
- `src/providers/router.test.ts`
- `src/providers/model-capabilities.test.ts`

**Changes**:

- Remove `ModelRouter.providers`.
- Remove `ProviderRegistry.providerMapForTests()`.
- Replace test casts that inspect `router.providers` with public APIs such as
  `router.listProviders()`, `router.getProvider()`, or
  `ProviderRegistry.entries()` when a registry instance is directly available.

**Validation**:

- `npm run typecheck && npm test -- src/providers/router.test.ts src/providers/model-capabilities.test.ts`

## Phase 2: Config and Import-Graph Cleanup

**Risk**: Low to medium

### 4. Break the config/persist circular dependency

**Files**:

- `src/config.ts`
- `src/server/rag/persist.test.ts`

**Changes**:

- Remove `SaivagePersistError`, `saveSaivageConfig`, and
  `SaivagePersistStage` re-exports from `src/config.ts`.
- Remove the dedicated test that asserts those convenience re-exports exist.
- Keep all production imports pointed directly at `src/server/rag/persist.ts`.

**Validation**:

- `npm run typecheck && npm test -- src/server/rag/persist.test.ts src/server/rag/errors.test.ts`

### 5. Decide and document unimplemented config knobs

**Files**:

- `src/config/schema/runtime.ts`
- `src/config/schema/mcp.ts`
- `docs/guide/config-runtime.md`
- `docs/internals/mcp/runtime.md`

**Changes**:

- Mark `runtime.maxServices`, `runtime.idleShutdownMs`, and
  `mcpServers.*.transport: "sse"` as deprecated no-ops in documentation, or
  remove them from the strict schema if there is no persisted-config need.
- Prefer a deprecation note first if local `.saivage/saivage.json` files may
  still contain these keys.
- If removal is chosen, update fixtures and tests that include the keys.

**Validation**:

- `npm run typecheck && npm test -- src/config src/mcp`

## Phase 3: Small One-Owner Collapses

**Risk**: Low to medium

### 6. Remove `BaseAgentConfig.skillContext`

**Files**:

- `src/agents/base-config.ts`
- `src/agents/planner.ts`
- `src/agents/manager.ts`
- `src/agents/worker.ts`
- `src/agents/inspector.ts`
- `src/agents/chat.ts`
- `src/agents/librarian.ts`
- `src/knowledge/loader.ts`

**Changes**:

- Remove the unused optional `skillContext` field from `BaseAgentConfig`.
- Remove the `import type { SkillMatchContext }` from `base-config.ts`.
- Remove constructor writes that pass `skillContext` into `super()`.
- Check if `SkillMatchContext` in `src/knowledge/loader.ts` still has other
  consumers after removal; if not, consider removing it too.
- Keep eager skill block construction unchanged.

**Validation**:

- `npm run typecheck && npm test -- src/agents`

### 7. Inline `PendingCallTracker`

**Files**:

- `src/agents/base.ts`
- `src/agents/pending-call-tracker.ts`

**Changes**:

- Replace `private pendingCallTracker = new PendingCallTracker()` with a
  `private pendingCall: PendingCall | null = null` field.
- Move `startInFlight`, `startBackoff`, `clear`, and `snapshot` behavior into
  private `BaseAgent` methods or inline it at call sites.
- Delete `src/agents/pending-call-tracker.ts`.

**Validation**:

- `npm test -- src/agents/base.compaction.test.ts src/agents/base.retry.test.ts src/agents/chat.lifecycle.test.ts && npm run typecheck`

### 8. Inline `StickyFailoverManager`

**Files**:

- `src/providers/router.ts`
- `src/providers/sticky-failover.ts`

**Changes**:

- Replace the one-owner `StickyFailoverManager` with a private map and small
  private methods on `ModelRouter`.
- Delete `src/providers/sticky-failover.ts`.
- Keep candidate-chain behavior and existing router tests unchanged.

**Validation**:

- `npm test -- src/providers/router.test.ts src/providers/candidate-planner.test.ts && npm run typecheck`

## Phase 4: Medium Mechanical Simplifications

**Risk**: Medium

### 9. Fold `CompactionController` into `BaseAgent`

**Files**:

- `src/agents/base.ts`
- `src/agents/compaction-controller.ts`

**Changes**:

- Move `shouldCompact`, `isStopReached`, `stopReason`, `compact`, and
  `recordCompactionUpdate` logic into private `BaseAgent` methods.
- Remove the 14-property controller config object and callback indirection.
- Delete `src/agents/compaction-controller.ts`.
- Keep `compactConversation()` in `src/runtime/compaction.ts`; only remove the
  per-agent wrapper class.

**Validation**:

- `npm test -- src/agents/base.compaction.test.ts src/runtime/compaction.test.ts && npm run typecheck`

### 10. Remove or narrow the `Agent` interface

**Files**:

- `src/agents/types.ts`
- `src/agents/worker.ts`
- `src/agents/manager.ts`
- `src/agents/planner.ts`
- `src/agents/inspector.ts`
- `src/agents/chat.ts`
- `src/agents/librarian.ts`
- `src/server/agent-orchestrator.ts`
- `src/index.ts`

**Changes**:

- Remove `implements Agent` clauses from all 6 concrete agents.
- Remove the `import type { ... Agent ... }` from `librarian.ts` (it imports
  `Agent` as a type, though it also uses it in `implements`).
- Change `let agent: Agent` in the orchestrator to `BaseAgent` and remove the
  `as unknown as BaseAgent` cast on line 128.
- Decide whether to remove `Agent` from the public barrel (`src/index.ts`) or
  keep it as a type alias for backward compatibility.

**Validation**:

- `npm run typecheck && npm test -- src/server/agent-orchestrator.test.ts src/agents/agents.test.ts`

### 11. Replace `CompactionLlmClient` with `LlmClient`

**Files**:

- `src/runtime/compaction.ts`
- `src/agents/types.ts`

**Changes**:

- Import `LlmClient` from `agents/types.js` into `compaction.ts`. This does not
  create a circular dependency (`agents/types.ts` does not import from
  `runtime/compaction.ts`).
- Replace the `CompactionLlmClient` type in `SelectOpts.router` and
  `compactConversation`'s parameter with `LlmClient`.
- Delete the local `CompactionLlmClient` interface definition.
- Adapt the `compactConversation` call site: the request construction already
  passes `{ modelSpec, model, system, messages, maxTokens }`, which is a valid
  subset of `ChatRequest & { modelSpec }`. The call site only reads `.content`
  from the response, which is present in `ChatResponse`. No behavioral change.
- Update `compaction-controller.ts` to pass `this.config.router` (already
  `LlmClient`-typed) directly without the implicit narrowing.

**Validation**:

- `npm test -- src/runtime/compaction.test.ts src/agents/base.compaction.test.ts && npm run typecheck`

## Phase 5: Store and Runtime Dependency Cleanup

**Risk**: Medium

### 12. Reuse the runtime `StageRunStore`

**Files**:

- `src/server/server.ts`
- `src/store/project-store.ts`
- `src/agents/worker.ts`
- `src/agents/manager.ts`

**Changes**:

- Change `ProjectStore` to accept a `StageRunStore` in its constructor.
- Pass `runtime.stageRuns` from `startServer()`.
- Consider threading `stageRuns` into worker/manager artifact validation reads
  instead of creating ephemeral stores.

**Validation**:

- `npm test -- src/store/project-store.test.ts src/server/routes && npm run typecheck`

### 13. Inline or relocate `runtime-facades.ts`

**Files**:

- `src/server/runtime-facades.ts`
- `src/server/agent-orchestrator.ts`
- `src/server/planner-runner.ts`

**Changes**:

- Either inline `AgentRuntimeDeps` and `PlannerRuntimeDeps` into their two
  consumers, or move them to a clearer shared server types module.
- Prefer no behavior changes.

**Validation**:

- `npm run typecheck && npm test -- src/server/planner-runner.test.ts src/server/bootstrap.test.ts`

### 14. Simplify bootstrap delegation and circular types

**Files**:

- `src/server/bootstrap.ts`
- `src/server/planner-runner.ts`
- Tests importing planner prompt constants or `waitForRecoveryDelay`

**Changes**:

- Move `PlannerRestartRequest` to `planner-runner.ts` or a shared type module to
  break the bootstrap/planner-runner type cycle.
- Point tests that import `CONTINUOUS_IMPROVEMENT_PROMPT`, `RECOVERY_PROMPT`, or
  `waitForRecoveryDelay` at `planner-runner.ts` directly. Four test files need
  import path changes: `prompt-self-correction.test.ts`,
  `prompt-tool-sequence.test.ts`, `prompt-snapshots.test.ts`, and
  `runtime.test.ts`.
- Remove pure re-exports from `bootstrap.ts`.
- Leave `bootstrap()`, `PlannerControl`, and `SaivageRuntime` in place unless a
  larger server-bootstrap redesign is planned.

**Validation**:

- `npm test -- src/server/prompt-self-correction.test.ts src/server/prompt-tool-sequence.test.ts src/server/prompt-snapshots.test.ts src/runtime/runtime.test.ts && npm run typecheck`

## Phase 6: Targeted Design Passes

These items are real, but should not be mixed into the low-risk cleanup series.

### 15. Replace RAG internal WeakMap with `RagManager.getIfOpen()`

**Files**:

- `src/rag/manager.ts`
- `src/rag/internal/datasetAccess.ts`
- `src/knowledge/recovery.ts`

**Plan**:

- Add `getIfOpen(id: string): Dataset | undefined` to the `RagManager`
  interface.
- Implement it as `cache.get(id)` in the real manager and `undefined` in the
  no-op manager.
- Update `recovery.ts` to call `store.ragManager.getIfOpen(...)`.
- Delete `datasetAccess.ts` and its tests.

**Validation**:

- `npm test -- src/rag/manager.test.ts src/knowledge/recovery.test.ts && npm run typecheck`

### 16. Introduce transport-neutral chat events

**Files**:

- `src/channels/types.ts`
- `src/channels/websocket.ts`
- `src/channels/telegram.ts`
- `src/channels/ws-schema.ts`
- `src/agents/chat.ts`

**Plan**:

- Define a transport-neutral `ChatEvent` in `channels/types.ts`.
- Make `ChatChannel.sendEvent(event: ChatEvent)` transport-neutral.
- Keep `WsOutbound` as the WebSocket wire schema and map `ChatEvent` to
  `WsOutbound` only inside `WebSocketChannel`.
- Make Telegram's unsupported-event behavior explicit, either by mapping to a
  concise text message or by logging an intentional discard.

**Validation**:

- `npm test -- src/channels src/agents/chat.lifecycle.test.ts && npm run build:web`

### 17. Rename or split `OpenAIProvider`

**Files**:

- `src/providers/openai.ts`
- `src/providers/ollama.ts`
- `src/providers/nvidia-nim.ts`
- `src/providers/llamacpp.ts`
- `src/providers/provider-registry.ts`

**Plan**:

- Rename `OpenAIProvider` to `OpenAICompatibleProvider` or
  `OpenAIChatCompletionsProvider`.
- Leave `PiAiProvider("openai")` as the production `"openai"` registry path
  unless provider routing is being redesigned separately.
- Consider adding a comment in the registry that direct `"openai"` routing uses
  pi-ai, while OpenAI-compatible local/cloud providers subclass the compatible
  base.

**Validation**:

- `npm test -- src/providers/openai.test.ts src/providers/model-capabilities.test.ts src/providers/router.test.ts && npm run typecheck`

### 18. Rename knowledge row/domain types

**Files**:

- `src/knowledge/types.ts`
- `src/knowledge/sidecar.ts`
- Consumers importing `AuditEntry`

**Plan**:

- Keep the domain `AuditEntry` name in `types.ts`.
- Rename the sidecar row type to `AuditRow` or `SidecarAuditRow`.
- Centralize `RecordKind` instead of duplicating it in `init.ts` and
  `sidecar.ts`.
- Rename `src/knowledge/store.ts` only if imports can be updated cleanly;
  likely target names are `guards.ts` or `errors.ts`.

**Validation**:

- `npm test -- src/knowledge && npm run typecheck`

## Items To Defer

- **`/api/mcp/tools`**: Keep unless an operator API review decides to remove or
  hide it. It is unused by the SPA but documented as a scriptable endpoint.
- **RAG store/provider factories**: Keep for now. They are single-implementation,
  but they are clean extensibility seams for persistence/provider backends.
- **`ModelHealthTracker`**: Borderline one-owner extraction; leave unless router
  code is already being edited. It is cohesive enough to keep.
- **`ProviderCaller` and `CandidatePlanner`**: Keep. Both contain meaningful
  logic and have dedicated tests.
- **`EventBus.pause/resume/getBufferSize`**: Confirmed production-dead, but keep
  until channel/offline delivery direction is decided. If no offline delivery is
  planned, remove in a separate event-bus cleanup.
- **`ChatCommands` / `createChatCommands`**: Keep. It has one method, but that
  method is a real transport/runtime orchestration point.

## Suggested Commit Breakdown

1. `refactor: remove inert self-check code`
2. `refactor: remove unused token cache reset`
3. `refactor: remove router provider backdoor`
4. `refactor: remove config persistence re-exports`
5. `refactor: deprecate unimplemented config knobs` (or `refactor: remove unimplemented config knobs`)
6. `refactor: drop unused agent skill context`
7. `refactor: inline pending call tracker`
8. `refactor: inline sticky failover state`
9. `refactor: fold compaction controller into base agent`
10. `refactor: simplify agent interface usage`
11. `refactor: replace CompactionLlmClient with LlmClient`
12. `refactor: reuse stage run store in project reads`
13. `refactor: inline runtime facades`
14. `refactor: simplify bootstrap planner exports`
15. `refactor: add RagManager getIfOpen lookup`
16. `refactor: introduce transport-neutral chat events`
17. `refactor: rename OpenAIProvider to OpenAICompatibleProvider`
18. `refactor: rename knowledge AuditEntry row type`

Phase 1 (steps 1-3) and Phase 2 (steps 4-5) are low-risk and can be done in any
order within their phase. Phase 3 (steps 6-8) and Phase 4 (steps 9-11) should be
done in order because step 9 modifies `base.ts` heavily. Phase 5 (steps 12-14)
and Phase 6 (steps 15-18) are independent within their phase.

Each commit should run the focused tests listed in its section plus
`npm run typecheck`. For commits touching runtime dispatch, compaction, provider
routing, or persistence, also run `npm test` before reporting success.

## Review Corrections (2026-06-05)

Issues found during plan review and corrected above:

1. **Step 1 file list was incomplete**: The original list missed 5 doc files
   that reference self-check (`docs/.vitepress/config.ts` sidebar,
   `docs/internals/agents/index.md`, `docs/internals/architecture.md`,
   `docs/internals/runtime/supervisor.md`, `docs/internals/source-tree.md`).
   Added all to the file list and change descriptions.

2. **Step 6 file list was incomplete**: `src/knowledge/loader.ts` defines the
   `SkillMatchContext` type imported by `base-config.ts`. Added to file list
   with a note to check if `SkillMatchContext` still has consumers after removal.

3. **Step 10 file list was too vague**: `src/agents/*.ts` is imprecise.
   Replaced with the exact 6 agent files that carry `implements Agent`, plus
   `src/agents/librarian.ts` which also imports the `Agent` type directly.

4. **Step 11 was underspecified**: Simply deleting `CompactionLlmClient` and
   using `LlmClient` requires adapting the `compactConversation` call site and
   the `CompactionController` bridging pattern, not just swapping a type.
   Expanded the change description with the actual call-site adaptation details.
   Confirmed no circular dependency is introduced.

5. **Step 14 test file list was incomplete**: The 4 test files that import
   planner prompt constants from `bootstrap.ts` were not named. Added explicit
   file names.

6. **Validation commands used shell glob patterns**: `npm test --` runs Vitest;
   avoid shell-only globs like `src/agents/base.*.test.ts`. Replaced validation
   commands with explicit Vitest file and directory arguments.

7. **Commit list was incomplete**: The original 12 commits missed steps 10-11
   (Phase 4) and steps 13-18 (Phase 5-6). Expanded to 18 commits matching all
   plan steps, with ordering notes.
