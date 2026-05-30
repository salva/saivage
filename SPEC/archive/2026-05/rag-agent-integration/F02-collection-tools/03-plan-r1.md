# F02 — Implementation Plan

Implementation order honours `F02 → F01 → F03`. Each batch ends
with a validation step run from `/home/salva/g/ml/saivage` with
`export PATH=~/.local/node-24/bin:$PATH`. The plan refers to the
approved design at
[02-design-r6.md](saivage/SPEC/2026-05/rag-agent-integration/F02-collection-tools/02-design-r6.md).

## Batches

### B01 — Persistence helper

Scope:
- Add `SaivagePersistError` and `saveSaivageConfig(projectRoot, mutate)` in `src/config.ts` (raw-JSON read/validate/write; no env interpolation).
- Add unit tests in `src/config.test.ts` covering: missing-file create, validate-fail path, atomic temp+rename, stage-classified errors.

Validation:
```bash
npm run typecheck && npx eslint src/config.ts src/config.test.ts && npm test -- config
```

Commit: `F02(B01): add saveSaivageConfig + SaivagePersistError`.

### B02 — Walker hardening

Scope:
- Compute `rootReal = await fs.realpath(root)` once in `walk()` ([src/rag/walker.ts](src/rag/walker.ts#L55-L69)).
- After per-entry `stat`, compute `realAbs = await fs.realpath(abs)`; if `path.relative(rootReal, realAbs)` starts with `..` or is absolute, log via `log.warn("rag.walker.symlink-escape " + JSON.stringify(...))` and `continue`.
- Add walker fixture test for a symlink that points outside the root.

Validation:
```bash
npm run typecheck && npx eslint src/rag/walker.ts && npm test -- walker
```

Commit: `F02(B02): walker silently skips symlink escapes`.

### B03 — `ToolCallContext.operatorContext` field

Scope:
- Extend `ToolCallContext` ([src/mcp/toolContext.ts](src/mcp/toolContext.ts#L17-L34)) with optional `operatorContext?: boolean`.
- CLI / server runtime construction path sets it to `true` only for operator-driven calls; default remains `undefined`.
- Add `isRuntimeOperatorContext(ctx)` predicate exported from `src/server/rag/service.ts` (file created in B04).

Validation:
```bash
npm run typecheck && npx eslint src/mcp/toolContext.ts && npm test -- toolContext
```

Commit: `F02(B03): operatorContext field on ToolCallContext`.

### B04 — `RagService` skeleton

Scope:
- Create `src/server/rag/service.ts` (RagService, RAG_TOOLS, requiresAdminRole, requiresControlMutex, isRuntimeOperatorContext, RuntimeRagDatasetConfig).
- Create `src/server/rag/envelope.ts` (ragOk/ragErr).
- Create `src/server/rag/errors.ts` (mapRagError with the canonical RAG_* codes table).
- Create `src/server/rag/mutex.ts` (tryRunExclusive with sync-throw safe release).
- Add unit tests for `mapRagError`, mutex, envelope.

Validation:
```bash
npm run typecheck && npx eslint src/server/rag/ && npm test -- server/rag
```

Commit: `F02(B04): RagService skeleton, mapRagError, mutex`.

### B05 — Tool implementations

Scope:
- Create `src/server/rag/tools/{list,stats,query,register,ingest,drop,admin}.ts` implementing each tool per design §A.5 and §A.9.
- `rag_register` and `rag_drop` follow the config-first/manager-second/rollback ordering.
- `rag_admin` covers `watch_arm`, `watch_disarm`, `reconcile` per analysis §4.7.
- Add per-tool unit tests with mocked `RagManager`.

Validation:
```bash
npm run typecheck && npx eslint src/server/rag/tools/ && npm test -- server/rag
```

Commit: `F02(B05): rag_* tool implementations`.

### B06 — Handler + builtins wiring

Scope:
- Create `src/server/rag/handler.ts` (`makeRagHandler`, `RAG_TOOL_DEFINITIONS`, `TOOL_SCHEMAS`, `TOOL_IMPL`).
- Extend `BuiltinServicesOptions` in [src/mcp/builtins.ts](src/mcp/builtins.ts#L1912-L1966) with `rag?: RagService` and register the service with `available: true` when provided.
- Add integration tests: `RAG_DISABLED` envelope when disabled; `RAG_UNAUTHORIZED_ROLE` when role lacks admin; operator bypass works; mutex contention returns `RAG_CONTROL_BUSY`.

Validation:
```bash
npm run typecheck && npx eslint src/server/rag/ src/mcp/builtins.ts && npm test -- server/rag mcp/builtins
```

Commit: `F02(B06): wire rag service through registerBuiltinServices`.

### B07 — Bootstrap construction

Scope:
- In [src/server/bootstrap.ts](src/server/bootstrap.ts#L133-L151), construct `ragDatasets`, `manager`, and `ragService` per design §A.8; pass `ragService` through `registerBuiltinServices` options.
- Propagate `ragService` into the agent-construction switch (parameter on the spawner closure) so F03 can later consume it.
- Add bootstrap smoke test loading a temp project with `rag.enabled = false` → service registered as available, returns `RAG_DISABLED` envelope.

Validation:
```bash
npm run typecheck && npx eslint src/server/bootstrap.ts && npm test -- server/bootstrap
```

Commit: `F02(B07): bootstrap constructs and wires RagService`.

### B08 — E2E + full validation

Scope:
- E2E test in `src/server/rag/e2e.test.ts`: in-process `RagManager` + temp project; full `rag_register → rag_ingest → rag_query → rag_drop` under both operator and admin-role contexts.
- Full repo validation:

```bash
npm run typecheck && npm test && npx eslint src/server/rag/ src/rag/walker.ts src/config.ts src/mcp/builtins.ts src/mcp/toolContext.ts src/server/bootstrap.ts
```

Commit: `F02(B08): e2e + full validation`.

## Risks

- Existing tests using `loadConfig` must not regress; `saveSaivageConfig` keeps its raw-JSON path independent.
- Builtins registration order matters: register `rag` before any caller that depends on it; B06 places the call at the end of `registerBuiltinServices`.
- `Dataset.watch()` throws `WatcherUnavailableError` synchronously; B05 `rag_admin watch_arm` catches it explicitly.
