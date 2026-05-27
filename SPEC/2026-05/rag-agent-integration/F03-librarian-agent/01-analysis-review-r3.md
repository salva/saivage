# Review - F03 Librarian Agent Functional Analysis r3

The analysis is close and gets the central architecture right: one bounded non-worker Librarian role, no scheduler, no dispatcher autorouting, no Chat dispatch, no plan mutation, and no new runtime path beyond roster/schema/bootstrap wiring. It also correctly identifies the manual dispatch schema requirement in [src/agents/base.ts](src/agents/base.ts#L1121), the exhaustive bootstrap switch in [src/server/bootstrap.ts](src/server/bootstrap.ts#L336), the fact that conventions are warning checks rather than prompt injection in [src/agents/conventions.ts](src/agents/conventions.ts#L21), and Chat's `create_note` relay boundary in [prompts/chat.md](prompts/chat.md#L14).

## Findings

1. **Blocking - the knowledge ACL design claims enforcement the current ACL cannot provide.**
   The reviewed document specifies project-only Librarian memory writes in [SPEC/2026-05/rag-agent-integration/F03-librarian-agent/01-analysis-r3.md](SPEC/2026-05/rag-agent-integration/F03-librarian-agent/01-analysis-r3.md#L228-L244) and later says ACL enforces project scope. Current permissions are not scope-matrix permissions: `AccessCell` is only `"Y" | "Y†" | "-"` in [src/knowledge/permissions.ts](src/knowledge/permissions.ts#L29), `canCall` gates only `(role, op, kind)` in [src/knowledge/permissions.ts](src/knowledge/permissions.ts#L242), and `checkScope` only enforces the existing worker `Y†` rule in [src/knowledge/permissions.ts](src/knowledge/permissions.ts#L260). A simple `librarian` row with `create-memory: "Y"` / `update-memory: "Y"` would allow stage/session creates if the model violates the prompt, and [src/mcp/knowledgeMemory.ts](src/mcp/knowledgeMemory.ts#L216) currently does not perform any scope check for `update_memory` before applying the update. This also weakens the promised topic restriction (`domain="rag"`, allowed subjects) because the document assigns it to prompt behavior only. The analysis must specify concrete enforcement: either extend the permission/scope model for project-only Librarian memory writes and handler-side topic guards, or explicitly downgrade these to prompt-only behavior and justify that weaker architecture. For this role's write access, prompt-only is not architecture-first enough.

2. **High - secret-incident memories require affected paths that the Librarian cannot actually observe.**
   The analysis says that when `rag_ingest` reports `chunksDroppedSecrets > 0`, the Librarian records affected paths or a path-glob summary. The actual `IngestReport` only exposes aggregate counters, including `chunksDroppedSecrets`, in [src/rag/types.ts](src/rag/types.ts#L150-L156). F02 says affected paths are written to operator logs in [SPEC/2026-05/rag-agent-integration/F02-collection-tools/01-analysis-r3.md](SPEC/2026-05/rag-agent-integration/F02-collection-tools/01-analysis-r3.md#L468-L470), but the F03 whitelist does not grant a log-reading tool. The report contract should not require unavailable path data. It should either record only counts plus collection/source pattern context available from the call, require the operator/Planner to provide log excerpts in `context`, or explicitly require F02 to add a secret-safe path summary to the `rag_ingest` result.

3. **Medium - the per-error decision tree omits one F02 error code.**
   F02's error table includes `RAG_SECRET_DROPPED` as a reserved code in [SPEC/2026-05/rag-agent-integration/F02-collection-tools/01-analysis-r3.md](SPEC/2026-05/rag-agent-integration/F02-collection-tools/01-analysis-r3.md#L369). The F03 decision tree handles `chunksDroppedSecrets > 0`, but it does not name the reserved code even though the section claims to map every F02 error. Add an explicit row saying it is currently reserved/not emitted and, if surfaced in the future, should be handled as a secret incident with secret-safe count/path-summary reporting only.

4. **Medium - dispatch coverage does not close the topic's retrieval-miss fallback path.**
   The document correctly rejects supervisor routing, dispatcher heuristics, and Chat direct dispatch, but the topic also asks how other agents reach the Librarian as a fallback when their own retrieval returns nothing. With the proposed roster entry, only Planner and Manager can call `run_librarian`. The analysis should explicitly state the accepted path for workers and other agents: for example, workers report the retrieval gap in their TaskReport/escalation and the Manager decides whether to dispatch the Librarian, while Chat relays operator requests to Planner through `create_note`. Without that sentence, the dispatch choice is architecturally sound but incomplete against the requested comparison.

## Required Changes

1. Correct the knowledge permission section so project-scope and topic-scope Librarian memory writes are enforceable in the actual ACL/handler architecture, or explicitly mark them as prompt-only and justify the residual risk. Include the `update_memory` existing-record scope case.

2. Fix secret-safe incident reporting so it only promises data the Librarian can observe, or add an explicit dependency on F02 exposing a secret-safe path summary in the ingest result.

3. Add a decision-tree entry for reserved `RAG_SECRET_DROPPED` and relate it to the existing `chunksDroppedSecrets > 0` handling.

4. Add the explicit retrieval-miss fallback path for non-Planner/Manager agents while preserving the no-autorouting and Chat-denied-dispatch decisions.

VERDICT: CHANGES_REQUESTED