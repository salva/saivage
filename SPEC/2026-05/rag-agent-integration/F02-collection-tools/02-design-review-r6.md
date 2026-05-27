# F02 Collection Tools Design Review R6

Reviewed `02-design-r6.md` against approved `01-analysis-r7.md`, the R5 review blocker, and the current source under `src/`.

## Findings

None.

## R5 Blocker Verification

- Project id source: fixed. R6 now uses `projectId: project.config.project_name` in the bootstrap snippet. This matches the current bootstrap scope, where `project` is loaded by `loadProject(projectRoot)` before runtime `config` is loaded, and `ProjectContext.config` is the project config object. The project-name field is source-backed by the existing `ProjectConfig` shape; runtime `SaivageConfig` still has no `project_name` field, so the R5 bug is addressed rather than moved.

## Regression Check

- The shared dataset-array invariant remains intact: one `ragDatasets` array is passed to `createRagManager({ datasets: ragDatasets })` and stored as `RagService.datasets`, preserving visibility for runtime register/drop mutations because `RagManager` closes over the array reference for lookups.
- `createRagManager` is still awaited and still receives the required options bag: `projectRoot`, `projectId`, `enabled`, `datasets`, and optional `providerOptions`.
- The `rag` in-process service remains registered with `available: true`, preserving the handler-level `RAG_DISABLED` envelope path required by the approved analysis.
- The admin/operator authorization split, control-mutex scope, typed error mapping, watcher-disabled pre-check, and walker hardening notes remain consistent with the approved analysis and the current source contracts rechecked.

VERDICT: APPROVE