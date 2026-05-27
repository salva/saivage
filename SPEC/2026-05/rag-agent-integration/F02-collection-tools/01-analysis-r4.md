# F02 — Agent-Facing RAG Collection Tools: Functional Analysis

This analysis specifies the MCP tool surface that lets agents and
operators **configure, feed, query, and observe** RAG collections at
runtime. The surface lives under a single MCP service id, `rag`, with
exactly seven tools. It composes the existing public API of
[src/rag/](src/rag/) without changing it.

## 1. Verified Facts

### 1.1 In-process service registration and envelope

[McpRuntime.registerInProcess](src/mcp/runtime.ts#L153-L162) takes
`(name, tools, handler, options?)`. Each handler returns
`{ content, isError }`. Existing handlers use
`{ content: { error: { code, message, details? } }, isError: true }`.
[McpRuntime.callTool](src/mcp/runtime.ts#L184-L203) throws a
JSON-wrapped `Error` on `isError === true`, which the caller-side
plumbing already decodes.

When an in-process service is registered with `available: false`,
`callTool` throws `Service "<name>" is registered but unavailable`
**before** the handler runs
([src/mcp/runtime.ts](src/mcp/runtime.ts#L177-L178)); the handler
cannot return a typed envelope. Consequence: the `rag` service is
**always registered as available**. Disabled-RAG (`config.rag.enabled
=== false`) is handled inside the handler with a `RAG_DISABLED`
envelope. See §6.

### 1.2 Tool-call context

[ToolCallContext](src/mcp/toolContext.ts#L17-L34) carries
`role: AgentRole` (required), `agentId`, `projectRoot`, optional
`author`, `stageId`, `channelId`, `sessionId`. No `operator` role
exists. Operator invocation goes through the CLI which constructs the
context directly; see §3.2.

### 1.3 Tool filtering — deny-list for workers

[applyToolFilter](src/agents/tool-filters.ts#L31-L44) is keyed on
`ToolFilterKind` and checks `tool.name` only. The five existing kinds:

- `planner` — allow-list (`PLAN_TOOLS ∪ READ_ONLY_TOOLS ∪ {read_stash}`).
- `worker` — **deny-list**: every name not in `WORKER_EXCLUDED_TOOLS`
  is allowed
  ([src/agents/tool-filters.ts](src/agents/tool-filters.ts#L24-L34)).
- `reviewer`, `inspector`, `chat` — allow-list.

The deny-list means any new tool name not added to
`WORKER_EXCLUDED_TOOLS` is automatically reachable by every worker
role (`manager`, `coder`, `researcher`, `data_agent`, `designer`,
`critic` — and by extension `reviewer` workers, though `reviewer` has
its own allow-list filter). F02 therefore extends both filters
explicitly:

- Reads (`rag_list`, `rag_stats`, `rag_query`) → added to
  `READ_ONLY_TOOLS`. They become reachable by every role through the
  existing allow-list/deny-list intersection.
- Mutating tools (`rag_register`, `rag_ingest`, `rag_drop`,
  `rag_admin`) → added to `WORKER_EXCLUDED_TOOLS`. They are also not
  added to any allow-list filter. They are therefore unreachable from
  every existing role.

### 1.4 RagManager — runtime registration via mutable datasets array

[createRagManager](src/rag/manager.ts#L42-L51) closes over the
`opts.datasets` array; `manager.get(id)` resolves by
`opts.datasets.find((d) => d.id === id)` on every call
([src/rag/manager.ts](src/rag/manager.ts#L117-L121)). Pushing a new
`DatasetConfig` into the same array object makes the dataset
discoverable to all of `get`, `ingest`, `query`, `stats`, `drop`. The
manager also writes a registry entry under `.saivage/rag/registry.json`
when `register()` is called. `list()` reads that registry.

`createRagManager` requires `projectRoot`, `projectId`, `enabled`,
`datasets`, `providerOptions`
([src/rag/manager.ts](src/rag/manager.ts#L34-L40)). There is **no
watcher-logger option** on `RagManagerOptions` or `DatasetOpenOptions`
([src/rag/dataset.ts](src/rag/dataset.ts#L58-L61)). The
`WatcherController` carries an internal logger slot
([src/rag/watcher/controller.ts](src/rag/watcher/controller.ts#L60-L67))
but it is not exposed through the public API. F02 cannot redirect
watcher events to the shared `log` without changing `src/rag/`. F02
accepts this limitation: chokidar floods and `ENOSPC` go to
`console.warn`. A future RAG change to surface a logger seam is
recorded as **FUP-WATCHER-LOG** but is out of F02 scope.

### 1.5 Snapshot ingest semantics

[runIngest](src/rag/pipeline.ts#L168-L290) treats supplied items as
the complete seen set. After processing changed items it deletes
every prior `file_state` path not present in the current input
([src/rag/pipeline.ts](src/rag/pipeline.ts#L276-L288)).

Consequences for F02:

- **Each `fs` dataset is constrained to exactly one source root.**
  `rag_register` rejects `sources.length !== 1`. Multiple roots cannot
  share a dataset because a per-root ingest would purge the other
  root's content.
- **`rag_ingest` over the full root is the deletion convergence path.**
  Re-walking the root won't see a deleted file, and the pipeline's
  snapshot rule purges its chunks.
- **`rag_admin reconcile` is not a deletion path.** Internally
  [WatcherController.reconcile](src/rag/watcher/controller.ts#L72-L93)
  short-circuits when `changedPaths` is empty, even if `removedPaths`
  is non-empty. F02 documents `rag_ingest` as the only deletion
  convergence call.

### 1.6 Path/secret guards

[shouldSkipPath](src/rag/security/secrets.ts#L59) is the canonical
guard for path arguments; [scanChunk](src/rag/security/secrets.ts#L71)
is the per-chunk content scanner used inside the pipeline. F02
handlers call `shouldSkipPath` on every path arg.

### 1.7 Watcher controls and error mapping

[Dataset.watch](src/rag/dataset.ts#L149-L153) throws a plain `Error`
(message `watch is disabled for dataset <id>`) when
`config.watch === false`. F02 maps this to `RAG_WATCH_DISABLED` via a
**handler-side pre-check**: if `dataset.config.watch === false`,
the handler returns `RAG_WATCH_DISABLED` without invoking
`dataset.watch()`. `WatcherUnavailableError`
([src/rag/errors.ts](src/rag/errors.ts)) thrown asynchronously after
arm cannot be observed by F02 because there is no public seam; the
watch status map records `"armed"` after a successful arm and stays
that way until the next process restart. Removing the dataset clears
the entry.

## 2. Canonical Tool List

Exactly **seven** tools under service id `rag`:

`rag_list`, `rag_stats`, `rag_query`,
`rag_register`, `rag_ingest`, `rag_drop`,
`rag_admin`.

`rag_admin` multiplexes three control-plane actions: `reconcile`,
`watch_arm`, `watch_disarm`. There is no `delete_record` action and
no `rag_add` tool.

`rag_query` truncates hit text to 2 KB. Full text is not recoverable
through any F02 tool; callers needing source content use `read_file`
on the path returned in hit `metadata.path`.

## 3. Authorization

### 3.1 Filter deltas

| Tool             | `READ_ONLY_TOOLS` | `WORKER_EXCLUDED_TOOLS` | Reachable from |
|------------------|-------------------|--------------------------|----------------|
| `rag_list`       | added             | (no change)              | every role     |
| `rag_stats`      | added             | (no change)              | every role     |
| `rag_query`      | added             | (no change)              | every role     |
| `rag_register`   | (no)              | added                    | none           |
| `rag_ingest`     | (no)              | added                    | none           |
| `rag_drop`       | (no)              | added                    | none           |
| `rag_admin`      | (no)              | added                    | none           |

Net effect: every existing role gains read access to RAG; **no
existing role** gains write or admin access. F03 introduces a
`librarian` filter (allow-list) that grants the mutating/admin tools
to one bounded role.

### 3.2 Operator path

Operator invocation is via the CLI (`saivage rag …`). The CLI
constructs a `ToolCallContext` with `role: "planner"` (the
most-privileged existing role) and calls the handler functions
directly. The CLI bypasses `applyToolFilter` because it does not go
through `MCPRuntime.callTool` for these commands; this is the same
pattern existing operator subcommands use.

### 3.3 Protected datasets

Datasets with `source ∈ {"skill", "memory"}` are protected.

- `rag_ingest`, `rag_drop`, `rag_admin` against a protected dataset →
  `RAG_PROTECTED_DATASET`.
- `rag_register` with `source ∈ {"skill", "memory"}` → schema
  rejection. The Zod schema enumerates `source` as `"doc" | "code"`,
  so the envelope is `RAG_INVALID_ARGS` with
  `details.field: "source"`. There is **no `RAG_PROTECTED_SOURCE`
  code**; the validation layer catches this case first.
- `rag_list`, `rag_stats`, `rag_query` operate on protected datasets
  freely; the response decorates `protected: true`.

## 4. Tool Schemas

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

Returns `manager.list()` decorated with `protected`.

### 4.2 `rag_stats`

```ts
input: { collection_id: string }
output: {
  chunks: number; files: number; bytesOnDisk: number;
  provider: { provider: string; model: string; dim: number; releaseFingerprint: string };
  lastIngestAt: string | null;
  secretsDropped: number;
  protected: boolean;
  watch: "off" | "armed";
}
```

`watch` is read from the per-id status `Map<string, "off" | "armed">`
maintained by the `rag` service. The map records "armed" after a
successful `dataset.watch()` and "off" otherwise (including drop or
disarm). Async watcher unavailability after arm is not observable by
F02 (see §1.4).

### 4.3 `rag_query`

```ts
input: {
  collection_id: string;
  text: string;          // length ≤ 8 KB
  topK?: number;         // 1..50, default 10
  filter?: QueryFilter;  // pass-through; eq|and|or|gt|lt|pathGlob|in
}
output: {
  hits: Array<{
    chunkId: string;
    score: number;
    text: string;        // truncated to 2 KB
    metadata: ChunkMetadata;
  }>;
}
```

Empty result is `{ hits: [] }`, never an error.

### 4.4 `rag_register`

```ts
input: {
  collection_id: string;
  source: "doc" | "code";           // schema enum; skill/memory → RAG_INVALID_ARGS
  provider?: { model: "text-embedding-3-small"; dim: 256 | 512 | 1024 | 1536 };
  chunker: { kind: "markdown" | "code" | "memory"; chunkSize?: number; overlap?: number };
  exclusions?: string[];
  sources: [{ root: string; include?: string[]; exclude?: string[] }];  // exactly one
  watch?: false | true | { usePolling: true; interval?: number };       // default false
  persist?: boolean;                  // default false
}
output: {
  collection: { id: string; source: "doc" | "code"; providerStamp: {...}; createdAt: string; protected: false };
  persisted: boolean;
  watch: "off" | "armed";
  initialIngestReport: IngestReport;  // singular — one source root
}
```

`sources` is a one-element tuple; an empty or multi-element array is
rejected by the Zod schema with `RAG_INVALID_ARGS`. `watch` defaults
to `false` when omitted; `RAG_WATCH_DISABLED` is impossible from
`rag_register` because the handler reads the resolved value.

Handler procedure (under `rag.controlMutex`, see §7.2):

1. Validate the input through Zod. Resolve `sources[0].root` against
   `ctx.projectRoot`, reject escape with `RAG_BLOCKED_PATH`. Run
   `shouldSkipPath` on the resolved root.
2. If `persist: true`, call `saveSaivageConfig(projectRoot, prior =>
   { ...prior, rag: { ...prior.rag, datasets: [...prior.rag.datasets,
   newConfig] } })`. On failure: return `RAG_PERSIST_FAILED`; nothing
   else runs.
3. Push `newConfig` into `rag.datasets` (the same mutable array
   passed to `createRagManager`). Call `manager.register(newConfig)`.
   On drift errors, return the typed envelope; the array push is
   reverted; if `persist` was true, the config write is rolled back
   by `saveSaivageConfig(projectRoot, prior => /* remove newConfig */)`.
   If rollback also fails: return `RAG_PERSIST_FAILED` with
   `details.rollback: "failed"`.
4. Run `manager.ingest(newConfig.id, { kind: "fs", root: sources[0].root,
   include: sources[0].include ?? ["**/*"], exclude: sources[0].exclude })`.
   Errors flow as their typed code; the dataset stays registered
   (operator may retry ingest).
5. If `watch !== false`, call `manager.get(newConfig.id).then(ds =>
   ds.watch())`. Record `"armed"` in the watch status map. The
   handler does not catch `WatcherUnavailableError` because it cannot
   reach the watcher layer through the public API; chokidar
   thrown-from-arm surfaces here as `RAG_INTERNAL`; the operator sees
   the chokidar message via the standard log.

### 4.5 `rag_ingest`

```ts
input: {
  collection_id: string;
  source: { root: string; include: string[]; exclude?: string[] };
}
output: { ingestReport: IngestReport }
```

Protected → `RAG_PROTECTED_DATASET`. `root` is validated through
`shouldSkipPath` after `ctx.projectRoot` resolution. Calls
`manager.ingest(id, { kind: "fs", ...source })`.

**`rag_ingest` is the deletion convergence path.** Operators wanting
to drop a single file from an `fs` dataset delete the file on disk
and run `rag_ingest` against the dataset's root; the pipeline's
snapshot rule purges its chunks.

### 4.6 `rag_drop`

```ts
input: { collection_id: string; persist?: boolean }
output: { dropped: true; persisted: boolean }
```

Protected → `RAG_PROTECTED_DATASET`. Order under `rag.controlMutex`:

1. If `persist: true`, rewrite `saivage.json` with the entry removed
   via `saveSaivageConfig`. `RAG_PERSIST_FAILED` on write failure;
   runtime untouched.
2. Call `manager.drop(id)`. Remove from `rag.datasets`. Delete from
   watch status map.

### 4.7 `rag_admin`

```ts
input:
  | { collection_id: string; action: "reconcile" }
  | { collection_id: string; action: "watch_arm" }
  | { collection_id: string; action: "watch_disarm" }
output:
  | { reconciled: true }
  | { watch_armed: true }
  | { watch_disarmed: true }
```

Protected → `RAG_PROTECTED_DATASET`. All actions under
`rag.controlMutex`.

- `reconcile` calls `dataset.reconcile()`. Internally this picks up
  changed files but does **not** purge deletions
  (see §1.5). The action returns `{ reconciled: true }` and the
  operator must run `rag_ingest` separately for deletions.
- `watch_arm` is gated by a pre-check on `dataset.config.watch`. If
  `false`, return `RAG_WATCH_DISABLED`. Otherwise call
  `dataset.watch()`; record `"armed"`; return `{ watch_armed: true }`.
  Synchronous failures bubble as `RAG_INTERNAL`.
- `watch_disarm` calls `dataset.unwatch()`; clears the status entry.

## 5. Error Envelope and Codes

Every error: `{ content: { error: { code, message, details? } }, isError: true }`.

| Code                          | Trigger                                                                                                              |
|-------------------------------|-----------------------------------------------------------------------------------------------------------------------|
| `RAG_DISABLED`                | `config.rag.enabled === false`. Checked at handler entry.                                                            |
| `RAG_INVALID_ARGS`            | Zod schema validation failed (including `source ∈ {skill,memory}` on `rag_register` and `sources.length !== 1`).     |
| `RAG_DATASET_NOT_FOUND`       | `DatasetNotFoundError` from manager.                                                                                  |
| `RAG_PROTECTED_DATASET`       | Mutating tool against `source ∈ {skill, memory}`.                                                                     |
| `RAG_BLOCKED_PATH`            | `shouldSkipPath` rejected a path argument; or ingest root escapes project root.                                       |
| `RAG_INVALID_QUERY_FILTER`    | `InvalidQueryFilterError`.                                                                                            |
| `RAG_CONFIG_DRIFT`            | `ConfigDriftError`.                                                                                                   |
| `RAG_EMBEDDING_DRIFT`         | `EmbeddingDriftError`.                                                                                                |
| `RAG_CORRUPTED_STORE`         | `CorruptedStoreError`.                                                                                                |
| `RAG_PROVIDER_UNAVAILABLE`    | `ProviderUnavailableError`.                                                                                           |
| `RAG_INGEST_LOCKED`           | `IngestLockedError`.                                                                                                  |
| `RAG_WATCH_DISABLED`          | Handler pre-check found `dataset.config.watch === false`.                                                            |
| `RAG_SECRET_DROPPED`          | **Reserved.** F02 never emits this; bulk drops are surfaced via `IngestReport.chunksDroppedSecrets`.                  |
| `RAG_PERSIST_FAILED`          | `saveSaivageConfig` failed. Runtime state is **not** mutated. May include `details.rollback: "failed"`.               |
| `RAG_CONTROL_BUSY`            | Second control-plane action attempted while `rag.controlMutex` is held. Caller retries.                              |
| `RAG_INTERNAL`                | Any other thrown `Error` (including synchronous chokidar arm errors). Message is `.message` only.                    |

## 6. Service Construction

[bootstrap.ts](src/server/bootstrap.ts#L150) currently calls
`registerBuiltinServices(mcpRuntime, config.mcp, config.security)`.
F02 extends it:

```ts
// In bootstrap.ts, after authProfiles + config are loaded:
const ragDatasets: DatasetConfig[] = [...config.rag.datasets];    // mutable
const ragManager = createRagManager({
  projectRoot,
  projectId: config.projectId,
  enabled: config.rag.enabled,
  datasets: ragDatasets,
  providerOptions: resolveOpenAIProviderOptions(authProfiles),
});
const ragService: RagService = {
  manager: ragManager,
  datasets: ragDatasets,            // same array as above
  watchStatus: new Map<string, "off" | "armed">(),
  controlMutex: createMutex(),
  enabled: config.rag.enabled,
};

registerBuiltinServices(mcpRuntime, config.mcp, config.security, { rag: ragService });
```

`registerBuiltinServices` gains a fourth options field `rag: RagService`.
The `rag` service is **always registered with `available: true`**.
Every handler runs `if (!ragService.enabled) return ragDisabledEnvelope()`
as its first statement.

Tests inject a fake `RagService` with the same shape; no public RAG
API change is needed.

## 7. Concurrency

### 7.1 Data plane

- `.ingest.lock` is fail-fast with one stale retry
  ([src/rag/lock.ts](src/rag/lock.ts#L28-L60)). Concurrent
  `rag_ingest` on the same dataset → `RAG_INGEST_LOCKED`.
- Query and stats do not acquire the ingest lock.
- `rag_list` reads the registry file.

### 7.2 Control plane

`rag_register`, `rag_drop`, `rag_admin` (all three actions) serialise
on `rag.controlMutex`. Contention → `RAG_CONTROL_BUSY`. The mutex
covers the persistence step so registry/runtime/config converge
atomically.

### 7.3 Persistence rollback

Register-with-persist order: config write → runtime register →
ingest → watch arm. Config write failure: nothing else runs. Register
failure after successful config write: rollback config write
best-effort. Rollback failure: `RAG_PERSIST_FAILED` with
`details.rollback: "failed"`. Ingest and watch failures occur after
persistence/register; the dataset stays registered and persisted
(operator retries the failed step).

## 8. Logging

Tool invocation log line via [`log.info`](src/log.ts):
`service=rag tool=<name> role=<ctx.role> agentId=<ctx.agentId>
collection_id=<id>`; on completion `duration_ms=<n> result=<tag>` where
tag is `ok`, error code, or `chunksUpserted=<n>`.

`rag_query.text` is logged by length only.
`IngestReport.chunksDroppedSecrets > 0` produces a `log.warn` line
prefixed `rag.secret-drop` with `collection_id=<id> count=<n>`. The
affected paths are not visible to F02 (the pipeline does not return
them) — they appear only in the chokidar log line for `fs` ingests
that the operator can correlate via timing. F02 does not invent
path-exposure plumbing.

Chokidar floods and async `ENOSPC` go to `console.warn` via the
default `WatcherController` logger; redirecting them to the shared
`log` requires the FUP-WATCHER-LOG public RAG change, out of scope.

## 9. Path/Secret Guards

- Every path argument resolved against `ctx.projectRoot` (must not
  escape) then `shouldSkipPath`.
- Per-chunk content scanning by `scanChunk` inside the pipeline.
- `rag_query.text` is not scanned: it is a query that leaves the
  process only via the embedding provider call; the operator's
  outbound policy gates that. F02 records the call by length only.

## 10. Files

| File                                                                                | Action                                                                 |
|-------------------------------------------------------------------------------------|------------------------------------------------------------------------|
| `src/mcp/rag.ts` (new)                                                              | Seven tool schemas, handler, `RagService` type.                        |
| [src/mcp/builtins.ts](src/mcp/builtins.ts#L1912-L1971)                              | Extend `registerBuiltinServices` signature with `rag: RagService`.     |
| [src/server/bootstrap.ts](src/server/bootstrap.ts#L150)                             | Construct `RagService`; pass to `registerBuiltinServices`.             |
| [src/config.ts](src/config.ts)                                                      | Add `saveSaivageConfig(projectRoot, mutator)`: atomic temp-file write + rename under `.saivage/.config.lock`. |
| [src/agents/tool-filters.ts](src/agents/tool-filters.ts#L12-L27)                    | Add three read tools to `READ_ONLY_TOOLS`; add four mutating/admin tools to `WORKER_EXCLUDED_TOOLS`. |
| `src/mcp/rag.test.ts` (new)                                                         | Schema validation, envelope shape, deny-list/allow-list filter coverage, protected gates, dynamic register→ingest→query→drop, control-mutex contention, persist rollback, watch arm/disarm, deletion-by-ingest. |
| `src/mcp/rag.integration.test.ts` (new)                                             | End-to-end with sqlite-vec store and ephemeral temp project root.       |
| `src/config.test.ts`                                                                | Cover `saveSaivageConfig` atomic semantics and concurrent-write contention. |
| `SPEC/v2/rag/agent-tools.md` (new)                                                  | Operator-facing summary of the seven-tool surface.                      |

## 11. Internal Consistency

- Seven tools in §2, §3.1, §4 (one schema each), §5 (error codes), and
  §10 (file inventory + tests).
- No `rag_add`, no `delete_record`, no `RAG_PROTECTED_SOURCE` anywhere.
- `rag_drop` is standalone; `rag_admin` actions are exactly
  `reconcile`, `watch_arm`, `watch_disarm`.
- Envelope shape is `{ content: { error: { code, message, details? } },
  isError: true }` in §1.1 and every handler in §4.
- Worker authorization is via the deny-list addition in §3.1; read
  tools via `READ_ONLY_TOOLS` addition; mutating/admin tools have no
  positive grant.
- Persistence atomicity: §4.4's procedure matches §7.3's rules; both
  acquire `rag.controlMutex`.
- Watcher logger limitation is explicit (§1.4, §8); FUP recorded; no
  public RAG API change anywhere in the doc.
- Bootstrap snippet in §6 includes `enabled`; the `datasets` array is
  the same identity passed to manager and stored in `ragService`.
- `RAG_WATCH_DISABLED` is produced by the handler's pre-check in §4.7,
  matching §5.
