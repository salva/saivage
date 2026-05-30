# F02 Collection Tools Design Review R3

Reviewed `02-design-r3.md` against approved `01-analysis-r7.md`, the prior R2 blockers, and the current source under `src/`.

## Findings

1. Bootstrap constructs `RagManager` with an option object that does not match the current source or the approved service-construction analysis. R3 shows `createRagManager({ projectRoot, datasets, providerOptions })`, but `RagManagerOptions` requires `projectId` and `enabled`, and `createRagManager` returns the no-op disabled manager whenever `opts.enabled` is falsy. If implemented as written, a project with `config.rag.enabled === true` would still get a disabled manager while `RagService.enabled` is true, so normal RAG calls would fail through the no-op manager instead of operating on configured datasets. This contradicts analysis section 6. Required fix: pass `projectId: config.projectId` and `enabled: config.rag.enabled` to `createRagManager` in the R3 bootstrap snippet.

2. The `rag_admin watch_arm` snippet still does not match the source `RagManager.get` contract. R3 uses `const dataset = service.manager.get(input.id); if (!dataset) ...; if (dataset.config.watch === false) ...`, but `get(id)` returns `Promise<Dataset>` and throws `DatasetNotFoundError` on absence; it does not return `undefined`. As written, this is compile-invalid and does not model the canonical `DatasetNotFoundError` -> `RAG_DATASET_NOT_FOUND` path from analysis section 5. Required fix: `await service.manager.get(input.id)` and let `mapRagError` handle not-found, or catch `DatasetNotFoundError` explicitly with the canonical code.

## R2 Blocker Verification

- R2-1 fixed. R3 registers `rag` with `{ available: true }` regardless of `service.enabled`, and the handler pre-check returns `RAG_DISABLED`.
- R2-2 fixed. R3 splits `requiresAdminRole` from `requiresControlMutex`; `rag_ingest` is admin/operator-restricted but not in the control mutex set.
- R2-3 fixed. The mutex helper uses `Promise.resolve().then(fn).finally(...)`, so synchronous throws release `busy`.
- R2-4 fixed for the prior persistence-ordering issue. R3 specifies config-first register/drop, no manager side effects when config persistence fails, best-effort config rollback when the later manager call fails, and the real `manager.register` / `manager.drop` method names.
- R2-5 fixed. R3 restores the canonical codes `RAG_DATASET_NOT_FOUND`, `RAG_CORRUPTED_STORE`, and `RAG_INVALID_QUERY_FILTER`, including the watch-arm not-found code text.

## Confirmations

- `available: true` is necessary with current `McpRuntime.callTool`, which throws before the handler when an in-process service is unavailable.
- The current `RagManager` source exposes `register(config)` and `drop(id)`, matching the corrected R3 persistence section.
- The current RAG error classes include `DatasetNotFoundError`, `CorruptedStoreError`, and `InvalidQueryFilterError`, matching the restored canonical error table.

VERDICT: CHANGES_REQUESTED