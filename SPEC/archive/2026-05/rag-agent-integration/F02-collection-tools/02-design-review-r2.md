# F02 Collection Tools Design Review R2

Reviewed `02-design-r2.md` against approved `01-analysis-r7.md`, the prior R1 blockers, and the current source under `src/`.

## Findings

1. `rag` is registered as unavailable when RAG is disabled, so the handler cannot return the required typed `RAG_DISABLED` envelope. R2 moves registration into `registerBuiltinServices`, which fixes the R1 boundary issue, but the snippet passes `{ available: options.rag.enabled }`. The approved analysis explicitly says in-process `available: false` makes `McpRuntime.callTool` throw before the handler runs, so `rag` must always be registered as available and let the handler's `service.enabled` pre-check return `RAG_DISABLED`. Required fix: omit the availability option or set it to `true` for `rag`.

2. `rag_ingest` is incorrectly placed under the control mutex. R2 defines `isMutating` as including `rag_ingest` and then uses `isMutating(toolName)` to decide both authorization and `tryRunExclusive`. The approved analysis treats `rag_ingest` as admin/operator-restricted, but not as a control-plane mutex operation: concurrent same-dataset ingest is handled by the existing ingest lock and maps to `RAG_INGEST_LOCKED`, while unrelated dataset ingests should not be blocked by `RAG_CONTROL_BUSY`. Required fix: split the concepts, for example `requiresAdminRole` may include `rag_ingest`, while `requiresControlMutex` covers only `rag_register`, `rag_drop`, and `rag_admin`.

3. The concrete mutex helper does not implement its stated release semantics. R2 says synchronous throws are covered by `Promise.resolve().then(fn)` semantics, but the code does `const value = fn().finally(...)`. If `fn` throws before returning a promise, `state.busy` remains `true` permanently. Required fix: implement the helper as `const value = Promise.resolve().then(fn).finally(() => { state.busy = false; });` or use an equivalent `try`/`catch` path, and keep the synchronous-throw release test.

4. The persist/register/drop operation order still conflicts with the approved rollback contract and current `RagManager` source. The `saveSaivageConfig` helper itself now reads raw JSON without env interpolation and throws `SaivagePersistError`, which fixes the core R1 persistence concern. However, R2's register/drop flow mutates `service.datasets` and calls `service.manager.register(cfg)` / `unregister(id)` before persistence. The approved analysis requires register-with-persist to write config first, with no manager or in-memory side effects if that write fails; after a successful config write, later manager failures need best-effort config rollback. The current source also has `manager.drop(id)`, not `unregister(id)`, and `manager.register` writes registry state, so a later persist failure would leave more than an in-memory mutation to roll back. Required fix: align register/drop sequencing with analysis §§4.4, 4.6, and 7.3, and name the actual `RagManager` methods.

5. The error-code table in `mapRagError` no longer matches the approved analysis. R2 maps `DatasetNotFoundError` to `RAG_NOT_FOUND`, `CorruptedStoreError` to `RAG_STORE_CORRUPTED`, and `InvalidQueryFilterError` to `RAG_INVALID_FILTER`; the approved codes are `RAG_DATASET_NOT_FOUND`, `RAG_CORRUPTED_STORE`, and `RAG_INVALID_QUERY_FILTER`. Required fix: use the canonical code names from analysis §5 everywhere, including the `rag_admin watch_arm` not-found path.

## R1 Blocker Verification

- R1-1 persistence: partially fixed. Raw JSON read/no env interpolation and `SaivagePersistError` stage classification are present, and `SaivagePersistError` maps to `RAG_PERSIST_FAILED`; the surrounding register/drop ordering remains blocking per finding 4.
- R1-2 watcher mapping: fixed. `WatcherUnavailableError` is included and `RAG_WATCH_DISABLED` is described as a `watch_arm` pre-check.
- R1-3 mutex helper: partially fixed. `src/server/rag/mutex.ts` is specified, but the helper's sync-throw release semantics and mutex scope are still wrong per findings 2 and 3.
- R1-4 registration boundary: partially fixed. Registration now goes through `registerBuiltinServices` via `options.rag`, with no separate direct runtime registration, but the `available` flag contradicts the approved envelope behavior per finding 1.
- R1-5 walker log call: fixed. The walker snippet uses a single-string `log.warn("rag.walker.symlink-escape " + JSON.stringify(...))`, matching `src/log.ts`.

## Confirmations

- `saveSaivageConfig` no longer calls `loadConfig`, so it avoids the current `deepInterpolate` path in `src/config.ts`.
- `WatcherUnavailableError` exists in the public RAG barrel and is the correct source error for synchronous watcher arm failures.
- The single-string walker log call matches the current `log.warn(msg: string)` API.
- Builtins remains the right registration owner; R2 should keep that direction while correcting the availability option.

VERDICT: CHANGES_REQUESTED