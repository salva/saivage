# F01 — Skills & Memories on the RAG Subsystem: Functional Analysis

This analysis re-grounds the Saivage knowledge store on the RAG
subsystem. After F01, skill bodies and memory bodies live inside two
**protected RAG datasets**; an authoritative SQLite **sidecar** holds
the structured metadata fields the existing handlers rely on. The
legacy JSON-tree under `.saivage/{skills,memory}/` is fully removed.

## 0. Current State

### 0.1 On-disk layout (today)

`.saivage/skills/<scope>/<scope-ref>/records/<uuid>.json` — frontmatter
record; the body lives in a sibling Markdown file referenced by
`body_path`.
`.saivage/memory/<scope>/<scope-ref>/records/<uuid>.json` — the body
is inline (no body_path).
`<scope>` ∈ `project | stages/<stage_id> | sessions/<session_id>`.
`index.json` per scope directory caches `(id → relative path)`;
`audit.jsonl` records every write attempt.
Built-in skills live in `skills/builtin/<topic>/SKILL.md`; the loader
assigns `id = randomUUID()` per process.

### 0.2 Record schemas

[SkillRecord](src/knowledge/types.ts#L105-L117) shape (all fields are
indexable today via filesystem walking):

`id: uuid`, `kind: "skill"`, `scope`, `status`, `created_at` (ISO),
`updated_at` (ISO), `author_agent: { role, agent_id }`,
`source?: { stage_id, task_id }`, `scope_ref?`, `expires_at?`,
`ttl_ms?`, `supersedes?`, `superseded_by?`, `relates_to: uuid[]`,
`survive_compaction: bool`, `origin: "builtin"|"project"`,
`name: string`, `description: string`, `triggers: string[]`,
`target_agents: KnowledgeAgentRole[]`, `body_path: string`.

[MemoryRecord](src/knowledge/types.ts#L147-L158) shape:

Same `RecordBase` plus `topic: { domain, subject, aspect? }`,
`keys: string[]`, `target_agents: KnowledgeAgentRole[]`, `body: string`
(inline), `source_ref?: { kind, id }`.

### 0.3 Eager loading

At process start the knowledge store walks `.saivage/skills/builtin/`
+ `.saivage/skills/<scope>/` and loads every record satisfying
`survive_compaction === true` into the long-lived context. Memory
records with `survive_compaction === true` follow the same path.

### 0.4 Current MCP read schemas

The existing search/list tools have these input shapes (preserved
verbatim by F01):

- `search_skills`: `{ query: string, scope?: KnowledgeScope, limit?: number }`
- `list_skills`: `{ scope?: KnowledgeScope, limit?: number, after?: string }`
- `read_skill`: `{ id: string }`
- `search_memories`: `{ query: string, scope?: KnowledgeScope, limit?: number }`
- `list_memories`: `{ scope?: KnowledgeScope, limit?: number, after?: string }`
- `get_memory`: `{ id: string }`

The current `search_*` result shape is `{ hits: Array<{ id, score,
snippet }> }`. F01 preserves this exactly.

### 0.5 Current tool filter

[READ_ONLY_TOOLS](src/agents/tool-filters.ts#L12-L15) =
`{ read_file, list_dir, search_files, git_status, git_log, git_diff,
list_skills, read_skill }`. The memory read tools (`list_memories`,
`get_memory`, `search_memories`) and `search_skills` are **not**
currently in `READ_ONLY_TOOLS` and are reached only by roles whose
allow-list filter explicitly includes them or by workers via the
deny-list filter.

### 0.6 Current knowledge ACL (relevant rows)

[permissions.ts](src/knowledge/permissions.ts#L100-L130) data points:

- `data_agent` has `read-skill / list-skill / search-skill = "Y"` but
  every memory op = `"-"`. Granting data_agent filter access to memory
  read tools is still blocked by the handler-level `canCall` check
  with envelope `KNOWLEDGE_PERMISSION_DENIED`.
- Workers (`coder`, `researcher`, `data_agent` — for skills only)
  carry `Y†` on writes; `checkScope`
  ([permissions.ts](src/knowledge/permissions.ts#L260)) enforces
  worker writes are confined to their current `stage_id` and stage
  scope.
- The handler [knowledgeMemory.ts](src/mcp/knowledgeMemory.ts#L216)
  does not enforce any topic restriction.

### 0.7 RAG types relevant to F01

- [ChunkMetadata.createdAt](src/rag/types.ts#L77) is `number` (epoch
  ms), optional. F01's pipeline metadata mapping coerces ISO strings
  via `Date.parse(record.updated_at)`.
- [ChunkMetadataInput](src/rag/types.ts#L84) is
  `Omit<ChunkMetadata, ...>` with `source` dropped (set by the
  pipeline from `inferSource(path)`); for record-style ingest the
  pipeline applies `metadataOverlay.scope` to produce `source =
  "memory"` for inline-body kinds.
- There is no `record_id` field reaching `ChunkMetadata`; the only
  internal `recordId` lives on the pipeline's `InputItem` and never
  reaches stored metadata. F01 joins via `metadata.path`.

## 1. Goal

Treat the existing handler surface as the **invariant**. Behind the
handlers:

- **RAG = vector index.** Two protected datasets, `knowledge.skills`
  and `knowledge.memory`, source-tagged `"skill"` and `"memory"`.
- **SQLite sidecar = record-of-truth.** All structured fields live
  here; the body lives both in the sidecar (canonical) and in RAG
  chunks (indexed). RAG receives a full-snapshot reingest for the
  affected kind on every write.
- **Legacy JSON tree removed.** No reader path traverses
  `.saivage/{skills,memory}/<scope>/records/`. The tree is deleted at
  install; stale operator copies are inert.

## 2. Datasets

Two protected dataset entries are seeded into `config.rag.datasets` on
first boot using `saveSaivageConfig` (the F02 deliverable —
[src/config.ts](src/config.ts) extension):

```ts
{ id: "knowledge.skills", source: "skill", chunker: { kind: "markdown" },
  provider: { model: "text-embedding-3-small", dim: 1024 },
  sources: [{ kind: "records" }], watch: false }
{ id: "knowledge.memory", source: "memory", chunker: { kind: "memory" },
  provider: { model: "text-embedding-3-small", dim: 1024 },
  sources: [{ kind: "records" }], watch: false }
```

`sources: [{ kind: "records" }]` is a sentinel; the actual record
items are supplied at ingest time by the knowledge layer (the
pipeline accepts `IngestInput.kind === "records"` today and walks
`items` directly).

These two ids are **protected** at the F02 layer: the four mutating
tools (`rag_register`, `rag_ingest`, `rag_drop`, `rag_admin`) refuse
operation against `source ∈ {skill, memory}`. The knowledge layer
calls the manager API directly (`manager.ingest`, `manager.query`)
bypassing F02's protection, because protection there is intended for
external agent invocation only.

## 3. SQLite Sidecar

Path: `.saivage/knowledge/store.sqlite`. Opened by a new
`src/knowledge/store.ts` that owns the connection and migrations.

### 3.1 Tables

```sql
-- One row per knowledge record (skill or memory).
CREATE TABLE record (
  id              TEXT PRIMARY KEY,           -- See §3.3 for skill ids
  kind            TEXT NOT NULL CHECK (kind IN ('skill','memory')),
  scope           TEXT NOT NULL CHECK (scope IN ('project','stage','session')),
  scope_ref       TEXT,                       -- NULL iff scope='project'
  status          TEXT NOT NULL CHECK (status IN ('active','superseded','archived','expired')),
  created_at      TEXT NOT NULL,              -- ISO8601 UTC
  updated_at      TEXT NOT NULL,
  body            TEXT NOT NULL,              -- canonical body
  body_hash       TEXT NOT NULL,              -- sha256(body) for divergence
  record_json     TEXT NOT NULL,              -- frozen full record incl. all unindexed fields
  pending_reingest INTEGER NOT NULL DEFAULT 0 -- 1 ⇒ last RAG ingest failed
);
CREATE INDEX record_kind_status ON record(kind, status);
CREATE INDEX record_scope ON record(scope, scope_ref);

-- Skill-specific indexed fields.
CREATE TABLE record_skill (
  id              TEXT PRIMARY KEY REFERENCES record(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  origin          TEXT NOT NULL CHECK (origin IN ('builtin','project'))
);
CREATE UNIQUE INDEX record_skill_name ON record_skill(name);  -- enforced uniqueness
CREATE INDEX record_skill_origin ON record_skill(origin);

-- Memory-specific indexed fields.
CREATE TABLE record_memory (
  id              TEXT PRIMARY KEY REFERENCES record(id) ON DELETE CASCADE,
  topic_domain    TEXT NOT NULL,
  topic_subject   TEXT NOT NULL,
  topic_aspect    TEXT
);
CREATE INDEX record_memory_topic ON record_memory(topic_domain, topic_subject);

-- Eager-load flag.
CREATE TABLE record_survive (
  id TEXT PRIMARY KEY REFERENCES record(id) ON DELETE CASCADE
);

-- Target_agents fan-out.
CREATE TABLE record_target_agent (
  id TEXT REFERENCES record(id) ON DELETE CASCADE,
  agent_role TEXT NOT NULL,
  PRIMARY KEY (id, agent_role)
);

-- Audit log (replaces audit.jsonl).
CREATE TABLE audit (
  ts TEXT NOT NULL, record_id TEXT NOT NULL, op TEXT NOT NULL, outcome TEXT NOT NULL,
  error_code TEXT, author_role TEXT NOT NULL, author_agent_id TEXT NOT NULL,
  reason TEXT NOT NULL, prev_status TEXT, next_status TEXT,
  content_hash_before TEXT, content_hash_after TEXT
);
CREATE INDEX audit_record ON audit(record_id, ts);

-- RAG snapshot pairing (used for divergence detection at boot).
CREATE TABLE rag_sync (
  id            TEXT PRIMARY KEY REFERENCES record(id) ON DELETE CASCADE,
  collection_id TEXT NOT NULL CHECK (collection_id IN ('knowledge.skills','knowledge.memory')),
  body_hash     TEXT NOT NULL,             -- hash that was last successfully embedded
  embedded_at   TEXT NOT NULL
);
```

### 3.2 Field placement table

Every current field of `SkillRecord` and `MemoryRecord` is classified:

| Field                              | Sidecar location                                  | RAG metadata? |
|------------------------------------|---------------------------------------------------|---------------|
| `id`                               | `record.id`                                       | as `metadata.path = "<kind>:<id>"` |
| `kind`                             | `record.kind`                                     | as `metadata.source = "skill"|"memory"` |
| `scope`                            | `record.scope`                                    | no (filter through sidecar join) |
| `scope_ref`                        | `record.scope_ref`                                | no |
| `status`                           | `record.status`                                   | no (filtered to `active` at ingest; see §5.2) |
| `created_at` / `updated_at`        | `record.created_at`, `record.updated_at`          | `metadata.createdAt = Date.parse(updated_at)` |
| `author_agent.{role,agent_id}`     | `record_json`                                     | no |
| `source.{stage_id,task_id}`        | `record_json`                                     | no |
| `expires_at` / `ttl_ms`            | `record_json`                                     | no |
| `supersedes` / `superseded_by`     | `record_json`                                     | no |
| `relates_to: uuid[]`               | `record_json`                                     | no |
| `survive_compaction: bool`         | `record_survive` (presence row) + `record_json`   | no |
| **Skill-only**                     |                                                    | |
| `origin`                           | `record_skill.origin` (indexed)                   | no |
| `name`                             | `record_skill.name` (unique index)                | no |
| `description`                      | `record_json`                                     | included in chunk body prefix |
| `triggers: string[]`               | `record_json`                                     | included in chunk body prefix |
| `target_agents`                    | `record_target_agent`                             | no |
| `body_path`                        | dropped (body inlined into `record.body`)         | n/a |
| **Memory-only**                    |                                                    | |
| `topic.{domain,subject,aspect}`    | `record_memory` (indexed on domain+subject)       | no |
| `keys: string[]`                   | `record_json`                                     | included in chunk body prefix |
| `target_agents`                    | `record_target_agent`                             | no |
| `body`                             | `record.body` (canonical)                          | embedded |
| `source_ref.{kind,id}`             | `record_json`                                     | no |

The chunk body prefix for skills is `"# <name>\n<description>\n\n"`
prepended to the body; for memories it is `"<topic.domain>/<topic.subject>"
(no aspect)\nkeys: <comma-joined>\n\n" + body`. This produces useful
matches against the structured metadata fields without inventing new
RAG metadata columns.

`updated_at` mapping: pipeline supplies `metadata.createdAt` as a
`number` ([src/rag/types.ts](src/rag/types.ts#L77)); F01 coerces with
`Date.parse(record.updated_at)`. Audit JSONL is replaced by the
`audit` table.

### 3.3 Built-in skill ids

Built-in skills (`skills/builtin/<topic>/SKILL.md`) get
deterministic ids `"builtin:" + nfcLower(frontmatter.name)`. The
loader inserts/upserts a `record` row with `origin='builtin'`; the
unique index on `record_skill.name` enforces the documented name
uniqueness invariant. The previous `randomUUID()` path is removed.

The `record.id` column accepts both UUIDs (project records) and
`builtin:<name>` strings.

## 4. Read Paths

### 4.1 `read_skill`, `get_memory`

Direct sidecar lookup by `record.id`. The response shape preserved
exactly is the existing record JSON. The body field is read from
`record.body` (the legacy `body_path` field is no longer emitted for
skills; the `SkillRecord` schema in
[src/knowledge/types.ts](src/knowledge/types.ts#L117) is updated to
move the body inline and the `body_path` field is removed).

### 4.2 `list_skills`, `list_memories`

Sidecar query; ordering by `(created_at DESC, id ASC)` with
`limit` + `after` cursor (cursor encodes `(created_at, id)`).

### 4.3 `search_skills`, `search_memories`

Inputs unchanged: `{ query, scope?, limit? }`. Result shape
**unchanged**: `{ hits: Array<{ id, score, snippet }> }`.

Internal flow:

1. Compute the hydrated filter. Mandatory: `eq("source", "skill"|"memory")`.
   When the caller passes `scope`, F01 also queries
   `record` by scope and uses the resulting ids in a
   `{ in: { field: "path", values: [...] } }` filter on RAG.
   `role` hydration: handler reads `ctx.role` and `ctx.stageId`
   internally to filter records the caller is allowed to see —
   **never exposed as a public input field**.
2. `manager.query("knowledge.{skills,memory}", { text, topK,
   filter })` returns `RagHit[]`.
3. Each hit's `metadata.path` decodes to the record id. Sidecar join
   yields canonical record fields for ACL checks (`canCall` /
   `checkScope`).
4. Reduce to `{ id, score, snippet }`. `snippet` is hit `text`
   truncated to the existing public-snippet length (current handler
   uses 240 chars; preserved).

### 4.4 Search-disabled fallback

If the manager throws `RAG_DISABLED` (it must not, because F01
requires `config.rag.enabled === true` to even start — see §6.1),
the handler returns `KNOWLEDGE_RAG_UNAVAILABLE`. If
`RAG_PROVIDER_UNAVAILABLE` or `RAG_EMBEDDING_DRIFT` surfaces, the
handler returns `KNOWLEDGE_RAG_UNAVAILABLE` with the upstream message
in `details`. List/get/read operations remain available because they
do not touch RAG.

## 5. Write Paths

### 5.1 Transaction boundary

`create_skill`, `update_skill`, `create_memory`, `update_memory`,
`supersede_*`, `archive_*`, `delete_*`:

1. `BEGIN IMMEDIATE` on the sidecar.
2. Apply ACL (`canCall` + `checkScope`).
3. Write/patch `record`, `record_skill`/`record_memory`,
   `record_survive`, `record_target_agent`, `audit`. Update
   `record.body_hash = sha256(record.body)`. Set
   `record.pending_reingest = 1`.
4. `COMMIT`.
5. Issue a **full-snapshot reingest of the affected kind** through
   `manager.ingest("knowledge.{skills,memory}", { kind: "records",
   items: [...] })`. The items list is `SELECT id, body, … FROM
   record WHERE kind = ? AND status = 'active'`. The pipeline's
   snapshot semantics then delete chunks for any record no longer in
   the active set (replicating the lifecycle visibility rule —
   superseded/archived/expired records disappear from RAG without
   removing them from the sidecar).
6. On ingest success, in a second transaction: set
   `record.pending_reingest = 0` for **every active record of that
   kind**, and upsert `rag_sync` rows with the new `body_hash` and
   `embedded_at`.
7. On ingest failure, leave `pending_reingest = 1` on the affected
   row(s); the handler returns success for the structured write but
   includes `details.ragWarning: "<code>"` in the response. Recovery
   is automatic on the next successful write of the same kind
   (snapshot reingest catches up).

### 5.2 Lifecycle filtering

Only `status === "active"` records are sent to RAG. State transitions
(`supersede_skill`, `archive_skill`, etc.) trigger a snapshot reingest
that removes the affected record from RAG via the pipeline's deletion
of unseen paths.

### 5.3 Concurrency

Sidecar holds the per-process mutex via `BEGIN IMMEDIATE`. Concurrent
F01 writes serialise at the sidecar. The RAG ingest acquires the
F01's own ingest mutex (separate from F02's `controlMutex` since F01
calls the manager directly, not through F02). Errors from the
embedder bubble up as `KNOWLEDGE_RAG_UNAVAILABLE`.

## 6. Startup Wiring

### 6.1 Boot order

In [src/server/bootstrap.ts](src/server/bootstrap.ts) the new sequence:

1. Load `saivageConfig`.
2. **Hard-require `config.rag.enabled === true` and an embedding
   provider with valid credentials.** If absent, log a fatal
   `KNOWLEDGE_RAG_UNAVAILABLE` and exit non-zero. F01 does not have a
   no-RAG fallback.
3. Construct `RagManager` (the F02 step, which adds `enabled`,
   `datasets`, `providerOptions`). The datasets array is the same
   identity shared with F02's `RagService`.
4. Call `initKnowledgeStore({ projectRoot, ragManager,
   ragDatasets })`. This:
   - Opens/migrates `.saivage/knowledge/store.sqlite`.
   - Ensures the two protected dataset entries exist in
     `ragDatasets`. Missing entries are pushed in-memory **and**
     persisted via `saveSaivageConfig` (F02 dependency) so they
     survive restart.
   - Calls `manager.register(config)` for each protected dataset on
     first boot. `ConfigDriftError` from the manager (provider stamp
     mismatch with stored config) surfaces as
     `KNOWLEDGE_RAG_UNAVAILABLE` with `details.cause: "drift"`.
   - Runs the boot-time divergence sweep (§7.2).
   - Loads built-in skills via deterministic ids (§3.3).
   - Loads `survive_compaction = true` records into the eager-load
     buffer.
5. Call `registerBuiltinServices(mcpRuntime, mcpConfig, securityConfig,
   { rag: ragService, knowledge: knowledgeStore })`. The new
   `knowledge` option supplies the existing knowledge handlers with
   the `ragManager` reference (in addition to the sidecar handle they
   own). Handlers receive both via injection — no module-level
   singletons.

### 6.2 Failure isolation

If knowledge init fails after step 3, the manager is still alive but
the knowledge service registers as `available: false` so every
knowledge tool call fails fast with the service-unavailable envelope.

## 7. Recovery and Divergence

### 7.1 Failure modes catalogued

- **Pre-commit crash.** Sidecar write is rolled back by SQLite. RAG
  is untouched. No recovery needed.
- **Post-commit, pre-ingest crash.** Sidecar carries
  `pending_reingest = 1` on the affected row; the corresponding
  `rag_sync.body_hash` is stale. Recovery is the boot divergence
  sweep (§7.2).
- **Ingest failure (provider down, drift).** `pending_reingest`
  stays at 1; handler returns `details.ragWarning`. Recovery is the
  next successful write of the same kind (snapshot catches up) or
  the boot sweep.
- **Sidecar corruption.** Hard fail at boot
  (`KNOWLEDGE_STORE_CORRUPTED`); operator restores from backup. RAG
  contents are reproducible by reingest once the sidecar is back.
- **RAG corruption.** `RagManager` surfaces
  `CorruptedStoreError` → `KNOWLEDGE_RAG_UNAVAILABLE`. The boot
  sweep does not auto-rebuild; the operator runs `rag_drop` +
  `rag_register` + first write triggers reingest.

### 7.2 Boot divergence sweep

After `initKnowledgeStore` registers the protected datasets:

1. For each kind, compute `expected = { id → body_hash }` from
   `record` where `status = 'active'`.
2. Load `actual = { id → body_hash }` from `rag_sync` where
   `collection_id = "knowledge.{skills,memory}"`.
3. Compute symmetric difference. If non-empty, run a single
   snapshot reingest of the kind, then update `rag_sync` and clear
   `pending_reingest` rows as in §5.1.

`rag_sync` is the **primary** divergence-detection mechanism;
`pending_reingest` is a fast hint that survives crashes between commit
and reingest. Both are reconciled by the same sweep.

## 8. Tool Filter Delta

Add to [READ_ONLY_TOOLS](src/agents/tool-filters.ts#L12-L15):

`search_skills`, `list_memories`, `get_memory`, `search_memories`.

Before/after:

| Tool             | Filter access before                | Filter access after                |
|------------------|-------------------------------------|------------------------------------|
| `list_skills`    | every role (READ_ONLY)              | every role (READ_ONLY) — unchanged |
| `read_skill`     | every role (READ_ONLY)              | every role (READ_ONLY) — unchanged |
| `search_skills`  | only roles whose allow-list grants  | every role (READ_ONLY)             |
| `list_memories`  | only roles whose allow-list grants  | every role (READ_ONLY)             |
| `get_memory`     | only roles whose allow-list grants  | every role (READ_ONLY)             |
| `search_memories`| only roles whose allow-list grants  | every role (READ_ONLY)             |

Filter access is a necessary-not-sufficient condition. The handler
ACL [permissions.ts](src/knowledge/permissions.ts#L112-L130) still
denies `data_agent` memory reads via `canCall` → envelope
`KNOWLEDGE_PERMISSION_DENIED`. Net behaviour:

- `data_agent` can name-resolve the memory tools but every call is
  rejected by `canCall`. Safe.
- Other roles (`planner`, `manager`, `coder`, `researcher`,
  `inspector`, `reviewer`, `designer`, `critic`, `chat`) already have
  `Y` on memory reads; they now reach the tools by the read-only
  filter too.

Write tools (`create_skill`, `update_skill`, `create_memory`,
`update_memory`, `supersede_*`, `archive_*`, `delete_*`) are
unaffected by F01's filter changes.

## 9. Files

| File                                                                          | Action                                                                       |
|-------------------------------------------------------------------------------|------------------------------------------------------------------------------|
| [src/knowledge/types.ts](src/knowledge/types.ts)                              | Drop `SkillRecord.body_path`; add inline `body: string`.                     |
| [src/knowledge/store.ts](src/knowledge/store.ts) (new)                        | Sidecar open/migrate/CRUD; snapshot iterator for RAG ingest; rag_sync upsert.|
| Remove legacy JSON-tree implementation                                        | Delete the loader and writer code under `src/knowledge/` that touches `.saivage/{skills,memory}/<scope>/`. |
| [src/knowledge/permissions.ts](src/knowledge/permissions.ts)                  | Unchanged for F01. (F03 extends.)                                            |
| [src/mcp/knowledgeSkills.ts](src/mcp/knowledgeSkills.ts)                      | Replace JSON-tree read/write with sidecar+RAG; preserve handler signatures.  |
| [src/mcp/knowledgeMemory.ts](src/mcp/knowledgeMemory.ts)                      | Same as above for memories.                                                  |
| [src/mcp/builtins.ts](src/mcp/builtins.ts#L1912)                              | Add `knowledge` option to `registerBuiltinServices`; pass manager handle.    |
| [src/server/bootstrap.ts](src/server/bootstrap.ts)                            | New §6.1 boot order; fatal exit on RAG-disabled; `initKnowledgeStore` call.  |
| [src/agents/tool-filters.ts](src/agents/tool-filters.ts#L12-L15)              | Extend `READ_ONLY_TOOLS` per §8.                                             |
| `src/knowledge/store.test.ts` (new)                                           | Migrations, transactional writes, snapshot iterator, lifecycle filtering.    |
| `src/knowledge/recovery.test.ts` (new)                                        | Pre-commit and post-commit crash recovery; boot divergence sweep; pending_reingest behaviour. |
| `src/mcp/knowledgeSkills.test.ts`, `src/mcp/knowledgeMemory.test.ts`          | Handler-level tests; result shape preservation; RAG-disabled envelope.       |
| `src/agents/tool-filters.test.ts`                                             | Filter delta coverage.                                                       |
| `SPEC/v2/knowledge/01-runtime.md` (new)                                       | Operator-facing summary.                                                     |

## 10. Internal Consistency

- §0 documents the current state; §1 frames the goal as preserving
  the handler shape on top of new internals.
- §3.2 enumerates every field in
  [SkillRecord](src/knowledge/types.ts#L105-L117) and
  [MemoryRecord](src/knowledge/types.ts#L147-L158); none unaccounted
  for. `body_path` is the only removed field; its body is inlined.
- §4.3 preserves the public search result shape exactly as the
  current handler returns. Internal hydration fields (`scopeRef`,
  `role`) are **never** in the public input schema (§0.4 lists the
  unchanged schemas).
- §3.3 uses `"builtin:" + nfcLower(name)` for built-in ids;
  uniqueness is enforced by `record_skill.name` unique index.
- §5.1 issues full-snapshot reingest after every commit; §5.2's
  lifecycle filter and the pipeline's snapshot semantics together
  give the correct active-only view in RAG without separate delete
  calls.
- §6.1 establishes RAG-required boot order and the
  `saveSaivageConfig` dependency on F02. The dataset array identity
  is shared with F02 (one mutable list).
- §7 distinguishes ingest-failure recovery (pending_reingest +
  catch-up on next write) from crash recovery (boot divergence sweep
  via `rag_sync`); the sweep is the primary, the marker is a hint.
- §8's filter delta lists `data_agent` as filter-permitted but
  handler-denied — explicit reconciliation against the matrix in
  §0.6.
- §9's file inventory covers `builtins.ts` and `bootstrap.ts` per
  §6.1.

## 11. Backout

The runtime never reads the legacy `.saivage/{skills,memory}/<scope>/`
tree after F01. Stale operator copies are inert artefacts; they do
not affect the sidecar or RAG and may be removed by the operator at
any time. The store ships with a one-shot install step that deletes
the legacy tree when the new sidecar is initialised on a project that
previously used JSON-tree storage. No migration shim, no read-side
fallback — by workspace rule.

Rollback to pre-F01 requires reverting the code and recreating the
JSON tree from external backups; F01 deliberately does not preserve
parallel-write capability.
