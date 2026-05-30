# F02 Collection Tools Design Review R4

Reviewed `02-design-r4.md` against approved `01-analysis-r7.md`, the R3 review blockers, and the current source under `src/`.

## Findings

1. Bootstrap still violates the approved shared-datasets invariant. R4 passes `config.rag.datasets` into `createRagManager`, but gives `RagService.datasets` a separate `[...config.rag.datasets]` copy. The approved analysis constructs one `ragDatasets` array and passes that same object to both the manager and the service. This matters because `RagManager.get(id)` searches the `opts.datasets` array it closed over; after `rag_register`, R4 pushes into `service.datasets`, but `get`, `ingest`, `query`, `stats`, and `drop` still search the original manager array and cannot discover the runtime registration. Required fix: create `const ragDatasets = [...config.rag.datasets]`, pass `datasets: ragDatasets` to `createRagManager`, and set `RagService.datasets = ragDatasets`.

2. The bootstrap snippet now includes the `projectId` option key, but the value expression does not match the approved analysis or the current source. R4 uses `projectId: config.project.id`; the approved analysis uses `config.projectId`, while the current `SaivageConfigSchema` has no `project` object and `ProjectConfigSchema` exposes `project_name`, not `project.id`. As written, the snippet does not identify a source-backed project id and would not type-check against the current bootstrap `config` object. Required fix: use the approved/source-backed project id path, or explicitly add the required project-id field to the config/source contract before this call.

## R3 Blocker Verification

- R3-1 is only partially fixed. R4 now supplies the full `RagManagerOptions` key set: `projectRoot`, `projectId`, `enabled`, `datasets`, and `providerOptions`, so the missing-`enabled` no-op-manager problem is addressed. The snippet remains blocked by the project-id source mismatch and by not sharing the datasets array between manager and service.
- R3-2 fixed. `rag_admin watch_arm` now awaits `service.manager.get(input.id)`, treats absence as `DatasetNotFoundError`, and returns `RAG_DATASET_NOT_FOUND` explicitly. This matches `RagManager.get(id): Promise<Dataset>` and its async-throwing not-found behavior in `src/rag/manager.ts`.

## Confirmations

- `available: true` is still preserved, so disabled RAG can return the handler-level `RAG_DISABLED` envelope.
- `rag_ingest` remains admin/operator-restricted without entering the control mutex set.
- The mutex still releases on synchronous throws via `Promise.resolve().then(fn).finally(...)`.
- The canonical error table remains restored, including `RAG_DATASET_NOT_FOUND`, `RAG_CORRUPTED_STORE`, and `RAG_INVALID_QUERY_FILTER`.
- The watcher-arm flow now catches `WatcherUnavailableError` separately as `RAG_WATCHER_UNAVAILABLE` and leaves other errors to `mapRagError`.

VERDICT: CHANGES_REQUESTED