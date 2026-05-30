# F01 — Skills & Memories on the RAG Subsystem: Functional Analysis

This analysis re-grounds the Saivage knowledge store on the RAG
subsystem. Skill bodies and memory bodies are stored once in a
canonical **SQLite sidecar** and indexed in two **protected RAG
datasets** (`knowledge.skills`, `knowledge.memory`) without changing
the public RAG API. The MCP handler input schemas and output shapes
are preserved verbatim; only the internal storage layer and the
search execution path change. The legacy `.saivage/{skills,memory}/`
JSON tree is removed.

## 0. Current State (verified)

### 0.1 On-disk layout

The current `.saivage/{skills,memory}/<scope>/<scope-ref>/records/`
tree stores one frontmatter JSON per record;
skills carry their body in a sibling Markdown file referenced by
`body_path`, memories store body inline.
`index.json` is **`{ entries: IndexSummary[] }`**
([src/knowledge/store.ts](src/knowledge/store.ts#L309-L357)), not an
`id → path` map. `audit.jsonl` carries one line per write attempt.
`archive/` subtrees hold records physically moved out of the live
`records/` directory by stage/session archival
([src/knowledge/lifecycle.ts](src/knowledge/lifecycle.ts#L917-L1017)).
Built-in skills live under `skills/builtin/<topic>/SKILL.md` and the
loader synthesizes `randomUUID()` ids per process
([src/knowledge/eagerLoader.ts](src/knowledge/eagerLoader.ts#L169-L212)).

Project initialization seeds `.saivage/skills/project` and
`.saivage/memory/project` with empty `index.json` and `audit.jsonl`
([src/store/project.ts](src/store/project.ts#L145-L174)).

### 0.2 Current MCP read tools — input schemas (preserved verbatim)

- **`list_skills`** — input `{ scope?, target_agent?, include_archived?,
  include_superseded? }`; output `{ skills: SkillSummary[] }`
  ([src/mcp/knowledgeSkills.ts](src/mcp/knowledgeSkills.ts#L110-L132),
  [src/knowledge/lifecycle.ts](src/knowledge/lifecycle.ts#L766-L833)).
- **`read_skill`** — input `{ id }`; output `{ record, body,
  redacted_spans }` where `body` comes from `record.body_path` and is
  redacted by `redactForRead`
  ([src/knowledge/lifecycle.ts](src/knowledge/lifecycle.ts#L716-L730)).
- **`search_skills`** — input `{ query, scope?, limit? }`; output
  `{ hits: SearchHit[] }` where `SearchHit = { id, score, snippet }`
  with `snippet` produced by `buildSearchSnippet` and post-processed
  by `redactForRead`
  ([src/knowledge/lifecycle.ts](src/knowledge/lifecycle.ts#L838-L880)).
  Scoring: `3·name + 2·triggers + 1·(description+body)` against
  active records only.
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
  Scoring: `3·topic + 2·keys + 1·body`.

F01 **preserves every one** of these input schemas and output shapes
byte-for-byte. The implementation behind each tool changes.

### 0.3 Current write tools

`create_skill`, `update_skill`, `supersede_skill`, `archive_skill`,
`delete_skill`, `create_memory`, `update_memory`, `supersede_memory`,
`archive_memory`, `delete_memory`. Write helpers return narrow
shapes such as `{ id, status }`, `{ id, updated_at }`,
`{ new_id, old_id }`
([src/knowledge/lifecycle.ts](src/knowledge/lifecycle.ts#L247-L630)).
F01 preserves those output shapes.

Existing write-time guards F01 preserves:

- `redactForRead` at read time.
- Secret + blocked-path guards on body and frontmatter at write time
  ([src/knowledge/store.ts](src/knowledge/store.ts#L86-L155)).
- Runtime-lock enforcement before mutations
  ([src/knowledge/lifecycle.ts](src/knowledge/lifecycle.ts#L45-L58)).
- Name/topic collision rules
  ([src/knowledge/lifecycle.ts](src/knowledge/lifecycle.ts#L273-L312),
  [src/knowledge/lifecycle.ts](src/knowledge/lifecycle.ts#L522-L557)).
- Supersession scope-pair rules
  ([src/knowledge/lifecycle.ts](src/knowledge/lifecycle.ts#L414-L481),
  [src/knowledge/lifecycle.ts](src/knowledge/lifecycle.ts#L647-L702)).

Existing semantics F01 **changes intentionally** (architecture-first
rule):

- Stage/session archival no longer physically moves files to an
  `archive/` subtree (no JSON tree exists). Archival is a sidecar
  `status` change to `archived`; the lifecycle hooks
  ([src/knowledge/lifecycle.ts](src/knowledge/lifecycle.ts#L917-L1017))
  are rewritten to operate on the sidecar.
- `audit.jsonl` is replaced by a sidecar `audit` table.
- `body_path` is removed from `SkillRecord`; the body is inlined
  into a sidecar column. The skill record's serialized JSON loses
  the `body_path` key. `read_skill` continues to return `{ record,
  body, redacted_spans }` — the `body` field is read from the
  sidecar column directly. This is a schema break against
  [SkillRecordSchema](src/knowledge/types.ts#L105-L117) and a
  knock-on update to [RecordBaseSchema](src/knowledge/types.ts#L76-L98)
  / [AuditEntrySchema](src/knowledge/types.ts#L154-L163) for the
  built-in id format (§3.3).

### 0.4 Current eager loading (preserved API, new data source)

Per-agent eager block construction:

- `buildEagerBlock` is called per agent
  ([src/agents/planner.ts](src/agents/planner.ts#L30-L39),
  [src/agents/worker.ts](src/agents/worker.ts#L147-L160)).
- It calls `loadAllCandidates` then `resolveEagerRecords`
  ([src/knowledge/eagerLoader.ts](src/knowledge/eagerLoader.ts#L236-L244),
  [src/knowledge/eagerLoader.ts](src/knowledge/eagerLoader.ts#L304-L313)).
- The resolver filters by `status === "active"`, target agents,
  skill triggers, memory opt-in (nonempty `target_agents`), and
  project-scoped survivor rules
  ([src/knowledge/loader.ts](src/knowledge/loader.ts#L233-L260),
  [src/knowledge/loader.ts](src/knowledge/loader.ts#L285-L300)).
- Survivors are reinjected after compaction via
  `buildSurvivorBlock`
  ([src/agents/base.ts](src/agents/base.ts#L916-L954)).

F01 keeps these function APIs. `loadAllCandidates` is rewritten to
query the sidecar (`SELECT … FROM record WHERE status = 'active'`
with target-agent + survivor joins) instead of walking JSON. Built-in
skills are loaded from the sidecar after the install-time builtin
upsert step (§6.1).

### 0.5 Current knowledge ACL (verbatim summary)

[permissions.ts](src/knowledge/permissions.ts):

- `data_agent`: `read-skill / list-skill / search-skill = "Y"`; every
  memory op `"-"`; every write op `"-"`
  ([src/knowledge/permissions.ts](src/knowledge/permissions.ts#L112-L128)).
- `coder`, `researcher`: `Y†` on `create-memory` / `update-memory`
  only ([src/knowledge/permissions.ts](src/knowledge/permissions.ts#L76-L99)).
- `checkScope` enforces `Y†` worker-stage rule only when
  `cellFor(...) === "Y†"`
  ([src/knowledge/permissions.ts](src/knowledge/permissions.ts#L260-L290)):
  requires `scope === "stage"`, an active `ctx.stageId`, and
  `scope_ref === ctx.stageId`.
- Handler envelope codes are `UNAUTHORIZED_ROLE` and
  `UNAUTHORIZED_SCOPE`
  ([src/mcp/knowledgeMemory.ts](src/mcp/knowledgeMemory.ts#L165-L181),
  [src/mcp/knowledgeMemory.ts](src/mcp/knowledgeMemory.ts#L297-L301)).
  There is no `KNOWLEDGE_PERMISSION_DENIED`.

F01 does not change the ACL matrix.

### 0.6 RAG public-API facts F01 relies on (no API changes)

- `DatasetConfig.sources` is `SourceRoot[]` where
  `SourceRoot = { root, include?, exclude? }`
  ([src/rag/types.ts](src/rag/types.ts#L28-L52)). Record ingest is
  a separate `IngestInput.kind === "records"` shape
  ([src/rag/types.ts](src/rag/types.ts#L143-L147)). F01 therefore
  cannot use `sources: [{ kind: "records" }]`. The protected
  datasets must declare a real on-disk source root (§2).
- `ChunkMetadataInput`
  ([src/rag/types.ts](src/rag/types.ts#L84)) includes a `source`
  field but the pipeline **ignores it**: in `buildRecordItems`
  ([src/rag/pipeline.ts](src/rag/pipeline.ts#L108-L134)) only a
  subset of overlay fields propagate, and per-chunk `source` is
  computed in `runIngest` from
  `metadataOverlay.scope === "memory" ? "memory" : inferSource(path)`
  ([src/rag/pipeline.ts](src/rag/pipeline.ts#L196-L207)).
  `inferSource(p)` returns only `"doc"` or `"code"` by extension
  ([src/rag/pipeline.ts](src/rag/pipeline.ts#L143-L147)).

  Consequences for F01:

  - Memory chunks get `source = "memory"` by setting
    `metadata.scope = "memory"` on every input item.
  - Skill chunks **cannot** be tagged `source = "skill"` through the
    public API. F01 does **not** rely on a per-chunk source filter
    to disambiguate skills from non-skills. Disambiguation is by
    `collection_id` — each query targets one dataset explicitly.
  - Skill input items use a path of the form `"skill:<id>.md"` so
    `inferSource` returns `"doc"`; the resulting tag is irrelevant.
- `ChunkMetadata.createdAt` is `number` (epoch ms), optional
  ([src/rag/types.ts](src/rag/types.ts#L77)). F01 sets it to
  `Date.parse(record.updated_at)` (a number).
- `RagManager.query` signature is `query(id: string, text: string,
  options?: QueryOptions): Promise<QueryHit[]>`
  ([src/rag/manager.ts](src/rag/manager.ts#L35-L48)). The hit type
  is `QueryHit` ([src/rag/query/pipeline.ts](src/rag/query/pipeline.ts#L18-L34)).
  F01 uses this signature exactly.
- `createRagManager` is `async`
  ([src/rag/manager.ts](src/rag/manager.ts#L87-L88)). When
  `enabled === false` it returns a no-op manager that throws
  `DatasetNotFoundError`
  ([src/rag/manager.ts](src/rag/manager.ts#L54-L88)). F01 requires
  `enabled === true` at boot (§6.1); the no-op path is never
  exercised by knowledge handlers.

### 0.7 Bootstrap, services, config — current state

- `bootstrap.ts` loads config and calls
  `registerBuiltinServices(mcpRuntime, mcpConfig, securityConfig)`
  ([src/server/bootstrap.ts](src/server/bootstrap.ts#L133-L151))
  with **no `knowledge` option** today; knowledge handlers are
  registered directly inside that function.
- `config.ts` exports `loadConfig` only
  ([src/config.ts](src/config.ts#L335-L343)); no
  `saveSaivageConfig` writer exists. **F01 depends on F02's
  `saveSaivageConfig`** (§6.1).
- RAG error names in source are `DatasetNotFoundError`,
  `ProviderUnavailableError`, `EmbeddingDriftError`,
  `ConfigDriftError`, `CorruptedStoreError`, `IngestLockedError`,
  `WatcherUnavailableError`, `InvalidQueryFilterError`
  ([src/rag/errors.ts](src/rag/errors.ts#L3-L116)). The
  envelope-code names `RAG_DISABLED`, `RAG_PROVIDER_UNAVAILABLE`,
  `RAG_EMBEDDING_DRIFT` are **F02 deliverables** — they exist only
  inside the F02 handler. F01 maps caught RAG errors to a single
  knowledge code `KNOWLEDGE_RAG_UNAVAILABLE` with the upstream
  message in `details`.

## 1. Goal

Treat the existing MCP handler surface as **invariant**. Behind the
handlers:

- **SQLite sidecar = record-of-truth.** All structured fields and
  bodies live here.
- **RAG = vector index.** Two protected datasets receive the active
  set on every write via the existing public ingest API.
- **Legacy JSON tree removed.** No reader path traverses
  `.saivage/{skills,memory}/<scope>/records/`. The tree is removed
  during sidecar initialisation; stale operator copies are inert.

## 2. Protected Datasets

Two protected dataset entries are seeded into `config.rag.datasets`
on first boot via F02's `saveSaivageConfig`:

```ts
{ id: "knowledge.skills", source: "skill", chunker: { kind: "markdown" },
  provider: { model: "text-embedding-3-small", dim: 1024 },
  sources: [{ root: "<projectRoot>/.saivage/knowledge/", include: [] }],
  watch: false }
{ id: "knowledge.memory", source: "memory", chunker: { kind: "memory" },
  provider: { model: "text-embedding-3-small", dim: 1024 },
  sources: [{ root: "<projectRoot>/.saivage/knowledge/", include: [] }],
  watch: false }
```

`sources[0].root` is a real on-disk path (the sidecar directory) and
`include: []` ensures the FS walker finds no files; **records are
fed via `IngestInput.kind === "records"` calls from the knowledge
layer**, not via the FS sources entry. The `sources` entry exists
only to satisfy `DatasetConfig`'s schema requirement.

The two ids are **protected** at the F02 layer (mutating tools
refuse). The knowledge layer calls `manager.ingest(id, { kind:
"records", items: [...] })` directly, bypassing F02 (which only
gates external agent invocation).

Per §0.6, F01 does not rely on per-chunk `source` matching `"skill"`
or `"memory"` for filtering — `collection_id` is the discriminator.

## 3. SQLite Sidecar

Path: `.saivage/knowledge/store.sqlite`. Owned by a new
`src/knowledge/sidecar.ts`.

### 3.1 Tables

```sql
CREATE TABLE record (
  id              TEXT PRIMARY KEY,             -- UUID or builtin:<name>
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

### 3.2 Field placement (every SkillRecord/MemoryRecord field accounted for)

| Field                              | Sidecar location                                   | RAG metadata? |
|------------------------------------|----------------------------------------------------|---------------|
| `id`                               | `record.id`                                        | `metadata.path = "<kind>:<id>.md"` |
| `kind`                             | `record.kind`                                      | indirectly (collection_id) |
| `scope`                            | `record.scope`                                     | for memory: `metadata.scope` overlay enables `source="memory"` (§0.6) |
| `scope_ref`                        | `record.scope_ref`                                 | no |
| `status`                           | `record.status`                                    | filtered to `active` (§5.2) |
| `created_at` / `updated_at`        | `record.created_at`, `record.updated_at`           | `metadata.createdAt = Date.parse(updated_at)` (number) |
| `author_agent.{role,agent_id}`     | `record_json`                                      | no |
| `source.{stage_id,task_id}`        | `record_json`                                      | no |
| `expires_at` / `ttl_ms`            | `record_json`                                      | no |
| `supersedes` / `superseded_by`     | `record_json`                                      | no |
| `relates_to: uuid[]`               | `record_json`                                      | no |
| `survive_compaction`               | `record_survive` presence + `record_json`          | no |
| **Skill**                          |                                                     |  |
| `origin`                           | `record_skill.origin` (indexed)                    | no |
| `name`                             | `record_skill.name` (unique index)                 | chunk body prefix |
| `description`                      | `record_json`                                      | chunk body prefix |
| `triggers: string[]`               | `record_json`                                      | chunk body prefix |
| `target_agents`                    | `record_target_agent`                              | no |
| `body_path`                        | **removed**; body inlined into `record.body`       | n/a |
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

### 3.3 Built-in skill ids and schema breaks

Built-in skills get deterministic ids `"builtin:" + nfcLower(name)`.
This requires schema changes
([src/knowledge/types.ts](src/knowledge/types.ts)):

- `RecordBaseSchema.id` widens from `z.string().uuid()` to
  `z.union([z.string().uuid(), z.string().regex(/^builtin:/)])`.
- `AuditEntrySchema.record_id` widens the same way.
- `SkillRecordSchema` drops `body_path`; adds inline
  `body: z.string()` (mirroring `MemoryRecordSchema`).
- `BuiltinSkillFrontmatterSchema` is unchanged.

The randomUUID code path in
[src/knowledge/eagerLoader.ts](src/knowledge/eagerLoader.ts#L169-L212)
is replaced by a builtin-upsert step at sidecar init (§6.1).

## 4. Read Paths

### 4.1 `read_skill`, `get_memory`

- `read_skill`: sidecar lookup by `record.id`; assemble the legacy
  `SkillRecord` shape (sans `body_path`) from `record_json` plus
  joins; return `{ record, body: record.body, redacted_spans }`
  where `body` and `redacted_spans` come from `redactForRead`.
- `get_memory`: supports `{ id }` and `{ topic }` inputs. For
  `{ topic }`, the lookup walks `record_memory` joined to `record`,
  filtering by scope priority `session > stage > project`. For both
  variants, the supersession chain is walked via `record_json.supersedes` /
  `record_json.superseded_by` until the head; head is returned only
  when `status === "active"`. This preserves the current behavior
  ([src/knowledge/lifecycle.ts](src/knowledge/lifecycle.ts#L216-L229),
  [src/knowledge/lifecycle.ts](src/knowledge/lifecycle.ts#L733-L760)).

### 4.2 `list_skills`, `list_memories`

Sidecar query with the preserved input filters:

- skills: `scope`, `target_agent` (joined on `record_target_agent`),
  `include_archived` (default false), `include_superseded` (default
  false).
- memories: `scope`, `topic_domain` (joined on `record_memory`),
  `include_archived` (default false; superseded always filtered),
  `older_than_days` (joined on `record.updated_at`).

Output shape matches the current `listSkills` / `listMemories`
results
([src/knowledge/lifecycle.ts](src/knowledge/lifecycle.ts#L766-L833)).

### 4.3 `search_skills`, `search_memories`

Input schema unchanged: `{ query, scope?, limit? }`. Output
unchanged: `{ hits: Array<{ id, score, snippet }> }`.

Internal flow:

1. Build a `QueryFilter` for `manager.query`:
   - Always: scope filter computed by querying `record` for ids
     matching the requested scope, then `{ in: { field: "path",
     values: pathsForIds } }`.
   - Library hydrates internal-only filters `role` (current
     `ctx.role`) and `stageId` only for evicting records the caller
     cannot read — never surfaced in the public input.
2. Call `manager.query("knowledge.{skills,memory}", text, { topK:
   limit ?? 10, filter })` with the public signature (§0.6).
3. For each `QueryHit`, decode `metadata.path` → record id; sidecar
   join confirms `status === "active"` and ACL visibility; eject
   hits the caller cannot read.
4. Build `snippet`: `buildSearchSnippet(hit.text, tokens)` then
   `redactForRead(snippet).text`, matching the existing implementation
   ([src/knowledge/lifecycle.ts](src/knowledge/lifecycle.ts#L838-L880)).
5. Return `{ hits: [{ id, score: hit.score, snippet }] }`.

### 4.4 RAG-unavailable mapping

When `manager.query` throws any RAG error, the search handler returns
`{ error: { code: "KNOWLEDGE_RAG_UNAVAILABLE", message: e.message,
details: { cause: e.constructor.name } } }`. Boot already aborts on
RAG-disabled (§6.1), so this path covers only runtime provider/drift
failures.

`list_*`, `read_skill`, `get_memory` never touch RAG and remain
available.

## 5. Write Paths

### 5.1 Transaction boundary

For every mutating tool:

1. The existing handler-side validation runs (role check, scope
   check where applicable, blocked-path/secret guards). No new
   error codes; reuses `UNAUTHORIZED_ROLE`, `UNAUTHORIZED_SCOPE`,
   etc. ([src/mcp/knowledgeMemory.ts](src/mcp/knowledgeMemory.ts#L165-L181)).
2. `BEGIN IMMEDIATE` on the sidecar.
3. Apply collision/supersession rules ported verbatim from
   `lifecycle.ts` (the helper functions stay; their data source
   becomes the sidecar).
4. Write rows; update `record.body_hash = sha256(record.body)`;
   set `pending_reingest = 1`; append audit row.
5. `COMMIT`.
6. **Snapshot reingest of the affected kind**:
   `manager.ingest("knowledge.{skills,memory}", { kind: "records",
   items: <every active record of that kind, as { id, text:
   chunkPrefix+body, metadata } > })`. The pipeline's snapshot rule
   deletes chunks for any path no longer present.
7. On success, second transaction: clear `pending_reingest` for all
   active records of the kind; upsert `rag_sync` rows.
8. On ingest failure: leave `pending_reingest = 1`. Handler returns
   the structured write success **and** the unchanged result shape
   for the tool — `details.ragWarning` is **not** added, because
   that would alter the handler's response surface. Instead, the
   failure surfaces through a structured `log.warn`
   (`knowledge.rag-reingest-failed`) and through
   `pending_reingest`'s effect on the boot divergence sweep.

The handler response shape is therefore preserved unchanged for
every existing tool.

### 5.2 Lifecycle visibility filter

Only `status === "active"` records are sent to RAG. Status changes
(`supersede_*`, `archive_*`, `delete_*`, expiry handler) trigger the
same snapshot reingest, which evicts the now-inactive record from
RAG without a separate delete call.

### 5.3 Stage/session archival hooks

The lifecycle hooks
([src/knowledge/lifecycle.ts](src/knowledge/lifecycle.ts#L917-L1017))
keep their entry-point names and return shapes. Their implementation
changes from "move files to `archive/` subtree" to "set
`record.status = 'archived'` for every record with the matching
`scope_ref`". The returned `ScopeArchiveResult` fields
(`archivedSkills`, `archivedMemories` — arrays of ids) are produced
from the sidecar `UPDATE … RETURNING id` clauses.

### 5.4 Concurrency

Sidecar's `BEGIN IMMEDIATE` serialises writers. The reingest call
acquires the RAG dataset's `.ingest.lock` — concurrent reingests on
the same protected dataset surface as `IngestLockedError` → caught
and translated to `log.warn` with `pending_reingest` left set. The
next successful write of the same kind catches up.

## 6. Startup Wiring

### 6.1 Boot order

In [src/server/bootstrap.ts](src/server/bootstrap.ts):

1. Load `saivageConfig`.
2. **Hard-require `config.rag.enabled === true`.** If false, log
   fatal `KNOWLEDGE_RAG_UNAVAILABLE` and exit non-zero. F01 has no
   no-RAG fallback because the search tools cannot serve queries
   without RAG.
3. Await `createRagManager({ projectRoot, projectId, enabled: true,
   datasets: ragDatasets, providerOptions })` (the F02 step). The
   datasets array identity is shared with F02's `RagService`.
4. Call `initKnowledgeStore({ projectRoot, ragManager, ragDatasets,
   saveSaivageConfig })`:

   a. Open/migrate `.saivage/knowledge/store.sqlite`.
   b. Detect legacy `.saivage/{skills,memory}/` JSON tree (presence
      of `index.json`). If present and the sidecar contains zero
      records, return a fatal `KNOWLEDGE_MIGRATION_REQUIRED` error
      that names the legacy paths — operator must explicitly delete
      them. F01 ships **no automatic migration shim** (workspace
      rule). On fresh installs (no `index.json`), the seed step from
      [src/store/project.ts](src/store/project.ts#L145-L174) is
      replaced with a sidecar init (`record` table starts empty).
   c. If the legacy tree is present **and** the sidecar already
      contains records, delete the legacy tree (operator already
      transitioned). This handles a clean restart after the initial
      transition.
   d. Ensure the two protected dataset entries exist in
      `ragDatasets`. Push missing entries in-memory; persist via
      `saveSaivageConfig` (F02 deliverable). Survive restart.
   e. Call `manager.register(config)` for each protected dataset on
      first boot. Catch `ConfigDriftError`, `EmbeddingDriftError`,
      etc.; surface as fatal `KNOWLEDGE_RAG_UNAVAILABLE`.
   f. Upsert built-in skills (`"builtin:<name>"` ids) into the
      sidecar from `skills/builtin/<topic>/SKILL.md` files.
   g. Run the boot divergence sweep (§7.2). This is the
      **authoritative recovery step** — it inspects both the sidecar
      and the RAG vector store (via `manager.query` cardinality and
      `dataset.stats()`) and reingests on disagreement.
   h. Pre-warm the eager loader cache (the sidecar query the loader
      will use, hot in the page cache).

5. Pass `knowledgeStore` to `registerBuiltinServices` so the
   handlers receive both the sidecar handle and the `ragManager`
   reference via injection (no module-level singletons).

### 6.2 Failure isolation

If knowledge init fails after step 3, F01 marks the knowledge
service `available: false`. Every knowledge tool call then fails
with the service-unavailable envelope from `McpRuntime.callTool`.
F02's `rag` surface remains available (the failure is
knowledge-specific).

## 7. Recovery and Divergence

### 7.1 Failure modes

- **Pre-commit crash.** SQLite rolls back; RAG untouched. No recovery
  needed.
- **Post-commit, pre-reingest crash.** `pending_reingest = 1` on the
  affected row; `rag_sync.body_hash` stale. Boot sweep (§7.2)
  reingests.
- **Reingest failure (provider down, drift).** `pending_reingest`
  stays at 1; handler response shape unchanged; structured log
  records the failure. Next successful write of the same kind
  catches up via snapshot semantics; boot sweep catches up otherwise.
- **Sidecar corruption.** Hard fail at boot
  (`KNOWLEDGE_STORE_CORRUPTED`); operator restores from backup.
- **RAG corruption.** `CorruptedStoreError` →
  `KNOWLEDGE_RAG_UNAVAILABLE` on search. Boot sweep does not
  auto-rebuild; operator runs `rag_drop` + `rag_register` and the
  next successful knowledge write triggers reingest.

### 7.2 Boot divergence sweep

The sweep verifies RAG against the sidecar source of truth using
**actual vector-store state**, not just `rag_sync`:

1. For each protected dataset, query `dataset.stats()` to get the
   current chunk count and `files` count
   ([src/rag/dataset.ts](src/rag/dataset.ts)).
2. For each kind, compute `expectedIds = { id → body_hash }` from
   `record` where `status = 'active'`.
3. Issue a wildcard `manager.query(id, " ", { topK: 10000, filter:
   { pathGlob: "<kind>:*" } })` (or equivalent broad query) to
   enumerate stored paths.
4. Compute path-set symmetric difference and hash mismatches against
   `rag_sync` (the latter is a fast-path hint).
5. If non-empty, run a single snapshot reingest of the affected
   kind; clear `pending_reingest` rows; refresh `rag_sync`.

`rag_sync` is the **fast hint**; the vector-store enumeration is the
**source-of-truth comparison**. Both converge on the same
reingest.

## 8. Tool Filter Delta

Add to [READ_ONLY_TOOLS](src/agents/tool-filters.ts#L12-L15):
`search_skills`, `list_memories`, `get_memory`, `search_memories`.

| Tool             | planner/reviewer/inspector/chat (allow-list) | worker (deny-list) | Net |
|------------------|----------------------------------------------|--------------------|-----|
| `list_skills`    | included via `READ_ONLY_TOOLS` (already)     | reachable (not excluded) | unchanged |
| `read_skill`     | same                                          | same                     | unchanged |
| `search_skills`  | **gains** via `READ_ONLY_TOOLS` (new)        | already reachable        | filter widens for allow-list filters; handler ACL unchanged |
| `list_memories`  | **gains**                                     | already reachable        | same |
| `get_memory`     | **gains**                                     | already reachable        | same |
| `search_memories`| **gains**                                     | already reachable        | same |

Reminder per F02: the filter is presentation-only; the runtime
dispatcher does not re-apply it. The handler ACL
([src/knowledge/permissions.ts](src/knowledge/permissions.ts#L112-L128))
denies `data_agent` memory reads via `canCall` → envelope
`UNAUTHORIZED_ROLE`. F01 does not change the matrix.

Write tools (`create_*`, `update_*`, `supersede_*`, `archive_*`,
`delete_*`) are unaffected by F01's filter changes.

## 9. Files

| File                                                                          | Action |
|-------------------------------------------------------------------------------|--------|
| [src/knowledge/types.ts](src/knowledge/types.ts)                              | Drop `SkillRecord.body_path`; add inline `body`; widen `id` and `record_id` unions for builtin ids; widen `AuditEntrySchema.record_id`. |
| `src/knowledge/sidecar.ts` (new)                                              | Open/migrate `store.sqlite`; CRUD; active-set iterator for snapshot reingest; `rag_sync` upsert. |
| [src/knowledge/lifecycle.ts](src/knowledge/lifecycle.ts)                      | Reimplement all read/write helpers on top of the sidecar. Preserve return shapes (`SkillSummary`, `MemorySummary`, `SearchHit`, `ScopeArchiveResult`) byte-for-byte. Rewrite `archive*Scope` to status-only. |
| [src/knowledge/store.ts](src/knowledge/store.ts)                              | Delete JSON-tree implementation; keep `KnowledgeStoreError` class only. |
| [src/knowledge/eagerLoader.ts](src/knowledge/eagerLoader.ts), [src/knowledge/loader.ts](src/knowledge/loader.ts) | Repoint `loadAllCandidates` / `resolveEagerRecords` at sidecar queries; preserve API. |
| [src/mcp/knowledgeSkills.ts](src/mcp/knowledgeSkills.ts), [src/mcp/knowledgeMemory.ts](src/mcp/knowledgeMemory.ts) | Unchanged tool schemas. Wire into new lifecycle layer; map RAG errors to `KNOWLEDGE_RAG_UNAVAILABLE` in search paths. |
| [src/mcp/builtins.ts](src/mcp/builtins.ts#L1912-L1966)                        | Add `knowledge` option to `registerBuiltinServices`; carry manager + sidecar handles. |
| [src/server/bootstrap.ts](src/server/bootstrap.ts#L133-L151)                  | New §6.1 boot order; fatal exit on RAG-disabled; `initKnowledgeStore` call; legacy-tree refusal/clean-up. |
| [src/store/project.ts](src/store/project.ts#L145-L174)                        | Remove legacy JSON tree seeding; sidecar init takes over. |
| [src/agents/tool-filters.ts](src/agents/tool-filters.ts#L12-L15)              | Extend `READ_ONLY_TOOLS` per §8. |
| `src/knowledge/sidecar.test.ts` (new)                                         | Migrations; transactional writes; snapshot iterator; lifecycle filter; supersession chain walk; concurrent writer serialisation. |
| `src/knowledge/recovery.test.ts` (new)                                        | Pre-commit and post-commit crash; boot divergence sweep against in-memory vector store; pending_reingest catch-up. |
| `src/mcp/knowledgeSkills.test.ts`, `src/mcp/knowledgeMemory.test.ts`          | Handler-level tests; response-shape preservation; topic-based get_memory; redaction; RAG-unavailable mapping. |
| `src/agents/tool-filters.test.ts`                                             | Filter delta coverage. |
| `SPEC/v2/knowledge/01-runtime.md` (new)                                       | Operator-facing summary. |

## 10. Internal Consistency

- §0 documents the verified current state from cited line ranges.
- §0.2 lists every current MCP read input schema and output shape;
  §4 implementations preserve all of them.
- §0.3 lists current write helper return shapes; §5 preserves them
  (no `details.ragWarning` added).
- §0.6 corrects RAG facts: no `sources: [{kind:"records"}]` (uses
  real on-disk root with empty include); `manager.query(id, text,
  options)`; pipeline ignores `metadata.source`; F01 disambiguates
  by `collection_id`; `createRagManager` awaited.
- §0.5 quotes the actual ACL; F01 does not change the matrix; ACL
  failures keep `UNAUTHORIZED_ROLE` / `UNAUTHORIZED_SCOPE`.
- §0.7 calls out non-existent error names (`RAG_DISABLED`,
  `RAG_PROVIDER_UNAVAILABLE`, ...) as F02 internals; F01 collapses
  them to `KNOWLEDGE_RAG_UNAVAILABLE`.
- §3.3 enumerates the schema breaks required by deterministic
  builtin ids and inline skill body; §9 lists the type file edit.
- §5.3 keeps the lifecycle hook return shape while moving archival
  to status-only.
- §6.1 specifies legacy-tree handling: refuse install when sidecar
  is empty + JSON tree present (no migration shim); clean up after
  transition.
- §7.2 grounds divergence detection in the vector store, not only
  in `rag_sync`.
- §8's filter delta lists `data_agent` as filter-permitted but
  handler-denied, reconciling §0.5.
- §9 covers `builtins.ts`, `bootstrap.ts`, `project.ts`,
  `types.ts`, `lifecycle.ts`.

## 11. Backout

The runtime never reads the legacy `.saivage/{skills,memory}/`
tree after F01. The §6.1.b refusal step prevents silent data loss:
a project carrying a legacy tree but an empty sidecar cannot boot
until the operator deletes the tree (after confirming external
backup). After the transition, the runtime cleans stale copies. No
migration shim, no parallel writes. Rollback to pre-F01 requires
reverting the code and restoring the JSON tree from backups; F01
deliberately does not preserve parallel-write capability.
