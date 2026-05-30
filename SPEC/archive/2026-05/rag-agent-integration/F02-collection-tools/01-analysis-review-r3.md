# F02 Collection Tools Analysis R3 Review

## Summary

R3 is much closer than R2: it settles on a single `rag` service, exactly seven tools, no `delete_record`, protected skill/memory datasets, the correct handler envelope shape, and an explicit `saveSaivageConfig` deliverable. I cannot approve it yet because several remaining claims contradict the current source contracts or leave an unsafe runtime story.

## Findings

1. The authorization model still accidentally grants write/admin RAG tools to worker-filter roles.

   The analysis says the mutating/admin tools are "placed in no existing filter" and therefore no current agent role can call them [SPEC/2026-05/rag-agent-integration/F02-collection-tools/01-analysis-r3.md](SPEC/2026-05/rag-agent-integration/F02-collection-tools/01-analysis-r3.md#L131-L142). That is not true for the current filter implementation. `worker` is deny-list based, not allow-list based: it accepts every tool name not in `WORKER_EXCLUDED_TOOLS` [src/agents/tool-filters.ts](src/agents/tool-filters.ts#L12-L43). Manager, Coder, Researcher, Data Agent, Designer, and Critic all use that worker filter through the roster. Adding `rag_register`, `rag_ingest`, `rag_drop`, and `rag_admin` without adding them to the worker exclusion set would expose them immediately to those roles, directly contradicting the protected/operator-only story and F03's bounded Librarian grant.

2. The multi-source ingest/register story conflicts with the pipeline's full-snapshot semantics.

   The draft correctly explains that `runIngest` treats each supplied input as the complete seen set for that call [SPEC/2026-05/rag-agent-integration/F02-collection-tools/01-analysis-r3.md](SPEC/2026-05/rag-agent-integration/F02-collection-tools/01-analysis-r3.md#L61-L68), and the pipeline deletes prior paths not present in the current input [src/rag/pipeline.ts](src/rag/pipeline.ts#L276-L288). But `rag_register` then ingests `sources` one entry at a time [SPEC/2026-05/rag-agent-integration/F02-collection-tools/01-analysis-r3.md](SPEC/2026-05/rag-agent-integration/F02-collection-tools/01-analysis-r3.md#L276-L278). With multiple roots, the second ingest can delete chunks from the first root. The same risk applies to `rag_ingest`, which accepts only one root and is described as a general collection-load path [SPEC/2026-05/rag-agent-integration/F02-collection-tools/01-analysis-r3.md](SPEC/2026-05/rag-agent-integration/F02-collection-tools/01-analysis-r3.md#L296-L303). The analysis needs a coherent rule: either constrain F02-managed `fs` datasets to one source root, require callers to ingest the collection's full root every time, or represent multiple sources under a single common root. As written, the automatic indexing requirement is implemented by a destructive sequence.

3. The delete-file-via-reconcile decision is not accurate against the watcher reconcile implementation.

   The draft rejects `delete_record`, then says operators can delete one file from an `fs` dataset by deleting the file and running `rag_admin action: "reconcile"` [SPEC/2026-05/rag-agent-integration/F02-collection-tools/01-analysis-r3.md](SPEC/2026-05/rag-agent-integration/F02-collection-tools/01-analysis-r3.md#L345-L347). Current `Dataset.reconcile()` delegates to `WatcherController.reconcile()` and returns `Promise<void>` [src/rag/dataset.ts](src/rag/dataset.ts#L170-L172). The controller computes `removedPaths`, but its ingest loop filters only `changedPaths` and does not route deletion-only results into an ingest call [src/rag/watcher/controller.ts](src/rag/watcher/controller.ts#L83-L91), while the reconcile helper merely returns removed paths [src/rag/watcher/reconcile.ts](src/rag/watcher/reconcile.ts#L64-L72). A full `rag_ingest` over the source root can purge missing files because of the pipeline snapshot rule, but `rag_admin reconcile` should not be documented as the deletion mechanism unless the analysis proves the current public method actually triggers that purge.

4. The disabled-service behavior contradicts the promised `RAG_DISABLED` envelope.

   The draft says that when `config.rag.enabled === false`, the service is registered with `available: false`, while the handler also short-circuits with `RAG_DISABLED` before the stub wrapper can fire [SPEC/2026-05/rag-agent-integration/F02-collection-tools/01-analysis-r3.md](SPEC/2026-05/rag-agent-integration/F02-collection-tools/01-analysis-r3.md#L408-L413). The runtime does not call handlers for unavailable in-process services; it throws `Service "..." is registered but unavailable` before handler dispatch [src/mcp/runtime.ts](src/mcp/runtime.ts#L177-L178). The design must pick one behavior: keep the tools registered and available so handlers can return the typed `RAG_DISABLED` envelope, or hide the service and stop promising a stable tool-level code.

5. The watcher logger/status story requires a RAG public-surface change that the document says it avoids.

   R3 claims bootstrap passes `watcherLogger: log` into `createRagManager` and that the logger reaches watcher flood/ENOSPC paths [SPEC/2026-05/rag-agent-integration/F02-collection-tools/01-analysis-r3.md](SPEC/2026-05/rag-agent-integration/F02-collection-tools/01-analysis-r3.md#L396-L415), [SPEC/2026-05/rag-agent-integration/F02-collection-tools/01-analysis-r3.md](SPEC/2026-05/rag-agent-integration/F02-collection-tools/01-analysis-r3.md#L458-L470). `RagManagerOptions` currently has only `projectRoot`, `projectId`, `enabled`, `datasets`, and `providerOptions` [src/rag/manager.ts](src/rag/manager.ts#L34-L40). `DatasetOpenOptions` also exposes only `providerOptions` [src/rag/dataset.ts](src/rag/dataset.ts#L58-L61), and `Dataset.createWatcherController()` does not pass a `log` callback [src/rag/dataset.ts](src/rag/dataset.ts#L175-L184). `WatcherController` has the logger seam [src/rag/watcher/controller.ts](src/rag/watcher/controller.ts#L49), but F02 cannot reach it through the fixed public RAG API. This must be reconciled with the hard constraint against public RAG API changes.

6. The bootstrap/runtime registration snippet is internally inconsistent.

   The snippet omits the required `enabled` option for `createRagManager` and adds unsupported `watcherLogger` [SPEC/2026-05/rag-agent-integration/F02-collection-tools/01-analysis-r3.md](SPEC/2026-05/rag-agent-integration/F02-collection-tools/01-analysis-r3.md#L392-L399), while the actual options type requires `enabled` [src/rag/manager.ts](src/rag/manager.ts#L34-L40). It also says the same mutable dataset array is passed to the manager and stored as `dynamicDatasets`, but the code shows `datasets: [...config.rag.datasets]` and then references an undeclared `dynamicDatasets` variable [SPEC/2026-05/rag-agent-integration/F02-collection-tools/01-analysis-r3.md](SPEC/2026-05/rag-agent-integration/F02-collection-tools/01-analysis-r3.md#L396-L403). Since mutating that exact array is the proposed runtime registration path, this needs to be precise, not illustrative.

7. Watch arming and watcher-disabled semantics need tightening.

   The schema leaves `watch` optional [SPEC/2026-05/rag-agent-integration/F02-collection-tools/01-analysis-r3.md](SPEC/2026-05/rag-agent-integration/F02-collection-tools/01-analysis-r3.md#L234-L241), but the procedure says to arm when `watch !== false` [SPEC/2026-05/rag-agent-integration/F02-collection-tools/01-analysis-r3.md](SPEC/2026-05/rag-agent-integration/F02-collection-tools/01-analysis-r3.md#L279-L282). If the tool schema does not default `watch` to `false` before handler logic, omitted `watch` attempts to arm a dataset whose config has watching disabled. `Dataset.watch()` throws a generic `Error` when `config.watch` is false or undefined [src/rag/dataset.ts](src/rag/dataset.ts#L149-L153), so `RAG_WATCH_DISABLED` should be produced by a handler pre-check rather than by pretending the RAG layer throws a typed error. The watcher status map also cannot observe async ENOSPC/flood events unless finding 5 is resolved.

8. A few schema/result details remain inconsistent with the stated decisions.

   `rag_register`'s input schema says `source: "doc" | "code"` while promising `"skill" | "memory" -> RAG_PROTECTED_SOURCE` [SPEC/2026-05/rag-agent-integration/F02-collection-tools/01-analysis-r3.md](SPEC/2026-05/rag-agent-integration/F02-collection-tools/01-analysis-r3.md#L234-L235); if the schema rejects those values first, callers see `RAG_INVALID_ARGS`, not `RAG_PROTECTED_SOURCE`. `initialIngestReport` is singular even though the procedure says reports are aggregated across multiple sources [SPEC/2026-05/rag-agent-integration/F02-collection-tools/01-analysis-r3.md](SPEC/2026-05/rag-agent-integration/F02-collection-tools/01-analysis-r3.md#L252-L278). The document also uses `dynamicDatasets` for both the mutable array and a per-process set [SPEC/2026-05/rag-agent-integration/F02-collection-tools/01-analysis-r3.md](SPEC/2026-05/rag-agent-integration/F02-collection-tools/01-analysis-r3.md#L271-L274). These are smaller than the findings above, but they undercut the internal-consistency claim.

## Required Changes

1. Correct the authorization section against the actual name-only filters, especially the deny-list `worker` filter. Specify the exact edits that keep `rag_register`, `rag_ingest`, `rag_drop`, and `rag_admin` unavailable to all current agent roles until F03 adds the Librarian filter.

2. Redesign `rag_register` initial ingest and `rag_ingest` around full-snapshot `fs` semantics. The next version must either restrict F02-managed collections to one source root, require full-collection ingests, or provide another fixed-API-safe way to avoid deleting previously indexed roots.

3. Fix the `delete_record`/file-deletion decision. Keep `delete_record` out, but do not claim `rag_admin reconcile` deletes a removed file unless the current public reconcile path really triggers the required full snapshot purge; otherwise document `rag_ingest` over the root as the explicit deletion convergence path.

4. Resolve disabled-RAG behavior: either register the `rag` service as available and have every handler return `RAG_DISABLED`, or hide the service and remove the stable-envelope claim.

5. Reconcile watcher flood/ENOSPC logging with the no-public-RAG-API-change constraint. Remove unsupported `watcherLogger` wiring, or explicitly identify the required RAG API change and explain why the hard constraint is being changed.

6. Make the bootstrap/service construction exact: define the mutable dataset array once, pass the same object to `createRagManager`, include `enabled`, remove unsupported options, and distinguish the runtime array from any registered-id set.

7. Clarify watch defaults and error mapping. `watch` omission must normalize to false, arming should happen only for `true` or polling config, and `RAG_WATCH_DISABLED` should be produced by explicit handler checks.

8. Clean up remaining schema/result inconsistencies: protected-source validation versus schema rejection, singular versus multi-source `initialIngestReport`, naming of `dynamicDatasets`, and any file/test inventory implications from the fixes above.

VERDICT: CHANGES_REQUESTED