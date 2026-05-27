# F01 — Skill and Memory on RAG: Functional Analysis

This analysis treats the RAG subsystem under [src/rag/](src/rag/) as the
**primary** storage and retrieval backend for skills and memories. The
bespoke JSONL/index/keyword machinery currently under
[src/knowledge/](src/knowledge/) is reduced to a thin facade — a
sidecar metadata table plus a few lifecycle helpers — and most of it is
deleted.

No public surface of [src/rag/](src/rag/) is changed by this feature.
Where the existing RAG API is too narrow, this design routes around the
gap using existing primitives (`Dataset.ingest` with `records`,
`Dataset.query` with `QueryFilter`, `Dataset.reconcile`) and names the
gap as an explicit follow-up if any remains.

## 1. Current State

### 1.1 On-disk layout (today)

Active records live under three scope subtrees per kind
([src/knowledge/lifecycle.ts](src/knowledge/lifecycle.ts#L106-L121)):

```
<projectRoot>/.saivage/
  skills/
    project/records/<uuid>.json     # record JSON
    project/records/<uuid>.md       # body (referenced by body_path)
    project/index.json              # rebuilt aggregate
    project/audit.jsonl             # append-only audit
    stages/<stageId>/...            # same shape
    sessions/<sessionId>/...        # same shape
  memory/
    project/records/<uuid>.json     # body inlined into record JSON
    project/index.json
    project/audit.jsonl
    stages/<stageId>/...
    sessions/<sessionId>/...
```

Skill bodies are physical files at `<scopeDir>/<record.body_path>`,
typically `records/<uuid>.md`. Memory bodies are stored inline in the
record's `body` field
([src/knowledge/types.ts](src/knowledge/types.ts#L146-L155)).

Built-in skills are mounted at
`<bundle>/skills/builtin/<topic>/SKILL.md` and read via
[walkBuiltinSkills](src/knowledge/eagerLoader.ts#L165-L221). They are
**not** materialised as JSON records on disk; the eager loader fabricates
a synthetic `SkillRecord` with a fresh `randomUUID()` every load.

### 1.2 Indexing and search

Per scope, [rebuildIndex](src/knowledge/store.ts) scans `records/*.json`
and writes `index.json`. The loader/searcher
[src/knowledge/loader.ts](src/knowledge/loader.ts) tokenises queries with
`canonicalizeTokens` (NFC → lower → Unicode-letter/number split) and
scores results:

- `scoreSkillForSearch`: `3·name + 3·triggers + 2·description + 1·body_snippet`
  ([src/knowledge/loader.ts](src/knowledge/loader.ts#L102-L130)).
- `scoreMemoryForSearch`: `3·topic + 2·keys + 1·body_snippet`
  ([src/knowledge/loader.ts](src/knowledge/loader.ts#L77-L99)).

Trigger scoring at agent boot (`scoreSkillTriggers` —
keyword/tag/agent only) and eager budgeting (`splitByBudget`,
`resolveEagerRecords`) live in the same file and are used by
`eagerLoader.ts` to inject pre-loaded skills/memories into the agent's
opening prompt.

### 1.3 MCP tool surface used by agents

Per [src/mcp/knowledgeSkills.ts](src/mcp/knowledgeSkills.ts#L40-L143)
and [src/mcp/knowledgeMemory.ts](src/mcp/knowledgeMemory.ts#L32-L138):

| Service  | Tools                                                                                                              |
|----------|--------------------------------------------------------------------------------------------------------------------|
| `skills` | `create_skill`, `update_skill`, `supersede_skill`, `archive_skill`, `delete_skill`, `list_skills`, `read_skill`, `search_skills` |
| `memory` | `create_memory`, `update_memory`, `supersede_memory`, `archive_memory`, `delete_memory`, `list_memories`, `get_memory`, `search_memories` |

Callers and patterns:

- Every worker role (`coder`, `researcher`, `reviewer`, `designer`,
  `critic`, `data_agent`) plus `planner`, `manager`, `inspector`, `chat`
  may call read tools (`list_*`, `read_skill`/`get_memory`,
  `search_*`); see [src/agents/tool-filters.ts](src/agents/tool-filters.ts#L13-L14)
  for the `READ_ONLY_TOOLS` set including `list_skills` and `read_skill`,
  and [src/agents/tool-filters.ts](src/agents/tool-filters.ts#L31-L41)
  for per-role gates.
- `search_skills` and `search_memories` are reached via the `worker`
  filter (`WORKER_EXCLUDED_TOOLS` denies only plan tools plus
  `create_skill`/`update_skill`).
- Write tools follow the matrix in
  [src/knowledge/permissions.ts](src/knowledge/permissions.ts#L41-L268):
  Planner/Inspector may create/update memories (project/stage/session);
  Manager may create/update/supersede/archive/delete skills and
  memories; Coder/Researcher may only create/update memory at
  `scope=stage` and `scope_ref===ctx.stageId` (the `Y†` cell enforced
  by `checkScope`).

Argument patterns are visible in the tool schemas: writes always carry a
`reason`, `scope`, optional `scope_ref`, content fields. Searches carry
`query`, optional `scope`, optional `limit`.

### 1.4 Lifecycle

Lifecycle transitions live in
[src/knowledge/lifecycle.ts](src/knowledge/lifecycle.ts): each write
acquires an in-process `scopeLifecycleLocks` chain key plus the
project-wide `runtime.lock`
([src/runtime/runtime-lock.ts](src/runtime/runtime-lock.ts)); the order
inside is reason validation → blocked-path/secret scan →
`writeRecordAtomic` (atomic rename) → audit append → `rebuildIndex`.
Status values are `active`, `superseded`, `archived`, `expired`
([src/knowledge/types.ts](src/knowledge/types.ts#L32-L37)).

### 1.5 Open contradictions in shipped code/docs

- Runtime config schema at
  [src/config.ts](src/config.ts#L217-L266) accepts only
  `text-embedding-3-small`, while shipped docs at
  [SPEC/v2/rag/configuration.md](SPEC/v2/rag/configuration.md) mention
  `text-embedding-3-large`. **Decision below: code wins; docs follow.**
- [src/rag/pipeline.ts](src/rag/pipeline.ts#L196-L208) sets
  `source = "memory"` only when `metadataOverlay.scope === "memory"`,
  but actual `KnowledgeScope` values are `project|stage|session` — so
  records ingest currently mislabels source from path extension. **This
  is a code defect the migration must work around or surface as a
  follow-up; see §6.**

## 2. Schema Gap Analysis

### 2.1 Fixed columns supplied by `ChunkMetadata`

[ChunkMetadata](src/rag/types.ts#L57-L77) fields the records ingest
input can populate via `ChunkMetadataInput`
([src/rag/types.ts](src/rag/types.ts#L79-L86)):

| Field             | Skills payload                                          | Memories payload                                                |
|-------------------|---------------------------------------------------------|------------------------------------------------------------------|
| `path`            | Synthetic stable path (see §3)                          | Synthetic stable path (see §3)                                   |
| `source`          | `"skill"`                                               | `"memory"`                                                       |
| `scope`           | `"project" \| "stage" \| "session"`                     | same                                                             |
| `scopeRef`        | stage/session id or empty for project                   | same                                                             |
| `role`            | author role (`planner`, `manager`, …)                  | same                                                             |
| `lifecycleStatus` | `"active"`                                              | `"active"`                                                       |
| `createdAt`       | record `created_at` (ms epoch)                          | same                                                             |
| `supersedes`      | previous record id when superseding                     | same                                                             |
| `headingPath`     | section heading from skill body, if any                | unused                                                           |
| `symbolName`      | skill `name`                                            | unused                                                           |
| `symbolKind`      | `"skill"`                                               | unused                                                           |
| `language`        | `"markdown"`                                            | `"markdown"`                                                     |

Fields not supplied (filled by the pipeline): `chunkIndex`, `contentHash`,
`sourceHash`, `mtimeMs`.

### 2.2 Fields that cannot live in `ChunkMetadata`

[QueryFilter](src/rag/types.ts#L114-L120) supports only `eq`, `and`,
`or`, `gt`, `lt`, `pathGlob`, `in` against the fixed columns. Arrays and
nested objects cannot be filtered. The following knowledge fields cannot
be expressed cleanly:

| Field                      | Origin                                                | Storage decision                                                  |
|----------------------------|-------------------------------------------------------|-------------------------------------------------------------------|
| `target_agents: string[]`  | Skill + memory record                                 | **Sidecar.** Filtered post-query in the loader.                   |
| `triggers: string[]`       | Skill record                                          | **Sidecar.** Read for `eager` injection only.                     |
| `keys: string[]`           | Memory record                                         | **Sidecar.** Read for display only.                               |
| `topic.{domain,subject,aspect}` | Memory record                                    | **Sidecar.** `domain` and `subject` mirrored into `headingPath` so semantic queries still hit them. |
| `survive_compaction: bool` | Both                                                  | **Sidecar.** Read by eager loader.                                |
| `ttl_ms`, `expires_at`     | Both                                                  | **Sidecar.** Lifecycle helper computes expiry; `lifecycleStatus` is the chunk column source of truth. |
| `relates_to: string[]`     | Both                                                  | **Sidecar.** Display only.                                        |
| `superseded_by`            | Both                                                  | **Sidecar.** `supersedes` chunk column captures the reverse edge. |
| `source_ref`               | Memory record                                         | **Sidecar.**                                                      |
| `origin: builtin|project`  | Skill record                                          | **Sidecar.**                                                      |
| `author_agent.agent_id`    | Both                                                  | **Sidecar.** `role` chunk column captures the role half.          |

### 2.3 Fields dropped entirely

- `kind`: implied by `source` ("skill" vs. "memory").
- `body_path`: removed; bodies live in chunks plus the sidecar's
  optional `body_snippet` cache.
- Per-scope `index.json` files: removed; the RAG store is the index.

### 2.4 Sidecar schema

A single SQLite database per knowledge kind at
`<projectRoot>/.saivage/knowledge/<kind>.sqlite` (separate from the RAG
store directory, which RAG owns exclusively). Schema:

```sql
CREATE TABLE record (
  id TEXT PRIMARY KEY,                 -- record UUID or builtin stable id
  kind TEXT NOT NULL,                  -- 'skill' | 'memory'
  scope TEXT NOT NULL,                 -- project|stage|session
  scope_ref TEXT,                      -- null for project
  status TEXT NOT NULL,                -- active|superseded|archived|expired
  created_at TEXT NOT NULL,            -- ISO8601
  updated_at TEXT NOT NULL,
  author_role TEXT NOT NULL,
  author_agent_id TEXT NOT NULL,
  origin TEXT,                         -- 'builtin'|'project' (skills)
  name TEXT,                           -- skill name
  description TEXT,                    -- skill description
  triggers_json TEXT,                  -- json array
  target_agents_json TEXT,             -- json array
  topic_domain TEXT,                   -- memory
  topic_subject TEXT,                  -- memory
  topic_aspect TEXT,                   -- memory
  keys_json TEXT,                      -- json array
  source_ref_json TEXT,                -- memory source provenance
  survive_compaction INTEGER NOT NULL, -- 0|1
  expires_at TEXT,
  ttl_ms INTEGER,
  supersedes TEXT,                     -- predecessor id
  superseded_by TEXT,
  relates_to_json TEXT,
  body_snippet TEXT,                   -- first 500 chars, redacted
  rag_path TEXT NOT NULL,              -- synthetic path used in ChunkMetadata
  UNIQUE (kind, scope, scope_ref, name) -- name collision per scope (skills)
);

CREATE TABLE audit (
  rowid INTEGER PRIMARY KEY,
  ts TEXT NOT NULL,
  record_id TEXT NOT NULL,
  op TEXT NOT NULL,
  outcome TEXT NOT NULL,
  error_code TEXT,
  author_role TEXT NOT NULL,
  author_agent_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  prev_status TEXT,
  next_status TEXT
);
```

Reasoning for SQLite over JSONL: per-scope `index.json` rebuilds are the
hottest path today; an indexed table eliminates rebuilds and supports
fast `WHERE rag_path = ?` lookup after a RAG hit. The audit log keeps a
strict append-only contract via single-statement inserts.

## 3. Sources, Identity, and Synthetic Paths

### 3.1 Skills dataset

- `DatasetConfig.source = "skill"`,
  `chunker.kind = "markdown"`, `provider.model = "text-embedding-3-small"`,
  `provider.dim = 1536` (matches current default).
- `sources: []` — skills are ingested as `records`, not by filesystem
  walk, because builtin skills live in the package bundle and project
  skills travel through the MCP `create_skill` path. Watcher disabled.
- `watch: false`. Reconciliation is invoked explicitly by the facade
  after every record write.

### 3.2 Memories dataset

- `DatasetConfig.source = "memory"`,
  `chunker.kind = "memory"`, same provider/store as skills.
- `sources: []` — memories arrive via MCP writes and supersedes.
- `watch: false`.

### 3.3 Synthetic stable paths

The records ingest pipeline diffs by `metadata.path` and deletes prior
chunks for that path
([src/rag/pipeline.ts](src/rag/pipeline.ts#L108-L125),
[src/rag/pipeline.ts](src/rag/pipeline.ts#L256-L285)). To make
re-ingest idempotent, every record gets a deterministic synthetic
`rag_path`:

- Skills: `skills/<scope>[/<scopeRef>]/<recordId>.md`.
- Memories: `memory/<scope>[/<scopeRef>]/<recordId>.md`.

For projects, `<scope>` is `project`; for stages,
`stage/<stageId>`; for sessions, `session/<sessionId>`. The path is
opaque to the RAG store; nothing reads from disk at that path.

### 3.4 Stable identity for built-in skills

The eager loader currently calls
[randomUUID()](src/knowledge/eagerLoader.ts#L198) for every builtin skill
on every load, so the same skill appears under different IDs across
restarts. After this migration:

- Builtin skill id is deterministic:
  `id = "builtin:" + nfcLower(name)` where `name` is the YAML
  `name:` field.
- `rag_path` for a builtin skill is
  `skills/builtin/<nfcLower(name)>.md`.
- Builtins are seeded into the sidecar at startup
  (see §5.1) with `origin = "builtin"` and `status = "active"`.

For project records, identity remains the record UUID stored in JSON
today, **but** record JSON files cease to exist (see §6); the UUID lives
only in the sidecar `record.id` column.

### 3.5 Sample sizes (typical project)

Skills: builtin tree ships ~10–50 skills, each 0.5–4 KB of markdown.
Project skills: typically <50 per project. Total: under 1 MB,
2k–10k tokens per chunk, single-batch embedding round trip.

Memories: 100–1000 active records per project; 200–1500 chars each.
Total: a few MB, embedding cost a few cents per full re-seed.

### 3.6 Watcher exclusions

`WatchConfig` is `false` for both datasets; no chokidar interaction.

## 4. Permissions and Scope on `QueryFilter`

Filters expressible via `QueryFilter.eq` / `in` directly:

- `scope` ∈ {`project`, `stage`, `session`}.
- `scopeRef` ∈ stage/session id list.
- `source` ∈ {`skill`, `memory`}.
- `lifecycleStatus = "active"`.

Filters not expressible in `QueryFilter`, enforced as post-query
sidecar checks:

- `target_agents` membership: load the sidecar row, drop hits whose
  `target_agents_json` array is non-empty and does not contain
  `ctx.role`.
- Worker scope (`checkScope` `Y†`): write-side only; queries are
  unaffected.
- Permissions matrix (`canCall`): gate enforced before the facade
  reaches RAG, so RAG never sees a query the caller is not allowed to
  run.

`pathGlob` is used as a coarse first filter
(`pathGlob: "skills/<scope>/**"` or `memory/<scope>/<scopeRef>/**`)
before the post-query sidecar check; this keeps `topK` results
relevant.

## 5. Lifecycle

### 5.1 First-run seeding

On Saivage startup, after the project's runtime lock is acquired and
RAG is enabled with both `skill` and `memory` datasets registered, the
facade runs a single-shot seed:

1. Open `knowledge/<kind>.sqlite`. If missing, create schema.
2. Walk built-in skills (`walkBuiltinSkills`); for each, compute
   stable id and synthetic path; upsert the sidecar row.
3. For built-in rows whose `body_snippet` differs from the prior row
   (i.e. the bundled skill text changed), submit a `records` ingest
   batch to the `skills` dataset.
4. If the sidecar `knowledge_seed_version` row is missing or below
   `CURRENT_SEED_VERSION` (constant in code), and no project records
   exist in the sidecar yet, the facade refuses to start with a clear
   `KNOWLEDGE_SEED_REQUIRED` error pointing the operator at the manual
   `saivage knowledge seed` CLI subcommand. There is no automatic
   migration from the old `records/*.json` tree; the topic mandates
   architecture-first with no backward compatibility.
5. Set `knowledge_seed_version` and proceed.

### 5.2 Create / update / supersede / archive / delete

All five operations follow the same step order:

1. `assertRuntimeLockHeld` (project-wide).
2. `canCall` and (for memory writes) `checkScope` from
   [src/knowledge/permissions.ts](src/knowledge/permissions.ts).
3. `assertReason`, `assertNotBlockedPath`, `detectSecrets` from
   [src/knowledge/store.ts](src/knowledge/store.ts).
4. Acquire the in-process scope-lifecycle chain lock for
   `<kind>:<scope>:<scopeRef>`.
5. Begin a SQLite transaction on the sidecar:
   - **create/update**: upsert `record`.
   - **supersede**: set predecessor `status = "superseded"`,
     `superseded_by = newId`; insert new row with `supersedes = oldId`.
   - **archive**: set `status = "archived"`.
   - **delete**: delete row.
6. Issue `dataset.ingest({ kind: "records", items: [...] })` where the
   items reflect the post-step-5 row state:
   - **create/update**: one item with the new content.
   - **supersede**: two items — the predecessor with empty text and
     `lifecycleStatus = "superseded"` (overwrites prior chunks at the
     predecessor's `rag_path`), plus the successor as a fresh item.
     The ingest pipeline diffs by `path` and replaces existing chunks at
     that path; empty text yields zero chunks, effectively deleting the
     prior chunks for that path.
   - **archive**: one item with the existing text and
     `lifecycleStatus = "archived"`. Queries filter on
     `eq: { lifecycleStatus: "active" }` so archived records are hidden.
   - **delete**: one item with empty text (drops chunks).
7. Commit the SQLite transaction. Insert audit row.
8. Release the chain lock.

The lock ordering is: runtime lock → scope-lifecycle chain lock →
SQLite transaction → `runIngest`'s `proper-lockfile`-backed
`.ingest.lock`. This avoids deadlock because the runtime lock and chain
lock are project-process-local while the ingest lock is per-dataset.
Two concurrent facade writes on the same scope serialise on the chain
lock; two concurrent writes on different scopes can run in parallel,
each acquiring its own dataset ingest lock sequentially.

### 5.3 Partial-write recovery

If step 6 throws after step 5 commits, the sidecar row is correct but
RAG chunks are stale. The next write or the periodic reconcile (see
§5.4) restores coherence. The facade re-raises the original error so
the caller observes the failure.

If step 5 commits but the process crashes before step 7's audit
insert, audit is best-effort; the audit row carries a generated
`error_code = "AUDIT_LATE"` on the next opportunity (sidecar query at
startup).

### 5.4 Reconciliation

A facade-level `reconcileKnowledge(kind)` operation:

1. For every sidecar row, compute the expected chunk path/state.
2. Submit a single `records` ingest batch with all active rows
   (one item per row) and one `lifecycleStatus`-only update item per
   non-active row. The pipeline naturally drops unchanged paths.

Reconcile is invoked: at startup after seeding (best-effort, swallows
non-fatal errors), and on operator demand via a CLI subcommand. There
is no scheduler.

### 5.5 Stage and session archival

When a stage or session terminates, the existing helpers in
[src/knowledge/lifecycle.ts](src/knowledge/lifecycle.ts#L923-L1016)
move its records under an archive subtree. After the migration:

- Records under a terminated stage/session are flagged
  `status = "archived"` in the sidecar.
- A bulk ingest call updates `lifecycleStatus = "archived"` for all
  affected chunks. The archived rows remain queryable for reviewer
  history but are excluded from the default
  `lifecycleStatus = "active"` filter.
- No filesystem move occurs; the archive subtree concept disappears.

## 6. Eager Loading vs. Retrieval

### 6.1 What stays eager

The eager prompt-loading mechanism in
[src/knowledge/eagerLoader.ts](src/knowledge/eagerLoader.ts) and the
budget split in
[splitByBudget](src/knowledge/loader.ts) remain — they are the only
mechanism that delivers `survive_compaction` survivor skills/memories
into the initial system prompt.

Source changes:

- `loadAllCandidates` no longer walks JSON record files. It queries the
  sidecar for `status = "active"` rows that pass scope/target_agents
  rules.
- Bodies are loaded lazily: skill bodies from the chunk store (the
  pipeline already chunked the full body, so the eager loader reads the
  body from the chunk hits or — if needed atomically — from a small
  helper that runs a `pathGlob` chunk query and concatenates by
  `chunkIndex`).
- Built-in skill bodies remain readable directly from the package
  bundle path (`walkBuiltinSkills`), but their identity is the
  deterministic builtin id (§3.4), not a fresh UUID.

### 6.2 What becomes RAG-on-demand

`search_skills` and `search_memories` become semantic searches via
`Dataset.query`:

1. Caller passes `query`, optional `scope`, optional `limit`.
2. Facade resolves `topK = limit ?? 10`.
3. Facade builds `QueryFilter`:
   `{ and: [ { eq: { source, lifecycleStatus: "active" } },
              { eq: { scope } } ] }` (scope omitted when caller did not
   constrain).
4. `Dataset.query(text, { topK, filter })` → `QueryHit[]`.
5. Facade extracts the unique `metadata.path` values, runs one
   `SELECT * FROM record WHERE rag_path IN (...)` to hydrate the
   sidecar rows, drops hits whose `target_agents_json` excludes
   `ctx.role`, and returns the existing
   `searchSkills`/`searchMemories` result shape (top-N records with
   body snippet, score, and lineage fields).

### 6.3 Keyword scorer

`scoreSkillForSearch` and `scoreMemoryForSearch` are deleted; their
sole callers were the legacy lookup paths.

`scoreSkillTriggers`, `splitByBudget`, `resolveEagerRecords`,
`reinjectSurvivors`, `canonicalizeTokens`, and `redactForRead` are
retained for the eager loader and the read-redaction path. They take
sidecar rows as input rather than JSON record files.

## 7. RAG-Disabled Behaviour

When `config.rag.enabled === false` the facade refuses to start. Every
MCP write or read on the `skills` or `memory` service returns the
typed envelope `{ error: { code: "KNOWLEDGE_RAG_UNAVAILABLE",
message } }`. There is **no flat-file fallback**: the topic requires
removal of the legacy lookup path, and the architecture-first rule
forbids preserving it as a shim.

On startup with `rag.enabled = true` but either the `skills` or the
`memory` dataset missing from `config.rag.datasets`, the runtime fails
to start with `KNOWLEDGE_RAG_UNREGISTERED` naming the absent dataset.

On `ConfigDriftError` (provider dim changed) or `EmbeddingDriftError`,
startup fails with the underlying error. The operator must either
rebuild the affected dataset or restore the prior config. The facade
does not auto-rebuild.

## 8. Backout and File Inventory

### 8.1 [src/knowledge/](src/knowledge/)

| File                                              | Action     | Notes                                                                                              |
|---------------------------------------------------|------------|----------------------------------------------------------------------------------------------------|
| [src/knowledge/types.ts](src/knowledge/types.ts) | Keep, trim | Drop `LifecycleStatusSchema` re-export only; everything else stays. Skill `body_path` field stays as optional for builtin path display but is no longer read. |
| [src/knowledge/store.ts](src/knowledge/store.ts) | Rewrite    | Replace `writeRecordAtomic`/`rebuildIndex`/`unlinkRecordIfExists`/`appendAuditEntry`/`detectSecrets` with sidecar-backed equivalents. `KnowledgeStoreError` retained; add codes `KNOWLEDGE_RAG_UNAVAILABLE`, `KNOWLEDGE_RAG_UNREGISTERED`, `KNOWLEDGE_SEED_REQUIRED`. |
| [src/knowledge/lifecycle.ts](src/knowledge/lifecycle.ts) | Rewrite | Per §5; lock chains and `assertRuntimeLockHeld` stay; JSON IO removed; ingest dispatch added. |
| [src/knowledge/loader.ts](src/knowledge/loader.ts) | Keep, trim | Drop `scoreSkillForSearch`, `scoreMemoryForSearch`, `MemoryIndexEntry`, `SkillIndexEntry`. Keep `canonicalizeTokens`, `scoreSkillTriggers`, eager budgeting helpers, `redactForRead`, `estimateTokens`. |
| [src/knowledge/eagerLoader.ts](src/knowledge/eagerLoader.ts) | Rewrite | `loadAllCandidates` reads sidecar; `walkBuiltinSkills` stays for body access but assigns deterministic builtin id (§3.4). |
| [src/knowledge/permissions.ts](src/knowledge/permissions.ts) | Keep | `canCall`/`checkScope` unchanged. |

New file: `src/knowledge/sidecar.ts` — opens/migrates the SQLite db,
exposes `upsertRecord`, `markStatus`, `deleteRecord`, `getRecord`,
`hydrateRows(paths)`, `auditAppend`.

### 8.2 [src/mcp/](src/mcp/)

| File                                                                  | Action     | Notes                                                              |
|-----------------------------------------------------------------------|------------|--------------------------------------------------------------------|
| [src/mcp/knowledgeSkills.ts](src/mcp/knowledgeSkills.ts)              | Rewrite    | Tool entries unchanged; handlers delegate to new lifecycle helpers. |
| [src/mcp/knowledgeMemory.ts](src/mcp/knowledgeMemory.ts)              | Rewrite    | Same.                                                              |

### 8.3 Tests

| File                                                                                       | Action  |
|--------------------------------------------------------------------------------------------|---------|
| [src/knowledge/types.test.ts](src/knowledge/types.test.ts)                                 | Keep    |
| [src/knowledge/store.test.ts](src/knowledge/store.test.ts)                                 | Rewrite |
| [src/knowledge/lifecycle.test.ts](src/knowledge/lifecycle.test.ts)                         | Rewrite |
| [src/knowledge/loader.test.ts](src/knowledge/loader.test.ts)                               | Trim    |
| [src/knowledge/eagerLoader.test.ts](src/knowledge/eagerLoader.test.ts)                     | Rewrite |
| [src/knowledge/permissions.test.ts](src/knowledge/permissions.test.ts)                     | Keep    |
| [src/mcp/knowledgeSkills.test.ts](src/mcp/knowledgeSkills.test.ts)                         | Rewrite |
| [src/mcp/knowledgeMemory.test.ts](src/mcp/knowledgeMemory.test.ts)                         | Rewrite |

New tests: `src/knowledge/sidecar.test.ts`,
`src/knowledge/rag-facade.test.ts` (integration over a real ephemeral
RAG dataset using the in-test `sqlite-vec` store).

### 8.4 Docs

[SPEC/v2/rag/configuration.md](SPEC/v2/rag/configuration.md) updated
to drop `text-embedding-3-large` and to add the `skills` and `memory`
dataset entries.
[SPEC/v2/skills-memory/01-DESIGN.md](SPEC/v2/skills-memory/01-DESIGN.md)
gains a "RAG-backed storage" section pointing to this analysis;
sections describing per-scope `index.json` are removed.

### 8.5 On-disk artifacts removed at first seed

The seed CLI subcommand deletes the legacy
`<projectRoot>/.saivage/{skills,memory}/{project,stages,sessions}/{records,index.json,audit.jsonl}`
trees only after a successful seed pass.

## 9. Failure Modes

| Condition                                                                 | Error code                       | Surface                  |
|---------------------------------------------------------------------------|----------------------------------|--------------------------|
| `config.rag.enabled === false`                                            | `KNOWLEDGE_RAG_UNAVAILABLE`      | Tool envelope.            |
| `skill` or `memory` dataset absent from `config.rag.datasets`             | `KNOWLEDGE_RAG_UNREGISTERED`     | Startup; refuses to start.|
| Sidecar absent and seed version missing                                   | `KNOWLEDGE_SEED_REQUIRED`        | Tool envelope; operator runs `saivage knowledge seed`. |
| `ConfigDriftError` from `RagManager.register`                             | re-raised; logged.               | Startup.                  |
| `EmbeddingDriftError` from `Dataset.open`                                 | re-raised; logged.               | Startup.                  |
| `SECRET_DETECTED` from `detectSecrets`                                    | `SECRET_DETECTED`                | Tool envelope. Audit row records the rejection. |
| `BLOCKED_PATH` from `assertNotBlockedPath`                                | `BLOCKED_PATH`                   | Tool envelope.            |
| `NO_RUNTIME_LOCK`                                                         | `NO_RUNTIME_LOCK`                | Tool envelope.            |
| RAG `IngestLockedError` from a concurrent ingest                          | `KNOWLEDGE_RAG_BUSY`             | Tool envelope; caller retries. |
| RAG `ProviderUnavailableError`                                            | `KNOWLEDGE_RAG_PROVIDER`         | Tool envelope; bubbled cause.  |
| RAG `WatcherUnavailableError`                                             | Not possible — both datasets have `watch: false`. |
| `InvalidQueryFilterError` (programming error in facade)                   | Logged; surfaced as 500-equivalent.  |
| Sidecar SQLite IO error                                                   | `KNOWLEDGE_SIDECAR_IO`           | Tool envelope; manual repair via seed. |
| Partial write: sidecar committed but ingest threw                         | Tool returns the original RAG error; row remains, chunks stale; next write or reconcile heals. |

## 10. Resolved Open Questions

- **`text-embedding-3-small` vs. `text-embedding-3-large`**: code at
  [src/config.ts](src/config.ts#L224-L228) is authoritative;
  [SPEC/v2/rag/configuration.md](SPEC/v2/rag/configuration.md) is
  corrected as part of the docs deliverable.
- **`metadataOverlay.scope === "memory"` defect in pipeline**: the
  facade does not rely on the pipeline's source inference. Records
  ingest items already carry `source` in their metadata, and the
  pipeline preserves it via `metadataOverlay.scope`. For this feature
  the facade sets `metadata.scope` to the actual knowledge scope
  (`project|stage|session`) and the pipeline-set `source` reflects
  the path extension (`.md` → `"doc"`). To keep `source = "skill"`
  and `source = "memory"`, the facade passes `metadata.source` in the
  records input and the pipeline's source-from-overlay branch is
  retained at present. If the pipeline's `metadataOverlay.scope === "memory"`
  branch proves insufficient (it currently is, since real scopes are
  `project|stage|session`), the migration carries an explicit
  follow-up to add `metadataOverlay.source` honouring; this is a
  caller-provided field already present in
  [ChunkMetadataInput](src/rag/types.ts#L79-L86) and would not require
  any new public API. Listed as follow-up `FUP-01` for the F01 plan.
- **`Dataset.deleteByFilter`**: not needed. Empty-text record items
  replace chunks at a stable `path`, which is functionally equivalent
  for the supersede/archive/delete flows.
- **Tombstone records**: rejected. We model `archived`/`superseded` as
  `lifecycleStatus` chunk metadata plus an `eq: { lifecycleStatus: "active" }`
  query filter; tombstones are unnecessary and would double-count.
- **Keyword vs. eager**: the keyword scorers (`score*ForSearch`) are
  deleted because their only callers (`searchSkills`/`searchMemories`
  legacy paths) are rewritten. The trigger/budget helpers stay because
  the eager loader path is unchanged. No contradiction.
