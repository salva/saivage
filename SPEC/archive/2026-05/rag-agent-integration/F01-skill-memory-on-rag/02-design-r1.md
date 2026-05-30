# F01 — Skills & Memories on RAG: Design

This design crystallises the sidecar module boundaries, the
knowledge-store façade, the lifecycle re-implementation strategy,
and the boot recovery flow specified in
[01-analysis-r7.md](saivage/SPEC/2026-05/rag-agent-integration/F01-skill-memory-on-rag/01-analysis-r7.md).

## A. Focused Proposal — façade injection with sidecar-only data plane

### A.1 Modules

```
src/knowledge/
├── sidecar.ts             // openSidecar, schema migrations, low-level CRUD
├── sidecar-queries.ts     // typed read/list queries used by lifecycle + loader
├── lifecycle.ts           // unchanged exports; bodies rewritten on top of sidecar
├── reingest.ts            // per-kind snapshot reingest helper called after every commit
├── recovery.ts            // boot divergence sweep + pending_reingest catch-up
├── eagerLoader.ts         // unchanged exports; loadAllCandidates rewritten
├── loader.ts              // unchanged scoring + filter helpers
├── permissions.ts         // unchanged ACL
├── store.ts               // KnowledgeStoreError only; JSON-tree code removed
└── types.ts               // body_path dropped from SkillRecord; id unions widened
```

The boot entry point is `initKnowledgeStore({ projectRoot,
ragManager, ragDatasets, saveSaivageConfig })` exported from
`src/knowledge/init.ts` (new). It returns a `KnowledgeStore` handle
with `sidecar`, `ragManager`, and `ragDatasets` for injection into
MCP handlers.

### A.2 `KnowledgeStore` interface

```ts
export interface KnowledgeStore {
  sidecar: SidecarHandle;            // open SQLite handle
  ragManager: RagManager;
  ragDatasets: RuntimeRagDatasetConfig[];   // shared array (also held by F02 RagService)
  reingestKind: (kind: "skill" | "memory") => Promise<IngestReport>;
}
```

`registerBuiltinServices` gains a `knowledge?: KnowledgeStore`
option; on receipt, the knowledge handlers
([knowledgeSkills.ts](src/mcp/knowledgeSkills.ts),
[knowledgeMemory.ts](src/mcp/knowledgeMemory.ts)) use injection
instead of module-level singletons.

### A.3 Sidecar handle

`openSidecar(path)` opens
`.saivage/knowledge/store.sqlite` with `better-sqlite3`. Migrations
are versioned via `PRAGMA user_version`; v1 establishes the §3.1
schema. `SidecarHandle` exposes:

```ts
interface SidecarHandle {
  db: Database;
  inTransaction<T>(fn: () => T): T;            // BEGIN IMMEDIATE
  getRecord(id: string): RecordRow | undefined;
  putRecord(row: RecordRow, audit: AuditEntry): void;
  setStatus(id: string, next: Status, audit: AuditEntry): void;
  listActiveItems(kind: "skill"|"memory"): IngestItem[];
  getRagSync(id: string): { body_hash, embedded_at } | undefined;
  upsertRagSync(rows: RagSyncRow[]): void;
  clearPendingReingest(kind: "skill"|"memory"): void;
}
```

`listActiveItems` produces the `IngestInput.records.items` array
directly: `{ id, text: chunkPrefix(record), metadata: {...} }`.

### A.4 Reingest helper

```ts
export async function reingestKind(store, kind): Promise<IngestReport> {
  const datasetId = kind === "skill" ? "knowledge.skills" : "knowledge.memory";
  const items = store.sidecar.listActiveItems(kind);
  const report = await store.ragManager.ingest(datasetId,
                                               { kind: "records", items });
  store.sidecar.inTransaction(() => {
    store.sidecar.clearPendingReingest(kind);
    store.sidecar.upsertRagSync(items.map(i => ({
      id: i.metadata.path.replace(/^(skill|memory):/, "").replace(/\.md$/, ""),
      collection_id: datasetId,
      body_hash: hashOf(i),
      embedded_at: new Date().toISOString(),
    })));
  });
  return report;
}
```

On `IngestLockedError` / provider error: caught upstream by the
handler, logged via `log.warn("knowledge.rag-reingest-failed",
JSON.stringify({ kind, err: err.message }))`; `pending_reingest`
stays at 1; handler returns the existing write-success shape.

### A.5 Lifecycle rewrite strategy

Every helper in `lifecycle.ts` becomes:

```ts
export async function createSkill(store, input, ctx) {
  enforceWriteGuards(input.body, input.frontmatter);
  const audit = buildAuditEntry(...);
  const row = buildRecordRow(input, ctx);

  store.sidecar.inTransaction(() => {
    enforceCollisionRules(store.sidecar, row);     // ported verbatim from current
    store.sidecar.putRecord({ ...row, pending_reingest: 1 }, audit);
  });

  await reingestKind(store, "skill").catch((err) => {
    log.warn("knowledge.rag-reingest-failed", JSON.stringify({ err: err.message }));
  });
  return { id: row.id, status: row.status };
}
```

The collision, supersession, expiry, blocked-path and secret guards
are extracted from current `lifecycle.ts` into pure helpers reused
by every write path. `redactForRead` and `buildSearchSnippet` are
preserved in place.

### A.6 Search helper

```ts
export async function searchSkills(store, input, ctx) {
  let filter: QueryFilter | undefined;
  if (input.scope) {
    const ids = store.sidecar.activeIdsForScope("skill", input.scope);
    filter = { in: { path: ids.map(id => `skill:${id}.md`) } };
  }
  let hits: QueryHit[];
  try {
    hits = await store.ragManager.query("knowledge.skills", input.query,
                                         { topK: input.limit ?? 10, filter });
  } catch (err) {
    return { error: { code: "KNOWLEDGE_RAG_UNAVAILABLE", message: err.message,
                      details: { cause: err.constructor.name } } };
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

`searchMemories` is structurally identical with
`"knowledge.memory"` and the `memory:` path prefix.

### A.7 Eager loader rewrite

`loadAllCandidates(projectRoot, scopeRefs)` becomes:

```ts
return store.sidecar.db
  .prepare(`SELECT record_json, body FROM record WHERE status='active'`)
  .all()
  .map((row) => ({ ...JSON.parse(row.record_json), body: row.body }));
```

`resolveEagerRecords` already accepts the candidate list and applies
target-agent / trigger / survivor filters; no change required.
`buildSurvivorBlock` in
[base.ts](src/agents/base.ts#L916-L954) is unchanged.

Built-in skills are upserted at boot via
`upsertBuiltinSkills(store)` reading
`skills/builtin/<topic>/SKILL.md`; each gets `id = "builtin:" +
nfcLower(name)`. The current per-process `randomUUID` path in
[eagerLoader.ts](src/knowledge/eagerLoader.ts#L169-L212) is deleted.

### A.8 Boot flow (`initKnowledgeStore`)

```ts
export async function initKnowledgeStore(opts) {
  assertRagEnabled(opts);                             // fatal on enabled === false
  const sidecar = await openSidecar(opts.projectRoot);
  await refuseOrCleanLegacyTree(opts.projectRoot, sidecar);
  await ensureProtectedDatasets(opts);                // pushes + saveSaivageConfig
  await registerProtectedDatasets(opts);              // manager.register
  await upsertBuiltinSkills({ sidecar });
  await runBootDivergenceSweep({ sidecar, ragManager: opts.ragManager });
  return { sidecar, ragManager: opts.ragManager, ragDatasets: opts.ragDatasets,
           reingestKind: (k) => reingestKind({ sidecar, ragManager: opts.ragManager }, k) };
}
```

`refuseOrCleanLegacyTree`:

```ts
const legacyPresent = await exists(join(root, ".saivage/skills"))
                    || await exists(join(root, ".saivage/memory"));
const sidecarEmpty = sidecar.db.prepare("SELECT COUNT(*) c FROM record").get().c === 0;
if (legacyPresent && sidecarEmpty)
  throw new KnowledgeStoreError("KNOWLEDGE_MIGRATION_REQUIRED",
    "delete .saivage/skills and .saivage/memory after backup");
if (legacyPresent && !sidecarEmpty)
  await fs.rm(join(root, ".saivage/skills"), { recursive: true, force: true })
       .then(() => fs.rm(join(root, ".saivage/memory"), { recursive: true, force: true }));
```

### A.9 Boot divergence sweep

```ts
for (const kind of ["skill", "memory"]) {
  const datasetId = kind === "skill" ? "knowledge.skills" : "knowledge.memory";
  const dataset = await opts.ragManager.getInternal(datasetId);   // see below
  const stored = dataset.store.getFileState();    // path → hash map from file_state table
  const expected = new Map(sidecar.listActiveItems(kind)
    .map(i => [i.metadata.path, hashOf(i)]));
  const diverged = !mapsEqual(stored, expected);
  if (diverged) await reingestKind({ sidecar, ragManager: opts.ragManager }, kind);
}
```

`getInternal` is a friend method on `RagManager` (added in a small
private hook) returning the `Dataset` instance with its `store`
property. **This is the one private RAG-internals seam F01 needs.**
The seam preserves all exported signatures from
[src/rag/index.ts](src/rag/index.ts).

## B. Level-up Alternative — sidecar-as-RAG-store driver

Replace the protected `sqlite-vec` stores entirely: write a
`KnowledgeVectorStore` driver that reads/writes from the knowledge
sidecar tables (chunks alongside records). Pros: one storage
substrate; no `rag_sync` table; no divergence sweep. Cons: requires
extending the public `VectorStoreRef` union with `"knowledge-sidecar"`
(public RAG API change — forbidden by workspace rule); deepens RAG
coupling to knowledge-specific schema; duplicates the proven
`sqlite-vec` index for marginal gain. **Rejected** on the public-API
constraint.

## C. Chosen Direction

A. Sidecar-of-truth + protected `sqlite-vec` datasets, with one
internal `getInternal` seam on `RagManager` for divergence
inspection. The seam preserves the exported public API and is the
minimum private surface needed to use the store's authoritative
file-state enumerator.

## D. Risks and Mitigations

| Risk | Mitigation |
|------|-----------|
| Reingest after every write inflates write latency | Reingest is bounded by active-record count of the affected kind; expected ≤ 5k records per project. Provider batching mitigates. |
| `pending_reingest` flag never clears (provider outage) | Boot sweep catches up; next successful write of the kind also catches up; operator sees `log.warn` stream. |
| Inline skill bodies bloat sidecar | Acceptable: bodies were already on disk; only storage location changes. |
| Built-in id collisions across NFC-normalised names | Builtin loader rejects collisions at upsert time. |
| `getInternal` seam tempts knowledge code to bypass public API | Seam is private (not in `src/rag/index.ts`), documented as recovery-only, and covered by a single call site in `recovery.ts`. |

## E. Test Strategy

- Unit: sidecar migrations; transactional rollback; collision /
  supersession helpers; reingest item construction; legacy-tree
  refusal.
- Integration: full lifecycle round-trip (`create_skill` →
  `search_skills` → `archive_skill` → re-`search_skills`);
  `update_memory` scope preflight (closes pre-existing gap);
  redaction and snippet pipeline.
- Recovery: simulate post-commit/pre-reingest crash; verify boot
  sweep restores RAG state.
- E2E: bootstrap in temp project; live `RagManager` (in-memory
  provider stub); search returns sidecar-backed records.

## F. Out of Scope

- Public RAG API extensions (rejected per workspace rule).
- Parallel writes to the legacy JSON tree.
- A knowledge-specific vector-store driver (Alternative B).
