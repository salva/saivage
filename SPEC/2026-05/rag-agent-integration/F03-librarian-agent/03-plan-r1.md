# F03 — Implementation Plan

Implementation order honours `F02 → F01 → F03`. F03 begins after
F01 and F02 have merged. Each batch ends with a validation step
run from `/home/salva/g/ml/saivage` with
`export PATH=~/.local/node-24/bin:$PATH`. Plan refers to the
approved design at
[02-design-r5.md](saivage/SPEC/2026-05/rag-agent-integration/F03-librarian-agent/02-design-r5.md).

## Batches

### B01 — Role type and prompt-key plumbing

Scope:
- Add `"librarian"` to `KnowledgeAgentRoleSchema` in `src/knowledge/types.ts`.
- Add `"librarian"` to `ToolFilterKind` and `RolePromptName` in `src/agents/roster.ts` / `src/agents/prompt-keys.ts`.
- Add the Librarian entries to `PROMPT_KEY_TO_ROLE` and `ROLE_PROMPT_NAMES` in `src/agents/prompts.ts`.
- Create `prompts/librarian.md` with the role prompt from analysis §7.

Validation:
```bash
npm run typecheck && npx eslint src/knowledge/types.ts src/agents/ && npm test -- agents/prompts knowledge/types
```

Commit: `F03(B01): librarian role type + prompt key`.

### B02 — Roster + tool filter

Scope:
- Add the full `RosterEntry` for `librarian` to `ROSTER` in `src/agents/roster.ts` per design §A.3 (dispatchTool `"run_librarian"`, dispatchableBy `["planner", "manager"]`, abortPriority 8, selfCheckFrequency 20, convention writeTerritory `[".saivage/memory/project/"]`, workerInit null).
- Define `LIBRARIAN_TOOLS` and add `TOOL_FILTERS.librarian` in `src/agents/tool-filters.ts` per analysis §3.2 (allow knowledge reads + create_memory + update_memory + all rag_*; deny everything else).
- Add `RUN_LIBRARIAN_SCHEMA` and wire into `DISPATCH_SCHEMA_BY_TOOL` in `src/agents/base.ts`.
- Add unit tests for roster membership, tool-filter contents, and dispatch schema.

Validation:
```bash
npm run typecheck && npx eslint src/agents/ && npm test -- agents/roster agents/tool-filters agents/base
```

Commit: `F03(B02): librarian roster + tool filter + dispatch schema`.

### B03 — LibrarianAgent class

Scope:
- Create `src/agents/librarian.ts` mirroring Inspector pattern (constructor, `static async create`, `run()` calling `runLoop()`).
- Define `LibrarianInput`; `buildLibrarianMessage` formats the initial message from `objective`, optional `collection_id`, optional `context`.
- Unit tests: factory builds eager block; run() success/abort/failure paths return correct `AgentResult` kinds.

Validation:
```bash
npm run typecheck && npx eslint src/agents/librarian.ts && npm test -- agents/librarian
```

Commit: `F03(B03): LibrarianAgent class`.

### B04 — Permissions ACL + update_memory preflight

Scope:
- Add the Librarian `Y†` ACL row in `src/knowledge/permissions.ts` (create_memory and update_memory only).
- Insert the Librarian branch in `checkScope` (before the existing worker-stage Y† branch): `if (role === "librarian") { if (scope === "project") return { ok: true }; return { ok: false, code: "UNAUTHORIZED_SCOPE", reason: ... }; }`.
- In `src/mcp/knowledgeMemory.ts` `update_memory` handler, add the preflight per design §A.5: read `prior = getMemory(saivageRoot, { id })`, run `checkScope(role, "update", "memory", prior.scope, prior.scope_ref, ctx)`, throw on failure, then run `enforceLibrarianTopic(prior)` when role === "librarian".
- In both `create_memory` and `update_memory`, add the topic guard rejecting non-`rag` topics or non-allowlisted subjects for Librarian.
- Unit tests: Librarian project-scope allowed; non-project scope denied; topic enforcement; non-Librarian roles still work; update_memory scope preflight catches the pre-existing gap.

Validation:
```bash
npm run typecheck && npx eslint src/knowledge/permissions.ts src/mcp/knowledgeMemory.ts && npm test -- knowledge/permissions mcp/knowledgeMemory
```

Commit: `F03(B04): librarian ACL + update_memory preflight`.

### B05 — Bootstrap wiring

Scope:
- In `src/server/bootstrap.ts`, add `case "librarian": ragService.adminRoles.add("librarian"); return LibrarianAgent.create(ctx, input as LibrarianInput);` before `assertExhaustive`.
- Smoke test: Planner dispatches `run_librarian` and the constructed agent has expected role, eager block, and adminRoles updated.

Validation:
```bash
npm run typecheck && npx eslint src/server/bootstrap.ts && npm test -- server/bootstrap
```

Commit: `F03(B05): librarian bootstrap case`.

### B06 — Manager retrieval-miss routing prompt

Scope:
- Patch `prompts/manager.md` per design §A.7 with the retrieval-miss routing rule.
- Regression test: render Manager prompt with a sample TaskReport containing the marker and assert it mentions `run_librarian` and `objective`.

Validation:
```bash
npm run typecheck && npm test -- agents/manager prompts
```

Commit: `F03(B06): manager retrieval-miss routing rule`.

### B07 — E2E + full validation

Scope:
- E2E test in `src/agents/librarian.e2e.test.ts`: bootstrap temp project with F02 + F01; Planner dispatches `run_librarian`; Librarian calls `rag_list` + `rag_stats` + `search_memories`; writes a `rag/policy` project memory; Manager picks up a `"rag retrieval miss:"` issue and dispatches `run_librarian`.
- Full repo validation:

```bash
npm run typecheck && npm test && npx eslint src/agents/ src/knowledge/ src/mcp/knowledgeMemory.ts src/server/bootstrap.ts
```

Commit: `F03(B07): e2e + full validation`.

## Risks

- `update_memory` preflight surfaces scope failures for non-Librarian roles previously silent; release notes flag the behaviour change.
- Manager prompt regression test must not be brittle against prompt wording drift.
