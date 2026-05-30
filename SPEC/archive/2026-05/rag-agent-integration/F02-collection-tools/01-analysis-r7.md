# F02 — Agent-Facing RAG Collection Tools: Functional Analysis

This analysis specifies the MCP tool surface that lets agents and
operators **configure, feed, query, and observe** RAG collections at
runtime. The surface lives under a single MCP service id, `rag`, with
exactly seven tools. It composes the existing public API of
[src/rag/](src/rag/) without changing it; one private internal
walker hardening (§1.6) is required.

## 1. Verified Facts

### 1.1 In-process service registration and envelope

[McpRuntime.registerInProcess](src/mcp/runtime.ts#L153-L184) takes
`(name, tools, handler, options?)`. When an in-process service is
registered with `available: false`, `callTool` throws `Service
"<name>" is registered but unavailable` **before** the handler runs;
the handler cannot return a typed envelope. The `rag` service is
therefore **always registered as available**.

Handler success returns `{ content, isError: false }`. Handler
failure returns whatever `content` the implementation chooses; on
`isError === true`, [McpRuntime.callTool](src/mcp/runtime.ts#L184-L193)
JSON-wraps that content into a thrown `Error` and the caller-side
plumbing decodes it. Existing handlers vary — typed objects
([src/mcp/knowledgeSkills.ts](src/mcp/knowledgeSkills.ts#L166-L171))
and bare strings
([src/mcp/builtins.ts](src/mcp/builtins.ts#L1876-L1885)). F02's
`rag` handler uses the typed envelope `{ content: { error: { code,
message, details? } }, isError: true }`.

### 1.2 Tool-call context

[ToolCallContext](src/mcp/toolContext.ts#L17-L34) carries
`role: AgentRole` (required), `agentId`, `projectRoot`, optional
`author`, `stageId`, `channelId`, `sessionId`. There is **no
`operator` role** and no operator flag on the current type.

F02 extends `ToolCallContext` with an optional private field:

```ts
// In src/mcp/toolContext.ts:
export type ToolCallContext = {
  // ...existing fields
  /** Internal-only: set true by CLI/server when the caller is the
   *  human operator. Never settable from tool args; only the
   *  runtime context construction code may set it. */
  operatorContext?: boolean;
};

// In src/server/rag/service.ts (new):
export function isRuntimeOperatorContext(ctx: ToolCallContext): boolean {
  return ctx.operatorContext === true;
}
```

The CLI entry point and server bootstrap are the only call sites
that set `operatorContext: true`; tool-arg parsing never touches
this field. The handler-side authorization predicate is:

```ts
const denied =
  isMutating(toolName) &&
  !isRuntimeOperatorContext(ctx) &&
  !ragService.adminRoles.has(ctx.role);
```

### 1.3 Tool filtering — deny-list for workers; presentation-only

[applyToolFilter](src/agents/tool-filters.ts#L31-L44) is keyed on
`ToolFilterKind` and checks `tool.name` only. The filter is consumed
by [BaseAgent](src/agents/base.ts#L662-L668) when building the
**tool schema list shown to the model**. The runtime dispatcher does
not re-apply the filter: it resolves the name through the unfiltered
`mcpRuntime.getAllTools()` catalog and calls `mcpRuntime.callTool`
([src/runtime/dispatcher.ts](src/runtime/dispatcher.ts#L156-L194)).
The filter is a presentation boundary, **not an enforcement
boundary**.

F02 enforces authorization in two layers:

- **Filter layer (presentation).** Reads added to `READ_ONLY_TOOLS`;
  mutating/admin tools added to `WORKER_EXCLUDED_TOOLS` (deny-list
  per [src/agents/tool-filters.ts](src/agents/tool-filters.ts#L24-L34))
  and omitted from every allow-list filter.
- **Handler layer (enforcement).** §1.2 predicate. F02 ships with
  `ragService.adminRoles = new Set<AgentRole>()` — empty. F03 adds
  `"librarian"`.

Roster role-filter mapping (from
[src/agents/roster.ts](src/agents/roster.ts#L87-L266)): `planner` →
planner; `manager`, `coder`, `researcher`, `data_agent`, `designer`
→ worker (deny-list); `critic`, `reviewer` → reviewer (allow-list);
`inspector` → inspector (allow-list); `chat` → chat (allow-list).

### 1.4 RagManager — runtime registration via mutable datasets array

[createRagManager](src/rag/manager.ts#L87-L88) is **`async`**; all
bootstrap call sites must `await`. The `RagManagerOptions`
([src/rag/manager.ts](src/rag/manager.ts#L34-L40)) shape:

```ts
{ projectRoot: string; projectId: string; enabled: boolean;
  datasets: ReadonlyArray<Omit<DatasetConfig, "projectId">>;
  providerOptions?: OpenAIProviderOptions }
```

`providerOptions` is **optional**.
[OpenAIProviderOptions](src/rag/provider/index.ts#L22-L34) carries
raw OpenAI options (`apiKey`, `baseUrl`, `client`, `batchSize`,
retry settings). F02 provides a private helper
`resolveOpenAIProviderOptions(authProfiles)` inside
[src/server/bootstrap.ts](src/server/bootstrap.ts) — an
implementation detail of bootstrap, not a new public RAG export.

When `enabled === false`, `createRagManager` returns a no-op manager
whose methods throw `DatasetNotFoundError`. F02 never relies on this
disabled path: the `rag` handler pre-checks `ragService.enabled` and
returns `RAG_DISABLED` before touching the manager.

The manager closes over the `opts.datasets` array; `manager.get(id)`
resolves by `opts.datasets.find((d) => d.id === id)`
([src/rag/manager.ts](src/rag/manager.ts#L117-L121)). Pushing a new
config into the same array object makes the dataset discoverable to
all of `get`, `ingest`, `query`, `stats`, `drop`.

There is **no watcher-logger option** on `RagManagerOptions` or
`DatasetOpenOptions` ([src/rag/dataset.ts](src/rag/dataset.ts#L59-L61)).
Operator-visible watcher floods and `ENOSPC` go to `console.warn`
via the default `WatcherController` logger; redirecting them
requires a public RAG API change (out of F02 scope; **FUP-WATCHER-LOG**).

### 1.5 Snapshot ingest semantics; one-root rule

[runIngest](src/rag/pipeline.ts#L168-L290) treats supplied items as
the complete seen set
([src/rag/pipeline.ts](src/rag/pipeline.ts#L177-L188)) and deletes
every prior `file_state` path absent from the current input
([src/rag/pipeline.ts](src/rag/pipeline.ts#L276-L288)). The fs walk
uses caller-supplied `include`/`exclude`
([src/rag/pipeline.ts](src/rag/pipeline.ts#L83-L88)), and `seenPaths`
is built from that walked set
([src/rag/pipeline.ts](src/rag/pipeline.ts#L178-L184)). A narrower
caller-supplied `include` would purge every prior chunk outside that
window.

[IngestInput](src/rag/types.ts#L120-L126) for `kind: "fs"` accepts
**one** root per call.

Consequences for F02:

- Each `fs` dataset is constrained to exactly one source root,
  stored on `DatasetConfig.sources[0]`. `rag_register` rejects
  `sources.length !== 1`.
- **`rag_ingest` takes no caller globs.** The handler reads
  `dataset.config.sources[0]` and passes its `root`, `include`, and
  `exclude` verbatim to `manager.ingest`. Caller-supplied
  `include`/`exclude` are not accepted (would invite destructive
  snapshot purges).
- `rag_ingest` is the **manual / operator** deletion convergence
  path. A live watcher `unlink` event also converges deletions: it
  enters `processBatch()`
  ([src/rag/watcher/controller.ts](src/rag/watcher/controller.ts#L161-L164)),
  groups events by source root, and calls full-root fs ingest
  ([src/rag/watcher/controller.ts](src/rag/watcher/controller.ts#L184-L225))
  which purges missing `file_state` entries via the same snapshot
  rule.
- **`rag_admin reconcile` is not a deletion path.**
  [WatcherController.reconcile](src/rag/watcher/controller.ts#L72-L93)
  does not take the `changedPaths.concat(removedPaths)` early
  return, but the per-root ingest loop filters on
  `result.changedPaths` and continues past roots with no changed
  paths
  ([src/rag/watcher/controller.ts](src/rag/watcher/controller.ts#L87-L93)),
  so a deletion-only reconcile does not call ingest.

### 1.6 Path containment and secret guards

- [shouldSkipPath](src/rag/security/secrets.ts#L59-L64) is a
  secret-path predicate (`.env`, `auth-profiles.json`,
  `credentials.json`).
- [scanChunk](src/rag/security/secrets.ts#L71) scans per-chunk
  content during ingest.
- The RAG walker [src/rag/walker.ts](src/rag/walker.ts#L6-L10)
  **follows symlinks**; `fs.stat(abs)` on a symlinked subdirectory
  recurses into it
  ([src/rag/walker.ts](src/rag/walker.ts#L55-L69)). A symlink inside
  the configured root pointing outside the project would ingest
  external files.

The public `RagManager.ingest` API does not expose the
`WalkedFile[]` to handlers
([src/rag/manager.ts](src/rag/manager.ts#L47),
[src/rag/dataset.ts](src/rag/dataset.ts#L101-L103)); a handler-side
post-walk would only re-walk, with TOCTOU. F02 therefore requires a
**private RAG-internals change**:

- Harden `walk` / `loadFsItems` inside
  [src/rag/walker.ts](src/rag/walker.ts) and
  [src/rag/pipeline.ts](src/rag/pipeline.ts) to skip any walked
  entry whose `realpath` is not contained within the dataset's
  configured root realpath. Exported signatures are preserved; the
  hardening is internal.
- Containment check uses the `assertInside` pattern from
  [src/mcp/builtins.ts](src/mcp/builtins.ts#L64-L71): `const rel =
  path.relative(rootReal, abs); if (rel === "" || (!rel.startsWith("..")
  && !path.isAbsolute(rel))) { ok }`. **No prefix-string check** —
  prefix string accepts sibling roots like `<root>-evil`.

At the F02 handler layer:

1. `rag_register` resolves `sources[0].root` to realpath; rejects
   `RAG_BLOCKED_PATH` when the dataset root is not contained within
   `realpath(ctx.projectRoot)`. Containment is
   `const rel = path.relative(projectRoot, datasetRoot); ok = (rel
   === "" || (!rel.startsWith("..") && !path.isAbsolute(rel)));`.
   The empty-string case (dataset root equals project root) is
   accepted; only `..` or absolute relative paths fail. Stores the
   resolved realpath on the persisted config.
2. The hardened internal walker enforces the same containment for
   every walked entry's realpath against the stored dataset root.
   Escaping entries are **skipped silently** with a structured
   `log.warn("rag.walker.symlink-escape", { datasetId, path })`
   line; the ingest run continues with the remaining contained
   entries. The exported `WalkedFile[]` shape is unchanged. There
   is no `RAG_BLOCKED_PATH` envelope from this path — the handler
   surface for `rag_ingest` returns the normal `IngestReport`
   reflecting only the contained entries that were processed.
   `RAG_BLOCKED_PATH` is reserved for the register-time root check
   in step 1 and for `shouldSkipPath` rejections (step 3).
3. `shouldSkipPath` continues to drop secret files per path.

The internal walker hardening is recorded as **FUP-RAG-SYMLINK**
remediation; the change preserves every exported signature.

### 1.7 Watcher error mapping

- `Dataset.watch()` throws a plain `Error` when watch is disabled
  ([src/rag/dataset.ts](src/rag/dataset.ts#L149-L153)). The `rag`
  handler pre-checks `dataset.config.watch` and returns
  `RAG_WATCH_DISABLED` without invoking `watch()`.
- `WatcherUnavailableError` is exported from the public RAG barrel
  ([src/rag/index.ts](src/rag/index.ts#L1-L14)) and is thrown
  synchronously by `WatcherController.arm()` when `chokidar.watch()`
  throws
  ([src/rag/watcher/controller.ts](src/rag/watcher/controller.ts#L130-L140)).
  F02 catches it on arm and returns `RAG_WATCHER_UNAVAILABLE` (typed
  code distinct from `RAG_INTERNAL`).
- Async `ENOSPC` after a successful arm flips `armed` false inside
  the chokidar handler
  ([src/rag/watcher/controller.ts](src/rag/watcher/controller.ts#L142-L153))
  and logs via the default logger. F02 cannot observe this; the
  watch status map keeps `"armed"` until the next operator action.

## 2. Canonical Tool List

Exactly **seven** tools under service id `rag`:

`rag_list`, `rag_stats`, `rag_query`,
`rag_register`, `rag_ingest`, `rag_drop`,
`rag_admin`.

`rag_admin` multiplexes three control-plane actions: `reconcile`,
`watch_arm`, `watch_disarm`. There is no `delete_record` action and
no `rag_add` tool.

`rag_query` truncates hit text to 2 KB.

## 3. Authorization

### 3.1 Filter delta (presentation)

| Tool             | `READ_ONLY_TOOLS` | `WORKER_EXCLUDED_TOOLS` | Allow-list grant | Net schema visibility |
|------------------|-------------------|--------------------------|------------------|-----------------------|
| `rag_list`       | added             | (unchanged)              | implicit via `READ_ONLY_TOOLS` | every role |
| `rag_stats`      | added             | same                     | same             | every role |
| `rag_query`      | added             | same                     | same             | every role |
| `rag_register`   | (no)              | added                    | no               | none |
| `rag_ingest`     | (no)              | added                    | no               | none |
| `rag_drop`       | (no)              | added                    | no               | none |
| `rag_admin`      | (no)              | added                    | no               | none |

### 3.2 Handler-layer enforcement

```ts
// Initialised by bootstrap; F03 mutates to add "librarian".
const RAG_ADMIN_ROLES = new Set<AgentRole>([]);

if (isMutating(toolName)
    && !isRuntimeOperatorContext(ctx)
    && !RAG_ADMIN_ROLES.has(ctx.role)) {
  return { content: { error: { code: "RAG_UNAUTHORIZED_ROLE",
    message: `role=${ctx.role} cannot ${toolName}` } }, isError: true };
}
```

`isMutating` covers `rag_register`, `rag_ingest`, `rag_drop`,
`rag_admin`. The operator bypass goes through
`isRuntimeOperatorContext` (§1.2) — never via tool args.

### 3.3 Operator path

The CLI (`saivage rag …`) constructs a `ToolCallContext` with
`role: "planner"` and `operatorContext: true`, then calls the
handler directly. The bypass is source-grounded and not reachable
from any in-process agent path.

### 3.4 Protected datasets

Datasets with `source ∈ {"skill", "memory"}` are protected:

- `rag_ingest`, `rag_drop`, `rag_admin` against a protected dataset
  → `RAG_PROTECTED_DATASET`.
- `rag_register` with `source ∈ {"skill", "memory"}` → schema
  rejection. The Zod schema enumerates `source` as `"doc" | "code"`,
  so the envelope is `RAG_INVALID_ARGS` with `details.field:
  "source"`. There is **no `RAG_PROTECTED_SOURCE` code**.
- `rag_list`, `rag_stats`, `rag_query` operate on protected datasets
  freely; the response decorates `protected: true`.

## 4. Tool Schemas

### 4.1 `rag_list`

```ts
input: {}
output: { collections: Array<{ id, source, providerStamp, createdAt, protected }> }
```

### 4.2 `rag_stats`

```ts
input: { collection_id: string }
output: { chunks, files, bytesOnDisk, provider, lastIngestAt, secretsDropped,
          protected, watch: "off" | "armed" }
```

### 4.3 `rag_query`

```ts
input: { collection_id, text, topK?, filter? }
output: { hits: Array<{ chunkId, score, text /* ≤ 2 KB */, metadata }> }
```

Handler calls `manager.query(id, text, { topK, filter })` — the
public signature `query(id: string, text: string, options?:
QueryOptions): Promise<QueryHit[]>`
([src/rag/manager.ts](src/rag/manager.ts#L35-L48)).

### 4.4 `rag_register`

```ts
input: {
  collection_id: string;
  source: "doc" | "code";             // schema enum; skill/memory → RAG_INVALID_ARGS
  provider?: { model, dim };
  chunker: { kind, chunkSize?, overlap? };
  exclusions?: string[];
  sources: [{ root: string; include?: string[]; exclude?: string[] }];  // exactly one
  watch?: false | true | { usePolling: true; interval?: number };       // default false
  persist?: boolean;                  // default false
}
output: { collection, persisted, watch: "off" | "armed", initialIngestReport: IngestReport }
```

Procedure (under `rag.controlMutex`):

1. Validate via Zod. Resolve `sources[0].root` against
   `ctx.projectRoot`; compute realpath and reject containment escape
   via the `path.relative` check in §1.6. Run `shouldSkipPath`. Store
   realpath plus the caller's `include`/`exclude` on the config.
2. If `persist: true`, write config via `saveSaivageConfig` (F02
   adds it; see §6). On failure: `RAG_PERSIST_FAILED`; nothing else
   runs.
3. Push into `rag.datasets` (the mutable array shared with the
   manager). Call `manager.register(newConfig)`. On error, rollback
   the array push and, if applicable, the config write (best-effort).
4. Run `manager.ingest(newConfig.id, { kind: "fs", root:
   sources[0].root, include: sources[0].include, exclude:
   sources[0].exclude })`. The hardened internal walker (§1.6) skips
   symlink-escaping entries silently and logs them; the handler
   receives a normal `IngestReport` over the contained subset.
5. If `watch !== false`, call `dataset.watch()`. Synchronous
   `WatcherUnavailableError` → `RAG_WATCHER_UNAVAILABLE`. Other sync
   errors → `RAG_INTERNAL`.

### 4.5 `rag_ingest`

```ts
input: { collection_id: string }
output: { ingestReport: IngestReport }
```

No caller globs. Protected → `RAG_PROTECTED_DATASET`. The handler
reads `dataset.config.sources[0]` (root, include, exclude) and calls
`manager.ingest(id, { kind: "fs", root, include, exclude })`. The
internal hardened walker enforces containment.

`rag_ingest` is the manual/operator deletion convergence path. Live
watcher `unlink` events also converge deletions (§1.5).
`rag_admin reconcile` does not converge deletions (§1.5).

### 4.6 `rag_drop`

```ts
input: { collection_id: string; persist?: boolean }
output: { dropped: true; persisted: boolean }
```

Protected → `RAG_PROTECTED_DATASET`. Order under
`rag.controlMutex`: persist write first, then `manager.drop(id)`,
then array splice, then watch-status entry deletion.

### 4.7 `rag_admin`

```ts
input:
  | { collection_id, action: "reconcile" }
  | { collection_id, action: "watch_arm" }
  | { collection_id, action: "watch_disarm" }
```

Protected → `RAG_PROTECTED_DATASET`. All actions under
`rag.controlMutex`.

- `reconcile`: `dataset.reconcile()`. Deletion-only sweeps do not
  call ingest (§1.5); returns `{ reconciled: true }` regardless.
- `watch_arm`: pre-check `dataset.config.watch`; if `false`, return
  `RAG_WATCH_DISABLED`. Call `dataset.watch()`. Catch
  `WatcherUnavailableError` → `RAG_WATCHER_UNAVAILABLE`.
- `watch_disarm`: `dataset.unwatch()`; clear status entry.

## 5. Error Envelope and Codes

All errors: `{ content: { error: { code, message, details? } },
isError: true }`.

| Code                          | Trigger |
|-------------------------------|---------|
| `RAG_DISABLED`                | Handler pre-check (`ragService.enabled === false`). |
| `RAG_UNAUTHORIZED_ROLE`       | Handler role check on mutating tool (§3.2). |
| `RAG_INVALID_ARGS`            | Zod validation (includes `source ∈ {skill,memory}` and `sources.length !== 1`). |
| `RAG_DATASET_NOT_FOUND`       | `DatasetNotFoundError`. |
| `RAG_PROTECTED_DATASET`       | Mutating tool against protected source. |
| `RAG_BLOCKED_PATH`            | `shouldSkipPath` rejection at any path encountered by the handler; realpath containment failure at register-time root check. Per-entry walker symlink escapes are logged and skipped, not surfaced as `RAG_BLOCKED_PATH`. |
| `RAG_INVALID_QUERY_FILTER`    | `InvalidQueryFilterError`. |
| `RAG_CONFIG_DRIFT`            | `ConfigDriftError`. |
| `RAG_EMBEDDING_DRIFT`         | `EmbeddingDriftError`. |
| `RAG_CORRUPTED_STORE`         | `CorruptedStoreError`. |
| `RAG_PROVIDER_UNAVAILABLE`    | `ProviderUnavailableError`. |
| `RAG_INGEST_LOCKED`           | `IngestLockedError`. |
| `RAG_WATCH_DISABLED`          | Handler pre-check: `dataset.config.watch === false`. |
| `RAG_WATCHER_UNAVAILABLE`     | Synchronous `WatcherUnavailableError` from arm. |
| `RAG_SECRET_DROPPED`          | Reserved; F02 never emits. Bulk drops surface via `IngestReport.chunksDroppedSecrets`. |
| `RAG_PERSIST_FAILED`          | `saveSaivageConfig` failed; may include `details.rollback`. |
| `RAG_CONTROL_BUSY`            | Contention on `rag.controlMutex`. |
| `RAG_INTERNAL`                | Any other thrown `Error`. |

## 6. Service Construction

[bootstrap.ts](src/server/bootstrap.ts#L150) currently calls
`registerBuiltinServices(mcpRuntime, config.mcp, config.security)`.
F02 extends it:

```ts
import type { DatasetConfig } from "../rag/types.js";

type RuntimeRagDatasetConfig = Omit<DatasetConfig, "projectId">;

const ragDatasets: RuntimeRagDatasetConfig[] = [...config.rag.datasets];
const ragManager = await createRagManager({
  projectRoot,
  projectId: config.projectId,
  enabled: config.rag.enabled,
  datasets: ragDatasets,
  providerOptions: resolveOpenAIProviderOptions(authProfiles),
});
const ragService: RagService = {
  manager: ragManager,
  datasets: ragDatasets,
  watchStatus: new Map<string, "off" | "armed">(),
  controlMutex: createMutex(),
  enabled: config.rag.enabled,
  adminRoles: new Set<AgentRole>([]),
};

registerBuiltinServices(mcpRuntime, config.mcp, config.security, { rag: ragService });
```

The `RuntimeRagDatasetConfig` alias matches
`RagManagerOptions.datasets` and the current config dataset schema
which omits `projectId` ([src/config.ts](src/config.ts#L217-L260),
[src/rag/manager.ts](src/rag/manager.ts#L34-L40)).

F02 also adds `saveSaivageConfig(projectRoot, mutate)` to
[src/config.ts](src/config.ts): a writer that loads the current
config JSON, applies a `mutate` callback, validates against the same
Zod schema as `loadConfig`, and persists atomically (temp + rename).
This is required by `rag_register persist:true` and `rag_drop
persist:true`, and is consumed by F01 boot.

`registerBuiltinServices` gains a fourth options field
`rag: RagService`. The `rag` service is always registered with
`available: true`; every handler runs the `enabled` pre-check first.

## 7. Concurrency

### 7.1 Data plane

- `.ingest.lock` is fail-fast with one stale retry
  ([src/rag/lock.ts](src/rag/lock.ts#L28-L60)). Concurrent ingest on
  the same dataset → `RAG_INGEST_LOCKED`.
- Query and stats do not acquire the ingest lock.

### 7.2 Control plane

`rag_register`, `rag_drop`, `rag_admin` (all three actions) serialise
on `rag.controlMutex`. Contention → `RAG_CONTROL_BUSY`.

### 7.3 Persistence rollback

Register-with-persist order: config write → in-memory array push →
`manager.register` → `manager.ingest` → optional `watch()`. Config
write failure: nothing else runs. Register failure after config
write: rollback config best-effort. Rollback failure:
`RAG_PERSIST_FAILED` with `details.rollback: "failed"`. Ingest/watch
failures after persist: dataset stays registered and persisted
(operator retries).

## 8. Logging

Tool invocation log line via [`log.info`](src/log.ts):
`service=rag tool=<name> role=<ctx.role> agentId=<ctx.agentId>
collection_id=<id>`; on completion `duration_ms=<n> result=<tag>`.

`rag_query.text` is logged by length only.
`IngestReport.chunksDroppedSecrets > 0` produces a `log.warn` line
`rag.secret-drop collection_id=<id> count=<n>`. F02 does not surface
affected paths (the pipeline does not return them).

## 9. Files

| File                                                                     | Action |
|--------------------------------------------------------------------------|--------|
| [src/mcp/toolContext.ts](src/mcp/toolContext.ts#L17-L34)                 | Add optional `operatorContext?: boolean` field. |
| `src/server/rag/service.ts` (new)                                         | Export `RagService` type and `isRuntimeOperatorContext`. |
| `src/server/rag/handler.ts` (new)                                         | Register seven tools; typed envelope; `isMutating` + admin/operator predicate; per-tool implementations. |
| [src/server/bootstrap.ts](src/server/bootstrap.ts#L133-L151)             | Construct `RagManager` (awaited), `RagService`; pass to `registerBuiltinServices`; CLI seam sets `operatorContext: true`. |
| [src/mcp/builtins.ts](src/mcp/builtins.ts#L1912-L1966)                   | Add `rag` option; register the `rag` service. |
| [src/agents/tool-filters.ts](src/agents/tool-filters.ts#L9-L44)          | Extend `READ_ONLY_TOOLS`; extend `WORKER_EXCLUDED_TOOLS`; omit admin tools from every allow-list. |
| [src/rag/walker.ts](src/rag/walker.ts), [src/rag/pipeline.ts](src/rag/pipeline.ts) | Internal hardening: per-entry realpath containment via `path.relative`; preserve exported signatures. |
| [src/config.ts](src/config.ts#L335-L343)                                 | Add `saveSaivageConfig(projectRoot, mutate)`. |
| `src/server/rag/handler.test.ts` (new)                                    | Filter delta; handler authorization (worker hallucinated name → RAG_UNAUTHORIZED_ROLE; operator bypass); protected dataset; envelope shape; per-error mapping. |
| `src/rag/walker.containment.test.ts` (new)                                | Symlink escape rejected at walk time; legitimate symlinks inside project accepted; sibling-prefix root not accepted. |
| `src/server/rag/persist.test.ts` (new)                                    | `saveSaivageConfig` round-trip; rollback on failure. |
| `SPEC/v2/rag/agent-api.md` (new)                                          | Operator-facing tool contract. |

## 10. Non-Goals

- No change to public RAG API exports
  ([src/rag/index.ts](src/rag/index.ts)).
- No new `RAG_PROTECTED_SOURCE` code (uses `RAG_INVALID_ARGS`).
- No `rag_add`, `delete_record`, or extra control actions beyond the
  three listed in §4.7.
- No watcher-logger redirection (FUP-WATCHER-LOG).
- No caller globs on `rag_ingest`.
- No handler-layer post-walk symlink validation (hardening is
  internal; FUP-RAG-SYMLINK).
- No `operatorContext` flag readable from tool args.
