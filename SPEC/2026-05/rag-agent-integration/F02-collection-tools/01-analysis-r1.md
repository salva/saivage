# F02 — Agent-facing RAG collection tools: functional analysis

## 1. Current MCP service surface

### 1.1 Registration shape

Built-in MCP services are wired in
[saivage/src/mcp/builtins.ts](saivage/src/mcp/builtins.ts). A service
is an `{ id, tools: ToolEntry[], handlers: Record<string, InProcessToolHandler> }`
record registered at runtime startup. Each `ToolEntry` declares a
`name`, `description`, and `inputSchema` (JSON Schema, not Zod — the
MCP wire format is JSON Schema; Zod is reserved for internal validation).

Handlers receive a `ToolContext` from
[saivage/src/mcp/toolContext.ts](saivage/src/mcp/toolContext.ts)
carrying `projectRoot`, `agentRole`, `agentId`, `stageId?`,
`sessionId?`, and a typed logger. Return values are arbitrary JSON;
errors are thrown and the runtime maps them to a tool-error envelope.

### 1.2 Per-agent tool whitelist

The dispatcher applies the per-agent allowlist before invoking the
handler. Filters live in
[saivage/src/agents/tool-filters.ts](saivage/src/agents/tool-filters.ts).
A typical filter pattern is a static `Set<string>` of allowed tool
names per `AgentRole`. New tools default to the deny-all stance: an
agent that has not been explicitly granted a tool cannot call it.

### 1.3 Error taxonomy

The runtime maps thrown errors to a wire shape via the helper in
[saivage/src/mcp/runtime.ts](saivage/src/mcp/runtime.ts). The
convention is to throw a typed error class whose `name` becomes the
top-level error code seen by the agent (e.g. `KnowledgeStoreError`
with `code: "UNAUTHORIZED_ROLE"`). The RAG errors already follow this
pattern in
[saivage/src/rag/errors.ts](saivage/src/rag/errors.ts) — every class
has a stable `name` literal and structured fields.

## 2. What agents need to do with RAG

The operations agents (and operators) realistically perform fall into
six bands:

1. **Discovery.** "What collections exist? What is in each?"
2. **Retrieval.** "Find the top-k relevant chunks for this query in
   this collection."
3. **Explicit insertion.** "Remember this text under this collection
   (no file involved)."
4. **Bulk indexing.** "Ingest this directory into this collection."
5. **Lifecycle.** "Create a new collection. Drop one. Force a
   reconcile."
6. **Operations.** "Arm/disarm the watcher. Show stats."

These map cleanly to a tool set; the only judgement call is whether
to split read vs. write across two MCP service ids.

## 3. Tool inventory

| Op band     | Tool name        | Side     | Required ctx               | Returns                                                                 |
| ----------- | ---------------- | -------- | -------------------------- | ----------------------------------------------------------------------- |
| Discovery   | `list`           | read     | none                       | `{ datasets: Array<{ id, provider, lastIngestAt }> }`                   |
| Discovery   | `stats`          | read     | `datasetId`                | `DatasetStats` (already a public RAG type)                              |
| Retrieval   | `query`          | read     | `datasetId`, `text`        | `{ hits: QueryHit[] }`                                                  |
| Insertion   | `add`            | write    | `datasetId`, `text`, `metadata?` | `{ chunkId, embeddingsCacheHit }`                                  |
| Insertion   | `ingest`         | write    | `datasetId`, `root`, `include?`, `exclude?` | `IngestReport`                                       |
| Lifecycle   | `register`       | admin    | full `DatasetConfig` (minus `projectId`) | `{ datasetId, providerStamp }`                            |
| Lifecycle   | `drop`           | admin    | `datasetId`                | `{ deleted: true }`                                                     |
| Operations  | `reconcile`      | write    | `datasetId`                | `{ scanned, changedPaths, removedPaths }`                               |
| Operations  | `watch_arm`      | admin    | `datasetId`                | `{ armed: true }`                                                       |
| Operations  | `watch_disarm`   | admin    | `datasetId`                | `{ armed: false }`                                                      |

Ten tools, three side-effect tiers (read / write / admin). Total
within the ≤ 8 cap on a single namespace once watch arm/disarm collapse
into a single `watch` tool with a `mode: "arm"|"disarm"|"reconcile"`
argument and once `register` / `drop` are admin-only and not exposed to
agents — but the design proposals decide on the actual splits.

## 4. Namespace and split options

### 4.1 Single namespace `rag`

All ten tools under one service id. Agents inherit the entire surface
via the tool whitelist. Pros: one service to discover; simpler
documentation. Cons: write tools sit next to read tools, so a
per-agent filter that meant to grant only `query` must enumerate every
read tool by name to keep `add` out.

### 4.2 Split `rag.read` / `rag.write`

`rag.read` exposes `list`, `stats`, `query`. `rag.write` exposes
`add`, `ingest`, `reconcile`, watcher controls. `rag.admin` (operator
+ Librarian only) exposes `register`, `drop`.

The split matches the per-agent filter shape: granting `rag.read.*`
gives retrieval to every agent, granting `rag.write.*` is the
Librarian's privilege, and `rag.admin.*` is reserved for the operator
identity.

The downside: agents that need to do both query and add (e.g. the
researcher writing a finding into a project-docs collection) must hold
two entries in their whitelist. This is mechanical, not painful.

### 4.3 Recommendation

The split lands cleanly with how F03 wants to wire the Librarian. The
focused proposal in the design doc will be the single-namespace
shape; the level-up alternative will be the split. The plan likely
picks the split.

## 5. Schemas (zod, before JSON Schema conversion)

### 5.1 Shared types

```ts
const DatasetIdSchema = z.string().min(1).max(64).regex(/^[a-z0-9][a-z0-9-]*$/);
const QueryFilterSchema = z.unknown(); // RAG's existing union, validated downstream
const RagSourceConfigSchema = z.union([
  z.object({ kind: z.literal("records") }),
  z.object({ kind: z.literal("fs"), root: z.string().min(1) }),
]);
```

### 5.2 `query`

```ts
{
  datasetId: DatasetIdSchema,
  text: z.string().min(1).max(4096),
  topK: z.number().int().min(1).max(32).optional(),
  filter: QueryFilterSchema.optional(),
}
→ {
  hits: Array<{
    chunkId: string;
    score: number;             // [0,1]
    text: string;
    path?: string;             // present when source is "fs"|"code"|"doc"
    scopeRef?: string;         // present for record-backed datasets
    metadata: Record<string, unknown>;
  }>;
}
```

### 5.3 `add`

```ts
{
  datasetId: DatasetIdSchema,
  text: z.string().min(1).max(65_536),
  metadata: z.record(z.unknown()).optional(),
  // Optional caller-provided id; otherwise derived from sha256(text).
  recordId: z.string().min(1).max(128).optional(),
}
→ { chunkId: string; embeddingsCacheHit: boolean; }
```

The `text` is run through `scanChunk` regardless of caller. If the
scanner trips, the tool throws `RagError` `name: "SecretDroppedError"`
and the call fails (it does NOT succeed with a counter bump — that
behaviour is for the bulk fs ingest path, not for explicit caller-text
insertion where the caller should know).

### 5.4 `ingest`

```ts
{
  datasetId: DatasetIdSchema,
  root: z.string().min(1),     // absolute or projectRoot-relative
  include: z.array(z.string()).optional(),
  exclude: z.array(z.string()).optional(),
}
→ IngestReport (the public RAG type)
```

The `root` is resolved against `ctx.projectRoot` if not absolute; it
is then run through `fsGuard.normalise(root)` to enforce the
project-local rule. Paths outside the project root are rejected with
`PATH_OUTSIDE_PROJECT`. Watcher build/cache exclusions are added to
the operator-provided `exclude` automatically (the watcher path
already does this; the explicit path here does it for parity).

### 5.5 `register`

```ts
{
  // The full DatasetConfig minus projectId — the handler injects projectId from ctx.
  id: DatasetIdSchema,
  source: RagSourceConfigSchema,
  provider: z.object({ kind: z.literal("openai"), model: z.enum(["text-embedding-3-large", "text-embedding-3-small"]), dim: z.union([z.literal(256), z.literal(512), z.literal(1024), z.literal(1536)]).optional() }),
  store: z.object({ kind: z.literal("sqlite-vec") }),
  chunker: z.object({ kind: z.enum(["markdown", "code", "memory"]), chunkSize: z.number().int().positive().optional(), overlap: z.number().min(0).max(0.5).optional() }),
  exclusions: z.array(z.string()).optional(),
  sources: z.array(z.object({ root: z.string().min(1), include: z.array(z.string()).optional(), exclude: z.array(z.string()).optional() })).optional(),
  watch: z.union([z.literal(false), z.literal(true), z.object({ usePolling: z.literal(true), interval: z.number().int().positive().optional() })]).optional(),
}
→ { datasetId: string; providerStamp: ProviderStamp; }
```

The handler is admin-side: it rejects when the calling agent is not
the Librarian or the operator. The protected ids `skills` and
`memories` (owned by F01) cannot be created or dropped via this tool
— attempts return `PROTECTED_DATASET`. Other names are free.

### 5.6 `add` permission semantics

`add` is write-side and is allowed for any agent that holds
`rag.write.*` in its whitelist, except against a `protected` dataset
(`skills` / `memories`). For those two, agents must go through the
existing knowledgeSkills / knowledgeMemory tools — they enforce the
records-layer invariants.

### 5.7 Watcher controls

```ts
// watch.arm
{ datasetId: DatasetIdSchema } → { armed: true }
// watch.disarm
{ datasetId: DatasetIdSchema } → { armed: false }
// reconcile
{ datasetId: DatasetIdSchema } → { changedPaths: string[]; removedPaths: string[]; scanned: number; }
```

`watch.arm` returns `armed: true` even if the watcher was already
armed (idempotent). `disarm` is symmetric. `reconcile` does not
require the watcher to be armed; it is the canonical convergence
mechanism per the operational runbook.

## 6. Permissions and authorisation

### 6.1 Per-tool role gate

A new helper
`saivage/src/mcp/ragPermissions.ts` exposes
`canCallRagTool(role, tool)` mirroring the shape of
`canCall(role, op, kind)` in
[saivage/src/knowledge/permissions.ts](saivage/src/knowledge/permissions.ts):

| Tool          | Default-allowed roles                                          |
| ------------- | --------------------------------------------------------------- |
| `list`        | every agent role                                                |
| `stats`       | every agent role                                                |
| `query`       | every agent role                                                |
| `add`         | librarian, researcher, designer, planner, manager               |
| `ingest`      | librarian, planner, manager                                     |
| `reconcile`   | librarian, planner, manager                                     |
| `watch.arm` / `watch.disarm` | librarian, planner, manager                       |
| `register`    | librarian, operator                                             |
| `drop`        | librarian, operator                                             |

These defaults are the floor; the per-agent whitelist in
`tool-filters.ts` is the ceiling. A role removed from the floor cannot
be re-granted by the whitelist; a role on the floor still has to be
on the whitelist to actually call it.

### 6.2 Path guard

Every tool that takes a path (`ingest.root`, `add.metadata.path`,
`reconcile.sources[*].root` if exposed) routes through
[`src/mcp/fsGuard`](saivage/src/mcp/fsGuard.test.ts) to enforce
project-locality. The guard already exists for `fs.readFile` etc.; a
small extension adds RAG-specific blocklist patterns
(`.saivage/**` is already in the secret guard, but
`.saivage/rag/**` is added explicitly to prevent indexing the RAG
store of another dataset).

### 6.3 Protected datasets

`skills` and `memories` are constants owned by F01. The tool layer
maintains a `PROTECTED_DATASET_IDS: ReadonlySet<string>` and rejects
write/admin operations against them with `PROTECTED_DATASET`.
`stats` and `query` against protected datasets are allowed — the
Librarian and the operator need to inspect them. `query` against
`skills`/`memories` returns chunk hits (not records) — agents that
want records should use the F01 search tools.

## 7. Concurrency and locking

Each dataset already serialises ingests via
[`acquireIngestLock`](saivage/src/rag/lock.ts). Two concurrent calls
to `rag.ingest` / `rag.add` against the same dataset block on the
lock; the second receives `IngestLockedError` after the configured
retry budget. The tool maps that to error code `INGEST_LOCKED` with a
`retryAfterMs` hint.

`query` is lock-free. Concurrent `query` and `ingest` are explicitly
supported by the existing sqlite-vec store (WAL mode + a
per-connection read snapshot).

## 8. Discovery surface

Agents discover existing datasets in two ways:

1. **At runtime, via `rag.list`.** The Librarian and the planner are
   expected to call this at the start of a task.
2. **At boot, via prompt injection.** A small fragment, generated by
   [`src/agents/conventions.ts`](saivage/src/agents/conventions.ts),
   lists the currently-registered dataset ids and their stated
   purposes (read from a per-dataset `description` field — new optional
   field on `DatasetConfig` from F02's perspective; F02 either ships
   the field or skips it and leaves the prompt injection for F03).

F02 chooses to NOT add the `description` field; F01 fixed
`DatasetConfig` and adding to it crosses the "no changes to
`src/rag/`" line. Discovery is via `rag.list` only. The Librarian
prompt (F03) carries the contextual descriptions.

## 9. Telemetry and logging

Each tool emits one structured log line per invocation:

```
{
  "ts": "...",
  "agent": "librarian",
  "tool": "rag.ingest",
  "datasetId": "project-docs",
  "argsRedacted": { "root": "<projectRoot>/docs", "include": ["**/*.md"] },
  "result": { "ok": true, "chunksUpserted": 42, "durationMs": 813 },
}
```

`text` arguments to `query` and `add` are truncated to the first 256
characters in the log line; full text is never written to the runtime
log.

Per-dataset counters (`ingests_total`, `chunks_added_total`,
`secrets_dropped_total`, `query_count`) are exposed via the existing
metrics mechanism in
[saivage/src/runtime/](saivage/src/runtime/) — F02 adds the counter
declarations; existing infrastructure carries them.

## 10. Configuration

F02 introduces no new top-level config keys. It does add a documented
expectation: every dataset registered via `rag.register` is persisted
to the RAG registry
([saivage/src/rag/registry.ts](saivage/src/rag/registry.ts)) which
already lives on disk. `saivage.json`'s `rag.datasets` continues to
declare the **bootstrap** set; runtime registrations are additive and
survive restarts via the registry file.

A protective contract: if `saivage.json` declares a dataset with id
X and the registry contains a dataset with id X whose `providerStamp`
differs, the runtime errors at startup with `RAG_CONFIG_DRIFT`. There
is no automatic resolution — the operator picks who wins by editing
the config or dropping the registry entry.

## 11. Failure-to-error mapping

| RAG error                  | Tool error code             | Returned hint                                |
| -------------------------- | --------------------------- | -------------------------------------------- |
| `ConfigDriftError`         | `CONFIG_DRIFT`              | "drop and re-register: dataset {id}"         |
| `EmbeddingDriftError`      | `EMBEDDING_DRIFT`           | "drop and re-ingest: dataset {id}"           |
| `CorruptedStoreError`      | `STORE_CORRUPTED`           | "drop and re-ingest: dataset {id}"           |
| `ProviderUnavailableError` | `PROVIDER_UNAVAILABLE`      | `{ retryAfterMs }`                           |
| `IngestLockedError`        | `INGEST_LOCKED`             | `{ retryAfterMs: 1000 }`                     |
| `SecretDroppedError`       | `SECRET_DETECTED`           | "rewrite without the secret and retry"       |
| `DatasetNotFoundError`     | `DATASET_NOT_FOUND`         | "call rag.list to see registered datasets"   |
| `InvalidQueryFilterError`  | `INVALID_QUERY_FILTER`      | shape hint                                    |
| `WatcherUnavailableError`  | `WATCHER_UNAVAILABLE`       | "use watch: { usePolling: true }"            |

Plus the F02-introduced codes:

| Code                       | When                                                              |
| -------------------------- | ----------------------------------------------------------------- |
| `PROTECTED_DATASET`        | write/admin op against `skills` or `memories`                     |
| `RAG_CONFIG_DRIFT`         | startup with mismatched `saivage.json` ↔ registry stamps          |
| `PATH_OUTSIDE_PROJECT`     | `ingest.root` / `reconcile` root resolves outside projectRoot     |
| `UNAUTHORIZED_RAG_TOOL`    | role missing from tool's permission floor                         |

## 12. Files to add / modify

| File                                             | Action                                                              |
| ------------------------------------------------ | ------------------------------------------------------------------- |
| `src/mcp/rag.ts` (new) or `src/mcp/ragRead.ts` + `src/mcp/ragWrite.ts` (new, on the split path) | tool entries + handlers       |
| `src/mcp/ragPermissions.ts` (new)                | per-tool role floor + `PROTECTED_DATASET_IDS` constant              |
| `src/mcp/builtins.ts`                            | register the new service(s)                                         |
| `src/agents/tool-filters.ts`                     | per-agent whitelist updates (every agent gets `rag.read.*`; nobody gets write except librarian, planner, manager) |
| `src/mcp/types.ts`                               | extend `ToolEntry` if needed for the new error mapping (likely no change) |
| `src/runtime/start.ts`                           | reconcile-registry-vs-config check at startup                       |
| `SPEC/v2/rag/agent-tools.md` (new)               | documentation                                                       |
| `src/mcp/rag.test.ts` (new)                      | per-tool unit tests with a fake `RagManager`                        |
| `src/mcp/rag.integration.test.ts` (new)          | end-to-end: register, ingest, query, drop via the runtime           |

## 13. Non-goals

- No "policy DSL" for fine-grained per-dataset role rules; the floor +
  whitelist combo is enough.
- No streaming results for `query`; top-k arrives in one response.
- No background ingest scheduling — the watcher and `reconcile` cover
  it; nothing else is added.
- No bulk export tool. The operator can read the sqlite-vec file
  directly.
- The Librarian's higher-level reasoning lives in F03; F02 stops at
  the tool surface.
