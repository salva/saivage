# F03 Librarian Agent R5 Review

Reviewed `/home/salva/g/ml/saivage/SPEC/2026-05/rag-agent-integration/F03-librarian-agent/01-analysis-r5.md` against the current `/home/salva/g/ml/saivage` source, with focus on roster, dispatch, tool filters, knowledge ACLs, memory handlers, RAG/task report types, and built-in MCP tool registration.

## Confirmed Matches

- F02 is explicit as a hard prerequisite. The current source has no `rag_list`, `rag_stats`, `rag_query`, `rag_register`, `rag_ingest`, `rag_drop`, or `rag_admin` registrations, so the Librarian whitelist necessarily depends on F02 registering that surface before F03 is usable.
- The non-RAG whitelist entries are real source tool names: `read_file`, `list_dir`, `search_files`, `list_skills`, `read_skill`, `search_skills`, `list_memories`, `get_memory`, `search_memories`, `create_memory`, `update_memory`, and the synthetic `read_stash`.
- The proposed ACL approach uses the existing `Y†` path, places the Librarian branch before the existing worker-stage branch, and reuses `UNAUTHORIZED_SCOPE` rather than inventing a new ACL error code.
- The `create_memory` topic guard validates `topic.domain === "rag"` and restricts `topic.subject` to the allowed set, using `KnowledgeStoreError("UNAUTHORIZED_ROLE", ...)` as requested.
- The `update_memory` preflight reads the existing memory, applies `gateScope` to `existing.scope` / `existing.scope_ref`, validates `existing.topic` for Librarian, and explicitly closes the existing update-scope gap.
- The roster territory points at the real `.saivage/memory/project/` tree, not the nonexistent `.saivage/knowledge/memory/` path.
- `IngestReport` in source contains aggregate counters only and no path-level secret data.

## Required Changes

1. Correct the TaskReport / Issue shape in sections 1.8 and 3.4. The source `TaskReportSchema` has `files_modified`, `files_created`, `tests_added`, `tests_run`, `commits`, and `issues_found`; it does not have `files_changed` or a top-level `tests` field. More importantly, `IssueSchema` has required `severity` and `description` fields and no `kind` field, so the proposed fallback issue with `kind: "open_question"` is not source-shaped and omits required `severity`. Use a valid issue object such as `{ severity: "warning", description: "rag retrieval miss: ..." }`.

2. Correct the section 3.4 claim that the retrieval gap is an "existing channel parsed by Manager runtime" at `src/runtime/dispatcher.ts`. The dispatcher separates local and dispatch tools, spawns the child, and JSON-stringifies the child result back to the parent; it does not parse `TaskReport.issues_found` or deterministically trigger `run_librarian`. Either describe this as Manager prompt-level handling of child tool output, or specify a real runtime hook if deterministic auto-dispatch is intended.

3. Tighten the secret-incident memory payload in sections 1.7 and 8 to the stated contract: aggregate secret-drop count, `collection_id`, and caller/operator context only. The current draft also includes `lastIngestAt` from `rag_stats`; while that is not path-level secret data, it violates the explicit "only counts + collection_id + operator context" payload boundary requested for this review.

VERDICT: CHANGES_REQUESTED