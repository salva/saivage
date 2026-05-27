# F02 Plan Review R2

Reviewed `03-plan-r2.md` against the approved `02-design-r6.md`, the r1 review findings, and the current `src/` tree.

## Findings

1. P1 - B03 still names a nonexistent CLI source file.

   R2 fixes the B03/B04 sequencing issue by moving `isRuntimeOperatorContext` into B04, and it now explicitly audits `src/runtime/dispatcher.ts` and `src/agents/chat.ts` as non-operator context builders. However, B03 says the operator path is in `src/cli.ts` and includes `src/cli.ts` in the eslint validation command. The current source tree has no `src/cli.ts`; the CLI entry point is `src/server/cli.ts`, with the CLI action layer in `src/server/cli-actions.ts`. As written, the B03 validation command will fail before implementation is validated, and the operator-source-site audit is not aligned with the source tree.

   Required change: replace the nonexistent `src/cli.ts` reference with the actual CLI source path(s) that will be patched and linted, at minimum `src/server/cli.ts` and any action-layer file that constructs the relevant runtime/operator path such as `src/server/cli-actions.ts` if it is touched.

## R1 Fix Verification

- B01 is fixed. It creates `src/server/rag/persist.ts`, exports `SaivagePersistError` and `saveSaivageConfig`, and re-exports them from `src/config.ts`, matching design §A.1 and §A.6.
- B03/B04 dependency ordering is fixed. B03 is limited to the `ToolCallContext.operatorContext` field plus runtime call-site changes/audits, while `isRuntimeOperatorContext` is created in B04 with `src/server/rag/service.ts`.
- B03 partially fixes the source-site audit. It now names the intended operator and non-operator files and asserts dispatcher/chat leave the flag unset, but the `src/cli.ts` path is wrong for the current source tree.
- B05 is fixed. It explicitly covers the `watch_arm` contract from design §A.9: `dataset.config.watch === false` pre-check produces `RAG_WATCH_DISABLED`; awaited `manager.get(id)` surfaces `DatasetNotFoundError` as `RAG_DATASET_NOT_FOUND`; `dataset.watch()` failures with `WatcherUnavailableError` produce `RAG_WATCHER_UNAVAILABLE`; success sets `watchStatus` to `armed`.

## Design Coverage

The revised plan otherwise matches the approved design's requested module boundaries, control-mutex ownership, persistence ordering, RAG error mapping, builtins wiring, bootstrap construction, and e2e coverage. The remaining blocker is narrow but concrete: B03's source path and validation command do not match the repository.

VERDICT: CHANGES_REQUESTED