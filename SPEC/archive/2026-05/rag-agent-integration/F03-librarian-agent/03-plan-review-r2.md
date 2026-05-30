# F03 — Implementation Plan Review r2

Reviewed plan: `03-plan-r2.md`  
Approved design: `02-design-r5.md`  
Source checked under: `src/`

## Summary

R2 addresses the four issues raised in the r1 review and is consistent with the approved design and current source shapes. The plan now specifies the full Librarian ACL row, uses an exact bounded RAG tool allow-list, adds explicit dispatch coverage for Planner/Manager allow plus Chat deny, and expands B07 with the approved Librarian behaviour suite.

## Findings

No blocking or major findings.

## Verification

- B04 now requires the full Librarian ACL row: skill read/list/search `Y`, memory read/list/search `Y`, memory create/update `Y†`, and every other operation denied. This matches the approved design's ACL requirements and the existing matrix/checkScope split in `src/knowledge/permissions.ts`.
- B02 now enumerates the exact `LIBRARIAN_TOOLS` list, including only `rag_list`, `rag_stats`, `rag_query`, `rag_register`, `rag_ingest`, `rag_drop`, and `rag_admin` for RAG tools. It explicitly forbids prefix wildcards and includes representative deny tests for knowledge writes, skill writes, dispatch, command, web, and file-write surfaces.
- Dispatch validation now covers the required roster path: `getDispatchToolsFor("planner")` and `getDispatchToolsFor("manager")` expose `run_librarian`, while `getDispatchToolsFor("chat")` does not. B05 also retains bootstrap behavior checks, including Manager dispatch success and Chat unauthorized behavior.
- B07 now adds the required behaviour suite for the drift confirmation gate, secret-incident memory payload, protected-dataset redirect, and no-hit fallback. The e2e remains as broader wiring coverage rather than substituting for these decision-tree tests.

## Residual Risk

F03 still correctly depends on F02 and F01 landing first; the current source does not yet expose the F02 `RagService`/`adminRoles` runtime shape, and the plan states that prerequisite clearly. No additional plan changes are required.

VERDICT: APPROVE