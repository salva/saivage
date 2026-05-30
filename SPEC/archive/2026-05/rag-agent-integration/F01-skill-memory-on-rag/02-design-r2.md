# F01 — Skills & Memories on RAG: Design

This design crystallises the sidecar module boundaries, the
knowledge-store façade, the lifecycle re-implementation strategy,
the eager-loader contract, and the boot recovery flow specified in
[01-analysis-r7.md](saivage/SPEC/2026-05/rag-agent-integration/F01-skill-memory-on-rag/01-analysis-r7.md).

## A. Focused Proposal — façade injection with sidecar-only data plane

### A.1 Modules

```
src/knowledge/
├── sidecar.ts             // openSidecar, schema migrations, low-level CRUD
├── sidecar-queries.ts     // typed read/list queries
├── init.ts                // initKnowledgeStore (boot entry)
├── lifecycle.ts           // unchanged exports; bodies rewritten on top of sidecar
├── reingest.ts            // per-kind snapshot reingest helper
├── recovery.ts            // boot divergence sweep + pending_reingest catch-up
├── eagerLoader.ts         // unchanged exports; loadAllCandidates rewritten
├── loader.ts              // unchanged scoring + filter helpers
├── permissions.ts         // unchanged ACL
├── store.ts               // KnowledgeStoreError only; JSON-tree code removed
└── types.ts               // body_path dropped from SkillRecord; id unions widened

src/rag/internal/
└── datasetAccess.ts       // PRIVATE: getInternalDataset(manager, id) → Dataset
```

### A.2 `KnowledgeStore` façade

```ts
export interface KnowledgeStore {
  sidecar: SidecarHandle;
  ragManager: RagManager;
  ragDatasets: RuntimeRagDatasetConfig[];        // shared array also held by RagService
  reingestKind: (kind: "skill" | "memory") => Promise<void>;
}
```

`registerBuiltinServices` (extended in F02) gains a
`knowledge?: KnowledgeStore` field; on receipt, the handlers in
[src/mcp/knowledgeSkills.ts](src/mcp/knowledgeSkills.ts) and
[src/mcp/knowledgeMemory.ts](src/mcp/knowledgeMemory.ts) use the
injected façade instead of the current module-level singletons.

### A.3 Sidecar handle

`openSidecar(path)` opens
`.saivage/knowledge/store.sqlite` with `better-sqlite3`. Migrations
are versioned via `PRAGMA user_version`; v1 establishes the schema
from analysis §3.1, with one design adjustment:

> The `record_skill` table **does not** carry a global unique index
> on `name`. Collisions remain scope-local and are enforced by
> `enforceCollisionRules(sidecar, row)` exactly as today in
> [src/knowledge/lifecycle.ts](src/knowledge/lifecycle.ts#L277-L279)
> and [src/knowledge/lifecycle.ts](src/knowledge/lifecycle.ts#L525-L527).
> A non-unique index `record_skill_name_idx ON record_skill(name)`
> supports the lookup at sub-millisecond cost.

The same adjustment applies to memories: collision rejection
remains scope-local at the lifecycle layer; the sidecar carries
non-unique indexes for fast lookup. This keeps the analysis's
schema intent (fast scope-bounded membership lookup) while
honouring the existing supersession/history behaviour.

`SidecarHandle` exposes:

```ts
interface SidecarHandle {
  db: Database;
  inTransaction<T>(fn: () => T): T;
  getRecord(id: string): RecordRow | undefined;
  putRecord(row: RecordRow, audit: AuditEntry): void;
  setStatus(id: string, next: Status, audit: AuditEntry): void;
  listActiveItems(kind: "skill" | "memory"): IngestItem[];
  activeRecordsByScope(kind: "skill" | "memory", scope: Scope, scopeRef?: string): RecordRow[];
  activeIdsForScope(kind: "skill" | "memory", scope: Scope, scopeRef?: string): string[];
  loadAllActiveRowsForEager(): EagerRow[];
  clearPendingReingest(kind: "skill" | "memory"): void;
}

interface EagerRow {
  record_json: string;
  body: string;
  origin: "builtin" | "project";
}
```

### A.4 Reingest helper

```ts
export async function reingestKind(store: KnowledgeStore, kind: "skill"|"memory") {
  const datasetId = kind === "skill" ? "knowledge.skills" : "knowledge.memory";
  const items = store.sidecar.listActiveItems(kind);
  await store.ragManager.ingest(datasetId, { kind: "records", items });
  store.sidecar.inTransaction(() => store.sidecar.clearPendingReingest(kind));
}
```

Failures bubble. Lifecycle write paths catch them, log via
`log.warn("knowledge.rag-reingest-failed " + JSON.stringify({ kind, err: err.message }))`,
and leave `pending_reingest = 1` so the boot sweep retries.

### A.5 Lifecycle rewrite strategy

Every write helper in `lifecycle.ts` follows this template:

```ts
export async function createSkill(store, input, ctx) {
  enforceWriteGuards(input.body, input.frontmatter);
  const audit = buildAuditEntry(...);
  const row = buildRecordRow(input, ctx);
  store.sidecar.inTransaction(() => {
    enforceCollisionRules(store.sidecar, row);       // scope-local; ported as-is
    store.sidecar.putRecord({ ...row, pending_reingest: 1 }, audit);
  });
  try { await reingestKind(store, "skill"); }
  catch (err) {
    log.warn("knowledge.rag-reingest-failed " + JSON.stringify({ err: (err as Error).message }));
  }
  return { id: row.id, status: row.status };
}
```

`enforceCollisionRules`, supersession, expiry, blocked-path, and
secret guards are extracted from the current `lifecycle.ts` into
pure helpers reused by every write path. `redactForRead` and
`buildSearchSnippet` are preserved.

`update_memory` gains a preflight (analysis §6):
`const prior = store.sidecar.getRecord(id)` → `gateScope(prior)` →
proceed.

### A.6 Search helpers

```ts
export async function searchSkills(store, input, ctx) {
  let filter: QueryFilter | undefined;
  if (input.scope) {
    const ids = store.sidecar.activeIdsForScope("skill", input.scope.kind, input.scope.ref);
    if (ids.length === 0) return { hits: [] };       // empty IN guard
    filter = { in: { path: ids.map(id => `skill:${id}.md`) } };
  }
  let hits: QueryHit[];
  try {
    hits = await store.ragManager.query("knowledge.skills", input.query,
                                         { topK: input.limit ?? 10, filter });
  } catch (err) {
    return { error: { code: "KNOWLEDGE_RAG_UNAVAILABLE", message: (err as Error).message,
                      details: { cause: (err as Error).constructor.name } } };
  }
  const out: SearchHit[] = [];
  for (const hit of hits) {
    const id = decodePathToId(hit.metadata.path, "skill");
    const row = store.sidecar.getRecord(id);
    if (!row || row.status !== "active") continue;
    if (!isVisibleToRole(row, ctx.role)) continue;
    out.push({ id, score: hit.score,
               snippet: redactForRead(buildSearchSnippet(hit.text, tokens(input.query))).text });
  }
  return { hits: out };
}
```

The empty-id guard short-circuits before constructing a
`QueryFilter.in` that the SQL compiler would reject as
`InvalidQueryFilterError`
([src/rag/store/sql.ts](src/rag/store/sql.ts#L58-L64)).
`searchMemories` is structurally identical with the
`"knowledge.memory"` dataset and `memory:` path prefix.

Post-filter visibility/active gating may return fewer than `limit`
hits even when additional eligible matches exist beyond the initial
RAG `topK`. The handler returns what survives; the design does not
re-query for more.

### A.7 Eager loader rewrite

The preserved `RawCandidate` shape from
[src/knowledge/eagerLoader.ts](src/knowledge/eagerLoader.ts#L31-L33)
is `{ record, body, origin? }`, and
`resolveEagerRecords` reads `cand.record`
([src/knowledge/loader.ts](src/knowledge/loader.ts#L233-L237)).
The rewrite preserves that shape:

```ts
export async function loadAllCandidates(store, scopeRefs): Promise<RawCandidate[]> {
  return store.sidecar.loadAllActiveRowsForEager().map((row) => ({
    record: assembleRecord(JSON.parse(row.record_json)),
    body: row.body,
    origin: row.origin,                              // "builtin" | "project"
  }));
}
```

`assembleRecord` reconstructs the typed record (no body_path) from
the JSON column. `buildEagerBlock` and `resolveEagerRecords` are
unchanged, and `buildSurvivorBlock` in
[src/agents/base.ts](src/agents/base.ts#L916-L954) keeps working.

Built-in skills are upserted at boot via `upsertBuiltinSkills(store)`
reading `skills/builtin/<topic>/SKILL.md` and writing records with
`id = "builtin:" + nfcLower(name)` and `origin = "builtin"`.

### A.8 Boot flow (`initKnowledgeStore`)

```ts
export async function initKnowledgeStore(opts): Promise<KnowledgeStore> {
  assertRagEnabled(opts);                              // fatal on rag.enabled === false
  const sidecar = await openSidecar(opts.projectRoot);
  await refuseOrCleanLegacyTree(opts.projectRoot, sidecar);
  await ensureProtectedDatasets(opts);                 // pushes + saveSaivageConfig (F02)
  await registerProtectedDatasets(opts);               // manager.register
  await upsertBuiltinSkills({ sidecar });
  const store: KnowledgeStore = {
    sidecar, ragManager: opts.ragManager, ragDatasets: opts.ragDatasets,
    reingestKind: (k) => reingestKind({ sidecar, ragManager: opts.ragManager,
                                        ragDatasets: opts.ragDatasets,
                                        reingestKind: () => Promise.resolve() }, k),
  };
  await runBootDivergenceSweep(store);
  return store;
}
```

`refuseOrCleanLegacyTree`:

```ts
const legacyPresent = await exists(join(root, ".saivage/skills"))
                    || await exists(join(root, ".saivage/memory"));
const sidecarEmpty = sidecar.db.prepare("SELECT COUNT(*) c FROM record").get().c === 0;
if (legacyPresent && sidecarEmpty)
  throw new KnowledgeStoreError("KNOWLEDGE_MIGRATION_REQUIRED",
    ".saivage/skills and .saivage/memory exist with empty sidecar — back up and delete to proceed");
if (legacyPresent && !sidecarEmpty) {
  await fs.rm(join(root, ".saivage/skills"), { recursive: true, force: true });
  await fs.rm(join(root, ".saivage/memory"), { recursive: true, force: true });
}
```

The seed in
[src/store/project.ts](src/store/project.ts#L145-L174) is updated
in the same change to stop creating `.saivage/skills` and
`.saivage/memory`; new projects start sidecar-only.

### A.9 Boot divergence sweep — private RAG seam

Rather than extending the public `RagManager` interface, the seam
is a separate non-index helper:

```ts
// src/rag/internal/datasetAccess.ts  (NOT re-exported from src/rag/index.ts)
import type { RagManager } from "../manager.js";
import type { Dataset } from "../dataset.js";
export function getInternalDataset(manager: RagManager, id: string): Dataset | undefined {
  // implementation reads the manager's private dataset map via an internal
  // symbol installed at module load; not part of the public type.
  return INTERNAL_GET(manager, id);
}
```

The `INTERNAL_GET` hook is installed by the manager module on first
import (a module-level `WeakMap<RagManager, (id: string) => Dataset>`
written from inside the manager's factory and read by
`getInternalDataset`). The public `RagManager` type
[src/rag/manager.ts](src/rag/manager.ts#L42-L49) and the public
barrel [src/rag/index.ts](src/rag/index.ts#L1-L14) are
untouched.

`runBootDivergenceSweep(store)`:

```ts
for (const kind of ["skill", "memory"] as const) {
  const datasetId = kind === "skill" ? "knowledge.skills" : "knowledge.memory";
  const dataset = getInternalDataset(store.ragManager, datasetId);
  if (!dataset) continue;
  const stored = dataset.store.getFileState();         // path → hash map
  const expected = new Map(store.sidecar.listActiveItems(kind)
                                          .map(i => [i.metadata.path, hashOf(i)]));
  if (!mapsEqual(stored, expected)) await reingestKind(store, kind);
}
```

The seam is the **only** non-public RAG surface F01 touches.

## B. Level-up Alternative — sidecar-as-RAG-store driver

Replace the protected `sqlite-vec` stores with a
`KnowledgeVectorStore` driver writing into the knowledge sidecar.
Pros: one substrate; no divergence sweep. Cons: requires extending
the public `VectorStoreRef` union (forbidden by workspace rule);
duplicates the proven `sqlite-vec` index for marginal gain.
Rejected.

## C. Chosen Direction

A. Sidecar-of-truth + protected `sqlite-vec` datasets, with a
single private non-index `getInternalDataset` helper for recovery.
Public RAG exports unchanged.

## D. Risks and Mitigations

| Risk | Mitigation |
|---|---|
| Reingest after every write inflates latency | Bounded by active-record count per kind (≤ 5k typical); provider batching mitigates. |
| `pending_reingest` flag never clears (provider outage) | Boot sweep retries on next start; next successful write also retries. |
| Built-in id collisions across NFC-normalised names | Builtin upsert loader rejects collisions at boot. |
| Private `getInternalDataset` tempts wider use | Single documented call site in `recovery.ts`; lint rule could forbid further imports later. |
| `rag_sync` rows for inactive/deleted records accumulate | Reingest helper additionally deletes `rag_sync` rows whose `id` no longer appears in active items (cleanup pass in same transaction). |

## E. Test Strategy

- Unit: sidecar migrations; transactional rollback; collision /
  supersession helpers; reingest item construction; legacy-tree
  refusal; empty-id search guard.
- Integration: lifecycle round-trip; `update_memory` scope
  preflight; redaction and snippet pipeline; built-in upsert.
- Recovery: simulate post-commit/pre-reingest crash; verify boot
  sweep restores RAG state.
- E2E: bootstrap in temp project; in-memory provider stub; search
  returns sidecar-backed records.

## F. Out of Scope

- Public RAG API extensions (alternative B).
- Parallel writes to the legacy JSON tree.
- Knowledge-specific vector-store driver.
