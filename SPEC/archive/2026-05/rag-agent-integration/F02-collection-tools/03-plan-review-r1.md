# F02 Plan Review R1

Reviewed `03-plan-r1.md` against the approved `02-design-r6.md` and the current `src/` implementation.

## Findings

1. P1 - B01 violates the approved persistence module boundary.

   The approved design places the implementation of `SaivagePersistError` and `saveSaivageConfig` in `src/server/rag/persist.ts`, with re-exports from `src/config.ts`. B01 instead says to add both directly in `src/config.ts`, and no later batch creates `src/server/rag/persist.ts`. This loses a design-required module and leaves the B01 validation command unable to lint or test the actual persistence module the handler/error layer will depend on.

   Required change: make B01 create `src/server/rag/persist.ts`, re-export the helper and error from `src/config.ts`, and update validation to include the new persist module and its tests.

2. P1 - B03 has a dependency on B04 and is not self-contained.

   B03 says to add `isRuntimeOperatorContext(ctx)` exported from `src/server/rag/service.ts`, but the same plan says `src/server/rag/service.ts` is created in B04. That breaks the requested sequence `B03 ToolCallContext -> B04 service skeleton`; B03 cannot be validated independently if it relies on a file created by the next batch.

   Required change: keep B03 limited to `ToolCallContext.operatorContext` plus the actual runtime call-site changes, and move `isRuntimeOperatorContext` into B04 with the rest of `service.ts`.

3. P2 - B03 validation does not cover all files it claims to edit.

   B03 scope says the CLI/server runtime construction path sets `operatorContext: true` only for operator-driven calls, but its eslint command covers only `src/mcp/toolContext.ts`. The current source builds agent tool contexts in `src/runtime/dispatcher.ts` and chat slash-command contexts in `src/agents/chat.ts`; any new operator-facing call path should be named and linted/tested, while those agent/chat paths should be asserted to remain unset.

   Required change: identify the exact source file(s) that set `operatorContext: true`, include them in B03 validation, and add a test that non-operator agent/chat contexts do not get the bypass flag.

4. P2 - B05 under-specifies the `rag_admin watch_arm` error contract and includes a wrong source assumption.

   The plan's risk section says `Dataset.watch()` throws `WatcherUnavailableError` synchronously. Current source does not match that: `Dataset.watch()` throws a generic disabled-watch error when `config.watch` is false or undefined, while `WatcherUnavailableError` is produced by watcher construction failures. The approved design requires `watch_arm` to pre-check `dataset.config.watch === false` and return `RAG_WATCH_DISABLED`, handle `DatasetNotFoundError` as `RAG_DATASET_NOT_FOUND`, then map `WatcherUnavailableError` as `RAG_WATCHER_UNAVAILABLE`.

   Required change: make B05 explicitly cover the design's `watch_arm` flow and add tests for `RAG_WATCH_DISABLED`, `RAG_DATASET_NOT_FOUND`, `RAG_WATCHER_UNAVAILABLE`, and successful `watchStatus.set(id, "armed")`.

## Sequence Review

The intended macro order is otherwise logical: persistence before mutating register/drop tools, walker hardening before ingest exposure, context before handler authorization, service primitives before tools, tools before handler/builtins, builtins before bootstrap, and bootstrap before e2e. With the B03 dependency fixed, the requested sequence `B01 -> B02 -> B03 -> B04 -> B05 -> B06 -> B07 -> B08` can work.

## Validation Review

Every batch has a concrete validation step containing typecheck, eslint, and a test command. The validation shape satisfies the requested rule in principle, but B01 and B03 need adjustment because the scoped eslint/test commands do not cover the files that the corrected batches must edit.

## Design Coverage

Covered by the plan: control mutex placement excluding `rag_ingest`, canonical error mapping, handler authorization and disabled envelope tests, `available: true` builtins registration, config-first register/drop ordering with rollback, walker symlink escape hardening, bootstrap construction, and operator/admin e2e flow.

Missing or insufficiently explicit: the `src/server/rag/persist.ts` module, B03/B04 ownership of `isRuntimeOperatorContext`, exact operator-context source sites, and the `rag_admin watch_arm` pre-check/error contract.

VERDICT: CHANGES_REQUESTED