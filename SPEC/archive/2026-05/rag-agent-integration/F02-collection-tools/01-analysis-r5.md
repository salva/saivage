# F02 — Agent-Facing RAG Collection Tools: Functional Analysis

This analysis specifies the MCP tool surface that lets agents and
operators **configure, feed, query, and observe** RAG collections at
runtime. The surface lives under a single MCP service id, `rag`, with
exactly seven tools. It composes the existing public API of
[src/rag/](src/rag/) without changing it.

## 1. Verified Facts

### 1.1 In-process service registration and envelope

[McpRuntime.registerInProcess](src/mcp/runtime.ts#L153-L184) takes
`(name, tools, handler, options?)`. When an in-process service is
registered with `available: false`, `callTool` throws `Service "<name>"
is registered but unavailable` **before** the handler runs; the
handler cannot return a typed envelope. The `rag` service is therefore
**always registered as available**.

Handler success returns `{ content, isError: false }`. Handler failure
returns whatever `content` the implementation chooses; on `isError ===
true`, [McpRuntime.callTool](src/mcp/runtime.ts#L184-L193) JSON-wraps
that content into a thrown `Error` and the caller-side plumbing
decodes it. Existing handlers use varied shapes — typed objects
([src/mcp/knowledgeSkills.ts](src/mcp/knowledgeSkills.ts#L166-L171))
and bare strings
([src/mcp/builtins.ts](src/mcp/builtins.ts#L1876-L1885)). F02's `rag`
handler will use the typed envelope `{ content: { error: { code,
message, details? } }, isError: true }`.

### 1.2 Tool-call context

[ToolCallContext](src/mcp/toolContext.ts#L17-L34) carries
`role: AgentRole` (required), `agentId`, `projectRoot`, optional
`author`, `stageId`, `channelId`, `sessionId`. No `operator` role
exists. Operator invocation goes through the CLI which constructs the
context directly; see §3.2.

### 1.3 Tool filtering — deny-list for workers; presentation-only

[applyToolFilter](src/agents/tool-filters.ts#L31-L44) is keyed on
`ToolFilterKind` and checks `tool.name` only. The filter is consumed
by [BaseAgent](src/agents/base.ts#L662-L668) when building the
**tool schema list shown to the model**. The runtime dispatcher does
**not** re-apply the filter on tool execution: it resolves the name
through the unfiltered `mcpRuntime.getAllTools()` catalog and calls
`mcpRuntime.callTool(...)` directly
([src/runtime/dispatcher.ts](src/runtime/dispatcher.ts#L156-L194)).
The filter is therefore a presentation boundary, **not an
enforcement boundary**.

Consequence: filter changes alone cannot prevent existing roles from
invoking a mutating RAG tool by hallucinating the name. F02 enforces
authorization in two layers:

- **Filter layer (presentation).** Reads added to
  `READ_ONLY_TOOLS`; mutating/admin tools added to
  `WORKER_EXCLUDED_TOOLS` (deny-list per
  [src/agents/tool-filters.ts](src/agents/tool-filters.ts#L24-L34))
  and *omitted* from every allow-list filter. This shapes the
  schemas every role's model sees.
- **Handler layer (enforcement).** The `rag` handler reads
  `ctx.role`. For `rag_register`, `rag_ingest`, `rag_drop`,
  `rag_admin`, the handler short-circuits with
  `RAG_UNAUTHORIZED_ROLE` for every role not in
  `RAG_ADMIN_ROLES`. F02 ships with `RAG_ADMIN_ROLES = new
  Set()` — empty — making the admin tools unreachable from every
  existing role even if the dispatcher is invoked by a stray
  hallucinated name. F03 will add `"librarian"` to this set.

Roster role-filter mapping (from
[src/agents/roster.ts](src/agents/roster.ts#L87-L266)): `planner` →
planner; `manager`, `coder`, `researcher`, `data_agent`, `designer` →
worker (deny-list); `critic`, `reviewer` → reviewer (allow-list);
`inspector` → inspector (allow-list); `chat` → chat (allow-list).

### 1.4 RagManager — runtime registration via mutable datasets array

[createRagManager](src/rag/manager.ts#L87-L88) is **`async` and
returns `Promise<RagManager>`**; all bootstrap call sites must
`await`. The `RagManagerOptions`
([src/rag/manager.ts](src/rag/manager.ts#L34-L40)) shape:

```ts
{ projectRoot: string; projectId: string; enabled: boolean;
  datasets: ReadonlyArray<Omit<DatasetConfig, "projectId">>;
  providerOptions?: OpenAIProviderOptions }
```

`providerOptions` is **optional**.
[OpenAIProviderOptions](src/rag/provider/index.ts#L22-L34) carries
raw OpenAI options (`apiKey`, `baseUrl`, `client`, `batchSize`, retry
settings). F02 provides a private helper
`resolveOpenAIProviderOptions(authProfiles)` inside
[src/server/bootstrap.ts](src/server/bootstrap.ts) — an
implementation detail of bootstrap, **not** a new public RAG export.

When `enabled === false`, `createRagManager` returns a no-op manager
whose methods throw `DatasetNotFoundError`
([src/rag/manager.ts](src/rag/manager.ts#L54-L88)). F02 never relies
on this disabled path: the `rag` handler pre-checks
`ragService.enabled` and returns `RAG_DISABLED` before touching the
manager.

The manager closes over the `opts.datasets` array; `manager.get(id)`
resolves by `opts.datasets.find((d) => d.id === id)`
([src/rag/manager.ts](src/rag/manager.ts#L117-L121)). Pushing a new
`DatasetConfig` into the same array object makes the dataset
discoverable to all of `get`, `ingest`, `query`, `stats`, `drop`.

There is **no watcher-logger option** on `RagManagerOptions` or
`DatasetOpenOptions`
([src/rag/dataset.ts](src/rag/dataset.ts#L59-L61)). Operator-visible
watcher floods and `ENOSPC` go to `console.warn` via the default
`WatcherController` logger; redirecting them requires a public RAG
API change (out of F02 scope, recorded as **FUP-WATCHER-LOG**).

### 1.5 Snapshot ingest semantics; one-root rule

[runIngest](src/rag/pipeline.ts#L168-L290) treats supplied items as
the complete seen set
([src/rag/pipeline.ts](src/rag/pipeline.ts#L177-L188)) and deletes
every prior `file_state` path absent from the current input
([src/rag/pipeline.ts](src/rag/pipeline.ts#L276-L288)).
[IngestInput](src/rag/types.ts#L120-L126) for `kind: "fs"` accepts
**one** root per call.

Consequences for F02:

- **Each `fs` dataset is constrained to exactly one source root**,
  set at registration time and stored on `DatasetConfig.sources[0]`.
  `rag_register` rejects `sources.length !== 1`.
- **`rag_ingest` derives its root from the dataset config.** It does
  not accept a caller-supplied root. The handler reads
  `dataset.config.sources[0]` and passes it to `manager.ingest`. This
  closes the destructive-purge attack vector identified in the prior
  iteration: a caller cannot point `rag_ingest` at a subdirectory or
  sibling and purge unrelated chunks. Caller-supplied `include` and
  `exclude` glob arrays *are* accepted (they cannot break snapshot
  semantics because the walker still walks the same registered root,
  and `seenPaths` is computed from the actual walk).
- **`rag_ingest` over the dataset's registered root is the only
  deletion convergence path.** Re-walking won't see deleted files,
  and the snapshot rule purges their chunks.
- **`rag_admin reconcile` is not a deletion path.**
  [WatcherController.reconcile](src/rag/watcher/controller.ts#L72-L93)
  does not take the `changedPaths.concat(removedPaths)` early-return
  for deletion-only results, but the per-root ingest loop filters on
  `result.changedPaths` and continues past roots with no changed
  paths
  ([src/rag/watcher/controller.ts](src/rag/watcher/controller.ts#L87-L93)).
  So a deletion-only reconcile **does not call ingest** and does not
  purge chunks. F02 documents `rag_ingest` as the deletion
  convergence call.

### 1.6 Path containment and secret guards

- [shouldSkipPath](src/rag/security/secrets.ts#L59-L64) is a
  secret-path predicate (matches names like `.env`, `auth-profiles.json`,
  `credentials.json`). It is **not** a containment check.
- [scanChunk](src/rag/security/secrets.ts#L71) scans per-chunk
  content during ingest.
- The RAG walker [src/rag/walker.ts](src/rag/walker.ts#L6-L10)
  **follows symlinks**; `fs.stat(abs)` on a symlinked subdirectory
  recurses into it
  ([src/rag/walker.ts](src/rag/walker.ts#L55-L69). A symlink inside
  the configured root pointing outside the project can therefore
  ingest external files.

F02 therefore enforces **explicit containment** at the handler:

1. Resolve `sources[0].root` to `realpath` at `rag_register` time.
   Reject (`RAG_BLOCKED_PATH`) if the realpath does not start with
   `realpath(ctx.projectRoot)`. Store the realpath on the dataset
   config.
2. After the walker returns its `WalkedFile[]`, the handler
   post-validates: for every walked file, compute its `realpath` and
   reject the entire ingest with `RAG_BLOCKED_PATH` if any path
   escapes `realpath(ctx.projectRoot)`. This is implemented as a
   `validateContainment(items, projectRealpath)` step in the handler
   that runs *before* the manager's ingest call.
3. `shouldSkipPath` is still applied per-path to drop secret files.

The realpath-based containment is documented as an F02-layer
requirement, not a RAG-layer change. **FUP-RAG-SYMLINK** is recorded
to add native containment inside the walker.

### 1.7 Watcher error mapping

- `Dataset.watch()` throws a plain `Error` when watch is disabled
  ([src/rag/dataset.ts](src/rag/dataset.ts#L149-L153)). The `rag`
  handler pre-checks `dataset.config.watch` and returns
  `RAG_WATCH_DISABLED` without invoking `watch()`.
- `WatcherUnavailableError` *is* exported from the public RAG barrel
  ([src/rag/index.ts](src/rag/index.ts#L1-L14)) and is thrown
  synchronously by `WatcherController.arm()` when `chokidar.watch()`
  throws
  ([src/rag/watcher/controller.ts](src/rag/watcher/controller.ts#L130-L140)).
  F02 catches `WatcherUnavailableError` on arm and returns
  `RAG_WATCHER_UNAVAILABLE` (typed code distinct from
  `RAG_INTERNAL`).
- Async `ENOSPC` after a successful arm flips `armed` false inside
  the chokidar handler
  ([src/rag/watcher/controller.ts](src/rag/watcher/controller.ts#L142-L153))
  and logs via the default logger. F02 cannot observe this; the
  watch status map keeps `"armed"` until the next operator action.
  This is a known gap.

## 2. Canonical Tool List

Exactly **seven** tools under service id `rag`:

`rag_list`, `rag_stats`, `rag_query`,
`rag_register`, `rag_ingest`, `rag_drop`,
`rag_admin`.

`rag_admin` multiplexes three control-plane actions: `reconcile`,
`watch_arm`, `watch_disarm`. There is no `delete_record` action and
no `rag_add` tool.

`rag_query` truncates hit text to 2 KB. Full text is not recoverable
through F02; callers needing source content use `read_file` on the
path returned in hit `metadata.path`.

## 3. Authorization

### 3.1 Filter delta (presentation)

| Tool             | `READ_ONLY_TOOLS` | `WORKER_EXCLUDED_TOOLS` | Allow-list grant | Net schema visibility |
|------------------|-------------------|--------------------------|------------------|-----------------------|
| `rag_list`       | added             | (unchanged)              | added to planner/reviewer/inspector/chat allow-lists implicitly via `READ_ONLY_TOOLS` membership | every role |
| `rag_stats`      | added             | same                     | same             | every role |
| `rag_query`      | added             | same                     | same             | every role |
| `rag_register`   | (no)              | added                    | no               | none |
| `rag_ingest`     | (no)              | added                    | no               | none |
| `rag_drop`       | (no)              | added                    | no               | none |
| `rag_admin`      | (no)              | added                    | no               | none |

The worker filter is deny-list
([src/agents/tool-filters.ts](src/agents/tool-filters.ts#L34)), so
adding to `WORKER_EXCLUDED_TOOLS` is the only way to remove a name
from manager/coder/researcher/data_agent/designer schemas.

### 3.2 Handler-layer enforcement

The `rag` handler reads `ctx.role` as its first action after
`RAG_DISABLED` check:

```ts
const RAG_ADMIN_ROLES = new Set<AgentRole>([]);   // F03 adds "librarian"
if (isMutating(toolName) && !RAG_ADMIN_ROLES.has(ctx.role)) {
  return { content: { error: { code: "RAG_UNAUTHORIZED_ROLE",
    message: `role=${ctx.role} cannot ${toolName}` } }, isError: true };
}
```

`isMutating` covers `rag_register`, `rag_ingest`, `rag_drop`,
`rag_admin`. This makes role authorization source-enforced regardless
of the dispatcher path.

### 3.3 Operator path

Operator invocation is via the CLI (`saivage rag …`). The CLI
constructs a `ToolCallContext` with `role: "planner"` and calls the
handler directly, bypassing the model-facing filter. The operator
CLI is allowed by configuration to bypass `RAG_ADMIN_ROLES`: it
passes a private flag through `ctx` (e.g. `ctx.operator === true`)
that the handler honours. The flag is **not settable** by any
in-process agent path because `ctx` is constructed by the runtime.

### 3.4 Protected datasets

Datasets with `source ∈ {"skill", "memory"}` are protected.

- `rag_ingest`, `rag_drop`, `rag_admin` against a protected dataset
  → `RAG_PROTECTED_DATASET`.
- `rag_register` with `source ∈ {"skill", "memory"}` → schema
  rejection. The Zod schema enumerates `source` as `"doc" | "code"`,
  so the envelope is `RAG_INVALID_ARGS` with
  `details.field: "source"`. There is **no `RAG_PROTECTED_SOURCE`
  code**.
- `rag_list`, `rag_stats`, `rag_query` operate on protected datasets
  freely; the response decorates `protected: true`.

## 4. Tool Schemas

### 4.1 `rag_list`

```ts
input: {}
output: { collections: Array<{ id, source, providerStamp, createdAt, protected }> }
```

Returns `manager.list()` decorated with `protected`.

### 4.2 `rag_stats`

```ts
input: { collection_id: string }
output: { chunks, files, bytesOnDisk, provider, lastIngestAt, secretsDropped,
          protected, watch: "off" | "armed" }
```

`watch` is read from the per-id status map maintained by the `rag`
service.

### 4.3 `rag_query`

```ts
input: { collection_id, text, topK?, filter? }
output: { hits: Array<{ chunkId, score, text /* ≤ 2 KB */, metadata }> }
```

Handler calls `manager.query(id, text, { topK, filter })` — the
public signature is `query(id: string, text: string, options?:
QueryOptions): Promise<QueryHit[]>`
([src/rag/manager.ts](src/rag/manager.ts#L35-L48)). The hit type is
`QueryHit` ([src/rag/query/pipeline.ts](src/rag/query/pipeline.ts#L18-L34));
F02 surfaces `{ chunkId, score, text (truncated), metadata }`.

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
   `ctx.projectRoot`; compute `realpath` and reject containment
   escape with `RAG_BLOCKED_PATH`. Run `shouldSkipPath`. Store
   realpath on the config.
2. If `persist: true`, write config via `saveSaivageConfig`. On
   failure: `RAG_PERSIST_FAILED`; nothing else runs.
3. Push into `rag.datasets` (the mutable array shared with the
   manager). Call `manager.register(newConfig)`. On error, rollback
   the array push and, if applicable, the config write
   (best-effort).
4. Run `manager.ingest(newConfig.id, { kind: "fs", root: sources[0].root,
   include, exclude })`. After the walker returns its `WalkedFile[]`,
   the handler post-validates symlink containment (§1.6); failure →
   `RAG_BLOCKED_PATH`.
5. If `watch !== false`, call `dataset.watch()`. Synchronous
   `WatcherUnavailableError` → `RAG_WATCHER_UNAVAILABLE`. Other
   sync errors → `RAG_INTERNAL`.

### 4.5 `rag_ingest`

```ts
input: { collection_id: string; include?: string[]; exclude?: string[] }
output: { ingestReport: IngestReport }
```

Protected → `RAG_PROTECTED_DATASET`. The handler reads
`dataset.config.sources[0].root` (the realpath stored at registration
time). Caller-supplied `include` / `exclude` are merged with the
configured globs. Walker output is post-validated against project
realpath. `manager.ingest(id, { kind: "fs", root, include, exclude })`
is called.

**`rag_ingest` is the deletion convergence path.** Operators wanting
to drop a single file from an `fs` dataset delete the file on disk
and run `rag_ingest`; the pipeline's snapshot rule purges its chunks.

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

- `reconcile`: `dataset.reconcile()`. The watcher's per-root loop
  filters on `changedPaths` only
  ([src/rag/watcher/controller.ts](src/rag/watcher/controller.ts#L87-L93)),
  so deletion-only results do **not** call ingest and do not purge
  chunks. The action returns `{ reconciled: true }` regardless.
- `watch_arm`: pre-check `dataset.config.watch`; if `false`, return
  `RAG_WATCH_DISABLED`. Call `dataset.watch()`. Catch
  `WatcherUnavailableError` → `RAG_WATCHER_UNAVAILABLE`.
- `watch_disarm`: `dataset.unwatch()`; clear status entry.

## 5. Error Envelope and Codes

All errors: `{ content: { error: { code, message, details? } }, isError: true }`.

| Code                          | Trigger |
|-------------------------------|---------|
| `RAG_DISABLED`                | Handler pre-check (`ragService.enabled === false`). |
| `RAG_UNAUTHORIZED_ROLE`       | Handler role check on mutating tool. |
| `RAG_INVALID_ARGS`            | Zod validation (includes `source ∈ {skill,memory}` and `sources.length !== 1`). |
| `RAG_DATASET_NOT_FOUND`       | `DatasetNotFoundError`. |
| `RAG_PROTECTED_DATASET`       | Mutating tool against protected source. |
| `RAG_BLOCKED_PATH`            | `shouldSkipPath` rejection; or realpath containment failure (register or post-walk). |
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
const ragDatasets: DatasetConfig[] = [...config.rag.datasets];        // mutable
const ragManager = await createRagManager({
  projectRoot,
  projectId: config.projectId,
  enabled: config.rag.enabled,
  datasets: ragDatasets,
  providerOptions: resolveOpenAIProviderOptions(authProfiles),        // optional; private bootstrap helper
});
const ragService: RagService = {
  manager: ragManager,
  datasets: ragDatasets,
  watchStatus: new Map<string, "off" | "armed">(),
  controlMutex: createMutex(),
  enabled: config.rag.enabled,
  adminRoles: new Set<AgentRole>([]),                                  // F03 mutates
};

registerBuiltinServices(mcpRuntime, config.mcp, config.security, { rag: ragService });
```

`registerBuiltinServices` gains a fourth options field `rag:
RagService`. The `rag` service is **always registered with
`available: true`**; every handler runs the `enabled` pre-check first.

Tests inject a fake `RagService` with the same shape.

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
`manager.register` → `manager.ingest` (walker + containment
post-validation) → optional `watch()`. Config write failure: nothing
else runs. Register failure after config write: rollback config
best-effort. Rollback failure: `RAG_PERSIST_FAILED` with
`details.rollback: "failed"`. Ingest/watch failures after persist:
dataset stays registered and persisted (operator retries).

## 8. Logging

Tool invocation log line via [`log.info`](src/log.ts):
`service=rag tool=<name> role=<ctx.role> agentId=<ctx.agentId>
collection_id=<id>`; on completion `duration_ms=<n> result=<tag>` where
tag is `ok`, error code, or `chunksUpserted=<n>`.

`rag_query.text` is logged by length only.
`IngestReport.chunksDroppedSecrets > 0` produces a `log.warn` line
prefixed `rag.secret-drop` with `collection_id=<id> count=<n>`. F02
does not surface affected paths (the pipeline does not return them).

Chokidar floods and async `ENOSPC` go to `console.warn` via the
default `WatcherController` logger.

## 9. Path/Secret Guards

- Every path argument resolved against `ctx.projectRoot` then
  realpath-contained against `realpath(ctx.projectRoot)` (§1.6).
- `shouldSkipPath` applied per-path to drop secret files.
- Per-chunk content scanning by `scanChunk` inside the pipeline.
- Post-walk containment re-validation rejects any symlinked file
  outside `realpath(ctx.projectRoot)`.
- `rag_query.text` is not scanned for secrets; the embedding
  provider call is gated by the operator's outbound policy. F02
  records the call by length only.

## 10. Files

| File                                                                                | Action |
|-------------------------------------------------------------------------------------|--------|
| `src/mcp/rag.ts` (new)                                                              | Seven tool schemas + handler + `RagService` type + role-enforcement layer. |
| [src/mcp/builtins.ts](src/mcp/builtins.ts#L1912-L1971)                              | Extend `registerBuiltinServices` signature with `rag: RagService`; always-available registration. |
| [src/server/bootstrap.ts](src/server/bootstrap.ts#L150)                             | `await createRagManager`; build `RagService`; pass through. Private `resolveOpenAIProviderOptions` helper here. |
| [src/config.ts](src/config.ts)                                                      | Add `saveSaivageConfig(projectRoot, mutator)`: atomic temp-file write + rename under `.saivage/.config.lock`. |
| [src/agents/tool-filters.ts](src/agents/tool-filters.ts#L12-L27)                    | Add three read tools to `READ_ONLY_TOOLS`; add four mutating/admin tools to `WORKER_EXCLUDED_TOOLS`. |
| `src/mcp/rag.test.ts` (new)                                                         | Schema validation, envelope shape, filter delta, role-enforcement (handler-side `RAG_UNAUTHORIZED_ROLE` reachable by every existing role), protected gates, dynamic register→ingest→query→drop, control-mutex contention, persist rollback, watch arm/disarm/disabled, symlink containment rejection at register and post-walk, deletion-by-ingest. |
| `src/mcp/rag.integration.test.ts` (new)                                             | End-to-end with sqlite-vec store. |
| `src/config.test.ts`                                                                | Cover `saveSaivageConfig` atomicity and concurrent contention. |
| `SPEC/v2/rag/agent-tools.md` (new)                                                  | Operator-facing summary. |

## 11. Internal Consistency

- Seven tools throughout (§2, §3.1, §4, §5, §10).
- Two-layer authorization (§1.3 + §3.2) — filter for presentation,
  handler for enforcement.
- One source root per dataset; `rag_ingest` reads from config, not
  caller (§1.5, §4.5).
- Realpath containment at both register and post-walk (§1.6, §9).
- Watcher error mapping distinguishes `RAG_WATCH_DISABLED`,
  `RAG_WATCHER_UNAVAILABLE`, async `ENOSPC` (limitation), and
  `RAG_INTERNAL` (§1.7, §4.4, §4.7, §5).
- `createRagManager` is awaited; `providerOptions` is optional (§1.4,
  §6).
- Error envelope is `{ content: { error: { code, message, details? } },
  isError: true }` for F02's own handler; runtime wraps arbitrary
  handler content on `isError` per `McpRuntime.callTool` (§1.1).
- No public RAG API change anywhere in the doc; FUPs recorded for
  symlink walker hardening and watcher logger seam.
