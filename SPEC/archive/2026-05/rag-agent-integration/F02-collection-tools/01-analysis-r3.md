# F02 — Agent-Facing RAG Collection Tools: Functional Analysis

This analysis specifies the MCP tool surface that lets agents
**configure, feed, query, and observe** RAG collections at runtime. The
surface lives under a single MCP service id, `rag`, with exactly seven
tools, and composes the existing public API of [src/rag/](src/rag/)
without changing it.

## 1. Verified MCP and RAG Facts

### 1.1 In-process service registration

[McpRuntime.registerInProcess](src/mcp/runtime.ts#L153-L162) takes
`(name, tools, handler, options?)`. Each handler returns
`{ content, isError }`. By convention used by every existing
in-process handler (e.g.
[src/mcp/builtins.ts](src/mcp/builtins.ts#L1958-L1964)), an error is
expressed as `{ content: { error: { code, message, details? } }, isError: true }`.
[McpRuntime.callTool](src/mcp/runtime.ts#L184-L203) then throws a
`JSON.stringify`-wrapped `Error` so caller-side tool plumbing can
recover the envelope. This document uses this exact shape everywhere.

### 1.2 Tool-call context

[ToolCallContext](src/mcp/toolContext.ts#L17-L34) carries:
`role: AgentRole`, `agentId`, `projectRoot`, optional `author`,
`stageId`, `channelId`, `sessionId`. `role` is **required** and typed
as `AgentRole`. There is no `operator` role and no nullable `role`.
Operator-only tools are not reachable from agents at all (see §3.2).

### 1.3 Per-agent tool filtering

[applyToolFilter](src/agents/tool-filters.ts#L31-L44) is keyed on
`ToolFilterKind` and inspects only `tool.name`. Today there are five
kinds: `planner`, `worker`, `reviewer`, `inspector`, `chat`. F02 adds
new tool **names** to `READ_ONLY_TOOLS` only; the new mutating and
admin tools are placed in **no** existing filter, so no agent role
can call them in v2-base. A future Librarian filter (F03) adds the
mutating tools to a new filter kind.

### 1.4 RagManager surface (verified)

[createRagManager](src/rag/manager.ts#L42-L51) returns an object whose
`get`, `ingest`, `query`, `stats`, `drop` all resolve a dataset by
`opts.datasets.find((d) => d.id === id)`
([src/rag/manager.ts](src/rag/manager.ts#L117-L121)). `list` reads
the on-disk registry. `register` opens the dataset, writes a registry
entry, and returns a `Dataset`. There is **no save-config helper in
[src/config.ts](src/config.ts)** — only `loadConfig` and path helpers
exist.

The implication: **adding a dataset to the live manager requires
either mutating the same `opts.datasets` array passed at construction,
or recreating the manager.** The first path is supported because
`opts.datasets.find(...)` is re-evaluated on every call, so pushing a
new `DatasetConfig` into the array makes it discoverable. This is the
only feasible runtime-register path with the fixed RAG API.

### 1.5 IngestInput and snapshot semantics

[runIngest](src/rag/pipeline.ts#L168-L290) treats the supplied items
(both `fs` and `records` modes) as the **complete seen set** for that
call. After processing changed items, it deletes every prior
`file_state` path not present in the current input
([src/rag/pipeline.ts](src/rag/pipeline.ts#L276-L288)). A single
records ingest with one item therefore deletes every other record in
the dataset.

This makes the empty-record-text idea for single-record deletion
**not usable** at the F02 layer. F02 does not expose a
single-record-delete tool; per-record deletion is owned by F01 for
protected datasets (which holds the canonical record snapshot in its
sidecar and re-ingests the full collection), and by `rag_admin
action: "reconcile"` on `fs` datasets (after the operator removes the
file). See §4.7.

### 1.6 Source field is not load-bearing

[buildRecordItems](src/rag/pipeline.ts#L108-L134) drops
`ChunkMetadataInput.source`; the canonical source written on each
chunk is computed by `inferSource(path)` unless
`metadataOverlay.scope === "memory"`
([src/rag/pipeline.ts](src/rag/pipeline.ts#L197)). F02 does not rely
on `metadata.source`. Datasets are partitioned by `id`, and queries
discriminate by `collection_id` and optional `pathGlob`.

### 1.7 Path/secret guards

The canonical guards are
[shouldSkipPath](src/rag/security/secrets.ts#L59) for path-shaped
arguments and [scanChunk](src/rag/security/secrets.ts#L71) for text
content. `isBlockedPath` is an internal helper called by
`shouldSkipPath`. F02 handlers call `shouldSkipPath` only.

### 1.8 Watcher controls

[Dataset.watch](src/rag/dataset.ts#L149-L173) arms the watcher;
`dataset.unwatch()` disarms; `dataset.reconcile()` returns
`Promise<void>`. `Dataset.open` does **not** arm a watcher.
[WatcherController](src/rag/watcher/controller.ts) logs floods and
async chokidar errors to its injected logger; F02 supplies the shared
`log` singleton at manager construction so floods and `ENOSPC` reach
the operator log without changing RAG code.

## 2. Canonical Tool List

Exactly **seven** tools under service id `rag`:

`rag_list`, `rag_stats`, `rag_query`,
`rag_register`, `rag_ingest`, `rag_drop`,
`rag_admin`.

`rag_admin` multiplexes three non-destructive control-plane actions
plus none-otherwise: `reconcile`, `watch_arm`, `watch_disarm`.
`rag_drop` is the only collection-deletion tool; it is **not** under
`rag_admin`.

There is no `rag_add` and no `delete_record` action in the v2-base
surface. Adding individual records is only safe when the collection's
sidecar holds an authoritative snapshot, which is the F01 domain.
Removing individual records from an `fs` dataset is done by deleting
the underlying file and running `rag_admin action: "reconcile"`.

`rag_query` truncates hit text to 2 KB. Full text is not recoverable
through any F02 tool; callers needing the source file read it with
`read_file` after resolving the path from hit `metadata.path` against
`ctx.projectRoot`.

## 3. Authorization

### 3.1 Default role grants

| Tool             | Filter set membership                                               |
|------------------|----------------------------------------------------------------------|
| `rag_list`       | Added to `READ_ONLY_TOOLS`.                                          |
| `rag_stats`      | Added to `READ_ONLY_TOOLS`.                                          |
| `rag_query`      | Added to `READ_ONLY_TOOLS`.                                          |
| `rag_register`   | None.                                                                |
| `rag_ingest`     | None.                                                                |
| `rag_drop`       | None.                                                                |
| `rag_admin`      | None.                                                                |

All existing roles (`planner`, `manager`, `coder`, `researcher`,
`data_agent`, `inspector`, `reviewer`, `designer`, `critic`, `chat`)
gain read access through `READ_ONLY_TOOLS`. None gain write or admin
access until the Librarian filter is added by F03.

### 3.2 Operator path

Operators invoke RAG control through CLI subcommands (e.g.
`saivage rag register …`, `saivage rag ingest …`). The CLI calls the
same F02 handler functions directly with a synthesised
`ToolCallContext` whose `role` is set to a configured admin role
(default `planner`, the most-privileged today). The filter never gates
the CLI because the CLI calls the handlers, not the runtime's
`callTool`. This is the only operator path; no new pseudo-role is
introduced.

### 3.3 Protected datasets

Datasets with `source ∈ {"skill", "memory"}` are protected. The
mutating tools (`rag_register` if `id` already exists with protected
source, `rag_ingest`, `rag_drop`, `rag_admin`) return
`{ error: { code: "RAG_PROTECTED_DATASET" } }`. `rag_register`
additionally rejects `source: "skill" | "memory"` in the input with
`RAG_PROTECTED_SOURCE`. The read tools (`rag_list`, `rag_stats`,
`rag_query`) operate freely on protected datasets, returning raw
`QueryHit[]` without F01 sidecar hydration.

## 4. Tool Schemas and Handler Behaviour

### 4.1 `rag_list`

```ts
input: {}
output: {
  collections: Array<{
    id: string;
    source: "skill" | "memory" | "doc" | "code";
    providerStamp: { provider: string; model: string; dim: number; releaseFingerprint: string };
    createdAt: string;
    protected: boolean;
  }>;
}
```

Returns `manager.list()` decorated with `protected = source ∈ {skill,memory}`.

### 4.2 `rag_stats`

```ts
input: { collection_id: string }
output: {
  chunks: number; files: number; bytesOnDisk: number;
  provider: { provider: string; model: string; dim: number; releaseFingerprint: string };
  lastIngestAt: string | null;
  secretsDropped: number;
  protected: boolean;
  watch: "off" | "armed" | "unavailable";
}
```

`watch` is read from a per-id `Map<id, WatchStatus>` maintained by the
`rag` service: `"off"` if never armed in this process; `"armed"` if
`rag_admin watch_arm` or `rag_register {watch:true|polling}` succeeded;
`"unavailable"` if a watcher arm threw `WatcherUnavailableError`.

### 4.3 `rag_query`

```ts
input: {
  collection_id: string;
  text: string;            // length checked, no pre-scan (the query is not stored)
  topK?: number;           // 1..50, default 10
  filter?: QueryFilter;    // pass-through; supports eq|and|or|gt|lt|pathGlob|in
}
output: {
  hits: Array<{
    chunkId: string;
    score: number;
    text: string;          // truncated to 2 KB
    metadata: ChunkMetadata;
  }>;
}
```

Empty result is `{ hits: [] }`, never an error.

### 4.4 `rag_register`

```ts
input: {
  collection_id: string;
  source: "doc" | "code";          // "skill" | "memory" → RAG_PROTECTED_SOURCE
  provider?: { model: "text-embedding-3-small"; dim: 256 | 512 | 1024 | 1536 };
  chunker: { kind: "markdown" | "code" | "memory"; chunkSize?: number; overlap?: number };
  exclusions?: string[];
  sources?: Array<{ root: string; include?: string[]; exclude?: string[] }>;
  watch?: false | true | { usePolling: true; interval?: number };
  persist?: boolean;               // default false
}
output: {
  collection: {
    id: string;
    source: "doc" | "code";
    providerStamp: { provider: string; model: string; dim: number; releaseFingerprint: string };
    createdAt: string;
    protected: false;
  };
  persisted: boolean;
  watch: "off" | "armed" | "unavailable";
  initialIngestReport: IngestReport | null;
}
```

Handler procedure (atomic at the F02 layer, single internal mutex
`rag.controlMutex` covers all of `rag_register`, `rag_drop`,
`rag_admin watch_*`, and `rag_admin reconcile` to keep registry,
manager, and config in agreement):

1. Validate `source ∈ {doc, code}`. Validate each `sources[].root` is
   inside `ctx.projectRoot` and passes `shouldSkipPath`. Reject with
   `RAG_PROTECTED_SOURCE` / `RAG_BLOCKED_PATH` on failure.
2. If `persist: true`, write the new entry into
   `<projectRoot>/.saivage/saivage.json` via the new helper
   `saveSaivageConfig(projectRoot, mutator)`
   (added to [src/config.ts](src/config.ts) — see §10). On failure
   return `RAG_PERSIST_FAILED`, **do not** mutate the runtime
   datasets array.
3. Push the `DatasetConfig` into the mutable
   `rag.dynamicDatasets` array (the same array passed to
   `createRagManager` at bootstrap). Call `manager.register(config)`.
   On thrown drift errors, return the typed envelope; on success,
   record the dataset id in the per-process `dynamicDatasets` set.
4. If `sources` is non-empty, immediately run
   `manager.ingest(id, { kind: "fs", root: sources[0].root, include: sources[0].include ?? ["**/*"], exclude: sources[0].exclude })`
   for each entry in `sources`; aggregate the reports as
   `initialIngestReport`. Lock contention or provider failure surfaces
   as the matching error envelope and the dataset stays registered
   (the operator may retry ingest).
5. If `watch !== false`, fetch the dataset via `manager.get(id)` and
   call `dataset.watch()` with polling options when supplied. On
   `WatcherUnavailableError`, set `watch: "unavailable"` in both the
   per-id status map and the response; do not error.

Persistence is atomic with respect to runtime registration: if
`persist: true` and the disk write fails, the runtime is not touched.
If runtime register fails after persistence succeeds, the config write
is rolled back by re-loading the prior config and rewriting it.

### 4.5 `rag_ingest`

```ts
input: {
  collection_id: string;
  source: { root: string; include: string[]; exclude?: string[] };
}
output: { ingestReport: IngestReport }
```

Protected dataset → `RAG_PROTECTED_DATASET`. `root` is resolved
against `ctx.projectRoot`, must not escape it, and must pass
`shouldSkipPath`. Calls `manager.ingest(id, { kind: "fs", ...source })`.

This is the only public way for F02 callers to load content. Records
ingest is reserved for F01.

### 4.6 `rag_drop`

```ts
input: { collection_id: string; persist?: boolean }
output: { dropped: true; persisted: boolean }
```

Protected → `RAG_PROTECTED_DATASET`. Order:

1. Acquire `rag.controlMutex`.
2. If `persist: true`, rewrite `saivage.json` removing the dataset
   entry. `RAG_PERSIST_FAILED` on write failure; runtime state
   untouched.
3. Call `manager.drop(id)`; remove from `rag.dynamicDatasets`; clear
   the per-id watch status. The watcher is unarmed by `Dataset.drop`
   internally (via `WatcherController.dispose` chain).

### 4.7 `rag_admin`

```ts
input:
  | { collection_id: string; action: "reconcile" }
  | { collection_id: string; action: "watch_arm" }
  | { collection_id: string; action: "watch_disarm" }
output:
  | { reconciled: true }
  | { watch_armed: true; watch: "armed" | "unavailable" }
  | { watch_disarmed: true }
```

Protected → `RAG_PROTECTED_DATASET`. All actions acquire
`rag.controlMutex`. `reconcile` calls `dataset.reconcile()`.
`watch_arm` calls `dataset.watch()` and updates the per-id watch
status; catches `WatcherUnavailableError` and returns
`watch: "unavailable"`. `watch_disarm` calls `dataset.unwatch()`.

There is no `delete_record` action because the pipeline's full-snapshot
semantics make safe single-record deletion impossible through the
public records ingest. Operators wanting to drop a single file from an
`fs` dataset delete the file on disk and run `reconcile`.

## 5. Error Envelope

Every error is `{ content: { error: { code, message, details? } }, isError: true }`.

| Code                          | Trigger                                                                                                              |
|-------------------------------|-----------------------------------------------------------------------------------------------------------------------|
| `RAG_DISABLED`                | `config.rag.enabled === false`. Checked at the top of every handler.                                                  |
| `RAG_INVALID_ARGS`            | Zod schema validation failed.                                                                                         |
| `RAG_DATASET_NOT_FOUND`       | `DatasetNotFoundError` from manager.                                                                                  |
| `RAG_PROTECTED_DATASET`       | Mutating tool against `source ∈ {skill, memory}`.                                                                     |
| `RAG_PROTECTED_SOURCE`        | `rag_register` invoked with `source ∈ {skill, memory}`.                                                               |
| `RAG_BLOCKED_PATH`            | `shouldSkipPath` rejected a path argument; or directory ingest root escapes project root.                            |
| `RAG_INVALID_QUERY_FILTER`    | `InvalidQueryFilterError`.                                                                                            |
| `RAG_CONFIG_DRIFT`            | `ConfigDriftError`.                                                                                                   |
| `RAG_EMBEDDING_DRIFT`         | `EmbeddingDriftError`.                                                                                                |
| `RAG_CORRUPTED_STORE`         | `CorruptedStoreError`.                                                                                                |
| `RAG_PROVIDER_UNAVAILABLE`    | `ProviderUnavailableError`.                                                                                           |
| `RAG_INGEST_LOCKED`           | `IngestLockedError`.                                                                                                  |
| `RAG_WATCH_DISABLED`          | `dataset.watch()` thrown because `config.watch === false`.                                                            |
| `RAG_WATCHER_UNAVAILABLE`     | Surfaced only by `rag_stats.watch === "unavailable"`. `rag_register` and `rag_admin watch_arm` succeed with the status; they do not error. |
| `RAG_SECRET_DROPPED`          | Reserved. F02 never emits this; bulk drops are surfaced via `IngestReport.chunksDroppedSecrets`.                      |
| `RAG_PERSIST_FAILED`          | `persist: true` could not write `saivage.json`. Runtime state is **not** mutated when persistence is requested and fails. |
| `RAG_CONTROL_BUSY`            | A second control-plane action (`register`/`drop`/`watch_*`/`reconcile`) attempted while `controlMutex` is held. Caller retries. |
| `RAG_INTERNAL`                | Any other thrown `Error`. The message is the error's `.message`; stack is omitted.                                    |

## 6. Service Construction

[bootstrap.ts](src/server/bootstrap.ts#L150) currently calls
`registerBuiltinServices(mcpRuntime, config.mcp, config.security)`. F02
extends the signature with the RAG dependency:

```ts
registerBuiltinServices(
  mcpRuntime,
  config.mcp,
  config.security,
  { /* existing options */ rag: ragService },
);
```

where `ragService` is constructed in bootstrap from
`config.rag`:

```ts
const ragManager = createRagManager({
  projectRoot,
  projectId: config.projectId,
  datasets: [...config.rag.datasets],   // mutable array — used as dynamicDatasets
  providerOptions: resolveOpenAIProviderOptions(authProfiles),
  watcherLogger: log,
});
const ragService: RagService = {
  manager: ragManager,
  dynamicDatasets,           // the same array
  watchStatus: new Map<string, "off" | "armed" | "unavailable">(),
  controlMutex: createMutex(),
  enabled: config.rag.enabled,
};
```

When `config.rag.enabled === false`, the service is registered with
`available: false`, so every tool call returns the stub-handler error.
The handler itself short-circuits with `RAG_DISABLED` envelope before
delegating, so the stub error wrapper never fires; this keeps the
error code consistent with this spec.

The watcher logger is passed through to dataset open; chokidar floods
and `ENOSPC` events go to `log.warn` instead of `console.warn`.

Tests inject a fake `RagService` (struct of the same shape) into
`registerBuiltinServices` — no public RAG API change is needed.

## 7. Concurrency

### 7.1 Data plane (`rag_ingest`, `rag_query`, `rag_stats`, `rag_list`)

- Per-dataset ingest lock is the fail-fast
  [`.ingest.lock`](src/rag/lock.ts#L28). Concurrent `rag_ingest` on
  the same dataset → `RAG_INGEST_LOCKED`. Same applies if a
  watcher-driven reconcile is in flight.
- Query and stats do not acquire the ingest lock; mid-batch reads may
  see partially-committed chunks. Acceptable.
- `rag_list` reads the registry file.

### 7.2 Control plane (`rag_register`, `rag_drop`, `rag_admin`)

All four serialise on the in-process `rag.controlMutex`. Contention →
`RAG_CONTROL_BUSY`. This eliminates the register/drop race the
manager does not guard against. Persistence (config write) happens
inside the mutex so registry, runtime, and config converge atomically.

### 7.3 Persistence rollback

`rag_register` with `persist: true` order: write config → register
runtime → ingest (if `sources`) → arm watch (if requested). If config
write fails: nothing else runs. If runtime register fails after a
successful config write: the handler reloads the prior config and
rewrites it (best-effort rollback). If rollback fails: return
`RAG_PERSIST_FAILED` with `details.rollback: "failed"`, leaving the
operator a diagnostic to act on.

## 8. Logging

The handlers use the [`log`](src/log.ts) singleton (`log.info`,
`log.warn`, `log.error`). One line per tool invocation, level `info`:
`service=rag tool=<name> role=<ctx.role> agentId=<ctx.agentId>
collection_id=<id>`; on completion, append the elapsed ms and a single
tag (`ok`, error code, or `chunksUpserted=N`).

The shared `log` is injected as the watcher logger at manager
construction, so chokidar flood events
([watcher/controller.ts](src/rag/watcher/controller.ts#L188)) and
post-arm errors
([watcher/controller.ts](src/rag/watcher/controller.ts#L142)) appear in
the same log buffer as tool invocations. No new metrics API is
introduced.

Free-text args (`text` on `rag_query`) are recorded by length only;
their content is never logged. `rag_ingest`'s reports are logged by
counts (`chunksUpserted`, `chunksDeleted`, `chunksDroppedSecrets`); if
`chunksDroppedSecrets > 0`, the affected paths are written to the log
prefixed `rag.secret-drop` so the operator can audit; F03's Librarian
also consumes that signal via memory writes when granted access.

## 9. Path/Secret Guards

- Every path argument (`sources[].root`, `rag_ingest.source.root`)
  resolved against `ctx.projectRoot` (must not escape) then
  `shouldSkipPath`.
- Per-chunk content is scanned by `scanChunk` inside the pipeline
  (existing); F02 surfaces the count.
- `rag_query.text` is **not** scanned: it is a query, not stored
  content; the embeddings provider sees it but the only mitigations
  are the operator's outbound network policy and the secret-bearing
  config helpers already in place.

## 10. Files

| File                                                                                | Action                                                                 |
|-------------------------------------------------------------------------------------|------------------------------------------------------------------------|
| `src/mcp/rag.ts` (new)                                                              | Create the seven tool schemas, handler, and `RagService` type.         |
| [src/mcp/builtins.ts](src/mcp/builtins.ts#L1912-L1971)                              | Extend `registerBuiltinServices` signature; register the `rag` service. |
| [src/server/bootstrap.ts](src/server/bootstrap.ts#L150)                             | Construct `RagService` and pass it to `registerBuiltinServices`.        |
| [src/config.ts](src/config.ts)                                                      | Add `saveSaivageConfig(projectRoot, mutator)` — atomic write via temp file + rename, holding a file lock under `.saivage/.config.lock`. |
| [src/agents/tool-filters.ts](src/agents/tool-filters.ts)                            | Add `rag_list`, `rag_stats`, `rag_query` to `READ_ONLY_TOOLS`.          |
| `src/mcp/rag.test.ts` (new)                                                         | Argument validation, envelope shape, protected gates, dynamic register→ingest→query→drop cycle, control-mutex contention, persist rollback, watch arm/disarm, watcher-unavailable mapping. |
| `src/mcp/rag.integration.test.ts` (new)                                             | End-to-end with sqlite-vec store, ephemeral temp project root.          |
| `src/config.test.ts`                                                                | Cover `saveSaivageConfig` atomic semantics.                             |
| `SPEC/v2/rag/agent-tools.md` (new)                                                  | Operator-facing summary of the seven-tool surface.                      |

## 11. Internal Consistency

- The canonical list of seven tools is repeated identically in §2,
  §3.1, §4, §5 (error table maps codes that all seven can produce),
  and §10. There is no `rag_add` and no `delete_record` anywhere.
- `rag_drop` is a standalone tool throughout; `rag_admin` actions are
  exactly `reconcile`, `watch_arm`, `watch_disarm`.
- Error envelope shape is fixed in §1.1 and used identically by every
  schema in §4 and every code in §5.
- Authorization is name-only via `READ_ONLY_TOOLS`; mutating/admin
  tools have no role grant in v2-base.
- Persistence and runtime registration are tied together by
  `controlMutex` (§7) and the rollback rule (§7.3); no split-brain
  state on failure.
- Watcher facts are uniform: armed by `rag_register watch !== false`
  or `rag_admin watch_arm`; status surfaced in `rag_stats`; chokidar
  events reach the shared `log` via injected logger (§8).
