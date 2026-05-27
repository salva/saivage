# F02 Collection Tools Analysis Review R7

Reviewed `01-analysis-r7.md` against the current Saivage source in `src/rag/`, `src/mcp/`, and `src/log.ts`, with a focused comparison to the R6 review findings.

Positive confirmations:

- The register-time containment fix is source-aligned. R7 now accepts `rel === ""`, matching the exact-root case already accepted by the `assertInside` pattern in `src/mcp/builtins.ts`, and rejects only parent/absolute escapes via `rel.startsWith("..")` or `path.isAbsolute(rel)`. This closes the R6 regression where using the project root itself as the dataset root would have been rejected.
- The walker symlink-escape contract is now internally consistent. R7 keeps the hardening in private RAG ingest internals where the current source actually walks files (`RagManager.ingest()` -> `Dataset.ingest()` -> `runIngest()` -> `walk()`), preserves the `WalkedFile` shape, and consistently states in §1.6, §4.4, §4.5, and §5 that per-entry symlink escapes are logged and skipped rather than surfaced as `RAG_BLOCKED_PATH`.
- The R6-to-R7 diff is limited to the two requested contract fixes. I did not find collateral changes to the one-root registration rule, no-caller-globs `rag_ingest`, protected dataset behavior, snapshot ingest semantics, or the existing non-goals.

Minor implementation note:

- R7's illustrative `log.warn("rag.walker.symlink-escape", { datasetId, path })` call shape does not match the current `src/log.ts` API, whose `warn` method accepts a single string. The implementation should either format the structured fields into that string or deliberately expand the logger API. This is a minor implementation-detail mismatch, not a blocker for the analysis contract.

VERDICT: APPROVE