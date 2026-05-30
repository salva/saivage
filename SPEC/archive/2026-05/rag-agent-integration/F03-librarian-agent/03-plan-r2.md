# F03 — Implementation Plan

Implementation order honours `F02 → F01 → F03`. F03 begins after
F01 and F02 have merged. Each batch ends with a validation step
run from `/home/salva/g/ml/saivage` with
`export PATH=~/.local/node-24/bin:$PATH`. Refers to the approved
design at
[02-design-r5.md](saivage/SPEC/2026-05/rag-agent-integration/F03-librarian-agent/02-design-r5.md).

## Batches

### B01 — Role type and prompt-key plumbing

Scope:
- Add `"librarian"` to `KnowledgeAgentRoleSchema` in `src/knowledge/types.ts`.
- Add `"librarian"` to `ToolFilterKind` in `src/agents/roster.ts` and to `RolePromptName` in `src/agents/prompt-keys.ts`.
- Add `librarian` entries to `PROMPT_KEY_TO_ROLE` and `ROLE_PROMPT_NAMES` in `src/agents/prompts.ts`.
- Create `prompts/librarian.md` with the role prompt from analysis §7.

Validation:
```bash
npm run typecheck \
  && npx eslint src/knowledge/types.ts src/agents/roster.ts src/agents/prompt-keys.ts src/agents/prompts.ts \
  && npm test -- agents/prompts knowledge/types
```

Commit: `F03(B01): librarian role type + prompt key`.

### B02 — Roster + tool filter + dispatch schema

Scope:
- Add the full `librarian` `RosterEntry` to `ROSTER` in `src/agents/roster.ts` per design §A.3 (dispatchTool `"run_librarian"`, dispatchableBy `["planner", "manager"]`, abortPriority 8, selfCheckFrequency 20, convention writeTerritory `[".saivage/memory/project/"]`, workerInit null).
- Define the **exact** `LIBRARIAN_TOOLS` allow-list in `src/agents/tool-filters.ts`:
  - `rag_list, rag_stats, rag_query, rag_register, rag_ingest, rag_drop, rag_admin`
  - `read_file, list_dir, search_files`
  - `list_skills, read_skill, search_skills`
  - `list_memories, get_memory, search_memories, create_memory, update_memory`
  - `read_stash`
  No prefix wildcards; deny-list everything else.
- Add `TOOL_FILTERS.librarian` to the typed `Record<ToolFilterKind, ...>`.
- Add `RUN_LIBRARIAN_SCHEMA` to `DISPATCH_SCHEMA_BY_TOOL` in `src/agents/base.ts`.
- Tests:
  - Roster membership; `getDispatchToolsFor("planner")` and `getDispatchToolsFor("manager")` expose `run_librarian`; `getDispatchToolsFor("chat")` does not.
  - Tool-filter allow-list matches the enumeration above byte-for-byte.
  - Deny tests for representative forbidden tools: `create_note, archive_memory, delete_memory, supersede_memory, create_skill, archive_skill, delete_skill, run_command, run_coder, run_manager, run_inspector, web_search, write_file`.

Validation:
```bash
npm run typecheck \
  && npx eslint src/agents/roster.ts src/agents/tool-filters.ts src/agents/base.ts \
  && npm test -- agents/roster agents/tool-filters agents/base
```

Commit: `F03(B02): librarian roster + tool filter + dispatch schema`.

### B03 — LibrarianAgent class

Scope:
- Create `src/agents/librarian.ts` mirroring `InspectorAgent` pattern (constructor, `static async create`, `run()` calling `runLoop()`).
- Define `LibrarianInput`; `buildLibrarianMessage` formats the initial message from `objective` + optional `collection_id` + optional `context`.
- Tests: `LibrarianAgent.create` builds eager block and initial message; `run()` success / abort / failure paths return correct `AgentResult` kinds.

Validation:
```bash
npm run typecheck \
  && npx eslint src/agents/librarian.ts \
  && npm test -- agents/librarian
```

Commit: `F03(B03): LibrarianAgent class`.

### B04 — Permissions ACL row + topic guard + update_memory preflight

Scope:
- In `src/knowledge/permissions.ts`, add the **full** Librarian ACL row to the permissions matrix per analysis §5:
  - `read-skill`, `list-skill`, `search-skill`: `Y`
  - `read-memory`, `list-memory`, `search-memory`: `Y`
  - `create-memory`, `update-memory`: `Y†`
  - every other operation: `-`
- Insert the Librarian branch in `checkScope` immediately after the non-`Y†` early return:
  ```ts
  if (role === "librarian") {
    if (scope === "project") return { ok: true };
    return { ok: false, code: "UNAUTHORIZED_SCOPE",
             reason: `role=librarian may only write memory with scope='project', got '${scope}'` };
  }
  ```
- In `src/mcp/knowledgeMemory.ts` `create_memory` and `update_memory` handlers, add the topic guard rejecting non-`rag` topics or non-allowlisted subjects (`policy | secret-incidents | drift-incidents`) when `ctx.role === "librarian"`.
- In `update_memory`, add the preflight per design §A.5: read `prior = getMemory(saivageDir(ctx.projectRoot), { id })`, run `checkScope(role, "update", "memory", prior.scope, prior.scope_ref, ctx)` and throw on failure; for Librarian, also `enforceLibrarianTopic(prior)`.
- Tests:
  - ACL: Librarian read/list/search cells return `Y` (canCall true); write cells outside memory create/update return `false`; create/update memory at project scope allowed; non-project scope denied.
  - Topic guard: allowed subjects on create_memory and update_memory; non-`rag` domain rejected; non-allowlisted subject rejected.
  - update_memory preflight closes the pre-existing gap for **all** `Y†` update roles (regression test for coder/researcher).
  - Non-Librarian roles continue to pass existing permissions tests.

Validation:
```bash
npm run typecheck \
  && npx eslint src/knowledge/permissions.ts src/mcp/knowledgeMemory.ts \
  && npm test -- knowledge/permissions mcp/knowledgeMemory
```

Commit: `F03(B04): full librarian ACL row + topic guard + update_memory preflight`.

### B05 — Bootstrap wiring

Scope:
- In `src/server/bootstrap.ts`, add `case "librarian": ragService.adminRoles.add("librarian"); return LibrarianAgent.create(ctx, input as LibrarianInput);` before `assertExhaustive`.
- Tests:
  - Bootstrap smoke: Planner dispatches `run_librarian`, the returned agent has role `"librarian"`, eager block is populated, `ragService.adminRoles` contains `"librarian"`.
  - Manager dispatches `run_librarian` succeeds.
  - Chat attempt fails with the unauthorized dispatch error from the dispatcher.

Validation:
```bash
npm run typecheck \
  && npx eslint src/server/bootstrap.ts \
  && npm test -- server/bootstrap
```

Commit: `F03(B05): librarian bootstrap case`.

### B06 — Manager retrieval-miss routing prompt

Scope:
- Patch `prompts/manager.md` per design §A.7 with the retrieval-miss routing rule (required `objective`, optional `collection_id`, optional `context`).
- Regression test: render the Manager prompt and assert it mentions `run_librarian`, `objective`, and the `"rag retrieval miss:"` marker.

Validation:
```bash
npm run typecheck \
  && npm test -- agents/manager prompts
```

Commit: `F03(B06): manager retrieval-miss routing rule`.

### B07 — Behaviour suite + e2e + full validation

Scope:
- Behaviour tests in `src/agents/librarian.behaviour.test.ts` with mocked F02 tools covering the decision tree:
  - **drift confirmation gate**: drift detected via `rag_stats` → Librarian asks for confirmation before destructive recovery.
  - **secret-incident memory payload**: writes a memory with body containing exactly `{count, collection_id, context}`; no `lastIngestAt` or path lists.
  - **protected-dataset redirect**: query routed to the protected dataset is redirected to `search_skills` / `search_memories`.
  - **no-hit fallback**: empty `rag_query` result triggers the documented fallback action.
- E2E in `src/agents/librarian.e2e.test.ts`: bootstrap temp project with F02 + F01 fixtures; Planner dispatches `run_librarian`; Librarian calls `rag_list` + `rag_stats` + `search_memories`; writes a `rag/policy` project memory; Manager picks up a `"rag retrieval miss:"` issue and dispatches `run_librarian`.
- Full repo validation:

```bash
npm run typecheck \
  && npm test \
  && npx eslint src/agents/ src/knowledge/ src/mcp/knowledgeMemory.ts src/server/bootstrap.ts
```

Commit: `F03(B07): behaviour suite + e2e + full validation`.

## Risks

- `update_memory` preflight surfaces scope failures for non-Librarian roles previously silent; release notes flag the behaviour change.
- Manager prompt regression test must not be brittle to prompt wording drift; assert on the three named tokens (`run_librarian`, `objective`, `rag retrieval miss:`) only.
- Behaviour suite uses mocked F02 tools; the e2e covers real wiring.
