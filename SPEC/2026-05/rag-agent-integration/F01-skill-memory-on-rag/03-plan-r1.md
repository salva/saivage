# F01 — Implementation Plan

Implementation order honours `F02 → F01 → F03`. F01 begins after
F02 has merged. Each batch ends with a validation step run from
`/home/salva/g/ml/saivage` with
`export PATH=~/.local/node-24/bin:$PATH`. Plan refers to the
approved design at
[02-design-r2.md](saivage/SPEC/2026-05/rag-agent-integration/F01-skill-memory-on-rag/02-design-r2.md).

## Batches

### B01 — Sidecar schema + handle

Scope:
- Create `src/knowledge/sidecar.ts` (`openSidecar`, `SidecarHandle`, `PRAGMA user_version` migrations for v1: `record`, `record_skill`, `record_memory`, `audit`, `rag_sync` tables with the design §A.3 columns; non-unique indexes; no global UNIQUE on skill name).
- Create `src/knowledge/sidecar-queries.ts` with typed queries.
- Add unit tests for migration idempotency, transactional rollback, and CRUD round-trip.

Validation:
```bash
npm run typecheck && npx eslint src/knowledge/sidecar.ts src/knowledge/sidecar-queries.ts && npm test -- knowledge/sidecar
```

Commit: `F01(B01): sidecar SQLite schema + handle`.

### B02 — Private RAG dataset access seam

Scope:
- Create `src/rag/internal/datasetAccess.ts` exporting `getInternalDataset(manager, id)` that reads from a module-level `WeakMap<RagManager, (id: string) => Dataset | undefined>` populated by `createRagManager` at construction.
- Hook into `src/rag/manager.ts` to register the lookup into the WeakMap on construction. **Do not** add `getInternalDataset` to `src/rag/index.ts` exports.
- Add unit test confirming the seam returns the correct `Dataset` and is `undefined` for unknown ids.

Validation:
```bash
npm run typecheck && npx eslint src/rag/ && npm test -- rag/internal rag/manager
```

Commit: `F01(B02): private getInternalDataset seam`.

### B03 — KnowledgeStore façade + reingest helper

Scope:
- Create `src/knowledge/init.ts` exporting `initKnowledgeStore(opts)` and the `KnowledgeStore` type.
- Create `src/knowledge/reingest.ts` with `reingestKind(store, kind)` (with `rag_sync` cleanup for inactive records).
- Create `src/knowledge/recovery.ts` with `runBootDivergenceSweep(store)` using `getInternalDataset` + `store.getFileState()`.
- Add unit tests: reingest item construction; sweep detects and corrects mismatch.

Validation:
```bash
npm run typecheck && npx eslint src/knowledge/{init,reingest,recovery}.ts && npm test -- knowledge/init knowledge/reingest knowledge/recovery
```

Commit: `F01(B03): KnowledgeStore facade + reingest + recovery`.

### B04 — Lifecycle rewrite

Scope:
- Rewrite `src/knowledge/lifecycle.ts` per design §A.5: every write helper becomes `enforceWriteGuards → buildRecord → sidecar transaction with enforceCollisionRules → post-commit reingestKind`.
- Extract collision/supersession/expiry/blocked-path/secret guards into pure helpers.
- Drop `SkillRecord.body_path` from `src/knowledge/types.ts`; widen `RecordBase.id` and `AuditEntry.record_id` to `string | "builtin:" prefixed string` union.
- `update_memory` gains the scope preflight.
- Preserve all current handler input/output schemas.

Validation:
```bash
npm run typecheck && npx eslint src/knowledge/ && npm test -- knowledge
```

Commit: `F01(B04): lifecycle on sidecar (no body_path, no legacy JSON tree)`.

### B05 — Eager loader rewrite + builtin upsert

Scope:
- Rewrite `loadAllCandidates` in `src/knowledge/eagerLoader.ts` to read `loadAllActiveRowsForEager()` from sidecar and return the preserved `{record, body, origin}` shape.
- Implement `upsertBuiltinSkills(store)` reading `skills/builtin/<topic>/SKILL.md`; id = `"builtin:" + nfcLower(name)`; origin = `"builtin"`.
- Add unit tests confirming `resolveEagerRecords` consumes the output shape correctly.

Validation:
```bash
npm run typecheck && npx eslint src/knowledge/eagerLoader.ts && npm test -- knowledge/eagerLoader
```

Commit: `F01(B05): eager loader on sidecar + builtin upsert`.

### B06 — Search helpers on RAG

Scope:
- Add `searchSkills` and `searchMemories` to `src/knowledge/lifecycle.ts` (or new `src/knowledge/search.ts`) per design §A.6, including the empty-id `{ hits: [] }` guard, post-query active+visibility filter, and `KNOWLEDGE_RAG_UNAVAILABLE` envelope on RAG failure.
- Wire MCP handlers in `src/mcp/knowledgeSkills.ts` and `src/mcp/knowledgeMemory.ts` to the new search helpers.
- Add integration tests for scoped/unscoped search and RAG-failure path.

Validation:
```bash
npm run typecheck && npx eslint src/knowledge/ src/mcp/knowledgeSkills.ts src/mcp/knowledgeMemory.ts && npm test -- knowledge search mcp/knowledge
```

Commit: `F01(B06): RAG-backed search for skills and memory`.

### B07 — Boot + legacy-tree refusal + handler injection

Scope:
- Bootstrap calls `initKnowledgeStore({ projectRoot, ragManager, ragDatasets, saveSaivageConfig })` after `RagService` construction.
- `refuseOrCleanLegacyTree`: hard-fail when legacy `.saivage/skills` or `.saivage/memory` exists with empty sidecar; remove silently when both exist.
- Remove legacy seed code in [src/store/project.ts](src/store/project.ts#L145-L174) so new projects start sidecar-only.
- Pass `knowledge: store` through `registerBuiltinServices` and switch `src/mcp/knowledgeSkills.ts` / `src/mcp/knowledgeMemory.ts` to use the injected façade instead of module-level singletons.
- Add bootstrap smoke test.

Validation:
```bash
npm run typecheck && npx eslint src/server/bootstrap.ts src/store/project.ts src/mcp/knowledge*.ts && npm test -- server/bootstrap store/project mcp/knowledge
```

Commit: `F01(B07): knowledge boot + legacy-tree refusal + handler injection`.

### B08 — E2E + full validation

Scope:
- E2E test in `src/knowledge/e2e.test.ts`: bootstrap a temp project; create skill → search → archive → search returns empty; `update_memory` scope preflight closes pre-existing gap; built-in skills loaded.
- Recovery test: simulate post-commit pre-reingest crash; verify boot sweep restores RAG state.
- Full repo validation:

```bash
npm run typecheck && npm test && npx eslint src/knowledge/ src/rag/internal/ src/mcp/knowledgeSkills.ts src/mcp/knowledgeMemory.ts src/server/bootstrap.ts src/store/project.ts
```

Commit: `F01(B08): e2e + full validation`.

## Risks

- Removing legacy JSON tree is a hard cutover; pre-merge announcement in release notes.
- `body_path` removal breaks any external consumer that read frontmatter; covered by analysis §0.8.
- Built-in skill loading happens at boot; first boot after upgrade does a full reingest of skill records (acceptable; bounded).
