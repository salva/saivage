# F01 — Skills and Memories on RAG: Functional Analysis

This analysis migrates the skill and memory storage layer onto the RAG
subsystem as the **vector index** and a per-kind **SQLite sidecar** as
the **record-of-truth**. The existing JSON-on-disk tree under
`.saivage/knowledge/` is removed wholesale (architecture-first; no
shims). All MCP tool names are preserved; their handlers are rewritten
against the new storage. No changes to `src/rag/`.

## 1. Storage Model

### 1.1 Layout

```
.saivage/
  knowledge/
    skills.sqlite        # sidecar (records, audit, builtin index)
    memory.sqlite        # sidecar (records, audit)
  rag/
    knowledge.skills/    # RAG dataset (vector index)
      store.db
      .ingest.lock
    knowledge.memory/    # RAG dataset (vector index)
      store.db
      .ingest.lock
```

The previous tree (`.saivage/knowledge/{skills,memory}/{project,stages/<id>,sessions/<id>}/records/<uuid>.json`,
`index.json`, `audit.jsonl`) is gone. No code reads or writes it.

### 1.2 Sidecar schema (per kind)

Both `skills.sqlite` and `memory.sqlite` use the same shape:

```sql
CREATE TABLE record (
  id TEXT PRIMARY KEY,                  -- stable id (UUID or builtin:<key>)
  kind TEXT NOT NULL,                   -- 'skill' | 'memory'
  scope TEXT NOT NULL,                  -- 'project' | 'stage' | 'session'
  scope_ref TEXT,                       -- null for project, required otherwise
  status TEXT NOT NULL,                 -- 'active' | 'superseded' | 'archived' | 'expired'
  rag_path TEXT NOT NULL UNIQUE,        -- '<kind>/<scope>[/<scope_ref>]/<id>.md'
  record_json TEXT NOT NULL,            -- canonical record JSON (schema-validated)
  body TEXT NOT NULL,                   -- inline body (skill body or memory body)
  body_hash TEXT NOT NULL,              -- sha256(body)
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX record_scope_idx ON record(scope, scope_ref);
CREATE INDEX record_status_idx ON record(status);
CREATE INDEX record_updated_idx ON record(updated_at);
-- Skill-only name uniqueness in active scope. SQLite respects partial unique
-- indexes; the COALESCE pins the project-scope row to a constant scope_ref so
-- duplicates across stages/sessions are independent.
CREATE UNIQUE INDEX record_skill_name_uq
  ON record(scope, COALESCE(scope_ref, ''), json_extract(record_json, '$.name'))
  WHERE kind = 'skill' AND status = 'active';

CREATE TABLE audit (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  op TEXT NOT NULL,                     -- create | update | supersede | archive | unarchive | delete | expire
  record_id TEXT NOT NULL,
  before_json TEXT,
  after_json TEXT,
  author_role TEXT NOT NULL,
  author_agent_id TEXT NOT NULL,
  reason TEXT
);
CREATE INDEX audit_record_idx ON audit(record_id);

CREATE TABLE rag_sync (
  rag_path TEXT PRIMARY KEY,            -- mirrors record.rag_path for survivors
  body_hash TEXT NOT NULL,              -- the body_hash the RAG snapshot was built from
  synced_at TEXT NOT NULL
);
```

`rag_sync` lets us detect whether the RAG dataset reflects current
sidecar state without re-reading the vector store.

### 1.3 Identity

- **Project / stage / session memories** and **project / stage /
  session non-builtin skills** keep UUID ids (matches existing
  `SkillRecordSchema.id = z.string().uuid()`, which will be **relaxed
  to a string** with a refinement permitting either a UUID or the
  literal prefix `builtin:`).
- **Builtin skills** get a deterministic id `builtin:<nfcLower(name)>`.
  This replaces the current
  [src/knowledge/eagerLoader.ts](src/knowledge/eagerLoader.ts#L198)
  `randomUUID()` instability; the same bundled skill keeps the same
  id across boots and operator hosts.

### 1.4 `rag_path` synthesis

```
rag_path = `${kind}/${scope}${scope_ref ? `/${scope_ref}` : ""}/${id}.md`
```

Examples:

- Project skill: `skill/project/builtin:saivage-development-validation.md`
- Stage memory: `memory/stage/stage-44/8c1d…d9.md`
- Session memory: `memory/session/sess-2026-05-21T08-12Z/cf2e…7b.md`

`rag_path` is the canonical join key between sidecar and RAG.

## 2. RAG Datasets

Two datasets, configured by F01-owned bootstrap (the configs are
written into `config.rag.datasets[]` on first run; users may not edit
or remove them, and F02's `rag_drop`/`rag_register` reject them as
protected):

```json
[
  {
    "id": "knowledge.skills",
    "source": "skill",
    "provider": { "model": "text-embedding-3-small", "dim": 1024 },
    "chunker": { "kind": "markdown", "chunkSize": 1200, "overlap": 120 },
    "watch": false
  },
  {
    "id": "knowledge.memory",
    "source": "memory",
    "provider": { "model": "text-embedding-3-small", "dim": 1024 },
    "chunker": { "kind": "memory", "chunkSize": 800, "overlap": 0 },
    "watch": false
  }
]
```

`source = "skill" | "memory"` makes both datasets **protected**: F02's
mutating tools refuse to touch them (see F02 §3.3). They are mutated
only by F01's MCP handlers.

`watch: false` because the records are not file-driven; the sidecar
is the canonical edit point and ingest is triggered explicitly by
lifecycle calls.

### 2.1 Why not one dataset per scope

Two reasons. First, `chunker.kind` differs (markdown vs. memory).
Second, query semantics differ — skill queries are
description/trigger-driven, memory queries are body-driven. Scopes
within a kind share the chunker and are filtered by
`metadataOverlay.scope` and `metadataOverlay.scopeRef`.

### 2.2 Source field is not load-bearing

[buildRecordItems](src/rag/pipeline.ts#L108-L134) drops
`ChunkMetadataInput.source`, and `runIngest` sets the per-chunk
`source` from `inferSource(path)` or `"memory"` when
`metadataOverlay.scope === "memory"`
([src/rag/pipeline.ts](src/rag/pipeline.ts#L197)). Since
`KnowledgeScope` values are `project | stage | session`, the inference
will tag skill chunks as `doc` and memory chunks as `doc`.

F01 does not use per-chunk `source` to distinguish. Discrimination is
by **dataset id** (which is one of `knowledge.skills` or
`knowledge.memory`) and by metadata filters
`metadataOverlay.scope`/`metadataOverlay.scopeRef`/`metadataOverlay.role`.

The pipeline's `inferSource` defect (treating
`metadataOverlay.scope === "memory"` as the only "memory" trigger) is
inert here because both datasets render as "doc" sources and we never
filter by chunk `source`. It is tracked as FUP-01 against `src/rag/`
but is out of F01 scope.

## 3. Ingest Snapshot Semantics

[runIngest](src/rag/pipeline.ts#L168-L290) treats supplied items as
the **complete seen set** for that call; any prior `file_state` path
not present is purged. F01 therefore submits a **complete dataset
snapshot** on every mutating call:

```
manager.ingest("knowledge.skills", { kind: "records", items: [<every active skill>] })
```

The `sourceHash` gate
([src/rag/pipeline.ts](src/rag/pipeline.ts#L237-L240)) skips
re-embedding for records whose `sourceHash = sha256(body)` matches the
prior snapshot, so re-ingesting N records embeds only the changed
ones. A single create therefore embeds 1 record and rebuilds nothing
else; a delete embeds 0 records and removes the dropped path's
chunks.

Snapshot construction (per kind, every lifecycle call):

```sql
SELECT id, rag_path, body, body_hash, record_json
FROM record
WHERE status = 'active';
```

Mapped to `IngestInput.items[]`:

```ts
items.push({
  id: row.id,                                // chunk id derivation ignores it but record_id propagates
  text: row.body,
  metadata: {
    path: row.rag_path,
    source: row.kind,                        // dropped by pipeline; informational
    scope: row.scope,
    scopeRef: row.scope_ref ?? undefined,
    role: row.author_role,
    lifecycleStatus: row.status,
    createdAt: row.created_at,
    mtimeMs: Date.parse(row.updated_at),
  },
});
```

`status = 'superseded' | 'archived' | 'expired'` records are excluded
from the snapshot, which causes the pipeline to drop their chunks
naturally (no extra delete call needed).

## 4. MCP Tool Surface (unchanged names, new handlers)

Names and call shapes match the current handlers in
[src/mcp/knowledgeSkills.ts](src/mcp/knowledgeSkills.ts) and
[src/mcp/knowledgeMemory.ts](src/mcp/knowledgeMemory.ts).

### 4.1 Reads use the sidecar

- `read_skill`, `list_skills`, `get_memory`, `list_memories` read
  directly from the SQLite sidecar. Bodies come from `record.body` /
  `record.record_json`. **RAG is not queried** for these — they must
  return exact stored content and `Dataset.query` is similarity-only.
- `search_skills`, `search_memories` issue
  `manager.query("knowledge.skills" | "knowledge.memory", text, { topK, filter })`
  with `filter` built from caller-supplied `scope`/`scopeRef`/`role`
  filters using only the supported `QueryFilter` shapes
  (`eq`, `and`, `or`, `pathGlob`, `in`). The `topK` chunks are joined
  back to records by `rag_path`; the search response is
  `{ id, score, snippet, scope, scopeRef, lifecycleStatus }`,
  matching the existing search result shape exactly (no surface
  change).

### 4.2 Writes go SQLite-first, then snapshot reingest

Every mutating call (`create_*`, `update_*`, `supersede_*`,
`archive_*`, `delete_*`) follows the same ordering:

1. Acquire `runtime.knowledge.<kind>.mutex` (in-process).
2. Acquire per-scope-chain advisory (an in-process `AsyncMutex` keyed
   by `${scope}:${scope_ref ?? ""}`).
3. Begin a SQLite transaction.
4. Insert/update `record` rows; append `audit` row.
5. Commit SQLite.
6. Build the full `<kind>` snapshot from current `record` table.
7. Call
   `manager.ingest("knowledge.<kind>", { kind: "records", items })`.
   This acquires the `.ingest.lock` (fail-fast, one stale retry).
8. On ingest success, `UPDATE rag_sync` rows for every
   active `rag_path` with the new `body_hash` and `synced_at`.
9. Release the scope mutex; release the runtime mutex.

If the ingest in step 7 fails (`IngestLockedError`, provider failure,
`CorruptedStoreError`, …): the SQLite write is already committed. The
handler:

- Logs the failure with `log.warn` including the error code.
- Writes a one-row marker into a `pending_reingest(kind, error_code, ts)`
  table inside the same sidecar.
- Returns success to the MCP caller. Reads from the sidecar are
  still authoritative; only `search_*` may be stale.
- Eager loader (§5) drains the marker on next process start by
  rerunning the snapshot ingest.

There is no cross-resource lock held during embedding/provider work:
the SQLite transaction commits **before** RAG ingest starts. There is
no invented `AUDIT_LATE` mechanism.

### 4.3 No public API change

The MCP search result shape is identical to the current one
(`{ id, score, snippet }` augmented with the same lifecycle fields the
existing handlers attach). Schemas in `inputSchema` are unchanged. The
F01 migration is invisible to callers.

## 5. Eager Loader and Builtin Skills

[src/knowledge/eagerLoader.ts](src/knowledge/eagerLoader.ts) is
rewritten:

- Reads survivors (`survive_compaction = true`) from the sidecar by
  scoped query, **not** from any JSON tree.
- On first invocation in a process, drains the
  `pending_reingest` marker (re-runs snapshot ingest) if present.
- Builtin skills are loaded once at first invocation by the new
  `seedBuiltinSkills` helper:
  1. Walk `<bundleRoot>/skills/builtin/<topic>/SKILL.md`.
  2. Parse frontmatter using existing `BuiltinSkillFrontmatterSchema`.
  3. For each, compute `id = "builtin:" + nfcLower(name)`.
  4. Upsert into `record` with `origin = "builtin"`,
     `scope = "project"`, `status = "active"`, `body = file body`,
     `body_hash = sha256(body)`. If a row with the same id exists and
     `body_hash` matches, no-op; otherwise rewrite, append audit row
     with op `update` and `reason: "builtin-resync"`.
  5. If the resulting record set differs from the prior snapshot,
     trigger a `knowledge.skills` snapshot reingest.

`seedBuiltinSkills` runs unconditionally at startup; it is idempotent
and cheap when the bundle is unchanged.

## 6. First-Run Behaviour and Backout

No automatic migration from the legacy JSON tree.
Architecture-first / no backward compatibility: the new code never
reads `.saivage/knowledge/**/records/*.json`,
`.saivage/knowledge/**/index.json`, or `.saivage/knowledge/**/audit.jsonl`.

On startup the loader runs `initKnowledgeStore(projectRoot)` which:

1. Creates `.saivage/knowledge/skills.sqlite` and `memory.sqlite` if
   absent (CREATE TABLE statements above).
2. Ensures `knowledge.skills` and `knowledge.memory` exist in
   `config.rag.datasets[]`. If missing, writes them through the same
   `saveSaivageConfig` helper introduced by F02; this is a one-time
   first-run config edit.
3. Calls `seedBuiltinSkills`.
4. If RAG is disabled (`config.rag.enabled === false`), **fail-fast**
   with `KNOWLEDGE_RAG_UNAVAILABLE`: there is no flat-file fallback.
   The dashboard's status surface reads the runtime state and renders
   a clear "knowledge requires RAG" message.

There is no `saivage knowledge seed` CLI command; the loader does the
work on every start. The legacy JSON tree, if present, is **not**
deleted by the runtime — the operator handles that out-of-band so an
accidental rollback can still read prior data manually. The runtime
never references it.

## 7. Lock Ordering and Failure Modes

| Step | Resource                                  | Acquired by               |
|------|-------------------------------------------|---------------------------|
| 1    | `runtime.knowledge.<kind>.mutex`          | F01 handler entry         |
| 2    | per-`(scope, scope_ref)` mutex            | F01 handler               |
| 3    | SQLite WAL write tx                       | sidecar code              |
| 4    | RAG dataset `.ingest.lock`                | `runIngest` (fail-fast)   |

Crash recovery rules:

- Crash between 3 and 4 (after SQLite commit, before RAG ingest):
  sidecar is current; `rag_sync` is stale. Next loader run sees a
  `pending_reingest` row (written by previous handler) **or** detects
  staleness by comparing `record.body_hash` to `rag_sync.body_hash`
  for the kind and reingests if any divergence.
- Crash inside RAG ingest: pipeline's per-batch transaction rolls
  back; next reingest is idempotent (sourceHash-gated).
- Concurrent calls on the same kind: step 1's mutex serialises.
- Concurrent calls on different scopes in the same kind: step 1
  still serialises because the snapshot is per-kind. This trades some
  parallelism for the guarantee that snapshot ingests do not
  interleave.

`IngestLockedError` (a watcher-driven reingest holding the lock) is
impossible because both datasets have `watch: false`.

## 8. Permissions and Tool-Filter Wiring (current state, then deltas)

### 8.1 Current MCP ACL ([src/knowledge/permissions.ts](src/knowledge/permissions.ts))

The current matrix grants every existing role read access to both
kinds in every scope. Writes are restricted: e.g. Planner has full
memory writes including supersede/archive/delete; Inspector has skill
and memory destructive rights for cleanup; workers have read-only on
skills and project/stage write on memory; chat has read-only
everywhere. F01 makes **no changes** to existing role rows.

### 8.2 Current `READ_ONLY_TOOLS` ([src/agents/tool-filters.ts](src/agents/tool-filters.ts#L9-L18))

Today it contains: `read_file`, `list_dir`, `search_files`,
`git_status`, `git_log`, `git_diff`, `list_skills`, `read_skill`.
The memory tools (`list_memories`, `get_memory`, `search_memories`)
and `search_skills` are **not** in `READ_ONLY_TOOLS`.

F01 deltas:

- Add `search_skills`, `list_memories`, `get_memory`, and
  `search_memories` to `READ_ONLY_TOOLS`. With the new RAG-backed
  search, gating these read-only operations by role still matches
  existing intent (reviewers, planners, and chat can read knowledge).
- No new tools are added by F01. F02 adds the three RAG read tools
  to the same set (consistent with F02 §3.1).

These are tool-filter exposures, distinct from the ACL in §8.1. The
ACL is the authoritative gate inside each handler; the filter only
controls which tool names a role's LLM is allowed to call.

## 9. File Inventory

Every existing file under `src/knowledge/` and `src/mcp/knowledge*.ts`
is classified:

| File                                                                          | Action  | Notes |
|-------------------------------------------------------------------------------|---------|-------|
| [src/knowledge/types.ts](src/knowledge/types.ts)                              | Rewrite | Relax `SkillRecord.id` to `z.string().refine(uuidOrBuiltin)`; drop `body_path`; add `body: string`. |
| [src/knowledge/store.ts](src/knowledge/store.ts)                              | Rewrite | New SQLite-backed implementation (better-sqlite3). |
| [src/knowledge/lifecycle.ts](src/knowledge/lifecycle.ts)                      | Rewrite | New ordering (§4.2). Removes JSON-tree code. |
| [src/knowledge/loader.ts](src/knowledge/loader.ts)                            | Rewrite | New `initKnowledgeStore`; preserves `SkillMatchContext` signature. |
| [src/knowledge/eagerLoader.ts](src/knowledge/eagerLoader.ts)                  | Rewrite | Sidecar-driven survivor block; deterministic builtin ids; `pending_reingest` drain. |
| [src/knowledge/permissions.ts](src/knowledge/permissions.ts)                  | Keep    | Unchanged. F03 adds a `librarian` row separately. |
| [src/mcp/knowledgeSkills.ts](src/mcp/knowledgeSkills.ts)                      | Rewrite | Same tool names/schemas; handler bodies rewritten against §4. |
| [src/mcp/knowledgeMemory.ts](src/mcp/knowledgeMemory.ts)                      | Rewrite | Same. |
| [src/knowledge/store.test.ts](src/knowledge/store.test.ts)                    | Rewrite | New SQLite store assertions; remove JSON-tree assertions. |
| [src/knowledge/lifecycle.archive.test.ts](src/knowledge/lifecycle.archive.test.ts) | Rewrite | Same. |
| [src/knowledge/loader.test.ts](src/knowledge/loader.test.ts)                  | Rewrite | Same. |
| [src/knowledge/eagerLoader.test.ts](src/knowledge/eagerLoader.test.ts)        | Rewrite | Builtin id stability across boots; survivor block content; `pending_reingest` drain. |
| [src/knowledge/permissions.test.ts](src/knowledge/permissions.test.ts)        | Keep    | Unchanged. |
| [src/knowledge/types.test.ts](src/knowledge/types.test.ts)                    | Rewrite | New schemas. |
| [src/knowledge/integration.test.ts](src/knowledge/integration.test.ts)        | Rewrite | End-to-end CRUD + search through MCP, with real RAG manager backed by sqlite-vec. |
| [src/knowledge/regression.test.ts](src/knowledge/regression.test.ts)          | Rewrite | Specific regression fixtures (e.g. unicode names, scope_ref edge cases) ported to new schema. |
| [src/knowledge/concurrency.test.ts](src/knowledge/concurrency.test.ts)        | Rewrite | New mutex/lock ordering coverage; ingest failure → marker → recover. |

No file is added (the surface is unchanged); no JSON-tree code remains.

## 10. Error Codes

`KnowledgeError` (existing class) gets new codes used by the rewritten
handlers. Domain-level codes returned in `{ error: { code, message } }`:

| Code                                | Trigger                                                                    |
|-------------------------------------|----------------------------------------------------------------------------|
| `KNOWLEDGE_RAG_UNAVAILABLE`         | `config.rag.enabled === false` at startup or during a search call.         |
| `KNOWLEDGE_INVALID_SCOPE`           | `scope_ref` missing for non-project scope.                                 |
| `KNOWLEDGE_NAME_CONFLICT`           | Skill name uniqueness violation (the partial index in §1.2).               |
| `KNOWLEDGE_NOT_FOUND`               | Record id absent.                                                          |
| `KNOWLEDGE_INGEST_DEFERRED`         | Internal — written into `pending_reingest`; never surfaced to the caller.  |
| `KNOWLEDGE_SEARCH_DEGRADED`         | `search_*` invoked while `pending_reingest` is non-empty; handler returns hits but with `degraded: true` in the response envelope used internally by the dashboard. |
| `KNOWLEDGE_PERMISSION_DENIED`       | ACL row denies the op (existing code, kept).                               |

Search failure modes propagate the F02 codes (`RAG_PROVIDER_UNAVAILABLE`,
`RAG_INVALID_QUERY_FILTER`) directly because they are caller-visible
errors of the same kind.

## 11. Internal Consistency

- One identity model: `id` is either a UUID or a `builtin:<...>`
  literal; `rag_path` is deterministic from `(kind, scope, scope_ref?, id)`.
- One body store: `record.body` is the source of truth for `read_*`
  and `get_*`; RAG only stores chunk-derived text. No `body_path`,
  no on-disk markdown file references.
- One ingest semantics: every mutating call rebuilds the full per-kind
  snapshot; the `sourceHash` gate is the only optimisation. The
  pipeline's "purge prior paths not in current input" matches this
  exactly.
- One transaction story: SQLite commits before RAG ingest; failures
  defer to a sidecar marker drained at boot or on next mutation.
- One first-run rule: builtins are seeded by the loader; legacy JSON
  tree is never read; RAG-disabled is a hard error.
- One file inventory: every file under `src/knowledge/` and
  `src/mcp/knowledge*.ts` is classified in §9; no other file is added
  by F01.
- Permissions stay split: ACL (§8.1) gates handler-level ops;
  tool-filter (§8.2) gates LLM access to tool names. F01 only changes
  the filter membership for the four read tool names listed.
