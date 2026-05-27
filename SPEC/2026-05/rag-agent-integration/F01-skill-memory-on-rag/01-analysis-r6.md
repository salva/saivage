# F01 — Skills & Memories on the RAG Subsystem: Functional Analysis

This analysis re-grounds the Saivage knowledge store on the RAG
subsystem. Skill bodies and memory bodies are stored in a canonical
**SQLite sidecar** and indexed in two **protected RAG datasets**
(`knowledge.skills`, `knowledge.memory`) without changing the public
RAG API. The MCP handler input schemas and outer output shapes are
preserved; the legacy `.saivage/{skills,memory}/` JSON tree is
removed. A small number of intentional output and ACL changes are
listed explicitly in §0.8.

## 0. Current State (verified)

### 0.1 On-disk layout

`.saivage/{skills,memory}/<scope>/<scope-ref>/records/` stores one
frontmatter JSON per record; skills carry their body in a sibling
Markdown file referenced by `body_path`; memories store body inline.

`index.json` has **two current shapes** depending on entry point:

- Initial seed by `initProjectTree` writes
  `skills/project/index.json = { skills: [] }` and
  `memory/project/index.json = { memories: [], topic_map: {} }`
  ([src/store/project.ts](src/store/project.ts#L154-L171)).
- `rebuildIndex` writes `{ entries: IndexSummary[] }`
  ([src/knowledge/store.ts](src/knowledge/store.ts#L309-L330)).

`audit.jsonl` carries one line per write attempt. `archive/`
subtrees hold records physically moved out of live `records/` by
stage/session archival
([src/knowledge/lifecycle.ts](src/knowledge/lifecycle.ts#L917-L1017)).

Built-in skills live under `skills/builtin/<topic>/SKILL.md` and the
loader synthesises `randomUUID()` ids per process
([src/knowledge/eagerLoader.ts](src/knowledge/eagerLoader.ts#L169-L212)).

Legacy-tree detection (§6.1) keys off the presence of either index
shape OR the directory tree itself.

### 0.2 Current MCP read tools — input schemas (preserved) and output shapes (preserved at outer envelope)

- **`list_skills`** — input `{ scope?, target_agent?, include_archived?,
  include_superseded? }`; output `{ skills: SkillSummary[] }`
  ([src/mcp/knowledgeSkills.ts](src/mcp/knowledgeSkills.ts#L110-L132),
  [src/knowledge/lifecycle.ts](src/knowledge/lifecycle.ts#L766-L833)).
- **`read_skill`** — input `{ id }`; output `{ record, body,
  redacted_spans }` where `body` is read from `record.body_path` and
  redacted by `redactForRead`
  ([src/knowledge/lifecycle.ts](src/knowledge/lifecycle.ts#L716-L730)).
  Today's `record` includes `body_path`. F01 changes this; see §0.8.
- **`search_skills`** — input `{ query, scope?, limit? }`; output
  `{ hits: SearchHit[] }` where `SearchHit = { id, score, snippet }`.
  Current scoring (verified):
  `+3 if name OR triggers match`, `+2 description match`,
  `+1 body match`
  ([src/knowledge/loader.ts](src/knowledge/loader.ts#L117-L135)).
- **`list_memories`** — input `{ scope?, topic_domain?,
  include_archived?, older_than_days? }`; output `{ memories:
  MemorySummary[] }`
  ([src/mcp/knowledgeMemory.ts](src/mcp/knowledgeMemory.ts#L103-L128),
  [src/knowledge/lifecycle.ts](src/knowledge/lifecycle.ts#L766-L833)).
- **`get_memory`** — input `{ id? } | { topic? }`; output the record
  (walking the supersession chain to head; returns null if head is
  not active)
  ([src/knowledge/lifecycle.ts](src/knowledge/lifecycle.ts#L216-L229),
  [src/knowledge/lifecycle.ts](src/knowledge/lifecycle.ts#L733-L760)).
- **`search_memories`** — input `{ query, scope?, limit? }`; output
  `{ hits: SearchHit[] }` over active records
  ([src/knowledge/lifecycle.ts](src/knowledge/lifecycle.ts#L880-L910)).
  Memory scoring: `3·topic + 2·keys + 1·body`
  ([src/knowledge/loader.ts](src/knowledge/loader.ts#L84-L103)).

F01 preserves every input schema and outer wrapper byte-for-byte
(`{ skills }`, `{ memories }`, `{ hits }`, `{ record, body,
redacted_spans }`). Internal element shapes change only as listed in
§0.8.

### 0.3 Current write tools

`create_skill`, `update_skill`, `supersede_skill`, `archive_skill`,
`delete_skill`, `create_memory`, `update_memory`, `supersede_memory`,
`archive_memory`, `delete_memory`. Write helpers return narrow
shapes like `{ id, status }`, `{ id, updated_at }`, `{ new_id,
old_id }`
([src/knowledge/lifecycle.ts](src/knowledge/lifecycle.ts#L247-L630)).
F01 preserves these.

Existing write-time guards F01 preserves:

- `redactForRead` at read time.
- Secret + blocked-path guards at write time
  ([src/knowledge/store.ts](src/knowledge/store.ts#L86-L155)).
- Runtime-lock enforcement before mutations
  ([src/knowledge/lifecycle.ts](src/knowledge/lifecycle.ts#L45-L58)).
- Name/topic collision rules
  ([src/knowledge/lifecycle.ts](src/knowledge/lifecycle.ts#L273-L312),
  [src/knowledge/lifecycle.ts](src/knowledge/lifecycle.ts#L522-L557)).
- Supersession scope-pair rules
  ([src/knowledge/lifecycle.ts](src/knowledge/lifecycle.ts#L414-L481),
  [src/knowledge/lifecycle.ts](src/knowledge/lifecycle.ts#L647-L702)).

### 0.4 Current eager loading (API preserved, data source repointed)

Per-agent eager block construction:

- `buildEagerBlock` is called per agent
  ([src/agents/planner.ts](src/agents/planner.ts#L30-L39),
  [src/agents/worker.ts](src/agents/worker.ts#L147-L160)).
- It calls `loadAllCandidates` then `resolveEagerRecords`
  ([src/knowledge/eagerLoader.ts](src/knowledge/eagerLoader.ts#L236-L244),
  [src/knowledge/eagerLoader.ts](src/knowledge/eagerLoader.ts#L304-L313)).
- The resolver filters by `status === "active"`, target agents,
  skill triggers, memory opt-in, and project-scoped survivor rules
  ([src/knowledge/loader.ts](src/knowledge/loader.ts#L233-L260),
  [src/knowledge/loader.ts](src/knowledge/loader.ts#L285-L300)).
- Survivors are reinjected after compaction via `buildSurvivorBlock`
  ([src/agents/base.ts](src/agents/base.ts#L916-L954)).

F01 keeps these function APIs; `loadAllCandidates` is rewritten to
query the sidecar.

### 0.5 Current knowledge ACL (verbatim)

[permissions.ts](src/knowledge/permissions.ts):

- `data_agent`: `read-skill / list-skill / search-skill = "Y"`;
  every memory op `"-"`; every write op `"-"`
  ([src/knowledge/permissions.ts](src/knowledge/permissions.ts#L112-L128)).
- `coder`, `researcher`: `Y†` on `create-memory` / `update-memory`
  only ([src/knowledge/permissions.ts](src/knowledge/permissions.ts#L76-L99)).
- `checkScope` enforces the `Y†` worker-stage rule when
  `cellFor(...) === "Y†"`
  ([src/knowledge/permissions.ts](src/knowledge/permissions.ts#L260-L290)).
- Handler envelope codes are `UNAUTHORIZED_ROLE` and
  `UNAUTHORIZED_SCOPE`
  ([src/mcp/knowledgeMemory.ts](src/mcp/knowledgeMemory.ts#L165-L181),
  [src/mcp/knowledgeMemory.ts](src/mcp/knowledgeMemory.ts#L297-L301)).
  There is no `KNOWLEDGE_PERMISSION_DENIED`.

Current handler `update_memory` calls `gateRole(role, "create")` but
**does not call `gateScope`**
([src/mcp/knowledgeMemory.ts](src/mcp/knowledgeMemory.ts#L216-L228));
the existing comment acknowledges the gap. F01 fixes this; see
§0.8.

### 0.6 RAG public-API facts F01 relies on

- `DatasetConfig.sources` is `SourceRoot[]` where `SourceRoot = {
  root, include?, exclude? }`
  ([src/rag/types.ts](src/rag/types.ts#L28-L52)). Record ingest is
  a separate `IngestInput.kind === "records"` shape
  ([src/rag/types.ts](src/rag/types.ts#L143-L147)). F01 cannot use
  `sources: [{ kind: "records" }]`. The protected datasets must
  declare a real on-disk source root (§2).
- `DatasetConfig` requires `store: { kind: "sqlite-vec" }`
  ([src/rag/types.ts](src/rag/types.ts#L39-L45)) and
  `RagManagerOptions.datasets` is `ReadonlyArray<Omit<DatasetConfig,
  "projectId">>` ([src/rag/manager.ts](src/rag/manager.ts#L34-L40)).
  F01 declares the protected dataset entries with `store: { kind:
  "sqlite-vec" }` and uses the local `RuntimeRagDatasetConfig =
  Omit<DatasetConfig, "projectId">` alias (§2, §6.1).
- `ChunkMetadataInput`
  ([src/rag/types.ts](src/rag/types.ts#L84)) has a `source` field
  but the records pipeline ignores it: `buildRecordItems` drops
  `source` ([src/rag/pipeline.ts](src/rag/pipeline.ts#L108-L134)),
  and per-chunk `source` is computed in `runIngest` as
  `metadataOverlay.scope === "memory" ? "memory" :
  inferSource(path)`
  ([src/rag/pipeline.ts](src/rag/pipeline.ts#L196-L207)).
  `inferSource(p)` returns only `"doc"` or `"code"` by extension
  ([src/rag/pipeline.ts](src/rag/pipeline.ts#L143-L147)).

  Consequences for F01:

  - Memory chunks get `source = "memory"` by setting
    `metadata.scope = "memory"` on every input item.
  - Skill chunks cannot be tagged `source = "skill"` through the
    public API. F01 disambiguates by `collection_id` alone — each
    query targets one dataset explicitly.
  - Skill input items use `path = "skill:<id>.md"` so `inferSource`
    returns `"doc"`; the resulting tag is irrelevant.
- `ChunkMetadata.createdAt` is `number` (epoch ms, optional)
  ([src/rag/types.ts](src/rag/types.ts#L77)). F01 sets it to
  `Date.parse(record.updated_at)`.
- `RagManager.query` signature is `query(id: string, text: string,
  options?: QueryOptions): Promise<QueryHit[]>`
  ([src/rag/manager.ts](src/rag/manager.ts#L35-L48)). The hit type
  is `QueryHit` ([src/rag/query/pipeline.ts](src/rag/query/pipeline.ts#L18-L34)).
- `QueryFilter` shape: `{ pathGlob?: string, eq?: Record<string,
  string|number|boolean>, in?: Record<string, Array<string|number>> }`
  ([src/rag/types.ts](src/rag/types.ts#L114-L124)). F01's
  path-restricted filter is `{ in: { path: pathsForIds } }`.
- `createRagManager` is `async`
  ([src/rag/manager.ts](src/rag/manager.ts#L87-L88)); the no-op
  disabled path is never exercised — F01 requires
  `config.rag.enabled === true` at boot (§6.1).
- `Dataset.store` exposes an internal `getFileState()` /
  equivalent path enumerator over the `file_state` table
  ([src/rag/store/sqlite-vec.ts](src/rag/store/sqlite-vec.ts#L420-L461)).
  F01 uses this for boot-time divergence detection (§7.2). The
  enumerator is treated as an existing internal seam already
  reachable from the manager; F01 does not add a new public RAG
  export.

### 0.7 Bootstrap, services, config — current state

- `bootstrap.ts` calls `registerBuiltinServices(mcpRuntime,
  mcpConfig, securityConfig)`
  ([src/server/bootstrap.ts](src/server/bootstrap.ts#L133-L151))
  with no `knowledge` option today.
- `config.ts` exports `loadConfig` only
  ([src/config.ts](src/config.ts#L335-L343)); F02 adds
  `saveSaivageConfig`, which F01 depends on for seeding the two
  protected dataset entries.
- RAG error names in source: `DatasetNotFoundError`,
  `ProviderUnavailableError`, `EmbeddingDriftError`,
  `ConfigDriftError`, `CorruptedStoreError`, `IngestLockedError`,
  `WatcherUnavailableError`, `InvalidQueryFilterError`
  ([src/rag/errors.ts](src/rag/errors.ts#L3-L116)). F01 catches
  them inside knowledge code and re-throws a single
  `KNOWLEDGE_RAG_UNAVAILABLE` envelope from search handlers (the
  upstream message goes into `details`).

### 0.8 Intentional behaviour changes against current state

These changes are **deliberate** under the workspace
architecture-first rule and are surfaced here so every consumer
checks them in one place.

1. **`SkillRecord.body_path` is removed.** The body is inlined into
   the sidecar `record.body` column. `read_skill` continues to
   return `{ record, body, redacted_spans }`, but the inner `record`
   no longer carries a `body_path` field. This is an inner-record
   shape change (`SkillRecordSchema` is updated; see §3.3 and §9).
2. **`update_memory` gains a scope preflight.** The current handler
   omits `gateScope`; F01 reads the prior record and runs `gateScope`
   against its `scope` / `scope_ref`. Coder/researcher writers that
   previously slipped through with a wrong-stage scope will now
   receive `UNAUTHORIZED_SCOPE`. The fix uses existing codes; no new
   envelope is added.
3. **Stage/session archival becomes status-only.** Lifecycle hooks
   keep their entry-point names and return shapes (`ScopeArchiveResult
   = { archivedSkills, archivedMemories }`) but operate on
   `record.status = 'archived'` instead of moving files into an
   `archive/` subtree (no JSON tree exists post-F01).
4. **Built-in skill ids switch to `"builtin:" + nfcLower(name)`.**
   `RecordBase.id` and `AuditEntry.record_id` widen from
   `z.string().uuid()` to `z.union([z.string().uuid(),
   z.string().regex(/^builtin:/)])`.
5. **`audit.jsonl` is replaced by a sidecar `audit` table.** The
   `AuditEntry` shape is preserved; the persistence medium changes.
6. **The legacy `.saivage/{skills,memory}/` tree is removed and not
   reintroduced.** No migration shim; install-time refusal protects
   operator data (§6.1.b).

The outer MCP wrapper shapes (`{ skills }`, `{ memories }`,
`{ hits }`, `{ record, body, redacted_spans }`) remain unchanged.
The byte-for-byte preservation claim applies only to (a) input
schemas, (b) outer wrappers, and (c) write-helper return shapes —
**not** to the inner `record` object content (point 1) or to ACL
edge cases (point 2).

## 1. Goal

Treat the MCP handler surface as the contract; behind it:

- **SQLite sidecar = record-of-truth** for structured fields and
  bodies.
- **RAG = vector index** over the two protected datasets, fed via
  the existing public ingest API.
- **Legacy JSON tree removed.**

## 2. Protected Datasets

Two protected dataset entries seeded into `config.rag.datasets` on
first boot via `saveSaivageConfig`:

```ts
const PROTECTED_DATASETS: RuntimeRagDatasetConfig[] = [
  { id: "knowledge.skills", source: "skill",
    chunker: { kind: "markdown" },
    provider: { model: "text-embedding-3-small", dim: 1024 },
    sources: [{ root: "<projectRoot>/.saivage/knowledge/", include: [] }],
    store: { kind: "sqlite-vec" },
    watch: false },
  { id: "knowledge.memory", source: "memory",
    chunker: { kind: "memory" },
    provider: { model: "text-embedding-3-small", dim: 1024 },
    sources: [{ root: "<projectRoot>/.saivage/knowledge/", include: [] }],
    store: { kind: "sqlite-vec" },
    watch: false },
];
```

`sources[0].root` is the sidecar directory (a real on-disk path);
`include: []` ensures the FS walker finds no files. Records are fed
via `IngestInput.kind === "records"` calls from the knowledge layer;
the `sources` entry exists only to satisfy `DatasetConfig`'s schema
requirement.

The two ids are protected at the F02 layer (mutating tools refuse).
The knowledge layer calls `manager.ingest(id, { kind: "records",
items: [...] })` directly; F02's protection only gates external
agent invocation. Per §0.6, F01 does not rely on per-chunk
`source = "skill"`.

## 3. SQLite Sidecar

Path: `.saivage/knowledge/store.sqlite`. Owned by a new
`src/knowledge/sidecar.ts`.

### 3.1 Tables

```sql
CREATE TABLE record (
  id              TEXT PRIMARY KEY,
  kind            TEXT NOT NULL CHECK (kind IN ('skill','memory')),
  scope           TEXT NOT NULL CHECK (scope IN ('project','stage','session')),
  scope_ref       TEXT,
  status          TEXT NOT NULL CHECK (status IN ('active','superseded','archived','expired')),
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  body            TEXT NOT NULL,
  body_hash       TEXT NOT NULL,
  record_json     TEXT NOT NULL,                -- frozen full record minus body
  pending_reingest INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX record_kind_status ON record(kind, status);
CREATE INDEX record_scope ON record(scope, scope_ref);

CREATE TABLE record_skill (
  id     TEXT PRIMARY KEY REFERENCES record(id) ON DELETE CASCADE,
  name   TEXT NOT NULL,
  origin TEXT NOT NULL CHECK (origin IN ('builtin','project'))
);
CREATE UNIQUE INDEX record_skill_name ON record_skill(name);
CREATE INDEX record_skill_origin ON record_skill(origin);

CREATE TABLE record_memory (
  id            TEXT PRIMARY KEY REFERENCES record(id) ON DELETE CASCADE,
  topic_domain  TEXT NOT NULL,
  topic_subject TEXT NOT NULL,
  topic_aspect  TEXT
);
CREATE INDEX record_memory_topic ON record_memory(topic_domain, topic_subject);

CREATE TABLE record_survive (
  id TEXT PRIMARY KEY REFERENCES record(id) ON DELETE CASCADE
);

CREATE TABLE record_target_agent (
  id         TEXT REFERENCES record(id) ON DELETE CASCADE,
  agent_role TEXT NOT NULL,
  PRIMARY KEY (id, agent_role)
);

CREATE TABLE audit (
  ts TEXT NOT NULL, record_id TEXT NOT NULL, op TEXT NOT NULL, outcome TEXT NOT NULL,
  error_code TEXT, author_role TEXT NOT NULL, author_agent_id TEXT NOT NULL,
  reason TEXT NOT NULL, prev_status TEXT, next_status TEXT,
  content_hash_before TEXT, content_hash_after TEXT
);
CREATE INDEX audit_record ON audit(record_id, ts);

CREATE TABLE rag_sync (
  id            TEXT PRIMARY KEY REFERENCES record(id) ON DELETE CASCADE,
  collection_id TEXT NOT NULL CHECK (collection_id IN ('knowledge.skills','knowledge.memory')),
  body_hash     TEXT NOT NULL,
  embedded_at   TEXT NOT NULL
);
```

### 3.2 Field placement

| Field                              | Sidecar location                                   | RAG metadata? |
|------------------------------------|----------------------------------------------------|---------------|
| `id`                               | `record.id`                                        | `metadata.path = "<kind>:<id>.md"` |
| `kind`                             | `record.kind`                                      | via `collection_id` |
| `scope`                            | `record.scope`                                     | memory: overlay `scope="memory"` enables pipeline `source="memory"` |
| `scope_ref`                        | `record.scope_ref`                                 | no |
| `status`                           | `record.status`                                    | filtered to `active` (§5.2) |
| `created_at` / `updated_at`        | `record.created_at`, `record.updated_at`           | `metadata.createdAt = Date.parse(updated_at)` |
| `author_agent.*`, `source.*`, `expires_at`, `ttl_ms`, `supersedes`, `superseded_by`, `relates_to` | `record_json` | no |
| `survive_compaction`               | `record_survive` presence + `record_json`          | no |
| **Skill**                          |                                                     |  |
| `origin`                           | `record_skill.origin` (indexed)                    | no |
| `name`                             | `record_skill.name` (unique index)                 | chunk body prefix |
| `description`, `triggers`          | `record_json`                                      | chunk body prefix |
| `target_agents`                    | `record_target_agent`                              | no |
| body                               | `record.body`                                      | embedded |
| **Memory**                         |                                                     |  |
| `topic`                            | `record_memory`                                    | chunk body prefix |
| `keys`                             | `record_json`                                      | chunk body prefix |
| `target_agents`                    | `record_target_agent`                              | no |
| `body`                             | `record.body`                                      | embedded |
| `source_ref`                       | `record_json`                                      | no |

Chunk body prefix for skills:
`"# <name>\n<description>\ntriggers: <comma-joined>\n\n" + body`.
For memories:
`"<topic.domain>/<topic.subject>(/aspect)\nkeys: <comma-joined>\n\n" + body`.

### 3.3 Built-in skill ids and schema changes

Built-in skills get deterministic ids `"builtin:" + nfcLower(name)`.
This requires schema changes
([src/knowledge/types.ts](src/knowledge/types.ts)):

- `RecordBaseSchema.id` widens from `z.string().uuid()` to
  `z.union([z.string().uuid(), z.string().regex(/^builtin:/)])`.
- `AuditEntrySchema.record_id` widens the same way.
- `SkillRecordSchema` drops `body_path`; the schema does not add an
  inline `body` field — `body` remains an out-of-record value
  returned through `read_skill.body`. The current
  `readSkillById` spread `{ ...found.record }` simply no longer
  includes `body_path` for skills.
- `BuiltinSkillFrontmatterSchema` unchanged.

The randomUUID code path in
[src/knowledge/eagerLoader.ts](src/knowledge/eagerLoader.ts#L169-L212)
is replaced by a builtin-upsert step at sidecar init (§6.1).

## 4. Read Paths

### 4.1 `read_skill`, `get_memory`

- `read_skill`: sidecar lookup by `record.id`; assemble
  `SkillRecord` from `record_json` plus joins (no `body_path` key
  per §0.8.1); return `{ record, body: record.body, redacted_spans }`
  where `body` + `redacted_spans` come from `redactForRead(record.body)`.
- `get_memory`: supports `{ id }` and `{ topic }`. For `{ topic }`,
  query `record_memory` joined to `record`, ordering by scope
  priority `session > stage > project`. For both variants, walk the
  supersession chain via `record_json.supersedes` /
  `record_json.superseded_by` until the head; return only when head
  status is `active`. Behaviour matches the current implementation
  ([src/knowledge/lifecycle.ts](src/knowledge/lifecycle.ts#L216-L229),
  [src/knowledge/lifecycle.ts](src/knowledge/lifecycle.ts#L733-L760)).

### 4.2 `list_skills`, `list_memories`

Sidecar queries with the preserved input filters:

- skills: `scope`, `target_agent` (join on `record_target_agent`),
  `include_archived` (default false), `include_superseded` (default
  false).
- memories: `scope`, `topic_domain` (join on `record_memory`),
  `include_archived` (default false), `older_than_days` (join on
  `record.updated_at`).

Output shapes match `listSkills` / `listMemories`
([src/knowledge/lifecycle.ts](src/knowledge/lifecycle.ts#L766-L833)).

### 4.3 `search_skills`, `search_memories`

Input schema unchanged: `{ query, scope?, limit? }`. Output
unchanged: `{ hits: Array<{ id, score, snippet }> }`.

Internal flow:

1. Build a `QueryFilter`. For caller-supplied `scope`, query the
   sidecar for ids active in that scope, compute their paths
   (`<kind>:<id>.md`), and build
   `filter = { in: { path: pathsForIds } }`
   matching the public type
   ([src/rag/types.ts](src/rag/types.ts#L114-L124)). When `scope`
   is omitted, no filter is built; the sidecar join in step 3
   constrains the result set.
2. Call `manager.query("knowledge.{skills,memory}", text, { topK:
   (limit ?? 10), filter })`.
3. For each `QueryHit`, decode `metadata.path` → record id; sidecar
   join confirms `status === "active"` and ACL visibility; eject
   ineligible hits.
4. Build `snippet`: `buildSearchSnippet(hit.text, tokens)` then
   `redactForRead(snippet).text`, matching the current implementation
   ([src/knowledge/lifecycle.ts](src/knowledge/lifecycle.ts#L838-L880)).
5. Return `{ hits: [{ id, score: hit.score, snippet }] }`.

### 4.4 RAG-unavailable mapping

When `manager.query` throws any RAG error, the search handler
returns `{ error: { code: "KNOWLEDGE_RAG_UNAVAILABLE", message:
e.message, details: { cause: e.constructor.name } } }`. Boot already
aborts on RAG-disabled (§6.1); this path covers runtime
provider/drift failures.

`list_*`, `read_skill`, `get_memory` never touch RAG and remain
available regardless of RAG state.

## 5. Write Paths

### 5.1 Transaction boundary

Per mutating tool:

1. Existing handler-side validation runs (role / scope / blocked-path
   / secret guards). For `update_memory`, F01 adds the scope
   preflight described in §0.8.2.
2. `BEGIN IMMEDIATE` on the sidecar.
3. Apply collision / supersession rules ported from `lifecycle.ts`
   (helper functions retained; data source becomes the sidecar).
4. Write rows; set `record.body_hash = sha256(record.body)`;
   `pending_reingest = 1`; append audit row.
5. `COMMIT`.
6. **Snapshot reingest of the affected kind**: `manager.ingest(
   "knowledge.{skills,memory}", { kind: "records", items: <every
   active record of that kind> })`. Pipeline snapshot semantics
   delete chunks for any record no longer present.
7. On success, clear `pending_reingest` for all active records of
   the kind; upsert `rag_sync` rows.
8. On ingest failure: leave `pending_reingest = 1`. Handler response
   shape is unchanged for every existing tool — no
   `details.ragWarning` is added. The failure surfaces through a
   structured `log.warn("knowledge.rag-reingest-failed", { ... })`
   and through `pending_reingest`'s effect on the boot divergence
   sweep.

### 5.2 Lifecycle visibility filter

Only `status === "active"` records are sent to RAG. Status changes
(`supersede_*`, `archive_*`, `delete_*`, expiry handler) trigger the
same snapshot reingest, which evicts the now-inactive record without
a separate delete call.

### 5.3 Stage/session archival hooks

Hooks keep their entry-point names and return shape (`ScopeArchiveResult
= { archivedSkills, archivedMemories }`). The implementation changes
to `UPDATE record SET status = 'archived' WHERE scope_ref = ?
RETURNING id` for each kind. The resulting ids populate the returned
arrays.

### 5.4 Concurrency

Sidecar `BEGIN IMMEDIATE` serialises writers. Reingest acquires the
RAG dataset's `.ingest.lock`; concurrent reingests surface as
`IngestLockedError`, caught and translated to `log.warn` with
`pending_reingest` left set. The next successful write of the same
kind catches up via snapshot semantics.

## 6. Startup Wiring

### 6.1 Boot order

In [src/server/bootstrap.ts](src/server/bootstrap.ts):

1. Load `saivageConfig`.
2. **Hard-require `config.rag.enabled === true`.** If false, log
   fatal `KNOWLEDGE_RAG_UNAVAILABLE` and exit non-zero. F01 has no
   no-RAG fallback because search cannot serve without RAG.
3. `await createRagManager({ projectRoot, projectId, enabled: true,
   datasets: ragDatasets, providerOptions })` (the F02 step). The
   `ragDatasets` array (`RuntimeRagDatasetConfig[]`) is shared with
   F02's `RagService`.
4. Call `initKnowledgeStore({ projectRoot, ragManager, ragDatasets,
   saveSaivageConfig })`:

   a. Open/migrate `.saivage/knowledge/store.sqlite`.
   b. **Legacy-tree handling**: detect either `.saivage/skills/` or
      `.saivage/memory/` directory presence. If present **and** the
      sidecar contains zero records, fail fast with
      `KNOWLEDGE_MIGRATION_REQUIRED` naming the legacy paths.
      Operator deletes them after external backup. F01 ships no
      automatic migration shim. If present **and** the sidecar
      already contains records, delete the legacy tree (clean-up
      after the initial transition). Both `{ skills: [] }` /
      `{ memories: [] }` seed shapes and `{ entries: ... }` rebuild
      shape (§0.1) are treated identically — only directory presence
      matters.
   c. Ensure the two protected dataset entries (§2) exist in
      `ragDatasets`. Push any missing entry in-memory; persist via
      `saveSaivageConfig`. Survive restart. Each entry must include
      `store: { kind: "sqlite-vec" }` (§0.6).
   d. Call `manager.register(config)` for each protected dataset on
      first boot. `ConfigDriftError`, `EmbeddingDriftError`,
      `CorruptedStoreError` → fatal `KNOWLEDGE_RAG_UNAVAILABLE`.
   e. Upsert built-in skills (`"builtin:<name>"` ids) into the
      sidecar from `skills/builtin/<topic>/SKILL.md`.
   f. Run the boot divergence sweep (§7.2) — the authoritative
      recovery step.
   g. Pre-warm the eager loader cache.

5. Pass `knowledgeStore` to `registerBuiltinServices` so the
   handlers receive the sidecar handle and the `ragManager`
   reference via injection.

### 6.2 Failure isolation

If knowledge init fails after step 3, F01 marks the knowledge
service `available: false`; every knowledge tool fails with the
service-unavailable envelope from `McpRuntime.callTool`. F02's `rag`
surface remains available.

## 7. Recovery and Divergence

### 7.1 Failure modes

- **Pre-commit crash.** SQLite rolls back; RAG untouched.
- **Post-commit, pre-reingest crash.** `pending_reingest = 1`;
  boot sweep (§7.2) reingests.
- **Reingest failure (provider down, drift).** `pending_reingest`
  stays at 1; handler response shape unchanged; structured log
  records the failure. Next successful write of the same kind
  catches up via snapshot semantics; boot sweep catches up
  otherwise.
- **Sidecar corruption.** Hard fail
  (`KNOWLEDGE_STORE_CORRUPTED`).
- **RAG corruption.** `CorruptedStoreError` →
  `KNOWLEDGE_RAG_UNAVAILABLE` on search. Boot sweep does not
  auto-rebuild; operator runs `rag_drop` + `rag_register` and the
  next successful knowledge write triggers reingest.

### 7.2 Boot divergence sweep

The sweep verifies RAG against the sidecar using the vector store's
internal file-state enumerator
([src/rag/store/sqlite-vec.ts](src/rag/store/sqlite-vec.ts#L420-L461)):

1. For each protected dataset, obtain the manager's `Dataset` handle
   and read its `store.getFileState()` (or equivalent path/hash
   enumerator) — this is an internal seam, **not** a KNN query.
2. For each kind, compute `expectedIds = { id → body_hash }` from
   `record` where `status = 'active'`.
3. Compute path-set symmetric difference and hash mismatches between
   the enumerator output and `expectedIds`. `rag_sync` is consulted
   as a fast hint but is not the source of truth.
4. If non-empty, run a single snapshot reingest of the affected
   kind; clear `pending_reingest`; refresh `rag_sync`.

KNN queries are never used for enumeration (they cap at `topK`).

## 8. Tool Filter Delta

Add to [READ_ONLY_TOOLS](src/agents/tool-filters.ts#L12-L15):
`search_skills`, `list_memories`, `get_memory`, `search_memories`.

| Tool             | planner/reviewer/inspector/chat | worker (deny-list) | Net |
|------------------|----------------------------------|--------------------|-----|
| `list_skills`    | included (already)               | reachable          | unchanged |
| `read_skill`     | same                             | same               | unchanged |
| `search_skills`  | gains via `READ_ONLY_TOOLS` (new)| already reachable  | filter widens for allow-lists |
| `list_memories`  | gains                            | already reachable  | same |
| `get_memory`     | gains                            | already reachable  | same |
| `search_memories`| gains                            | already reachable  | same |

Per F02: filter is presentation-only; the runtime dispatcher does
not re-apply it. Handler ACL
([src/knowledge/permissions.ts](src/knowledge/permissions.ts#L112-L128))
denies `data_agent` memory reads → `UNAUTHORIZED_ROLE`. F01 does
not change the ACL matrix.

Write tools are unaffected by F01's filter changes.

## 9. Files

| File                                                                          | Action |
|-------------------------------------------------------------------------------|--------|
| [src/knowledge/types.ts](src/knowledge/types.ts)                              | Drop `SkillRecord.body_path`; widen `id` and `record_id` unions for builtin ids. |
| `src/knowledge/sidecar.ts` (new)                                              | Open/migrate `store.sqlite`; CRUD; active-set iterator for snapshot reingest; `rag_sync` upsert. |
| [src/knowledge/lifecycle.ts](src/knowledge/lifecycle.ts)                      | Reimplement all read/write helpers on the sidecar; preserve outer return shapes. Rewrite `archive*Scope` to status-only. |
| [src/knowledge/store.ts](src/knowledge/store.ts)                              | Delete JSON-tree implementation; keep `KnowledgeStoreError` class. |
| [src/knowledge/eagerLoader.ts](src/knowledge/eagerLoader.ts), [src/knowledge/loader.ts](src/knowledge/loader.ts) | Repoint `loadAllCandidates` / `resolveEagerRecords` at sidecar queries; preserve API. |
| [src/mcp/knowledgeSkills.ts](src/mcp/knowledgeSkills.ts), [src/mcp/knowledgeMemory.ts](src/mcp/knowledgeMemory.ts) | Unchanged tool schemas. Wire into the new lifecycle layer; add `update_memory` scope preflight (§0.8.2); map RAG errors to `KNOWLEDGE_RAG_UNAVAILABLE` in search paths. |
| [src/mcp/builtins.ts](src/mcp/builtins.ts#L1912-L1966)                        | Add `knowledge` option to `registerBuiltinServices`. |
| [src/server/bootstrap.ts](src/server/bootstrap.ts#L133-L151)                  | New §6.1 boot order; fatal exit on RAG-disabled; `initKnowledgeStore` call; legacy-tree refusal/clean-up. |
| [src/store/project.ts](src/store/project.ts#L145-L174)                        | Remove legacy JSON tree seeding; sidecar init takes over. |
| [src/agents/tool-filters.ts](src/agents/tool-filters.ts#L12-L15)              | Extend `READ_ONLY_TOOLS` per §8. |
| `src/knowledge/sidecar.test.ts` (new)                                         | Migrations; transactional writes; snapshot iterator; lifecycle filter; supersession chain walk; concurrent writer serialisation. |
| `src/knowledge/recovery.test.ts` (new)                                        | Pre-commit and post-commit crash; boot divergence sweep via `getFileState`; `pending_reingest` catch-up. |
| `src/mcp/knowledgeSkills.test.ts`, `src/mcp/knowledgeMemory.test.ts`          | Handler tests; outer response shape preservation; `update_memory` scope preflight; topic-based `get_memory`; redaction; RAG-unavailable mapping. |
| `src/agents/tool-filters.test.ts`                                             | Filter delta coverage. |
| `SPEC/v2/knowledge/01-runtime.md` (new)                                       | Operator-facing summary including the §0.8 intentional changes. |

## 10. Internal Consistency

- §0 documents verified current state from cited line ranges.
- §0.1 acknowledges both index seed shapes (`{ skills: [] }`,
  `{ memories: [], topic_map: {} }`) and the `{ entries }` rebuild
  shape; §6.1.b uses directory presence as the legacy-tree
  signal so neither shape biases the install gate.
- §0.2 lists every current MCP read input schema and the outer
  output wrapper; §4 preserves them.
- §0.3 lists current write helper return shapes; §5 preserves them.
- §0.5 quotes the actual ACL and the `update_memory` enforcement
  gap; §0.8.2 names the F01 fix and §5.1 wires the preflight in.
- §0.6 anchors RAG facts: `DatasetConfig.sources = SourceRoot[]`;
  `store` field required; `RagManagerOptions.datasets` is `Omit<...,
  "projectId">[]`; `manager.query(id, text, options)`; `QueryFilter`
  uses `{ in: Record<string, Array<string|number>> }` so F01's
  filter is `{ in: { path: pathsForIds } }`; pipeline ignores
  `metadata.source`; `createRagManager` awaited; vector store has an
  internal file-state enumerator used by §7.2.
- §0.7 calls out non-existent error names as F02 handler internals;
  F01 collapses them to `KNOWLEDGE_RAG_UNAVAILABLE`.
- §0.8 enumerates the six intentional behaviour changes
  (`body_path` removal, `update_memory` scope preflight,
  status-only archival, builtin id format, audit medium, legacy
  tree removal). The byte-for-byte preservation claim is scoped to
  input schemas + outer wrappers + write-helper return shapes.
- §2 declares `store: { kind: "sqlite-vec" }` on every protected
  dataset and uses the `RuntimeRagDatasetConfig` alias.
- §3.3 enumerates the schema changes; §9 lists the type-file edit.
- §5.3 keeps the lifecycle hook return shape.
- §6.1 specifies legacy-tree handling without a migration shim.
- §7.2 grounds divergence detection in `store.getFileState()`, not
  KNN queries, and not `rag_sync` alone.
- §8's filter delta lists `data_agent` as filter-permitted but
  handler-denied, reconciling §0.5.

## 11. Backout

The runtime never reads the legacy `.saivage/{skills,memory}/` tree
after F01. The §6.1.b refusal prevents silent data loss: a project
carrying a legacy tree but an empty sidecar cannot boot until the
operator deletes the tree (after confirming external backup). After
the transition, the runtime cleans stale copies. No migration shim,
no parallel writes. Rolling back to pre-F01 requires reverting the
code and restoring the JSON tree from backups; F01 deliberately
does not preserve parallel-write capability.
