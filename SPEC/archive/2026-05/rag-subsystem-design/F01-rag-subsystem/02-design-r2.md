# F01 — RAG subsystem design

## 1. Scope

This document specifies the design of the Saivage v2 RAG (retrieval-augmented generation) subsystem as a library/module that lives inside the Saivage v2 process and serves multiple logically independent datasets per project. The library exposes a dataset-centric surface: register, ingest, query, stats, rebuild, drop. It owns its on-disk layout under each project's `.saivage/rag/` tree, owns its own embedding-provider abstraction, and owns its own chunking and metadata pipeline. It does NOT cover integration with consumers (skills loader at [saivage/src/knowledge/store.ts](saivage/src/knowledge/store.ts), memory manager at [saivage/src/knowledge/lifecycle.ts](saivage/src/knowledge/lifecycle.ts), planner, target-project doc tree, target-project source tree); those wirings are deferred to a future spec. The library exists in isolation in v1 and is opt-in via project configuration; absent configuration, no code path is exercised, no disk artifact is created, no dependency is loaded.

## 2. Constraints carried into design

- Node LTS >= 24, ESM, TypeScript. [saivage/package.json](saivage/package.json) `engines.node` is raised from `>=20.0.0` to `>=24.0.0` as part of this work.
- Architecture-first; no backward compatibility. No on-disk schema versions, no migration shims, no compatibility checks against hypothetical prior RAG layouts.
- No over-engineering. No sharding, no replication, no hybrid BM25+vector, no reranker, no cross-dataset query, no streaming KNN, no per-query mode/role knob exposed to callers.
- No daemon required. Embedded vector store. No Docker, no separate server.
- Provider keys never read directly. The library asks the existing provider abstraction for an authenticated client.
- Secrets never embedded. Mandatory exclusion glob set wraps all readers; per-chunk regex scan runs before embedding.

## 3. Two design proposals

### 3.1 Proposal A — Focused in-process library

The smallest viable RAG library that meets the scope above. One vector store (sqlite-vec on better-sqlite3), one hosted embedding provider default (OpenAI `text-embedding-3-small`), one chunker family (markdown + code + memory variants), and three explicitly named seams for later substitution.

#### 3.1.1 Module layout

```
saivage/src/rag/
  index.ts                  // public re-exports only
  types.ts                  // Chunk, ChunkMetadata, QueryFilter, DatasetConfig, ProviderStamp, RagError
  manager.ts                // RagManager: register/ingest/delete/query/stats/rebuild/drop
  config.ts                 // Zod schema for project-config slice; resolves provider + store + chunker
  provider/
    index.ts                // EmbeddingProvider interface, ProviderRegistry
    openai.ts               // OpenAIEmbeddingProvider (only impl in v1)
  store/
    index.ts                // VectorStore interface
    sqlite-vec.ts           // SqliteVecStore (only impl in v1)
    sql.ts                  // composed SQL fragments for pre-filter vs. post-filter
  chunker/
    index.ts                // Chunker interface
    markdown.ts             // header-recursive splitter
    code.ts                 // tree-sitter-aware + regex/blank-line fallback
    memory.ts               // atomic-up-to-1000-tokens splitter
    tokens.ts               // js-tiktoken adapter; char/4 fallback
  ingest/
    walker.ts               // filesystem walker with exclusion globs and symlink-cycle guard
    pipeline.ts             // file diff -> chunk diff -> embed -> upsert
    secrets.ts              // exclusion globs + per-chunk regex scan
    lock.ts                 // per-dataset cross-process lock via proper-lockfile
  cache/
    embedding-cache.ts      // (provider, model, dim, releaseFingerprint, sha256(content)) -> vector
  errors.ts                 // typed errors: ConfigDrift, Corrupted, ProviderUnavailable, IngestLocked, SecretDropped
```

No `services/`, no `repositories/`, no `controllers/`. The library is small enough that the manager talks to provider, store, and chunker directly.

#### 3.1.2 Public surface

```ts
export interface DatasetConfig {
  id: string;
  projectId: string;
  source: "skill" | "memory" | "doc" | "code";
  provider: EmbeddingProviderRef;
  store: VectorStoreRef;
  chunker: ChunkerRef;
  exclusions?: string[];
}

export interface RagManager {
  register(config: DatasetConfig): Promise<Dataset>;
  list(): Promise<Dataset[]>;
  get(id: string): Promise<Dataset>;
}

export interface Dataset {
  readonly id: string;
  readonly config: Readonly<DatasetConfig>;
  ingest(input: IngestInput): Promise<IngestReport>;
  delete(filter: QueryFilter | { chunkIds: string[] }): Promise<number>;
  query(text: string, options?: QueryOptions): Promise<QueryHit[]>;
  stats(): Promise<DatasetStats>;
  rebuild(input: IngestInput): Promise<IngestReport>;
  drop(): Promise<void>;
}

export type IngestInput =
  | { kind: "fs"; root: string; include: string[]; exclude?: string[] }
  | { kind: "records"; items: Array<{ id: string; text: string; metadata: ChunkMetadataInput }> };

export interface IngestReport {
  filesScanned: number;
  filesChanged: number;
  chunksUpserted: number;
  chunksDeleted: number;
  chunksDroppedSecrets: number;
  tokensEmbedded: number;
  embeddingMs: number;
  storeMs: number;
}

export interface QueryOptions {
  topK?: number;          // default 10
  filter?: QueryFilter;
}

export interface QueryHit {
  chunkId: string;
  score: number;
  text: string;
  metadata: ChunkMetadata;
}

export type QueryFilter =
  | { eq: Record<string, string | number | null> }
  | { and: QueryFilter[] }
  | { or: QueryFilter[] }
  | { gt: Record<string, number>; lt?: Record<string, number> }
  | { pathGlob: string }
  | { in: Record<string, Array<string | number>> };

export interface DatasetStats {
  chunks: number;
  files: number;
  bytesOnDisk: number;
  provider: ProviderStamp;
  lastIngestAt: string | null;
  secretsDropped: number;
}

export interface ProviderStamp {
  provider: string;
  model: string;
  dim: number;
  releaseFingerprint: string;
}

export interface EmbeddingProvider {
  readonly stamp: ProviderStamp;
  embedDocuments(texts: string[]): Promise<Float32Array[]>;
  embedQuery(text: string): Promise<Float32Array>;
}

export interface VectorStore {
  readonly path: string;
  open(stamp: ProviderStamp): Promise<void>;
  upsert(rows: StoredChunk[]): Promise<void>;
  deleteByFilter(filter: QueryFilter): Promise<number>;
  deleteByIds(ids: string[]): Promise<number>;
  query(vector: Float32Array, topK: number, filter?: QueryFilter): Promise<StoredHit[]>;
  stats(): Promise<{ chunks: number; files: number; bytesOnDisk: number; lastIngestAt: string | null }>;
  close(): Promise<void>;
  drop(): Promise<void>;
}

export interface Chunker {
  chunk(input: ChunkerInput): AsyncIterable<RawChunk>;
}
```

`register` is async because it opens the store file and validates the stamp on first use. `list` and `get` are async to keep the manager free to read its registry off disk if a later iteration moves the registry out of memory.

#### 3.1.3 Data flow — ingest

```
operator / future consumer
  -> Dataset.ingest(IngestInput)
  -> acquire per-dataset cross-process lock at <projectRoot>/.saivage/rag/<datasetId>/.ingest.lock
  -> walker.walk(input)
       fs mode: traverse include globs, apply exclusion globs, resolve symlinks once,
                yield {path, sourceHash, mtimeMs}
       records mode: yield records as-is
  -> for each batch of files (or records):
       diff against store: skip when sourceHash unchanged
       call Chunker.chunk(file/record) producing RawChunk[]
       compute contentHash per chunk
       symmetric-difference vs. existing store rows for (datasetId, path)
       drop chunks rejected by secrets.scanChunk(text)
       embedding-cache lookup by (stamp, contentHash); collect cache misses
       batch cache-miss texts -> provider.embedDocuments(texts) honouring batch size cap
       store.upsert(StoredChunk[]) inside one transaction per batch
       store.deleteByIds(stale chunk ids) inside same transaction
  -> release lock
  -> return IngestReport
```

#### 3.1.4 Data flow — query

```
caller
  -> Dataset.query(text, options)
  -> provider.embedQuery(text)            // network bound; ~80-250 ms hosted typical
  -> store.query(vector, K * overshoot, filter)   // sqlite-vec brute-force KNN
  -> post-filter (when the filter shape can not be expressed as pre-filter)
  -> hydrate text + metadata for top-K rowids
  -> return QueryHit[] sorted by score desc
```

The store-adapter decides pre-filter vs. post-filter internally. For sqlite-vec, equality and `in` predicates on indexed metadata columns become a candidate-rowid subquery feeding the `MATCH`; range and low-selectivity predicates run as a SQL `WHERE` after the `MATCH` with an internal overshoot multiplier applied to K. Callers never see this knob.

#### 3.1.5 On-disk layout — per dataset

```
<projectRoot>/.saivage/rag/
  registry.json                       // [{id, projectId, source, providerStamp, createdAt}]
  <datasetId>/
    store.db                          // sqlite-vec virtual table + sibling metadata table + embedding cache
    store.db-wal                      // SQLite WAL (transient)
    store.db-shm                      // SQLite shared memory (transient)
    .ingest.lock                      // proper-lockfile cross-process lock held during ingest
    .corrupted                        // sentinel written when PRAGMA integrity_check fails
```

One `.db` per dataset. Justification: lifecycle ops (`drop`, `rebuild`) become an `unlink` plus a fresh open; corruption in one dataset never blocks queries against the others; per-dataset locks are local to the file the lock protects; backups are file-granular.

`registry.json` holds only the operator-visible dataset list and the provider stamp captured at registration. The authoritative provider stamp lives in the store file itself, in a `meta` SQLite table; `registry.json` is a cache for `RagManager.list()` and a hint for "what datasets exist on this project."

#### 3.1.6 SQLite schema inside `store.db`

```
CREATE TABLE meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
-- rows: provider, model, dim, releaseFingerprint, createdAt, lastIngestAt, secretsDroppedTotal

CREATE TABLE chunk (
  id            TEXT PRIMARY KEY,         -- sha256(contentNormalized || '\0' || path || '\0' || startLine || '\0' || endLine)
  path          TEXT NOT NULL,
  source        TEXT NOT NULL,
  chunkIndex    INTEGER NOT NULL,
  startLine     INTEGER,
  endLine       INTEGER,
  contentHash   TEXT NOT NULL,
  sourceHash    TEXT NOT NULL,
  mtimeMs       INTEGER NOT NULL,
  language      TEXT,
  headingPath   TEXT,
  symbolName    TEXT,
  symbolKind    TEXT,
  scope         TEXT,
  scopeRef      TEXT,
  role          TEXT,
  lifecycleStatus TEXT,
  createdAt     INTEGER,
  supersedes    TEXT,
  text          TEXT NOT NULL
);

CREATE INDEX chunk_path_idx        ON chunk(path);
CREATE INDEX chunk_source_idx      ON chunk(source);
CREATE INDEX chunk_scope_idx       ON chunk(scope, scopeRef);
CREATE INDEX chunk_role_idx        ON chunk(role);
CREATE INDEX chunk_language_idx    ON chunk(language);
CREATE INDEX chunk_createdAt_idx   ON chunk(createdAt);
CREATE INDEX chunk_contentHash_idx ON chunk(contentHash);
CREATE INDEX chunk_sourceHash_idx  ON chunk(path, sourceHash);

CREATE VIRTUAL TABLE vec_chunk USING vec0(
  id TEXT PRIMARY KEY,
  embedding FLOAT[/* dim */]
);

CREATE TABLE embedding_cache (
  key TEXT PRIMARY KEY,                 -- sha256(stamp || '\0' || contentHash)
  vector BLOB NOT NULL                  -- Float32Array bytes
);

CREATE TABLE file_state (
  path        TEXT PRIMARY KEY,
  sourceHash  TEXT NOT NULL,
  mtimeMs     INTEGER NOT NULL,
  lastIngestAt INTEGER NOT NULL
);
```

`vec_chunk.id` is identical to `chunk.id`; the join is on the primary key. The `dim` literal in the `vec0` declaration is the dimension stamped at create time; if a later open detects a mismatched stamp in `meta`, the store refuses and asks for `rebuild`.

`PRAGMA journal_mode = WAL` and `PRAGMA synchronous = NORMAL` at open. WAL gives crash-safe writes without blocking concurrent readers, and `NORMAL` is the right safety/throughput trade for derived data that can always be regenerated.

#### 3.1.7 Configuration surface

A new top-level `rag` section is added to the project configuration schema at [saivage/src/config.ts](saivage/src/config.ts). This document defines the schema shape; the actual Zod definition is added in implementation. The shape:

```ts
// schema fragment for the rag config block
rag: z.object({
  enabled: z.boolean().default(false),
  datasets: z.array(z.object({
    id: z.string().min(1),
    source: z.enum(["skill", "memory", "doc", "code"]),
    provider: z.object({
      kind: z.literal("openai"),
      model: z.literal("text-embedding-3-small").default("text-embedding-3-small"),
      dim: z.union([z.literal(256), z.literal(512), z.literal(1024), z.literal(1536)]).default(1536),
    }),
    store: z.object({
      kind: z.literal("sqlite-vec").default("sqlite-vec"),
    }).default({ kind: "sqlite-vec" }),
    chunker: z.object({
      kind: z.enum(["markdown", "code", "memory"]),
      chunkSize: z.number().int().positive().optional(),
      overlap: z.number().min(0).max(0.5).optional(),
    }),
    exclusions: z.array(z.string()).default([]),
  })).default([]),
}).default({ enabled: false, datasets: [] }),
```

`enabled: false` makes the subsystem inert: `RagManager` is not constructed, no native deps load, no `.saivage/rag/` directory is created. Operator opt-in is a single boolean.

Additional change in [saivage/package.json](saivage/package.json):

```
"engines": { "node": ">=24.0.0" }
```

Provider credentials are not part of the `rag` config slice. The provider factory in `provider/openai.ts` calls the existing auth abstraction (`AuthProfile` resolution that already serves OpenAI for chat completions) and asks for an authenticated `openai` client. The RAG layer never touches `.saivage/auth-profiles.json`.

#### 3.1.8 Multi-dataset isolation

One `.db` per dataset. Rejected alternative: one `.db` with one `vec0` virtual table per dataset, sharing `embedding_cache` and `meta`. Reasons for one-file-per-dataset:

- `drop(datasetId)` becomes `close()` + `unlink(store.db, store.db-wal, store.db-shm)`. With shared file, `drop` would need a vacuum + DELETE pass with no straightforward way to reclaim the disk.
- Corruption in one dataset (power loss while writing dataset C) does not block queries against dataset A or B; with a shared file, `PRAGMA integrity_check` failure poisons all datasets.
- Per-dataset file locks (ingest mutex) are obvious and local. With a shared file, the lock would have to be a logical row in a `lock` table; multi-process safety becomes harder.
- Per-dataset `dim` differs across datasets (the metadata schema requires distinct `vec0` declarations per `dim`); separate files avoid mixing declarations inside one schema.

The per-dataset `dim` choice (256 / 512 / 1024 / 1536) is therefore a property of the dataset, not the project; the same project may run docs at 1536-d and code at 512-d.

#### 3.1.9 Failure modes and design responses

| Failure | Design response |
|---|---|
| Provider outage at query time | `provider.embedQuery` throws; `Dataset.query` re-throws `ProviderUnavailable`. No fallback model. |
| Provider 429 at ingest time | `OpenAIEmbeddingProvider` honors `Retry-After`; on persistent failure (capped attempts) throws; `pipeline` rolls back the current batch transaction; `IngestReport` is not returned; next `ingest` resumes via `file_state` diff. |
| Embedding-config drift | Mismatch on any of {provider, model, dim, releaseFingerprint} between query-time provider and stored dataset metadata -> query refused with `EmbeddingDriftError`; `dataset.rebuild()` is the only recovery. |
| Corrupt `store.db` | `open` runs `PRAGMA integrity_check`; on failure, writes the `.corrupted` sentinel, throws `Corrupted`, query/ingest refuse. Operator runs `rebuild` (which `drop`s the dataset directory first). |
| Concurrent ingest from two processes | `pipeline` acquires the per-dataset `proper-lockfile` lock at `<datasetId>/.ingest.lock` (TTL ~60s with auto-refresh while the ingest is alive). Second process sees a live lock and throws `IngestLocked` immediately; it does NOT wait. A stale lock (owner died) is retried exactly once and then fails with `IngestLocked` so the operator decides whether to retry. |
| Accidental ingest of secrets | `secrets.shouldSkipPath` runs over every path before `readFile`; `secrets.scanChunk` runs over every chunk before `provider.embedDocuments`; matched chunks are dropped, `IngestReport.chunksDroppedSecrets` counts them, `meta.secretsDroppedTotal` accumulates. The non-overridable credential glob set and key-pattern regex set live in `secrets.ts`. |
| Native crash (`better-sqlite3` segfault) | Takes the Saivage process down; `PRAGMA integrity_check` at startup is the cheapest pre-emption. No worker isolation in v1. |
| Mid-ingest crash | Batch transactions guarantee per-batch atomicity. `rebuild` writes to `<datasetId>.new/store.db` and renames at the end; orphan `.new` directories are cleaned on the next open. |

#### 3.1.10 Threading

| Operation | Blocking? | Worker offload in v1? |
|---|---|---|
| `provider.embedQuery` (HTTPS) | Network I/O, yields | No |
| `provider.embedDocuments` (HTTPS, batched) | Network I/O, yields | No |
| `store.upsert` (better-sqlite3) | Sync native call; sub-ms per row; batches sized to keep loop hold under ~5 ms | No |
| `store.query` (sqlite-vec KNN) | Sync native call; 5-25 ms at 50k vectors / 1536-d, sub-ms at <10k | No |
| markdown / memory chunker | Pure JS, fast | No |
| code chunker (tree-sitter) | Native call per file; tens of ms on large files | No (single-process v1) |
| `secrets.scanChunk` (regex) | Pure JS, fast | No |
| `walker` (fs.readdir + fs.stat) | Async fs I/O | No |
| Local embedding (future) | CPU-bound, would block | Yes (`worker_threads`); reserved as a seam, not built in v1 |

The single reserved seam is the embedding provider interface: a local-embedding implementation will own its `worker_threads` pool internally and the `EmbeddingProvider` interface stays unchanged. The store and chunker have no such offload path planned because they are not currently bottlenecks.

#### 3.1.11 Test surface (shape only)

Unit:

- `chunker/markdown.test.ts` — header recursion, oversized section split, undersized greedy merge, ~15% overlap, heading-path metadata, empty section handling.
- `chunker/code.test.ts` — tree-sitter happy path (TS, Python), oversized-declaration split, undersized merge, regex/blank-line fallback when grammar fails to load, symbol metadata absent in fallback mode.
- `chunker/memory.test.ts` — atomic for short bodies, falls through to markdown for >1000-token bodies, sub-chunks share `recordId`.
- `chunker/tokens.test.ts` — js-tiktoken parity with OpenAI for `cl100k_base`; char/4 fallback bounds.
- `ingest/secrets.test.ts` — every credential glob blocks the matching path; every key regex drops the matching chunk; non-credential globs are operator-overridable.
- `ingest/walker.test.ts` — exclusion globs short-circuit `readdir`, symlink cycle is broken at second visit, `**/.git/**` always excluded.
- `ingest/lock.test.ts` — `proper-lockfile` acquire/release happy path, double-acquire from same process throws `IngestLocked`, lock auto-refresh keeps the lock alive past TTL while owner is live, stale-lock (TTL expired, no owner) is retried exactly once then fails.
- `cache/embedding-cache.test.ts` — hit/miss, key derivation includes stamp, eviction by content-hash uniqueness only.
- `store/sqlite-vec.test.ts` — open creates schema, dim mismatch refuses, integrity-check failure refuses, upsert is idempotent on same `id`, deleteByFilter matches every `QueryFilter` shape, query returns top-K in score order.
- `errors.test.ts` — typed errors carry the documented fields.

Integration:

- `manager.integration.test.ts` — `register` + `ingest` (fs mode) over a fixture tree under `tmp/rag-fixtures/docs/`, `query` returns relevant chunks, `rebuild` produces identical results, `drop` removes the directory.
- `provider/openai.integration.test.ts` — gated by an `OPENAI_API_KEY` env presence; skipped otherwise; embeds a known string and asserts `dim` and the stamp.
- `concurrency.integration.test.ts` — two processes attempting `ingest` on the same dataset; second one throws `IngestLocked`; data is consistent after the first completes.
- `crash-recovery.integration.test.ts` — kill mid-ingest; restart; `rebuild` from staging directory completes; prior good index intact for the non-staging path.

No tests written in this document. The list above only enumerates the test files implied by the design surface.

### 3.2 Proposal B — Generic content store at the next conceptual level

A larger architectural move: introduce a generic "content store" layer that is the single way Saivage v2 keeps any addressable bag of text records, with retrieval (lexical and vector) as one of its capabilities. The existing knowledge store at [saivage/src/knowledge/store.ts](saivage/src/knowledge/store.ts), the built-in skills loader, and any future doc or code indexer would migrate onto this layer over time. RAG is one query mode on top of it. An MCP server can be exposed so external agents query datasets without speaking Saivage's internal API.

#### 3.2.1 Module layout

```
saivage/src/content-store/
  index.ts
  types.ts                  // Collection, Record, RecordMetadata, IndexSpec, Query, Hit
  manager.ts                // ContentStoreManager: collection lifecycle
  collection.ts             // Collection: records CRUD + index attach/detach + query
  schema.ts                 // metadata schema definitions per collection; Zod
  index/
    index.ts                // Index interface (lexical | vector); IndexRegistry
    vector-sqlite-vec.ts    // sqlite-vec adapter
    vector-lance.ts         // LanceDB adapter (alternative)
    lexical-fts5.ts         // SQLite FTS5 adapter (for future hybrid)
  store/
    index.ts                // RecordStore interface
    sqlite-records.ts       // per-collection SQLite DB holding the collection's canonical records
  provider/                 // unchanged from Proposal A
  chunker/                  // unchanged from Proposal A but renamed transformers/
  ingest/
    pipeline.ts             // produces records, attaches indexes
  mcp/
    server.ts               // MCP server exposing query operations across collections
    tools.ts                // MCP tool definitions
  migrations/
    knowledge-to-content-store.ts   // (future spec, not implemented)
```

Records live in a per-collection `records.db` under that collection's directory; vector and lexical indexes live in sibling files in the same directory. The skills and memory subsystems would eventually call `collection.upsert(record)` and `collection.query(...)` instead of operating on their own SQLite shape — but that migration is out of scope for this work and would be its own spec.

#### 3.2.2 Public surface

```ts
export interface ContentStoreManager {
  collection(id: string): Promise<Collection>;
  list(): Promise<CollectionDescriptor[]>;
  create(spec: CollectionSpec): Promise<Collection>;
  drop(id: string): Promise<void>;
}

export interface Collection {
  readonly id: string;
  upsert(records: ContentRecord[]): Promise<void>;
  delete(filter: RecordFilter | { ids: string[] }): Promise<number>;
  get(id: string): Promise<ContentRecord | null>;
  query(q: ContentQuery): Promise<ContentHit[]>;
  attachIndex(spec: IndexSpec): Promise<void>;
  detachIndex(name: string): Promise<void>;
  stats(): Promise<CollectionStats>;
}

export interface ContentQuery {
  index: string;          // "vec-default" | "fts-default" | ...
  vectorQuery?: string;   // text to embed
  lexicalQuery?: string;  // FTS5 MATCH expression
  filter?: RecordFilter;
  topK?: number;
}

export interface IndexSpec {
  name: string;
  kind: "vector" | "lexical";
  provider?: EmbeddingProviderRef;       // when kind = vector
  store?: VectorStoreRef;
  fts?: { language: string };            // when kind = lexical
}
```

Compared with Proposal A, the API is two levels deep (`manager.collection -> collection.method`), the record is the unit instead of the chunk (chunking becomes an ingest transformer per index), and indexes are first-class attachable objects so a single collection can have multiple indexes attached (vector + lexical) for future hybrid retrieval.

#### 3.2.3 Data flow — ingest

```
operator / consumer
  -> ingest.pipeline(collectionId, source)
  -> ingest.pipeline transforms source -> ContentRecord[]
  -> collection.upsert(records) writes to <collectionId>/records.db (canonical text + metadata)
  -> for each attached index:
       if vector: chunker.chunk(record.text) -> embed -> <collectionId>/vec.db
       if lexical: FTS5 insert into <collectionId>/fts.db
```

#### 3.2.4 Data flow — query

```
caller
  -> collection.query({index, vectorQuery, filter})
  -> dispatch on index.kind:
       vector: provider.embedQuery -> vector index .query -> rowids -> hydrate from records.db
       lexical: FTS5 MATCH -> rowids -> hydrate from records.db
  -> apply filter post-hoc when the index can not pre-filter
  -> return ContentHit[]
```

#### 3.2.5 On-disk layout

```
<projectRoot>/.saivage/rag/
  registry.json                         // [{id, schemaRef, indexes[], createdAt}]
  <collectionId>/
    records.db                          // canonical records for this collection
    vec.db                              // vector index (sqlite-vec) when attached
    fts.db                              // lexical index (FTS5) when attached
    .ingest.lock                        // per-collection cross-process lock
```

One directory per collection, mirroring Proposal A's per-dataset isolation: a collection is the level-up equivalent of a dataset and gets its own canonical records file plus one file per attached index. `drop(collectionId)` is an `unlink` of the directory; corruption in one collection's `records.db` does not poison any other collection; per-collection locks are obvious and local.

#### 3.2.6 Configuration surface

```ts
// schema fragment for the contentStore config block
contentStore: z.object({
  enabled: z.boolean().default(false),
  collections: z.array(z.object({
    id: z.string(),
    schemaRef: z.string(),
    indexes: z.array(z.object({
      name: z.string(),
      kind: z.enum(["vector", "lexical"]),
      provider: z.object({ kind: z.literal("openai"), model: z.string(), dim: z.number() }).optional(),
      store: z.object({ kind: z.enum(["sqlite-vec", "lance"]) }).optional(),
      chunker: z.object({ kind: z.enum(["markdown", "code", "memory"]) }).optional(),
      fts: z.object({ language: z.string() }).optional(),
    })),
  })).default([]),
  mcp: z.object({
    enabled: z.boolean().default(false),
    bind: z.string().default("127.0.0.1:0"),
  }).default({ enabled: false, bind: "127.0.0.1:0" }),
}).default({ enabled: false, collections: [], mcp: { enabled: false, bind: "127.0.0.1:0" } }),
```

The slice is parsed in [saivage/src/config.ts](saivage/src/config.ts). The MCP server is opt-in. When enabled, it registers tools like `content_store.query`, `content_store.list_collections`, `content_store.stats`, gated to localhost.

#### 3.2.7 Multi-collection isolation

Each collection owns its own directory under `<projectRoot>/.saivage/rag/<collectionId>/` and its own `records.db` + index files. Trade-off vs. a shared canonical store: cross-collection consistency requires application-level fan-out rather than a single SQL transaction, but `drop(collectionId)` is `close()` + `unlink` of the directory, corruption is scoped to one collection, and per-collection ingest mutexes do not serialize unrelated writers. This matches Proposal A's isolation properties.

#### 3.2.8 Failure modes and design responses

Same list as Proposal A, with these additions:

- A collection's `records.db` corruption only poisons that collection's records and forces a rebuild of its attached indexes; other collections are unaffected.
- MCP server crashes are isolated from the main Saivage process only if the MCP server runs in a child process; if it runs in-process, a crash in the MCP transport takes Saivage down.
- The knowledge-store migration is open-ended; until it ships, Saivage carries both the existing knowledge store and the content store, with the second indexing a copy of the first. That doubles the write surface and creates a real consistency hazard.

#### 3.2.9 Threading

Identical to Proposal A for the embedding and store paths. Adds an HTTP/MCP transport thread when the MCP server is enabled (Fastify or a small dedicated server in-process is sufficient; no `worker_threads` requirement for transport).

#### 3.2.10 Test surface (shape only)

Adds, on top of Proposal A's list:

- `collection.test.ts` — record CRUD, multi-index attach/detach, filter dispatch to the right index.
- `index/lexical-fts5.test.ts` — basic FTS5 query, language analyzer round-trip.
- `mcp/server.integration.test.ts` — boot, call `content_store.query` via the MCP client, assert response shape; gated to localhost.
- Migration tests for the knowledge-store move would be a separate spec entirely.

#### 3.2.11 Cost vs. value, honestly

What Proposal B buys, beyond Proposal A:

- A single substrate that the existing knowledge store, skills loader, and any future doc/code indexer can converge onto over time. Reduces the number of bespoke SQLite layouts in Saivage from N to 1 — eventually.
- First-class lexical (FTS5) and vector indexes side by side. Enables future hybrid retrieval without surgery.
- Opt-in MCP exposure: external agents (other Saivage instances, third-party MCP-capable clients) can query collections without speaking the internal API.

What Proposal B costs:

- A larger public surface: collections + records + indexes + index specs vs. datasets + chunks.
- Migration of the existing knowledge store is an open project of its own. Until it ships, the new layer indexes a copy of knowledge-store rows and the consistency problem is real.
- MCP server is an attack surface the focused design does not introduce.
- Schema discipline is harder because collections are generic — the metadata-schema-per-collection pattern has to actually be enforced, or the layer degenerates into a `JSON` column free-for-all.
- More code paths to test and review for the same v1 deliverable (no consumer integrations in this scope).

The "one conceptual level up" framing is real, but it is paying for capabilities that are explicit non-goals in v1: hybrid retrieval, cross-collection consumers, external MCP query, knowledge-store migration. The first version that exercises those capabilities is the right place to introduce the generic layer; doing it now is buying a generic substrate to host one concrete use case.

## 4. Recommendation

Proposal A — the focused in-process library at [saivage/src/rag/](saivage/src/rag/) — is recommended.

Justification, against the F01 constraints:

- Minimalism: Proposal A adds one module, one vector store, one provider, three chunkers, opt-in by a single boolean. No daemon, no MCP transport, no shared records substrate.
- Architecture-first: the three pluggable interfaces (`EmbeddingProvider`, `VectorStore`, `Chunker`) are the right seams to keep. They are the seams the analysis flagged as load-bearing for future change (local embedding, LanceDB fallback, AST chunker variants). Proposal B's "everything is a collection with attachable indexes" abstraction is not load-bearing in v1 because there is exactly one consumer and exactly one query mode.
- No over-engineering: Proposal B advertises future hybrid retrieval, cross-collection queries, MCP exposure, and knowledge-store migration as benefits. All four are explicit non-goals in v1. Building the substrate to host them before they ship is exactly the failure mode the F01 constraints push back on.
- No backward compatibility: both proposals respect this; Proposal A respects it with much less surface area to keep clean.
- Validation cost: Proposal A's test surface is half the size of Proposal B's. Faster to get to a green build and a verifiable smoke test.

Proposal B is the right design for the first version that integrates skills, memories, docs, and code consumers under one substrate AND wants to expose them over MCP. That version is not this version.

## 5. Explicit non-goals

This design does NOT cover:

- Hybrid BM25 + vector retrieval.
- Cross-dataset query in a single call (callers fan out and merge).
- Reranking (cross-encoder or LLM-as-reranker).
- MCP server surface around the RAG library.
- Integration adapters for the existing knowledge store at [saivage/src/knowledge/store.ts](saivage/src/knowledge/store.ts), built-in skills at [saivage/skills/builtin/](saivage/skills/builtin/), target-project doc trees, or target-project source trees. The library is registered, ingested, and queried by tests in v1; the wiring into consumers is a separate spec.
- Local embedding integration (the seam exists; no implementation ships).
- Telemetry / metrics / tracing emitted by the RAG layer. Logs only.
- Encryption-at-rest. The store inherits `.saivage/` directory permissions (0700/0600 where the OS supports them).
- Multi-tenant query across projects.
- Streaming / cursor-style queries.
- Quantization (float16, int8) of stored vectors.
- A write-ahead queue or background ingest worker; ingest is synchronous from the caller's view.
- A `mode` / `input_type` knob in the query payload; the provider decides internally.
- Free-form `tags[]` metadata. Every metadata field maps to a documented filter.
- Migrating any existing on-disk format. There is no prior RAG format to migrate from.
- Operator UI or web dashboard for the RAG store. Visibility is via `Dataset.stats()` and structured logs only.

## 6. Dependencies to add

All entries are ESM-friendly under Node >=24 and ship prebuilt binaries for Linux x64 where native; the implementer must reverify the prebuild matrix before merging.

| Package | Version expectation | License | Role | Prebuilt Linux x64 |
|---|---|---|---|---|
| `better-sqlite3` | `^12` | MIT | SQLite binding with `loadExtension` hook | Yes (npm prebuilds) |
| `sqlite-vec` | `^0.1` (latest stable line) | Apache-2.0 | Loadable extension providing `vec0` virtual table | Yes (bundled in npm package) |
| `tree-sitter` | `^0.22` | MIT | AST chunker substrate (code dataset) | Yes |
| `tree-sitter-typescript` | `^0.23` | MIT | TS / TSX grammar | Yes |
| `tree-sitter-python` | `^0.23` | MIT | Python grammar | Yes |
| `picomatch` | `^4` | MIT | Glob matcher for exclusions and `pathGlob` filter | n/a (pure JS) |
| `proper-lockfile` | `^4` | MIT | Cross-process per-dataset ingest lock (atomic mkdir-based, stale-lock TTL, auto-refresh) | n/a (pure JS) |

Not added in v1 (kept as candidates, listed here so the implementer does not invent them on the fly):

| Package | Why mentioned | Why deferred |
|---|---|---|
| `@lancedb/lancedb` | Documented fallback vector store | No production usage yet; adapter sketched in design only |
| `@xenova/transformers` (or `@huggingface/transformers`) | Local embedding seam | Designed-in, not implemented in v1 |

No removals from [saivage/package.json](saivage/package.json). The `"engines"` change to `>=24.0.0` is the only edit to existing manifest fields.

## 7. Open questions for the implementer

- Confirm `sqlite-vec` current release at [github.com/asg017/sqlite-vec/releases](https://github.com/asg017/sqlite-vec/releases) is on the stable line, ANN/IVF features still flagged as in-development, and the npm package ships a Linux x64 prebuild against Node 24.
- Confirm `better-sqlite3` >=12 has working prebuilds for Node 24 on Linux x64, ESM interop is clean from `"type": "module"`, and `db.loadExtension(path)` accepts the `sqlite-vec` shipped extension path.
- Confirm `tree-sitter` and the two chosen grammar packages have working prebuilds for Node 24 on Linux x64. If either grammar fails to load, the code chunker's regex+blank-line fallback is the only path that runs, and the test surface must exercise it.
- Inspect [saivage/node_modules/@mariozechner/pi-ai](saivage/node_modules/@mariozechner/pi-ai) for an embeddings export. If present and stable, `provider/openai.ts` should route through it for parity with the chat-completions surface; if absent, the direct `openai` SDK call is correct.
- Measure brute-force KNN latency on the operator's hardware at 50k, 100k, and 500k vectors of 1536-d float32. The estimates in the analysis are anchors, not commitments; before the docs / code datasets cross 100k chunks, the operator wants real numbers.
- Decide whether `node:sqlite` is a viable substrate for the SqliteVecStore. The recommendation is to keep `better-sqlite3` for v1; revisit only if `node:sqlite` ships a `loadExtension` story that matches the maturity of `better-sqlite3`'s.
- Reconfirm the secret-scan regex set against the credential shapes Saivage actually emits in [saivage/src/knowledge/store.ts](saivage/src/knowledge/store.ts); add any provider-specific token shapes the existing scanner already handles.
- Verify that the OpenAI provider's per-request batch size (number of documents per `embeddings.create` call) is bounded conservatively (e.g. 96) and that `provider.embedDocuments` chunks the input array accordingly.
- Verify on the operator's actual host that ingest with a typical doc dataset of ~600 chunks completes in seconds end-to-end against the configured OpenAI account; this is the smoke test referenced by the implementation plan.

## 8. Proposal comparison summary

| Aspect | Proposal A (Focused) | Proposal B (Content store) |
|---|---|---|
| Module count (new top-level) | 1 (`src/rag/`) | 1 (`src/content-store/`) but with twice the internal modules |
| Number of pluggable seams in v1 | 3 (provider, store, chunker) | 5 (provider, vector store, lexical store, chunker, MCP transport) |
| Vector stores supported in v1 | 1 (sqlite-vec) | 1 (sqlite-vec) + LanceDB sketched |
| Lexical (BM25) index in v1 | No | Yes (SQLite FTS5) |
| MCP exposure in v1 | No | Optional (opt-in) |
| Migration of existing knowledge store | Not addressed | Open-ended, deferred to its own spec |
| Per-dataset / per-collection isolation | Strong (file per dataset) | Strong (directory per collection) |
| Lifecycle ops cost (`drop`, `rebuild`) | `unlink` + fresh open | `unlink` of directory + fresh open |
| Lines of test surface (rough) | ~12 test files | ~20 test files |
| New npm deps | 7 | 9+ (adds FTS5 helper, MCP transport, potentially LanceDB) |
| Surfaces explicit v1 non-goals as built-in capabilities | No | Yes (hybrid, MCP, cross-substrate) |
| Risk of partial migration carrying two indexes for the same data | None | Real, until knowledge store moves |
| Time to first verifiable smoke test | Short | Longer |
| Fit with F01 minimalism constraint | Direct | Strained |

## 9. End-to-end ingest sequence (Proposal A)

```
caller                  RagManager           Dataset             Walker        Chunker        Secrets        EmbeddingProvider    VectorStore
  |                         |                  |                   |             |              |                  |                  |
  |--ingest(input)--------->|                  |                   |             |              |                  |                  |
  |                         |--get(datasetId)->|                   |             |              |                  |                  |
  |                         |                  |--lock()---------->|             |              |                  |                  |
  |                         |                  |<---ok-------------|             |              |                  |                  |
  |                         |                  |--walk(input)----->|             |              |                  |                  |
  |                         |                  |<--files[]---------|             |              |                  |                  |
  |                         |                  |--diff(files, store.file_state)  |              |                  |                  |
  |                         |                  |--for changed file: chunk()----->|              |                  |                  |
  |                         |                  |<--RawChunk[]------|             |              |                  |                  |
  |                         |                  |--scanChunk(text)----------------------------->|                  |                  |
  |                         |                  |<--keep|drop-------|             |              |                  |                  |
  |                         |                  |--cache.lookup(keys)             |              |                  |                  |
  |                         |                  |--embedDocuments(misses)---------------------------------->|       |                  |
  |                         |                  |<--Float32Array[]--|             |              |                  |                  |
  |                         |                  |--cache.put(misses)              |              |                  |                  |
  |                         |                  |--upsert(StoredChunk[])---------------------------------------------------->|       |
  |                         |                  |--deleteByIds(stale)------------------------------------------------------->|       |
  |                         |                  |<--ok--------------|             |              |                  |                  |
  |                         |                  |--unlock()-------->|             |              |                  |                  |
  |<--IngestReport----------|                  |                   |             |              |                  |                  |
```

## 10. End-to-end query sequence (Proposal A)

```
caller                  Dataset             EmbeddingProvider    VectorStore
  |                       |                    |                  |
  |--query(text, opts)--->|                    |                  |
  |                       |--embedQuery(text)->|                  |
  |                       |<--Float32Array-----|                  |
  |                       |--query(vec, K*overshoot, filter)----->|
  |                       |                    |<--StoredHit[]----|
  |                       |--post-filter & truncate to K          |
  |                       |--hydrate text+metadata                |
  |<--QueryHit[]----------|                    |                  |
```

## 11. Worked on-disk example

Three datasets registered on the Saivage v3 project, illustrative:

```
/work/saivage-v3/.saivage/rag/
  registry.json
  skills-saivage-v3/
    store.db                       // 50 chunks at 1536-d  -> ~310 KB vectors + metadata
    .ingest.lock
  docs-saivage-v3/
    store.db                       // 600 chunks at 1536-d -> ~3.7 MB vectors + metadata
    .ingest.lock
  code-saivage-v3/
    store.db                       // 12000 chunks at 512-d -> ~24 MB vectors + metadata
    .ingest.lock
```

`registry.json` for that project:

```
{
  "datasets": [
    {
      "id": "skills-saivage-v3",
      "projectId": "saivage-v3",
      "source": "skill",
      "providerStamp": { "provider": "openai", "model": "text-embedding-3-small", "dim": 1536, "releaseFingerprint": "te3s-2026-Q1" },
      "createdAt": "2026-05-27T00:00:00Z"
    },
    {
      "id": "docs-saivage-v3",
      "projectId": "saivage-v3",
      "source": "doc",
      "providerStamp": { "provider": "openai", "model": "text-embedding-3-small", "dim": 1536, "releaseFingerprint": "te3s-2026-Q1" },
      "createdAt": "2026-05-27T00:00:00Z"
    },
    {
      "id": "code-saivage-v3",
      "projectId": "saivage-v3",
      "source": "code",
      "providerStamp": { "provider": "openai", "model": "text-embedding-3-small", "dim": 512, "releaseFingerprint": "te3s-2026-Q1" },
      "createdAt": "2026-05-27T00:00:00Z"
    }
  ]
}
```

The `code` dataset uses `dim: 512` to keep the brute-force scan well under the §1 budget at the upper end of the corpus size; the `docs` and `skills` datasets run native 1536-d because the corpora are small enough that the saving is not worth the recall cost.

## 12. Configuration walkthrough

Operator opts in by adding the following slice to the project config (the slice is parsed in [saivage/src/config.ts](saivage/src/config.ts) per §3.1.7):

```
{
  "rag": {
    "enabled": true,
    "datasets": [
      {
        "id": "docs-saivage-v3",
        "source": "doc",
        "provider": { "kind": "openai", "model": "text-embedding-3-small", "dim": 1536 },
        "store": { "kind": "sqlite-vec" },
        "chunker": { "kind": "markdown", "chunkSize": 600, "overlap": 0.15 },
        "exclusions": ["docs/api/**"]
      },
      {
        "id": "code-saivage-v3",
        "source": "code",
        "provider": { "kind": "openai", "model": "text-embedding-3-small", "dim": 512 },
        "store": { "kind": "sqlite-vec" },
        "chunker": { "kind": "code", "chunkSize": 800 }
      }
    ]
  }
}
```

`RagManager` reads this slice once at process start, instantiates a `Dataset` per entry, and opens each store lazily on first `ingest` or `query`. Nothing in `.saivage/rag/` exists until the first ingest. Removing the slice (or setting `enabled: false`) leaves the on-disk artifacts untouched but stops the manager from constructing; operator may `rm -rf .saivage/rag/` at any time and the next ingest rebuilds.

## 13. Boundary with consumers (informational)

The library exposes the surface described in §3.1.2. The future skills-loader adapter will call `Dataset.ingest({ kind: "records", items: ... })` with one record per `KnowledgeRecord` carrying the existing metadata fields. The future docs and code adapters will call `Dataset.ingest({ kind: "fs", root, include, exclude })`. No consumer code is touched in this work. No consumer surface is exported.

## 14. Summary

- Proposal A (focused, in-process, sqlite-vec + OpenAI `text-embedding-3-small`) is the recommended design.
- Three seams (`EmbeddingProvider`, `VectorStore`, `Chunker`) keep later substitution cheap.
- One `.db` per dataset under `<projectRoot>/.saivage/rag/<datasetId>/` keeps lifecycle ops, isolation, and corruption blast radius small.
- Embedding-config drift is detected and refused; rebuild is the only forward path.
- Secrets are blocked by glob before read and by regex before embed.
- Local embedding, hybrid retrieval, cross-dataset query, MCP exposure, knowledge-store migration, telemetry, and encryption-at-rest are out of scope for v1.
- New dependencies are `better-sqlite3`, `sqlite-vec`, `tree-sitter`, `tree-sitter-typescript`, `tree-sitter-python`, `picomatch`, `proper-lockfile`. `engines.node` rises to `>=24.0.0`.
