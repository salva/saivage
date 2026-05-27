# F02 Collection Tools Analysis Review R6

Reviewed `01-analysis-r6.md` against the current Saivage source in `src/rag/`, `src/mcp/`, `src/agents/`, `src/runtime/`, `src/server/`, and `src/config.ts`.

Positive confirmations:

- The R6 analysis fixes the destructive snapshot-ingest issue: `rag_ingest` now takes only `collection_id`, reads `dataset.config.sources[0]`, and passes the configured `root`, `include`, and `exclude` to `manager.ingest`. This matches the source fact that `runIngest` treats the walked fs input as the complete seen set and purges prior `file_state` paths absent from that input.
- The analysis correctly moves symlink/realpath containment into private RAG internals instead of a handler-side post-walk. The handler cannot observe the `WalkedFile[]` consumed by `runIngest`, because `RagManager.ingest()` accepts only `IngestInput` and `Dataset.ingest()` delegates directly into `runIngest()`.
- The watcher deletion semantics are now source-aligned: `rag_ingest` is the manual/operator convergence path, live watcher `unlink` events also converge deletions by routing a full source-root fs ingest through `processBatch()`, and deletion-only `reconcile()` does not call ingest because the per-root loop filters only `changedPaths`.
- The operator bypass is now compile-grounded: it extends `ToolCallContext` explicitly with private `operatorContext?: boolean`, uses an `isRuntimeOperatorContext(ctx)` predicate, and states that the flag is set only by runtime context construction, never parsed from tool args.
- The service-construction dataset type is corrected with `RuntimeRagDatasetConfig = Omit<DatasetConfig, "projectId">`, matching both `RagManagerOptions.datasets` and the current config schema whose `rag.datasets` entries omit `projectId`.

Remaining source-level concerns:

- The analysis still contradicts the `assertInside` containment pattern in one handler-layer statement. The accepted source pattern is exact-or-contained: `rel === "" || (!rel.startsWith("..") && !rel.startsWith("/"))` in `src/mcp/builtins.ts`. R6 states that `rag_register` rejects when `path.relative(realpath(ctx.projectRoot), realpath(sources[0].root))` is empty, which would incorrectly reject using the project root itself as the dataset source root.
- The internal walker-hardening contract is inconsistent. R6 first says to skip any walked entry whose realpath escapes the configured root, then later says such an escape aborts ingest with `RAG_BLOCKED_PATH` propagated as a typed error class. The implementation needs one observable contract. If the contract is `RAG_BLOCKED_PATH`, the error must remain private/internal or service-local so F02 does not change the public RAG API or exported RAG signatures.

Required changes:

1. Fix the `rag_register` containment wording so `rel === ""` is accepted, matching the `assertInside` pattern; reject only `rel.startsWith("..")` or an absolute relative result.
2. Resolve the walker escape behavior to a single contract: either document silent skip and remove the promised ingest-time `RAG_BLOCKED_PATH`, or require a private/internal abort mapped by the RAG service to `RAG_BLOCKED_PATH` without exporting new public RAG API.

VERDICT: CHANGES_REQUESTED