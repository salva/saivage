# F03 Librarian Agent Functional Analysis Review

## Findings

The analysis is close to an implementable direction. It correctly rejects a `Handoff` envelope, supervisor queue, dispatcher auto-routing, scheduler behavior, source-file mutation, protected skill/memory dataset writes through F02, and plan-stage mutation. It also uses the right F02 tool names in most places and gives a concrete bounded role shape, prompt outline, knowledge integration story, and operator-conflict section.

It is not ready to approve because a few remaining points would still send implementation into incomplete or contradictory seams.

### 1. Dispatch wiring is still incomplete

The dispatch facts are directionally right but overstate how much the roster alone provides. [src/runtime/dispatcher.ts](src/runtime/dispatcher.ts) derives `DISPATCH_ROLE_MAP` from [src/agents/roster.ts](src/agents/roster.ts), but [src/agents/base.ts](src/agents/base.ts) still has explicit dispatch tool schemas in `DISPATCH_SCHEMA_BY_TOOL`, and [src/server/bootstrap.ts](src/server/bootstrap.ts) still instantiates child agents through a `switch (role)` with explicit cases. The analysis says the bootstrap child-spawner reads the roster to decide which class to instantiate, which is false for the current code.

That makes the file/action list incomplete. A non-worker Librarian reachable through `run_librarian` needs either a new `src/agents/librarian.ts` plus a bootstrap case and a `run_librarian` schema in [src/agents/base.ts](src/agents/base.ts), or a deliberate small refactor that makes non-worker dispatch schema and construction truly roster-derived. Without one of those, the proposed roster entry compiles the role union but does not create a runnable agent.

This also affects chat. [prompts/chat.md](prompts/chat.md) currently says Chat relays actionable work to the Planner through `create_note` and does not dispatch workers or inspectors. If the Librarian is dispatchable by `chat`, the analysis must call out the caller-prompt update that makes direct `run_librarian` dispatch an explicit exception for RAG collection questions/admin requests.

### 2. The whitelist is mostly exact, but one grant breaks the role boundary

The exact F02 tool names now match the peer analysis: `rag_list`, `rag_stats`, `rag_query`, `rag_add`, `rag_ingest`, `rag_register`, `rag_drop`, and `rag_admin`. The file and knowledge tool names are also corrected: `read_file`, `list_dir`, `search_files`, `read_skill`, `get_memory`, etc.

The remaining problem is `create_note`. [src/mcp/notes-server.ts](src/mcp/notes-server.ts) creates Planner notes, not operator notes. Granting it to the Librarian gives the role a second planning influence channel even though the analysis correctly says the caller decides whether to schedule follow-up stages or surface recommendations. The bounded architecture is cleaner if the Librarian returns a report and the Planner/Manager/Chat caller decides what to do. Remove `create_note` from the Librarian whitelist unless the analysis adds a very explicit, non-plan-mutating use case and reconciles it with Planner-owned mutation.

There is also a small internal contradiction in the whitelist prose: it says “Knowledge reads (no writes — Librarian's writes go via memory create only)” while granting both `create_memory` and `update_memory`. That should be made precise: read/list/search for skills and memories; create/update memory only for the named project-scope RAG policy/incident records; no skill writes and no memory supersede/archive/delete.

### 3. Failure handling omits several F02 error codes

The decision table covers the main operator-facing incidents, including drift, corrupted stores, lock contention, watcher failures, and secret drops. It still does not cover the full F02 error vocabulary. The F02 analysis defines `RAG_PROTECTED_SOURCE`, `RAG_UNAUTHORIZED_OPERATOR`, and `RAG_INTERNAL` in addition to the codes listed here.

`RAG_PROTECTED_SOURCE` is particularly relevant because the Librarian has a responsibility to refuse registration with `source: "skill" | "memory"`. The response should be distinct from `RAG_PROTECTED_DATASET`: protected source is a bad registration request, while protected dataset is a mutation attempt against an existing protected collection. `RAG_UNAUTHORIZED_OPERATOR` and `RAG_INTERNAL` should also have bounded responses, even if they are “report and stop; do not retry.”

### 4. Operator-conflict handling overclaims what RAG tools expose

The manual `saivage.json` conflict section still blurs on-disk config and live manager state. F02 says discovery is through `rag_list`, and the manager is built from configured datasets; `rag_list` and `rag_stats` expose the live manager view, not necessarily the operator's just-edited on-disk `config.rag.datasets`. If the operator edits `.saivage/saivage.json` while the process is already running, the Librarian cannot honestly claim to have read “current config” through `rag_list` alone.

This matters because the workspace rules treat provider/auth-bearing config as sensitive. The analysis should choose a safe source of truth: an operator-supplied report, a future safe config-inspection helper, or the live manager view after restart/reload. It should then say when the Librarian updates `topic.domain = "rag"` policy memory and when it merely reports that the live manager view may be stale.

### 5. Knowledge schema and permission row need exact matrix wording

The analysis correctly identifies that [src/knowledge/types.ts](src/knowledge/types.ts) has a separate `KnowledgeAgentRoleSchema` and that [src/knowledge/permissions.ts](src/knowledge/permissions.ts) needs a new row. The permission description should be rewritten as explicit matrix entries rather than prose that can be read two ways.

The intended row appears to be: `create-memory` and `update-memory` = `Y`; `read-skill`, `read-memory`, `list-skill`, `list-memory`, `search-skill`, `search-memory` = `Y`; all skill writes and all supersede/archive/delete operations = `-`. If memory writes are limited to project-scope RAG policy and incident records only by prompt convention, say so plainly because the current permission helper gates by role/op/kind/scope, not by memory topic.

The memory record shape should also state whether these policy/incident memories are targeted to `librarian` in `target_agents`, globally visible with `target_agents: []`, and whether they set `survive_compaction`. That is needed for consistency with the knowledge schema and F01's sidecar/eager-loading behavior.

### 6. The file list and tests do not yet match the implementation surface

The file table lists prompt keys, prompt loader, roster, tool filters, knowledge schema, permissions, tests, and docs. It needs the dispatch/instantiation files named above if `run_librarian` is a real dispatch path: [src/agents/base.ts](src/agents/base.ts), [src/server/bootstrap.ts](src/server/bootstrap.ts), and a Librarian agent implementation file. It should also include caller prompt updates for Planner/Manager/Chat when those roles are expected to use `run_librarian` deliberately.

The test list should cover those same seams: roster/accessor parity, tool-filter membership and exclusions, prompt round-trip, BaseAgent dispatch schema exposure for `run_librarian`, child-spawner construction, dispatch from Planner/Manager/Chat if all three are granted, and representative F02 error handling with mocked RAG tools.

### 7. Style is mostly compliant

The document is self-contained and does not refer to the review process. Existing source links are repo-root-relative under the `saivage` repo and the concrete tool names are now stable. Once the content issues above are fixed, style should not block approval.

## Required Changes Before Approval

1. Correct the dispatch implementation facts and file list: BaseAgent dispatch schema exposure and bootstrap child-spawner construction are not fully roster-derived today. Specify the `run_librarian` schema, the Librarian agent implementation, the bootstrap case, or a deliberate small refactor that makes those seams roster-derived.
2. Reconcile chat dispatch with the current Chat prompt. If `chat` can call `run_librarian`, update the analysis to require caller-prompt changes that define when direct Librarian dispatch is allowed instead of Planner notes.
3. Remove `create_note` from the Librarian tool whitelist, or justify it as a bounded non-plan-mutating exception. Prefer final reports to the caller so Planner remains the only plan-mutation authority.
4. Make the knowledge whitelist and permission row exact: memory create/update only, skill/memory read/list/search, no skill writes, no supersede/archive/delete. State the topic/scope/targeting conventions for policy, drift, and secret-incident memories.
5. Complete the F02 error decision tree with `RAG_PROTECTED_SOURCE`, `RAG_UNAUTHORIZED_OPERATOR`, and `RAG_INTERNAL`, and distinguish protected-source registration refusal from protected-dataset mutation refusal.
6. Fix operator-conflict handling so `rag_list`/`rag_stats` are described as live manager views, not direct reads of on-disk `config.rag.datasets`. Define a safe source of truth for manual `saivage.json` edits before the Librarian updates policy memory.
7. Expand validation coverage to include dispatch schema exposure, child-spawner construction, caller dispatch from each granted parent role, whitelist exclusions including `create_note`/plan tools/shell/write_file, and representative RAG error responses.

VERDICT: CHANGES_REQUESTED