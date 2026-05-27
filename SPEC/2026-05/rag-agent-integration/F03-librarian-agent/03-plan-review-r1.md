# F03 — Implementation Plan Review r1

Reviewed plan: `03-plan-r1.md`  
Approved design: `02-design-r5.md`  
Source checked under: `src/`

## Summary

The plan has the requested seven-batch sequence and every batch includes a concrete validation command. The ordering matches the requested spine:

1. B01 role types + prompt-key plumbing + prompt
2. B02 roster + tool filter + dispatch schema
3. B03 `LibrarianAgent`
4. B04 permissions + `update_memory` preflight + topic guard
5. B05 bootstrap case
6. B06 Manager retrieval-miss prompt rule
7. B07 e2e + full validation

However, the plan is not yet approvable because it under-specifies the Librarian ACL row and omits several approved design validation cases. Those gaps could produce an implementation that compiles and passes the listed batch validations while the Librarian cannot actually use approved read tools, or while dispatch/behavior constraints from the approved design remain untested.

## Findings

### 1. Blocking: B04 does not require the full Librarian ACL row

The approved design says the Librarian ACL row comes from analysis §5. That row grants not only `create-memory` and `update-memory` as `Y†`, but also read/list/search access for skills and memories:

- `read-skill`, `list-skill`, `search-skill`: `Y`
- `read-memory`, `list-memory`, `search-memory`: `Y`
- `create-memory`, `update-memory`: `Y†`
- every other operation: `-`

The current plan says in B04: “Add the Librarian `Y†` ACL row in `src/knowledge/permissions.ts` (create_memory and update_memory only).” That wording misses the required read/list/search grants. The B02 tool filter intentionally exposes knowledge reads, but the runtime handlers still call `canCall`; without the ACL grants, tools such as `list_memories`, `get_memory`, `search_memories`, `list_skills`, `read_skill`, and `search_skills` will be denied at runtime.

Required fix: revise B04 to specify the complete permissions row, including read/list/search cells, and add tests asserting the approved read cells as well as the denied write cells.

### 2. Blocking: B02 says “all rag_*” instead of the approved exact RAG allow-list

The approved design and analysis define a concrete Librarian tool allow-list:

- `rag_list`, `rag_stats`, `rag_query`
- `rag_register`, `rag_ingest`, `rag_drop`, `rag_admin`
- filesystem reads: `read_file`, `list_dir`, `search_files`
- skill reads: `list_skills`, `read_skill`, `search_skills`
- memory reads/writes: `list_memories`, `get_memory`, `search_memories`, `create_memory`, `update_memory`
- `read_stash`

B02 says to allow “all `rag_*`”. If implemented as a prefix check, this over-grants future or non-approved RAG tools. The approved design is explicit that the tool filter is an allow-list and that mutating surfaces outside the bounded set remain denied.

Required fix: make B02 enumerate the exact approved RAG tool names and require deny tests for representative forbidden tools, including `create_note`, `archive_memory`, `delete_memory`, `supersede_memory`, skill writes, `plan_*`, `run_command`, dispatch tools, and web tools.

### 3. Major: Dispatch validation omits Chat denial and direct Manager dispatch

The approved test strategy requires dispatch coverage for:

- Planner → `run_librarian` succeeds
- Manager → `run_librarian` succeeds
- Chat denied
- bootstrap case constructs `LibrarianAgent` and mutates `adminRoles`

B05 only names a Planner smoke test. B07 covers a Manager retrieval-miss route, but it does not clearly assert that Manager has the dispatch tool directly through the roster/schema path. Chat denial is not covered anywhere.

Required fix: add explicit tests, likely in B02 or B05, that `getDispatchToolsFor("planner")` and `getDispatchToolsFor("manager")` expose `run_librarian`, that Chat does not expose it, and that dispatcher/bootstrap behavior matches the design.

### 4. Major: Approved Librarian behavior branches are not validated

The approved design’s test strategy includes behavior tests with mocked F02 tools for:

- drift/corruption confirmation gate before destructive recovery
- secret-incident memory body containing only `count`, `collection_id`, and caller-supplied `context`
- protected-dataset redirect to knowledge search surfaces
- no-hit fallback behavior

The plan creates `prompts/librarian.md` in B01 and tests the class lifecycle in B03, but no batch requires these behavior tests. B07’s e2e checks basic dispatch and a `rag/policy` memory write, which is useful but does not cover the approved decision tree.

Required fix: add a behavior-test batch item, or expand B07, to validate the approved prompt/decision-tree contract with mocked RAG tools and memory writes.

## Dependency Check

The plan correctly states that F03 starts after F01 and F02 have merged. This is necessary: the current source tree has `src/rag/manager.ts` but no `RagService`, no `ragService.adminRoles`, and no registered `rag_*` MCP tools. B05 should restate that it depends on F02’s bootstrap/runtime injection of `ragService`; otherwise the listed bootstrap case cannot compile against the current source shape.

## Validation Check

Every batch has a concrete validation step. The commands are specific enough as batch gates, but the test content needs the additions above so that the commands prove the approved design rather than only proving the new files compile.

VERDICT: CHANGES_REQUESTED