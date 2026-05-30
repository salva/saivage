# F01 — Skill and memory subsystems on RAG: functional analysis

## 1. Current state

### 1.1 Storage and authoritative records

The skill and memory subsystems are a single, structured records system
rooted at [saivage/src/knowledge/](saivage/src/knowledge/). Records are
typed Zod schemas declared in
[saivage/src/knowledge/types.ts](saivage/src/knowledge/types.ts):

- `SkillRecord` — `kind: "skill"`, with `name`, `description`,
  `triggers[]`, `target_agents[]`, `body_path` (markdown body lives in a
  sibling file), `origin: "builtin" | "project"`.
- `MemoryRecord` — `kind: "memory"`, with structured `topic{domain,
  subject, aspect?}`, `keys[]`, `target_agents[]`, `body` (inline).

Both share `RecordBase`: `id` (UUID), `scope ∈ {project, stage, session}`,
`scope_ref?` (required if scope is stage/session), `status ∈ {active,
superseded, archived, expired}`, `created_at/updated_at` (datetime),
`author_agent{role, agent_id}`, optional `expires_at` / `ttl_ms`,
`supersedes` / `superseded_by`, `relates_to[]`, `survive_compaction`.

On disk the layout is:

```
<projectRoot>/.saivage/skills/records/<uuid>.json
<projectRoot>/.saivage/skills/bodies/<uuid>.md
<projectRoot>/.saivage/skills/index.json
<projectRoot>/.saivage/skills/audit.jsonl
<projectRoot>/.saivage/memory/records/<uuid>.json
<projectRoot>/.saivage/memory/index.json
<projectRoot>/.saivage/memory/audit.jsonl
```

plus bundled built-in skills under `saivage/skills/builtin/<topic>/SKILL.md`
parsed from YAML frontmatter
([saivage/src/knowledge/eagerLoader.ts](saivage/src/knowledge/eagerLoader.ts#L1-L80)).

The store layer
([saivage/src/knowledge/store.ts](saivage/src/knowledge/store.ts)) provides
atomic writes (`writeRecordAtomic`, `appendJsonlAtomic`), an
`index.json` rebuild (`rebuildIndex`), per-line audit append (with a
2048-byte PIPE_BUF cap), and the secret/blocked-path guards that drop
secrets at write time.

The lifecycle layer
([saivage/src/knowledge/lifecycle.ts](saivage/src/knowledge/lifecycle.ts))
owns the CRUD + supersede + archive semantics, the in-process
serialisation of collision-sensitive scope mutations, and the
write-time invariants (reason required, scope-path coherence,
content-hash for audit).

### 1.2 Retrieval surface today

Retrieval is purely keyword-based, scored against structured fields:

- `searchSkills` / `searchMemories` (lifecycle layer) load the on-disk
  index, canonicalise the query into NFC-lowercase tokens with
  [`canonicalize`](saivage/src/knowledge/loader.ts#L18-L34), then score
  each candidate via
  [`scoreSkillForSearch`](saivage/src/knowledge/loader.ts#L130-L150) /
  [`scoreMemoryForSearch`](saivage/src/knowledge/loader.ts#L100-L120):
  - Memories: `3·topic + 2·keys + 1·body_snippet`.
  - Skills: `3·(name|trigger value) + 2·description + 1·body_snippet`.
- Eager injection at agent boot is handled by
  [`eagerLoader.ts`](saivage/src/knowledge/eagerLoader.ts) +
  [`loader.ts`](saivage/src/knowledge/loader.ts). It loads the entire
  candidate pool, scores it against the agent's role and task
  description, and splits the pool into `survivors`
  (`survive_compaction === true` && `scope === "project"`, summarised
  to one line, ceiling 4096 tokens) and `ordinary` (budgeted at 2048
  tokens by default).

There is **no embedding, no vector index, no semantic recall** in the
existing surface. A query whose surface tokens do not appear in the
record's structured fields scores zero.

### 1.3 Agent-facing tool surface

Agents reach the subsystems through two MCP services:

- [`knowledgeSkills.ts`](saivage/src/mcp/knowledgeSkills.ts) exposes
  `create_skill`, `update_skill`, `supersede_skill`, `archive_skill`,
  `delete_skill`, `list_skills`, `read_skill_by_id`, `search_skills`.
- [`knowledgeMemory.ts`](saivage/src/mcp/knowledgeMemory.ts) exposes
  `create_memory`, `update_memory`, `supersede_memory`,
  `archive_memory`, `delete_memory`, `list_memories`, `get_memory`,
  `search_memories`.

Each handler:
1. Resolves the calling agent's role from `ctx`.
2. Calls
   [`canCall(role, op, kind)`](saivage/src/knowledge/permissions.ts) →
   `UNAUTHORIZED_ROLE` on miss.
3. For writes, calls the lifecycle helper which enforces reason,
   scope-path coherence, the secret/blocked-path guard, content-hash
   computation, atomic record write, audit append, and `index.json`
   rebuild — in that order, per
   [store.ts](saivage/src/knowledge/store.ts).
4. For reads, returns the record(s) through `redactForRead` (the
   secret-scanner applied to read paths too).

The role/op matrix is hard-coded in
[`permissions.ts`](saivage/src/knowledge/permissions.ts). Workers
(coder/researcher) are additionally restricted via `checkScope` to
`scope='stage' && scope_ref === ctx.stageId` for memory writes.

### 1.4 Why the existing surface stays

The CRUD + lifecycle + permissions surface is a structured
records-management system, not a search system. It encodes
non-negotiable correctness invariants:

- Authorisation per role / scope.
- Append-only audit log with reason and content hashes.
- Supersede semantics with explicit edges (`supersedes` /
  `superseded_by`) — critical for agents that need to know whether a
  fact has been corrected.
- Lifecycle states with transitions (`active → superseded`,
  `active → archived`, etc.) — drives compaction behaviour.

None of these are RAG concerns. The RAG subsystem at
[saivage/src/rag/](saivage/src/rag/) does not have a concept of
"authoritative record"; its unit is the chunk, addressed by a
content-derived id. There is no archive, no supersede, no audit.

Therefore the integration question is not "do we replace the records
layer with RAG" but **"how do we replace the bespoke keyword retrieval
with a RAG-backed semantic retrieval while preserving the records
layer"**.

## 2. What "use the new feature" means

The realistic interpretation: keep records authoritative in
`.saivage/{skills,memory}/`, keep CRUD/audit/lifecycle/permissions
exactly where they are, and:

1. **Mirror** every active record into a dedicated RAG dataset on each
   write (create / update / supersede), and **evict** the chunks on
   archive / delete / expire.
2. **Replace** the keyword scorers
   ([`scoreSkillForSearch`](saivage/src/knowledge/loader.ts#L130-L150),
   [`scoreMemoryForSearch`](saivage/src/knowledge/loader.ts#L100-L120))
   with a RAG query that returns chunk hits joined back to records.
3. **Keep** the eager loader as the budget enforcer; let it consume
   either the existing keyword pool or the new RAG pool depending on
   call site.
4. **Delete** the keyword scoring functions and the structures that
   only existed to feed them (the in-memory candidate-pool building in
   `searchSkills` / `searchMemories`).

The records on disk and the audit log are the source of truth; the
RAG datasets are derived state — drop, re-register, re-mirror is a
valid recovery on drift or corruption, with no data loss.

## 3. Two collections, two providers, one stamp policy

Skills and memories get **two separate RAG datasets**:

| Aspect                | `skills` dataset            | `memories` dataset             |
| --------------------- | --------------------------- | ------------------------------ |
| `id`                  | `skills`                    | `memories`                     |
| `source.kind`         | `records`                   | `records`                      |
| `chunker.kind`        | `markdown`                  | `memory`                       |
| `provider`            | openai text-embedding-3-large @ 1536 | openai text-embedding-3-large @ 1536 |
| `sources`             | `[]` (records-driven; the watcher is not used) | `[]` |
| `watch`               | `false`                     | `false`                        |
| `exclusions`          | `[]` (records are pre-filtered by the records layer) | `[]` |

Both use the same provider stamp deliberately: identical embeddings let
the future cross-collection query in F02 / F03 trivially compare scores
without re-embedding. Stamps still drift independently per dataset
(F01's design will not introduce a global-stamp mechanism), so swapping
one collection's model later is still safe.

### 3.1 Why two datasets, not one

A single `knowledge` dataset would force every query to filter by
`kind`. Two datasets:

- Make the audit story per kind self-contained.
- Allow per-kind chunker choice without a `chunker.kindHint` mechanism.
- Allow dropping one without dropping the other on drift recovery.
- Keep the disk-quota and reconcile cost separate (memories churn
  faster than skills).

## 4. Schema mapping — record fields → ChunkMetadata

`ChunkMetadata` in
[saivage/src/rag/types.ts](saivage/src/rag/types.ts) already mirrors
the SQL columns used by sqlite-vec:
`path`, `source`, `scope`, `scopeRef`, `startLine`, `endLine`,
`createdAt`, `metadata` (free-form record).

### 4.1 Skill record → chunk metadata

| `SkillRecord` field   | Mapping                                                          |
| --------------------- | ---------------------------------------------------------------- |
| `id`                  | `scopeRef` (UUID stays the join key back to the record file)     |
| `kind: "skill"`       | `source: "skill"` (new literal value of the `RagSource` union)   |
| `scope`               | `scope` (passthrough; the metadata column already accepts the same set) |
| `scope_ref`           | `metadata.scopeRefValue` (separate from `scopeRef` which is the record id) |
| `status`              | `metadata.status` — only `active` records are mirrored; status transitions trigger evict |
| `name`                | `metadata.name`                                                  |
| `description`         | `metadata.description`                                           |
| `triggers[]`          | `metadata.triggers`                                              |
| `target_agents[]`     | `metadata.targetAgents` — query-time filter for per-agent recall |
| `body_path`           | not stored in metadata; chunk text is the body file contents     |
| `origin`              | `metadata.origin`                                                |
| `survive_compaction`  | `metadata.surviveCompaction` — kept for the eager loader join     |
| `created_at`, `updated_at` | `createdAt` (UNIX ms); `updated_at` reflected as `metadata.updatedAt` |
| `supersedes`, `superseded_by` | not stored; supersede transitions evict via lifecycle hook |
| `expires_at`, `ttl_ms` | `metadata.expiresAt` (UNIX ms) — used by a periodic prune job   |

### 4.2 Memory record → chunk metadata

| `MemoryRecord` field  | Mapping                                                          |
| --------------------- | ---------------------------------------------------------------- |
| `id`                  | `scopeRef`                                                       |
| `kind: "memory"`      | `source: "memory"` (already a `RagSource` value)                 |
| `scope`               | `scope`                                                          |
| `scope_ref`           | `metadata.scopeRefValue`                                         |
| `topic.{domain,subject,aspect?}` | `metadata.topic` (the structured object)              |
| `keys[]`              | `metadata.keys`                                                  |
| `target_agents[]`     | `metadata.targetAgents`                                          |
| `body`                | the chunk text (inline)                                          |
| `source_ref`          | `metadata.sourceRef`                                             |
| Lifecycle fields      | same as skills                                                   |

### 4.3 Source kind extension

The current `RagSource` union in
[saivage/src/rag/types.ts](saivage/src/rag/types.ts) accepts `code`,
`doc`, `memory`. F01 adds `skill` to the union — the only RAG-side
change F01 requires. It is a one-line addition; the pipeline's
source-inference fallback (`.md → doc`, else `code`) is unaffected
because skills are always mirrored via the `records` ingest path with
`source` set explicitly.

## 5. Query semantics

### 5.1 Replacement of the keyword scorers

A new module
`saivage/src/knowledge/semantic-search.ts` exposes:

```ts
export interface SemanticSearchHit<T extends KnowledgeRecord> {
  record: T;
  score: number;             // RAG score in [0,1]
  matchedChunkText: string;  // for explainability / debugging
}

export async function searchSkillsSemantic(
  query: string,
  ctx: { agentRole: KnowledgeAgentRole; topK?: number; scope?: KnowledgeScope; targetAgent?: KnowledgeAgentRole },
): Promise<SemanticSearchHit<SkillRecord>[]>;

export async function searchMemoriesSemantic(
  query: string,
  ctx: { agentRole: KnowledgeAgentRole; topK?: number; scope?: KnowledgeScope; scopeRef?: string; targetAgent?: KnowledgeAgentRole },
): Promise<SemanticSearchHit<MemoryRecord>[]>;
```

Each implementation:
1. Runs `dataset.query(text, { topK: topK * 2, filter })` where the
   filter projects `scope`, `target_agents`, `status === "active"`.
2. Groups hits by `scopeRef` (= record UUID), summing the top-3 chunk
   scores per record.
3. Loads the record from disk via the existing
   [`readSkillById`](saivage/src/knowledge/lifecycle.ts) /
   [`getMemory`](saivage/src/knowledge/lifecycle.ts) helpers — never
   trusts the chunk metadata for the authoritative content.
4. Applies the existing `canCall` permission check on each record (the
   query filter narrows the pool but the per-record check is the
   authority).
5. Returns hits sorted by aggregated score.

### 5.2 Tool surface contract change

The two existing MCP tools `search_skills` and `search_memories` are
**rewritten in place**: same names, same argument schemas, same result
shape on the wire. Internally they call `searchSkillsSemantic` /
`searchMemoriesSemantic` instead of the keyword scorers. The query
canonicalisation step at
[`loader.ts#L18-L34`](saivage/src/knowledge/loader.ts#L18-L34) is no
longer used by the search path and is **deleted** (it is not exported
elsewhere — verified by repo grep).

The agent-visible result shape stays:
`{ id, score, name|topic, description|body_snippet, scope, ... }`.
The `score` field's numeric range changes (was a positive integer with
no upper bound; now a cosine-style float in `[0, 1]`). Agents already
treat it as opaque; the per-tool description is updated to make this
explicit.

### 5.3 No fallback to keyword

Per the topic file's hard constraint, there is no
"if RAG returns nothing, fall back to keyword scoring" path. When
`config.rag.enabled === false` or either dataset is unregistered, the
search tools throw a clear `KnowledgeStoreError`
(`RAG_UNAVAILABLE`, new code) with a remediation hint pointing at
`config.rag.datasets`. Agents see this as a normal tool error.

## 6. Lifecycle ↔ RAG state coherence

### 6.1 Hook points in `lifecycle.ts`

Every write helper in
[`lifecycle.ts`](saivage/src/knowledge/lifecycle.ts) currently runs the
sequence: validate → guard → write record → append audit → rebuild
index. F01 adds **exactly one step** after the audit append: invoke the
mirroring helper. The sequence becomes: validate → guard → write
record → append audit → mirror to RAG → rebuild index.

The mirror call is fire-and-await: if it throws, the write helper
catches and surfaces as a non-fatal warning while the record stays
written (the audit log is the source of truth). A separate `reconcile`
helper (§7) re-syncs any record that failed to mirror.

| Lifecycle op       | RAG action on success                                                     |
| ------------------ | ------------------------------------------------------------------------- |
| `create`           | `dataset.ingest({ kind: "records", records: [makeRagRecord(rec)] })`      |
| `update`           | same — `ingest` deletes prior chunks for the same `scopeRef` then upserts |
| `supersede`        | evict old, ingest new                                                     |
| `archive` / `delete` / `expire` | `dataset.ingest({ kind: "records", records: [tombstone(rec.id)] })` — see §6.2 |
| `unarchive`        | re-ingest                                                                 |

### 6.2 Eviction via tombstone records

The current RAG `ingest` interface accepts an `IngestInput` union that
includes a `records` variant. The simplest eviction shape, requiring
zero RAG changes, is a tombstone record: an `IngestInput` of
`{ kind: "records", records: [{ id, deleted: true }] }` whose
implementation in this F01 milestone is to call
`store.deleteByFilter({ eq: { scopeRef: id } })` directly.

This requires **one small change to the records-ingest path** inside
the existing pipeline: recognise the `deleted: true` marker and route
to delete instead of chunk+embed. Whether this counts as a "change to
src/rag/" the topic file forbids is the call-out below in §10. The
alternative — exposing `Dataset.deleteByFilter` publicly — is the
cleaner architecture and is the one F01 picks; tombstone records are
rejected.

### 6.3 What lives in the existing eager loader

`eagerLoader.ts` keeps its job: enumerate every active record, hand the
pool to the loader for scoring, budget. F01 does not change the eager
path at agent boot — it is too small (a few hundred records) to need
RAG and going through the embedding provider on boot would add latency
and cost. The decision is explicit: **eager = keyword on the
authoritative records on disk; on-demand = RAG**.

The trigger-scoring path
([`scoreSkillTriggers`](saivage/src/knowledge/loader.ts#L50-L75)) is
kept verbatim — it scores skills against the agent's task context using
`keyword:` / `tag:` / `agent:` trigger expressions, which is a
fundamentally different operation from semantic recall.

## 7. Reconcile and recovery

F01 ships a `reconcileKnowledgeRag(projectRoot, { kind })` helper that:

1. Lists every active record on disk for the given kind.
2. Calls `dataset.stats()` and `store.getFileState()` (the existing RAG
   API) to enumerate currently-stored `scopeRef` values.
3. Diffs: records present on disk but missing from RAG → ingest;
   records present in RAG but absent from disk or
   `status !== "active"` → delete by `scopeRef`.

This helper is called:

- Once at runtime start when `config.rag.enabled` is true and the
  datasets are registered (recovery from a half-finished mirror).
- By the operator via a new CLI subcommand `saivage rag reconcile
  --kind skill|memory` (added to
  [saivage/src/cli/](saivage/src/cli/)).

The reconcile helper does NOT touch the audit log; it produces a
report (counts of added/removed) that the caller can log.

## 8. Permissions and the query filter

The `target_agents` field already constrains who a record is meant for.
`canCall` constrains who can write. The RAG query layer adds a third
gate: the query filter pre-narrows results to chunks whose
`metadata.targetAgents` includes the calling role (empty array =
visible to all roles). This is an optimisation over post-filter — the
final answer is still authoritative because step 4 of §5.1 re-checks
`canCall` per record.

Memory's worker-scope rule (workers may only read memories in their
`stageId`'s session/stage) is enforced post-fetch: the query filter
pre-narrows by `scope ∈ {project, stage:ctx.stageId, session:ctx.sessionId}`,
and the read path re-asserts via `canCall("read", "memory")`.

## 9. Lifecycle of derived state on drift

Provider stamp drift on either dataset throws `EmbeddingDriftError` on
`open`. Recovery is:

1. The runtime catches the error at start, logs a warning.
2. Calls `dataset.drop()` to clear the on-disk store + cache + registry
   entry.
3. Calls `reconcileKnowledgeRag` which now sees an empty dataset and
   re-ingests every active record.

Because the records are authoritative and the audit is independent of
RAG, no data is lost. The runtime stays up — the skill/memory search
tools return `RAG_UNAVAILABLE` for the brief window while the
re-ingest runs, then return real hits.

## 10. Required `src/rag/` change call-out (one item)

F01 promises not to redesign RAG, but it does need one small addition
to the public surface to do its job cleanly: expose
`Dataset.deleteByFilter(filter: QueryFilter)` so the records layer can
evict by `scopeRef` without going through the `IngestInput` union.

The existing `VectorStore.deleteByFilter` is already implemented for
internal pipeline use
([saivage/src/rag/store/index.ts](saivage/src/rag/store/index.ts#L18));
the new method is a one-liner that delegates to it. This is the only
change to `src/rag/` F01 needs and is taken as a precondition; if
disallowed, the alternative is a `Dataset.evictByScopeRef(id: string)`
helper that has the same effect with a less generic name. The design
document will pick.

## 11. Files to delete, rewrite, or keep

| File                                              | F01 action     |
| ------------------------------------------------- | -------------- |
| [src/knowledge/types.ts](saivage/src/knowledge/types.ts) | keep (schemas unchanged) |
| [src/knowledge/store.ts](saivage/src/knowledge/store.ts) | keep (atomic IO, audit, guards stay) |
| [src/knowledge/permissions.ts](saivage/src/knowledge/permissions.ts) | keep |
| [src/knowledge/lifecycle.ts](saivage/src/knowledge/lifecycle.ts) | rewrite the write helpers' tails to call the mirror step; rewrite `searchSkills` / `searchMemories` to delegate to the new semantic-search module |
| [src/knowledge/loader.ts](saivage/src/knowledge/loader.ts) | DELETE `canonicalize`, `canonicalizeTokens`, `scoreSkillForSearch`, `scoreMemoryForSearch`, `MemoryIndexEntry`, `SkillIndexEntry`. KEEP `scoreSkillTriggers`, `estimateTokens`, `splitByBudget`, `summarizeForSurvivor` — these belong to the eager loader, not search. |
| [src/knowledge/eagerLoader.ts](saivage/src/knowledge/eagerLoader.ts) | keep (eager stays keyword over the on-disk pool) |
| [src/knowledge/lifecycle.archive.test.ts](saivage/src/knowledge/lifecycle.archive.test.ts) | update fixtures — archived records must no longer appear in semantic search; add an explicit assertion |
| [src/knowledge/concurrency.test.ts](saivage/src/knowledge/concurrency.test.ts) | update: mirror step must not break the existing single-writer invariant |
| [src/knowledge/integration.test.ts](saivage/src/knowledge/integration.test.ts) | rewrite search assertions for semantic results |
| [src/mcp/knowledgeSkills.ts](saivage/src/mcp/knowledgeSkills.ts) | rewrite the `search_skills` handler; `description` text updated |
| [src/mcp/knowledgeMemory.ts](saivage/src/mcp/knowledgeMemory.ts) | rewrite the `search_memories` handler |
| `src/knowledge/semantic-search.ts` (new)          | introduce — owns the RAG query, group-by-record, permission re-check |
| `src/knowledge/rag-mirror.ts` (new)               | introduce — owns `mirrorOnCreate / mirrorOnUpdate / mirrorOnSupersede / mirrorOnArchive` + `reconcileKnowledgeRag` |
| Bootstrap in [src/server/start.ts](saivage/src/server/start.ts) / [src/cli/](saivage/src/cli/) | extend to register the two datasets and run reconcile at start |

## 12. Configuration surface change

`saivage.json`'s `rag.datasets` gains two operator-managed entries:

```jsonc
{
  "rag": {
    "enabled": true,
    "datasets": [
      {
        "id": "skills",
        "source": { "kind": "records" },
        "provider": { "kind": "openai", "model": "text-embedding-3-large", "dim": 1536 },
        "store": { "kind": "sqlite-vec" },
        "chunker": { "kind": "markdown" }
      },
      {
        "id": "memories",
        "source": { "kind": "records" },
        "provider": { "kind": "openai", "model": "text-embedding-3-large", "dim": 1536 },
        "store": { "kind": "sqlite-vec" },
        "chunker": { "kind": "memory" }
      }
    ]
  }
}
```

These two ids are special-cased by the runtime — if either is missing
when the knowledge subsystem starts, the runtime emits a clear error.
Other datasets the operator registers (project docs, source code) are
ignored by the knowledge subsystem.

## 13. Failure modes

| Condition                                                | Behaviour                                                                 |
| -------------------------------------------------------- | ------------------------------------------------------------------------- |
| `config.rag.enabled === false`                           | `searchSkills` / `searchMemories` throw `RAG_UNAVAILABLE`; CRUD unaffected |
| `skills` or `memories` dataset not registered            | runtime startup hard-errors with `KNOWLEDGE_RAG_UNREGISTERED`              |
| Provider stamp drift on a knowledge dataset              | runtime auto-drops + auto-reconciles; logs a warning                       |
| Mirror call fails on `create/update/supersede`           | warn; record stays written; next `reconcileKnowledgeRag` picks it up       |
| Mirror call fails on `archive/delete`                    | warn; record marked archived; the chunk is stale (visible in search) until reconcile |
| Embedding provider 5xx during query                      | tool returns `RAG_PROVIDER_UNAVAILABLE` (new code); agent retries normally |
| `target_agents`-filtered query returns zero hits         | tool returns `[]`; agent's responsibility                                  |
| Audit append succeeds, mirror not yet acked, runtime dies| crash-safe by §7's reconcile-at-start                                      |

## 14. Test surface

The new test files:

- `src/knowledge/semantic-search.test.ts` — covers the query+group+
  permission-check path with a fake `Dataset` whose `query` is
  deterministic; verifies that `target_agents` filtering and the
  per-record `canCall` re-check both engage.
- `src/knowledge/rag-mirror.test.ts` — covers the lifecycle hook +
  reconcile diff. Uses a real sqlite-vec dataset with a mocked
  embedding provider (returns a one-hot vector keyed by `scopeRef`)
  so the test is offline.
- The existing
  [`integration.test.ts`](saivage/src/knowledge/integration.test.ts) is
  extended with one end-to-end semantic-recall scenario that ingests
  three memories then searches with a paraphrase.

The two existing MCP handler tests
([`knowledgeSkills.test.ts`](saivage/src/mcp/knowledgeSkills.test.ts),
[`knowledgeMemory.test.ts`](saivage/src/mcp/knowledgeMemory.test.ts))
are updated to call the new semantic implementations through the same
tool names; argument and result schemas don't change.

## 15. Non-goals and forward pointers

- **Hybrid scoring.** F01 does not ship a "BM25 + vector rerank"
  pipeline. The keyword scorer is gone; the trigger scorer stays for
  the eager loader. A future feature can add a hybrid mode if recall
  quality measurements demand it.
- **Cross-collection queries.** Asking "find me anything skill OR
  memory about X" is not supported. F02 / F03 may add a cross-dataset
  search tool but F01 does not.
- **Auto-summarisation.** Memories continue to use `body` verbatim as
  the chunk text. A future tool can pre-summarise long bodies.
- **Local embeddings.** The two datasets pin OpenAI per §3. Swapping
  to a local provider is a config change after the local-provider work
  in `src/rag/provider/` lands.
- **F02 tooling.** Operator / Librarian-facing tools that create new
  collections do not own the `skills` and `memories` datasets — those
  remain runtime-managed and config-pinned. F02 may expose them
  read-only.
