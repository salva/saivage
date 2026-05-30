# F01 — Implementation Plan

Implementation order honours `F02 → F01 → F03`. F01 begins after
F02 has merged. Each batch ends with a validation step run from
`/home/salva/g/ml/saivage` with
`export PATH=~/.local/node-24/bin:$PATH`. Refers to the approved
design at
[02-design-r2.md](saivage/SPEC/2026-05/rag-agent-integration/F01-skill-memory-on-rag/02-design-r2.md).

## Batches

### B01 — Sidecar schema + handle

Scope:
- Create `src/knowledge/sidecar.ts` (`openSidecar`, `SidecarHandle`, `PRAGMA user_version` migrations for v1: `record`, `record_skill`, `record_memory`, `audit`, `rag_sync` tables; non-unique indexes; **no global UNIQUE on `record_skill.name`**).
- `pending_reingest INTEGER NOT NULL DEFAULT 0` on `record` per design §A.3.
- Create `src/knowledge/sidecar-queries.ts` with typed read/list queries (`activeIdsForScope`, `activeRecordsByScope`, `loadAllActiveRowsForEager`, `pendingReingest` enumerators).
- Unit tests: migration idempotency; transactional rollback; CRUD round-trip; `pending_reingest` enumeration.

Validation:
```bash
npm run typecheck \
  && npx eslint src/knowledge/sidecar.ts src/knowledge/sidecar-queries.ts \
  && npm test -- knowledge/sidecar
```

Commit: `F01(B01): sidecar SQLite schema + handle`.

### B02 — Private RAG dataset access seam

Scope:
- Create `src/rag/internal/datasetAccess.ts` exporting `getInternalDataset(manager, id): Dataset | undefined`.
- Hook into `src/rag/manager.ts` `createRagManager` to install per-manager lookup in a module-level `WeakMap<RagManager, (id: string) => Dataset | undefined>`.
- **Do not** add `getInternalDataset` to `src/rag/index.ts` exports.
- Unit tests: seam returns the correct `Dataset` for registered ids; `undefined` for unknown ids; no-op manager returns `undefined` for everything.

Validation:
```bash
npm run typecheck \
  && npx eslint src/rag/internal/ src/rag/manager.ts \
  && npm test -- rag/internal rag/manager
```

Commit: `F01(B02): private getInternalDataset seam`.

### B03 — KnowledgeStore façade + handler injection

Scope:
- Create `src/knowledge/init.ts` exporting `initKnowledgeStore(opts)` and the `KnowledgeStore` type.
- Boot order per design §A.8: `assertRagEnabled(opts)` (fatal on `enabled === false`) → `openSidecar` → `refuseOrCleanLegacyTree` → `ensureProtectedDatasets` (push protected configs + `saveSaivageConfig` from F02) → `registerProtectedDatasets` (call `manager.register` for both protected datasets) → `upsertBuiltinSkills(store)` → `runBootDivergenceSweep(store)`. Order asserted by tests.
- Create `src/knowledge/reingest.ts` exporting `reingestKind(store, kind)` (clears `pending_reingest` and refreshes `rag_sync` rows in a single transaction; deletes `rag_sync` rows for ids no longer active).
- Create `src/knowledge/recovery.ts` exporting `runBootDivergenceSweep(store)` using `getInternalDataset` + `store.getFileState()` per design §A.9; **also enumerates `pending_reingest=1` rows and reingests those kinds even when the file-state map matches**.
- Extend `BuiltinServicesOptions` in `src/mcp/builtins.ts` with `knowledge?: KnowledgeStore`; pass to skills/memory handler factories.
- Refactor `src/mcp/knowledgeSkills.ts` and `src/mcp/knowledgeMemory.ts` handlers from module-level singleton calls to receive `store: KnowledgeStore` via the handler factory. The full lifecycle rewrite (B04) lands in the same merge train but B03 contains the API shim so types compile: B03 introduces façade-typed delegating helpers in `lifecycle.ts` that initially call the existing `(root, ...)` helpers as adapters, allowing handler-typecheck to land before B04 rewrites the bodies.
- Tests: boot order (mock each step, assert call order); `assertRagEnabled` fatal path; pending-reingest catch-up on boot when only the flag is set.

Validation:
```bash
npm run typecheck \
  && npx eslint src/knowledge/{init,reingest,recovery}.ts src/mcp/{knowledgeSkills,knowledgeMemory,builtins}.ts \
  && npm test -- knowledge/init knowledge/reingest knowledge/recovery mcp/knowledge
```

Commit: `F01(B03): KnowledgeStore facade + handler injection + recovery`.

### B04 — Lifecycle rewrite

Scope:
- Rewrite every write helper in `src/knowledge/lifecycle.ts` per design §A.5: `enforceWriteGuards → buildRecord → sidecar transaction with enforceCollisionRules (scope-local) → post-commit reingestKind`.
- Extract collision/supersession/expiry/blocked-path/secret guards into pure helpers.
- Drop `SkillRecord.body_path` from `src/knowledge/types.ts`; widen `RecordBase.id` and `AuditEntry.record_id` to accept either UUID or `builtin:<lower>` strings.
- `update_memory` gains the scope preflight from design §A.5.
- Replace the B03 shim adapters with the real sidecar-backed implementations.
- Tests: full create/update/supersede/archive round-trip on sidecar; collision rejection still scope-local; `update_memory` preflight closes the pre-existing gap; failed post-commit reingest leaves `pending_reingest = 1`.

Validation:
```bash
npm run typecheck \
  && npx eslint src/knowledge/lifecycle.ts src/knowledge/types.ts \
  && npm test -- knowledge/lifecycle knowledge/types
```

Commit: `F01(B04): lifecycle on sidecar (no body_path, no legacy JSON tree)`.

### B05 — Eager loader rewrite + builtin upsert + RAG ingest metadata

Scope:
- Rewrite `loadAllCandidates` in `src/knowledge/eagerLoader.ts` to read `loadAllActiveRowsForEager()` from sidecar; return the preserved `{record, body, origin}` shape.
- Implement `upsertBuiltinSkills(store)` in `src/knowledge/init.ts` (or a new `src/knowledge/builtins.ts`) reading `skills/builtin/<topic>/SKILL.md`; id = `"builtin:" + nfcLower(name)`; origin = `"builtin"`; called from `initKnowledgeStore`.
- **RAG pipeline metadata alignment**: in `src/rag/pipeline.ts` `runIngest`, when the input is `IngestInput.records` (not file-based snapshot), honour `metadata.source` from the records instead of inferring from path. Add unit test confirming `source: "skill"` and `source: "memory"` survive a round-trip from `reingestKind`.
- Tests: `resolveEagerRecords` consumes new candidate shape; builtin upsert idempotent; pipeline metadata round-trip for skill and memory.

Validation:
```bash
npm run typecheck \
  && npx eslint src/knowledge/eagerLoader.ts src/knowledge/builtins.ts src/rag/pipeline.ts \
  && npm test -- knowledge/eagerLoader knowledge/builtins rag/pipeline
```

Commit: `F01(B05): eager loader on sidecar + builtin upsert + RAG record metadata honour`.

### B06 — Search helpers on RAG

Scope:
- Add `searchSkills(store, input, ctx)` and `searchMemories(store, input, ctx)` per design §A.6 with empty-id `{ hits: [] }` guard, post-query active+visibility filter, and `KNOWLEDGE_RAG_UNAVAILABLE` envelope on RAG failure.
- Wire MCP handlers (already injected via B03) to use the new search helpers.
- Integration tests: scoped, unscoped, scope with no active records (empty-id guard); RAG failure → envelope.

Validation:
```bash
npm run typecheck \
  && npx eslint src/knowledge/lifecycle.ts src/mcp/knowledgeSkills.ts src/mcp/knowledgeMemory.ts \
  && npm test -- knowledge search mcp/knowledge
```

Commit: `F01(B06): RAG-backed search for skills and memory`.

### B07 — Boot + legacy-tree refusal + project seed cutover

Scope:
- Bootstrap calls `initKnowledgeStore({ projectRoot, ragManager, ragDatasets, saveSaivageConfig })` after the F02 `RagService` construction.
- Add `"KNOWLEDGE_MIGRATION_REQUIRED"` to `KnowledgeErrorCode` in `src/knowledge/store.ts` and to any union types used by handlers.
- `refuseOrCleanLegacyTree`: hard-fail with `KnowledgeStoreError("KNOWLEDGE_MIGRATION_REQUIRED", ...)` when legacy `.saivage/skills` or `.saivage/memory` exists with empty sidecar; remove silently when both legacy + non-empty sidecar exist.
- Remove legacy seed code in [src/store/project.ts](src/store/project.ts#L145-L174); new projects start sidecar-only.
- Tests: `KNOWLEDGE_MIGRATION_REQUIRED` raised on legacy+empty; legacy tree removed on legacy+populated; new project starts without legacy directories.

Validation:
```bash
npm run typecheck \
  && npx eslint src/server/bootstrap.ts src/store/project.ts src/knowledge/store.ts \
  && npm test -- server/bootstrap store/project knowledge/store
```

Commit: `F01(B07): knowledge boot + legacy-tree refusal + seed cutover`.

### B08 — E2E + full validation

Scope:
- E2E in `src/knowledge/e2e.test.ts`: bootstrap a temp project with provider stub; create skill → search → archive → empty-search; `update_memory` scope preflight closes the gap; built-in skills loaded.
- Recovery e2e: simulate (a) post-commit pre-reingest crash and (b) pending_reingest flag set on cold boot; verify both paths reingest correctly.
- Full repo validation:

```bash
npm run typecheck \
  && npm test \
  && npx eslint src/knowledge/ src/rag/internal/ src/mcp/knowledge*.ts src/server/bootstrap.ts src/store/project.ts src/rag/pipeline.ts
```

Commit: `F01(B08): e2e + full validation`.

## Risks

- `body_path` removal breaks external consumers; covered by analysis §0.8 release notes.
- Built-in skill loading at boot triggers a full reingest of skill records; bounded; first-boot cost noted.
- Legacy tree removal is irreversible; B07 hard-fail surfaces the migration requirement before any data loss.
