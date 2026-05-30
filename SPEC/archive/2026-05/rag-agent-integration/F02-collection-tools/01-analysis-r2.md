# F02 — Agent-Facing RAG Collection Tools: Functional Analysis

This analysis specifies the MCP tool surface that lets agents
**create, configure, feed, and query** RAG collections at runtime. The
surface lives under a single MCP service id, `rag`, with at most eight
tools, and composes the existing public API of [src/rag/](src/rag/)
without changing it.

## 1. Current MCP Wiring (Verified)

### 1.1 Registration

[McpRuntime.registerInProcess](src/mcp/runtime.ts#L153-L162) takes
`(name, tools, handler, options?)`: one service name, one
`ToolEntry[]`, one handler function. The handler dispatches on
`toolName`. Built-ins are registered by
[src/mcp/builtins.ts](src/mcp/builtins.ts#L1961-L1971), e.g.
`mcpRuntime.registerInProcess("skills", knowledgeSkillsTools, knowledgeSkillsHandler)`.

### 1.2 Tool-call context

[ToolCallContext](src/mcp/toolContext.ts#L17-L34) carries:
`role: AgentRole`, `agentId`, `projectRoot`, optional `author`,
`stageId`, `channelId`, `sessionId`. There is **no `agentRole`** field.

### 1.3 Per-agent tool filtering

[applyToolFilter](src/agents/tool-filters.ts#L31-L44) routes by
`ToolFilterKind` and inspects **only `tool.name`**, never the
`service`. The filter shapes today are:

- `planner` — `PLAN_TOOLS | READ_ONLY_TOOLS | "read_stash"`.
- `worker` — everything except `WORKER_EXCLUDED_TOOLS` (plan tools
  plus `create_skill`/`update_skill`).
- `reviewer` — `READ_ONLY_TOOLS | "run_command" | "read_stash"`.
- `inspector` — `READ_ONLY_TOOLS | "run_command" | "read_stash" | WEB_TOOLS`.
- `chat` — `READ_ONLY_TOOLS | "read_stash" | WEB_TOOLS | "create_note"`.

There are no wildcard sets like `rag.*`. New tool names must be added
explicitly to each filter that should accept them.

### 1.4 Error envelopes

In-process handlers return `{ content, isError }`. When `isError` is
true, [McpRuntime.callTool](src/mcp/runtime.ts#L184-L203) wraps the
content into a thrown `Error` for the caller. Existing knowledge
handlers translate domain errors into explicit envelopes
`{ error: { code, message } }` and set `isError: true` (see e.g.
[src/mcp/knowledgeSkills.ts](src/mcp/knowledgeSkills.ts#L160-L182)).
The RAG tool handlers will do the same: catch each `RagError` subclass,
emit a typed envelope, never throw raw `Error`.

### 1.5 RAG public surface used

[RagManager](src/rag/manager.ts#L42-L51) exposes `list`, `get`,
`register`, `ingest`, `query`, `stats`, `drop`, `close`. Watcher
controls live on [Dataset](src/rag/dataset.ts#L149-L173) as `watch`,
`unwatch`, `reconcile`. `Dataset.reconcile()` returns `Promise<void>`
today; the tool surface cannot synthesise a per-run delta report from
it without a public API change.

`RagManager.get(id)` resolves from `opts.datasets` (the manager's
configured list), not from the on-disk registry. This means
**runtime-only `register` does not persist a re-startable config** —
the registry file at `.saivage/rag/registry.json` is operator
diagnostic state, not the source of truth. See §6 for how this shapes
the `rag_register` design.

## 2. Required Operations

Per topic, the analysis must decide each of: register, list, stats,
directory ingest, explicit text ingest, record delete, query, drop,
watcher toggle, reconcile.

Decisions:

| Operation              | Decision                                                                                  |
|------------------------|-------------------------------------------------------------------------------------------|
| List collections       | Tool: `rag_list`.                                                                          |
| Collection stats       | Tool: `rag_stats`.                                                                         |
| Semantic query         | Tool: `rag_query`.                                                                         |
| Add a single text      | Tool: `rag_add`.                                                                           |
| Directory ingest       | Tool: `rag_ingest`.                                                                        |
| Register a collection  | Tool: `rag_register` (operator-grade authorization).                                       |
| Delete a record        | Multiplexed under `rag_admin` with `action: "delete_record"`.                              |
| Drop a collection      | Multiplexed under `rag_admin` with `action: "drop"`.                                       |
| Reconcile              | Multiplexed under `rag_admin` with `action: "reconcile"`.                                  |
| Watcher arm/disarm     | Multiplexed under `rag_admin` with `action: "watch_arm" | "watch_disarm"`.                 |

Canonical tool list (eight): `rag_list`, `rag_stats`, `rag_query`,
`rag_add`, `rag_ingest`, `rag_register`, `rag_drop`, `rag_admin`.

`rag_drop` is exposed as a separate tool (not under `rag_admin`) so
the role filter can grant `rag_admin` to roles that may reconcile or
arm watchers without granting collection deletion. Multiplexing inside
`rag_admin` is restricted to non-destructive admin actions plus
`delete_record`.

## 3. Authorization Model

Existing roles (no Librarian yet, no operator role): `planner`,
`manager`, `coder`, `researcher`, `data_agent`, `inspector`,
`reviewer`, `designer`, `critic`, `chat`.

The default grants for the eight tools, applied through the existing
name-only `applyToolFilter`:

| Tool             | Permitted roles (default)                                               |
|------------------|--------------------------------------------------------------------------|
| `rag_list`       | All roles.                                                              |
| `rag_stats`      | All roles.                                                              |
| `rag_query`      | All roles.                                                              |
| `rag_add`        | None by default. Reserved for a future Librarian role and the operator. |
| `rag_ingest`     | None by default. Same as `rag_add`.                                     |
| `rag_register`   | None by default. Operator-only.                                         |
| `rag_drop`       | None by default. Operator-only.                                         |
| `rag_admin`      | None by default. Operator-only.                                         |

Default integration into the existing filters:

- Add `rag_list`, `rag_stats`, `rag_query` to `READ_ONLY_TOOLS`. That
  gives every role read access via the same set used today for skill
  reads and file reads.
- Do not add the write/admin tools to any role filter. Operator access
  reaches them via the same out-of-band invocation path the operator
  CLI already uses to call MCP tools directly — see §3.1.

A future `librarian` filter (defined by feature F03) will add the
write/admin tools to a new bounded set.

### 3.1 Operator access without a role

`ToolCallContext.role` is typed `AgentRole`. The operator does not
have an `AgentRole`, so direct in-band invocation by a typed-role
caller is impossible by design. The two existing escape hatches are:

1. The Saivage CLI binary calls runtime methods directly, bypassing
   role-filter checks. The new `rag_register`/`rag_drop`/`rag_admin`
   handlers internally check
   `ctx.role === undefined || ctx.role === "operator"` only as a
   defence-in-depth assertion; the filter is the primary gate.
2. Until the Librarian ships (F03), there is no agent-side path to
   the write/admin tools. This is deliberate.

### 3.2 Protected datasets

Datasets with `source ∈ {"skill", "memory"}` are **protected**: F02
tools must not mutate them. Concretely:

- `rag_register`, `rag_drop`, `rag_ingest`, `rag_add`,
  `rag_admin` (any action) refuse to operate on a dataset whose
  registered `source` is `skill` or `memory`, returning
  `{ error: { code: "RAG_PROTECTED_DATASET" } }`. The skills/memories
  datasets are owned by F01 and are configured/managed exclusively
  through the F01 record-aware tools.
- `rag_list`, `rag_stats`, `rag_query` may operate on protected
  datasets. `rag_query` against a protected dataset returns raw
  `QueryHit[]` without the F01 sidecar hydration; agents wanting the
  full skill/memory record use `search_skills` or `search_memories`.

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

Maps to `RagManager.list()` plus a `protected = source in {skill,memory}` decoration.

### 4.2 `rag_stats`

```ts
input: { collection_id: string }
output: {
  chunks: number; files: number; bytesOnDisk: number;
  provider: { provider: string; model: string; dim: number; releaseFingerprint: string };
  lastIngestAt: string | null;
  secretsDropped: number;
  protected: boolean;
}
```

Maps to `RagManager.stats(id)` plus `protected` decoration.

### 4.3 `rag_query`

```ts
input: {
  collection_id: string;
  text: string;
  topK?: number;            // 1..50, default 10
  filter?: QueryFilter;     // pass-through to Dataset.query
}
output: {
  hits: Array<{
    chunkId: string;
    score: number;
    text: string;            // truncated to 2 KB; full text via rag_admin if needed
    metadata: ChunkMetadata;
  }>;
}
```

Pass-through to `manager.query(id, text, { topK, filter })`. Empty
results yield `{ hits: [] }`, never an error.

### 4.4 `rag_add`

```ts
input: {
  collection_id: string;
  text: string;             // ≤ 64 KB after redaction
  id: string;               // caller-supplied stable id
  metadata: ChunkMetadataInput;
}
output: { ingestReport: IngestReport }
```

Maps to `manager.ingest(id, { kind: "records", items: [{ id, text, metadata }] })`.
Handler validates path safety: `metadata.path` must not be absolute
and must not match `isBlockedPath`. Returns
`{ error: { code: "RAG_BLOCKED_PATH" } }` on violation. The
secret-scanning lives inside the pipeline
([scanChunk](src/rag/pipeline.ts) usage), which drops chunks and
increments `chunksDroppedSecrets`; the handler relays that count
through the report.

### 4.5 `rag_ingest`

```ts
input: {
  collection_id: string;
  source: { root: string; include: string[]; exclude?: string[] };
}
output: { ingestReport: IngestReport }
```

Maps to `manager.ingest(id, { kind: "fs", ...source })`. Handler
re-checks every arg: `root` is resolved against `ctx.projectRoot` and
must not escape it; the resolved path goes through `isBlockedPath` and
fails with `RAG_BLOCKED_PATH` if rejected.

### 4.6 `rag_register`

```ts
input: {
  collection_id: string;
  source: "doc" | "code";          // skill/memory rejected upfront
  provider?: {                     // optional; defaults match config schema
    model: "text-embedding-3-small";
    dim: 256 | 512 | 1024 | 1536;
  };
  chunker: { kind: "markdown" | "code" | "memory"; chunkSize?: number; overlap?: number };
  exclusions?: string[];
  sources?: Array<{ root: string; include?: string[]; exclude?: string[] }>;
  watch?: false | true | { usePolling: true; interval?: number };
  persist?: boolean;               // default false; see §6
}
output: { collection: RegisteredDataset; persisted: boolean }
```

`source: "skill" | "memory"` is rejected with `RAG_PROTECTED_SOURCE`.
The handler calls `manager.register(...)` to materialise the dataset
for the running process; the registry entry is written by the manager
itself. If `persist: true`, the handler additionally writes the new
config into `<projectRoot>/.saivage/saivage.json` under
`config.rag.datasets[]`, using the existing atomic config-write helper.
Without `persist`, the new dataset disappears on restart — operator
diagnostic mode only.

### 4.7 `rag_drop`

```ts
input: { collection_id: string; persist?: boolean }
output: { dropped: boolean; persisted: boolean }
```

Refuses to drop a protected dataset. Calls `manager.drop(id)`. If
`persist: true`, the handler removes the matching entry from
`config.rag.datasets` on disk.

### 4.8 `rag_admin`

```ts
input:
  | { collection_id: string; action: "reconcile" }
  | { collection_id: string; action: "watch_arm" }
  | { collection_id: string; action: "watch_disarm" }
  | { collection_id: string; action: "delete_record"; record_path: string }
output:
  | { reconciled: true }
  | { watch_armed: true }
  | { watch_disarmed: true }
  | { deleted: true }
```

Refuses to operate on protected datasets. Actions:

- `reconcile` — `dataset.reconcile()`; returns `{ reconciled: true }`
  because `Dataset.reconcile()` is `Promise<void>` and we will not
  invent a richer return shape on top of the public API.
- `watch_arm` — `dataset.watch()`; throws translated to
  `RAG_WATCH_DISABLED` if `config.watch === false`.
- `watch_disarm` — `dataset.unwatch()`.
- `delete_record` — submit
  `manager.ingest(id, { kind: "records", items: [{ id: record_path, text: "", metadata: { path: record_path, source: <dataset source> } }] })`
  which deletes all chunks at `record_path`. Returns
  `{ deleted: true }` on success.

## 5. Error Taxonomy

Every handler catches the following and returns a typed envelope; the
envelope shape is `{ error: { code, message, details? }, isError: true }`.

| Code                          | Trigger                                                                                                              |
|-------------------------------|-----------------------------------------------------------------------------------------------------------------------|
| `RAG_DISABLED`                | `config.rag.enabled === false`. Caught at the top of every handler.                                                  |
| `RAG_INVALID_ARGS`            | Zod schema validation failure on the tool input.                                                                     |
| `RAG_DATASET_NOT_FOUND`       | `DatasetNotFoundError` from manager.                                                                                 |
| `RAG_PROTECTED_DATASET`       | Mutating tool invoked against `source ∈ {skill, memory}`.                                                            |
| `RAG_PROTECTED_SOURCE`        | `rag_register` invoked with `source ∈ {skill, memory}`.                                                              |
| `RAG_BLOCKED_PATH`            | `isBlockedPath` rejected a path argument; or `rag_ingest` root escapes project root.                                 |
| `RAG_INVALID_QUERY_FILTER`    | `InvalidQueryFilterError`.                                                                                           |
| `RAG_CONFIG_DRIFT`            | `ConfigDriftError`. Bubbled to operator; not auto-resolved.                                                          |
| `RAG_EMBEDDING_DRIFT`         | `EmbeddingDriftError`.                                                                                               |
| `RAG_CORRUPTED_STORE`         | `CorruptedStoreError`.                                                                                               |
| `RAG_PROVIDER_UNAVAILABLE`    | `ProviderUnavailableError`. Caller-visible message names the provider; no `retryAfterMs`.                            |
| `RAG_INGEST_LOCKED`           | `IngestLockedError`. Caller retries.                                                                                 |
| `RAG_WATCH_DISABLED`          | `dataset.watch()` thrown because `config.watch === false`.                                                           |
| `RAG_WATCHER_UNAVAILABLE`     | `WatcherUnavailableError` (inotify limit).                                                                           |
| `RAG_SECRET_DROPPED`          | `SecretDroppedError` on a single-record `rag_add`. For bulk ingests, the chunk count is surfaced in `IngestReport.chunksDroppedSecrets` and the handler returns success. |
| `RAG_UNAUTHORIZED_OPERATOR`   | A handler reached an operator-only branch via a non-operator role. Defence-in-depth.                                 |
| `RAG_PERSIST_FAILED`          | `persist: true` could not update `saivage.json` (lock contention, parse failure). Manager state remains updated.     |
| `RAG_INTERNAL`                | Any other thrown `Error`. Message stripped of stack details.                                                         |

## 6. Discovery, Persistence, and Restart

- Discovery is `rag_list` only. No `description` field is added to
  `DatasetConfig` because the topic forbids changing `src/rag/`. The
  Librarian (F03) tracks human-readable summaries via the `memory`
  dataset under topic `rag-policy` (F03 owns that detail).
- Runtime-only `register` produces a dataset visible via `rag_list`
  for the lifetime of the process. On restart, the manager rebuilds
  only datasets present in `config.rag.datasets`. Operators wanting
  permanence pass `persist: true`.
- The `<projectRoot>/.saivage/rag/registry.json` file is the manager's
  own cache of provider stamps; it is not read by the tool layer and
  it is not the persistence story.

## 7. Concurrency, Locking, Logging

### 7.1 Concurrency

The per-dataset lock is the `proper-lockfile`-backed `.ingest.lock`
acquired by `runIngest`. It is fail-fast with one stale retry
([src/rag/lock.ts](src/rag/lock.ts#L3-L11),
[src/rag/lock.ts](src/rag/lock.ts#L45-L53)). Translation in the tool
layer:

- Two concurrent `rag_ingest` calls on the same dataset: the second
  immediately receives `RAG_INGEST_LOCKED`.
- `rag_add` vs. `rag_ingest` on the same dataset: same fail-fast
  behaviour.
- `rag_admin` reconcile internally calls `runIngest` through
  `Dataset.reconcile` → `WatcherController.reconcile` → `ingest`,
  competing on the same lock.
- `rag_register` vs. `rag_drop` on the same id: `register` opens the
  dataset, `drop` closes and unlinks. The manager itself is not
  guarded against this; in practice both operations are operator-only
  and serialised at the CLI level. The handler returns
  `RAG_INTERNAL` if `drop` finds a missing directory after a racing
  register.
- `rag_query` vs. `ingest` on the same dataset: queries read through
  sqlite-vec without acquiring the ingest lock; reads may briefly see
  half-written chunk batches between the per-batch transactions.
  Acceptable for retrieval.

### 7.2 Logging

Existing logging uses the
[`log`](src/log.ts) singleton with `log.info`/`log.warn`/`log.error`,
backed by a string-message buffer. No structured metrics API exists.
The handlers emit one log line per tool invocation, level `info`,
including: `service=rag`, `tool=<name>`, `role=<ctx.role>`,
`agentId=<ctx.agentId>`, `collection_id=<id>`, and on completion the
duration in ms and a single one-line result tag
(`ok`, error code, or `chunksUpserted=N`). Free-text arguments are
truncated to 80 characters; secret-bearing fields (`text` arg to
`rag_add`, query text on `rag_query`) are recorded only by length, not
by content.

## 8. Files

| File                                                                                | Action  |
|-------------------------------------------------------------------------------------|---------|
| `src/mcp/rag.ts` (new)                                                              | Create  |
| [src/mcp/builtins.ts](src/mcp/builtins.ts)                                          | Edit — register the `rag` service.       |
| [src/agents/tool-filters.ts](src/agents/tool-filters.ts)                            | Edit — add the three read tools to `READ_ONLY_TOOLS`. |
| `src/mcp/rag.test.ts` (new)                                                         | Create — argument validation, error envelopes, protected-dataset gates, lock fail-fast. |
| `src/mcp/rag.integration.test.ts` (new)                                             | Create — round trip register → ingest → query → drop using an ephemeral sqlite-vec store. |
| `SPEC/v2/rag/agent-tools.md` (new)                                                  | Create — operator-facing summary of the tool surface. |

## 9. Internal Consistency Check

Every section references the same canonical tool list of eight tools.
All schemas use `DatasetConfig.source` as a `RagSource` string, not an
object. All ingest paths use `IngestInput.items`. All result shapes
either match `IngestReport`, `RegisteredDataset`, `QueryHit`,
`DatasetStats`, or are explicitly typed in §4 with no overclaimed
fields. The error table covers every public RAG error class plus the
F02-owned validation, authorization, persistence, and disabled-RAG
codes. Discovery and persistence are mutually consistent: registry
state is process-local unless `persist` is passed, and discovery is
via `rag_list` only.
