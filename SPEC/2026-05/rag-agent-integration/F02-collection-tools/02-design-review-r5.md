# F02 Collection Tools Design Review R5

Reviewed `02-design-r5.md` against approved `01-analysis-r7.md`, the two remaining R4 blockers, and the current source under `src/`.

## Findings

1. `projectId` is still not source-backed in the bootstrap snippet. R5 correctly removes the fictitious `config.project.id`, but replaces it with `projectId: config.project_name`. In current `src/server/bootstrap.ts`, `config` is the runtime `SaivageConfig` loaded by `loadConfig(project.projectRoot)`, and current `src/config.ts` defines `SaivageConfigSchema` with `rag` but no `project_name` field. The project name is defined by `ProjectConfigSchema` in `src/types.ts` and is available in bootstrap as `project.config.project_name`. Because the same snippet uses `config.rag.datasets` and `config.rag.enabled`, `config` is the runtime config object, not the project config object. Required fix: use `project.config.project_name` for `RagManagerOptions.projectId`, or explicitly add a source-backed runtime config field before referencing it.

## R4 Blocker Verification

- Shared datasets array: fixed. R5 creates one `const ragDatasets: RuntimeRagDatasetConfig[] = [...config.rag.datasets]` and passes that exact array object to both `createRagManager({ datasets: ragDatasets })` and `RagService.datasets`. This satisfies the approved invariant because `RagManager.get(id)` searches the `opts.datasets` array it closed over, so runtime `rag_register` / `rag_drop` mutations through `service.datasets` remain visible to later manager calls.
- Project id source: not fixed. R5 no longer uses `config.project.id`, but `config.project_name` is still not a field on the source-backed runtime `SaivageConfig` object used by the bootstrap snippet. The source-backed expression in the current bootstrap scope is `project.config.project_name`.

## Regression Check

- `createRagManager` is still awaited and still receives the full required options bag: `projectRoot`, `projectId`, `enabled`, `datasets`, and optional `providerOptions`.
- The `rag` in-process service remains registered with `available: true`, preserving the handler-level `RAG_DISABLED` envelope path.
- The `rag_admin watch_arm` flow still awaits `service.manager.get(input.id)` and maps `DatasetNotFoundError` to `RAG_DATASET_NOT_FOUND` before checking `watch`.
- The admin/operator authorization split, control-mutex scope, and canonical error mapping remain consistent with the approved analysis in the areas rechecked.

VERDICT: CHANGES_REQUESTED