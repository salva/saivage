# Phase C — Implementation Plan Review (round 1)

Status: REVIEW
Reviewer: GPT-5.5
Verdict: REVISE
Date: 2026-05-23

## Verdict

REVISE: the plan tracks the accepted design at a high level, but it is not yet implementation-safe because it assumes role-aware MCP calls, initialized knowledge trees, lifecycle hooks, and an HTTP tool-catalog endpoint that the current code does not provide.

## Blocking issues

1. **WI-04 / WI-06 / WI-07 / WI-14 / WI-17 — MCP authorization is not implementable with the current call path.**
   - **What's wrong:** The plan adds a permissions engine and asserts `UNAUTHORIZED_ROLE` / `UNAUTHORIZED_SCOPE` behavior, but the current MCP runtime and dispatcher do not pass role, agent id, stage id, session id, or author context into tool handlers. The files-touched lists omit the runtime/dispatcher/base-agent API changes required to make FR-6 and FR-31e(i) enforceable.
   - **Evidence:** [src/mcp/runtime.ts](../../../src/mcp/runtime.ts) defines `InProcessToolHandler` as `(toolName, args)` only and `callTool(serviceName, toolName, args)` has no caller context. [src/runtime/dispatcher.ts](../../../src/runtime/dispatcher.ts) finds a tool in the global catalog and calls `mcpRuntime.callTool(toolEntry.service, tc.name, args)` without role context. [src/agents/base.ts](../../../src/agents/base.ts) only filters the schemas advertised to the LLM; it is not an enforcement boundary, and its role filters do not expose the new memory write/read matrix anyway.
   - **Suggested correction:** Add an explicit `ToolCallContext` to the MCP runtime and dispatcher path, e.g. `{ role, agentId, stageId?, channelId?, projectRoot }`; pass `AgentContext` data from `Dispatcher.executeLocalTool`; update `InProcessToolHandler` and all in-process services or provide a context-aware wrapper; update [src/agents/base.ts](../../../src/agents/base.ts) role filters to advertise the final allowed tool set. Tests for FR-31e(i) should call through the role-aware runtime path and assert the permission layer, not downstream handler conventions.

2. **WI-06 / WI-07 — additive `knowledge.skills` and `knowledge.memory` services collide with the current flat tool namespace.**
   - **What's wrong:** The plan says the new services coexist with the old `skills` service before cutover, but the runtime exposes tools by flat tool name, not service-qualified name. Adding another service with `create_skill`, `list_skills`, etc. creates duplicate tool names in the agent catalog and ambiguous dispatch.
   - **Evidence:** [src/mcp/runtime.ts](../../../src/mcp/runtime.ts) `getAllTools()` pushes every available in-process tool as `{ ...tool, service }`; it does not namespace tool names or reject duplicates. [src/runtime/dispatcher.ts](../../../src/runtime/dispatcher.ts) selects `allTools.find(t => t.name === tc.name)`, so duplicate tool names route to whichever service appears first. [src/mcp/builtins.ts](../../../src/mcp/builtins.ts) already registers active `skills` tools and unavailable `memory` / `index` stubs.
   - **Suggested correction:** Do not expose duplicate final tool names in an additive milestone. Either keep the new services unavailable/test-only until WI-12, register them under non-agent-visible temporary tool names, or make WI-06/WI-07 replace the final `skills`/`memory` names under a local feature flag in one runtime-aware slice. The final service names should still be `skills` and `memory`.

3. **WI-03 / WI-12 / §6 / FR-1 / FR-21 / FR-23 — project initialization is missing from the plan.**
   - **What's wrong:** The plan assumes `saivage init` creates `.saivage/{skills,memory}/{project,stages,sessions}/...` and a per-scope `.gitignore`, but no WI touches project initialization or `ProjectContext` paths. This makes the cutover smoke step for empty trees and FR-21 unimplemented.
   - **Evidence:** [src/store/project.ts](../../../src/store/project.ts) currently creates a flat `.saivage/skills`, no `.saivage/memory`, no per-scope `index.json`, no `audit.jsonl`, and writes `.gitignore` as only `tmp/`. Its `ProjectContext.paths` also has `skills` but no memory path.
   - **Suggested correction:** Add a pre-cutover WI that modifies [src/store/project.ts](../../../src/store/project.ts) to create the accepted tree, seed `{ skills: [] }` / `{ memories: [], topic_map: {} }`, create empty `audit.jsonl`, preserve `tmp/` ignore behavior, and add `skills/sessions/` plus `memory/sessions/`. Add tests for fresh init and reload.

4. **WI-12 / WI-16 / FR-3 / FR-4 / FR-9 — stage/session archival hooks are cited but not implemented.**
   - **What's wrong:** The FR matrix claims stage hook wiring in WI-12, but WI-12's files-touched list does not include the code paths where stage completion or chat-session close actually happen. Session-scoped archival is also absent.
   - **Evidence:** Stage terminal transitions are handled around `plan_complete_stage` in [src/mcp/plan-server.ts](../../../src/mcp/plan-server.ts) and runtime tracking in [src/server/bootstrap.ts](../../../src/server/bootstrap.ts). Chat session close is handled in [src/agents/chat.ts](../../../src/agents/chat.ts). None of these files appears in the relevant WI files-touched lists for lifecycle archival.
   - **Suggested correction:** Add a WI before WI-12 for lifecycle hooks: archive active records in `.saivage/{skills,memory}/stages/<stage_id>/` after terminal stage completion, archive session records on chat channel close, and test both idempotence and non-injection in the next stage/session.

5. **WI-03 / WI-15 / FR-29 / FR-31g — per-record mutexes are insufficient for per-scope index integrity.**
   - **What's wrong:** The plan tests parallel `create_memory` index integrity, but the described locking only serializes writes to the same record id. Distinct creates in the same scope can race their `rebuildIndex` writes and leave a parseable but stale `index.json` that omits one record.
   - **Evidence:** The design and WI-03 key the mutex by `<kind>:<scope>:<scope_ref|_>:<id>` and say `create_*` keys on a fresh UUID, so distinct creates are uncontended. Each mutation still rebuilds the same scope-level `index.json`.
   - **Suggested correction:** Add a per-scope mutation/index mutex, or make the mutation transaction lock both the record key and a scope index key before audit/index writes. WI-03 acceptance should explicitly cover two distinct creates in the same scope and prove the final index contains both records.

6. **§6.2 — `/api/mcp/tools` is not a real smoke endpoint.**
   - **What's wrong:** The smoke command for the new tool surface curls `/api/mcp/tools`, but the server has no such route. This would 404 or fall through to the SPA, so Phase D would not verify MCP registration.
   - **Evidence:** [src/server/server.ts](../../../src/server/server.ts) registers `/health`, `/api/plan`, `/api/state`, `/api/agents/...`, `/api/config`, `/api/providers`, `/api/inspections`, `/api/notes`, `/api/chats`, `/api/files`, and `/api/debug/...`. A source search found no `/api/mcp`, `mcp/tools`, or tool-catalog route in [src/server/server.ts](../../../src/server/server.ts).
   - **Suggested correction:** Either add `GET /api/mcp/tools` in [src/server/server.ts](../../../src/server/server.ts) returning `runtime.mcpRuntime.getAllTools()` and include that file in a WI, or replace the smoke with an existing supported verification path, such as an in-container node/CLI probe that instantiates the runtime and prints `getAllTools()`.

7. **§6.1 — live cutover operations are not written as classic LXC operations.**
   - **What's wrong:** The runbook uses `ssh root@<host>` against container IPs, but the workspace/operator rules and the review focus require classic LXC host operations. The commands also use placeholders in a way that does not map cleanly to the three v2 containers.
   - **Evidence:** Workspace guidance requires `sudo lxc-ls --fancy`, `sudo lxc-info -n <container>`, and `sudo lxc-attach -n <container> -- <command>`. The three v2 deployments are the containers `saivage`, `saivage-v3`, and `diedrico`; the v3 GetRich v2 container is correctly excluded, but the runbook still frames the operation as SSH-to-IP.
   - **Suggested correction:** Rewrite §6 with a container table keyed by LXC name and project dir, e.g. `sudo lxc-attach -n saivage -- systemctl stop saivage.service`, `sudo lxc-attach -n saivage-v3 -- systemctl stop saivage.service`, and `sudo lxc-attach -n diedrico -- systemctl stop saivage.service`. Keep host-side health curls to the container IPs only after the service restart.

8. **WI-02 / WI-06 / WI-07 / WI-14 / WI-17 / FR-27 — read-side secret redaction is not planned or pinned.**
   - **What's wrong:** The design requires read-time scans and `[REDACTED]` responses from `read_skill`, `get_memory`, and `search_*`, but the implementation plan only tests scanner heuristics and write-time rejection.
   - **Evidence:** Design §C.3 says read tools and snippets re-scan bodies, substitute matches with `[REDACTED]`, and return `redacted_spans`. WI-02 only creates `scanForSecrets`; WI-03 covers write rejection; WI-06/WI-07 acceptance omits redaction on reads/search; WI-17 only pins create rejection for FR-31f.
   - **Suggested correction:** Add acceptance criteria and tests for redaction in `read_skill`, `get_memory`, `search_skills`, and `search_memories`, including corrupted-on-disk records that bypassed write-time scanning.

## Non-blocking issues

1. **§8 — rollback overstates what `git reset --hard` can safely do.**
   - **What's wrong:** The runbook treats `git reset --hard <pre-WI-12-sha>` as safe and says no records will be lost because there were none. That is true only before the new runtime writes any records and only for a clean implementation worktree.
   - **Evidence:** §8 itself acknowledges `.saivage/{skills,memory}/` may exist after new init and suggests deleting it. The design intentionally deletes old `.saivage/skills/` schema support and does not ship a migrator.
   - **Suggested correction:** Prefer `git revert WI-12` for code rollback after committed WIs; separate the code point of no return from the live-state point of no return, which is the first successful new-runtime write. Require preserving/restoring the pre-cutover state snapshot before any `rm -rf`.

2. **WI-14 / WI-03 — error taxonomy count is off by one.**
   - **What's wrong:** The plan repeatedly says "14 error codes," but Design §C.3 lists 15.
   - **Evidence:** The design list includes `UNAUTHORIZED_ROLE`, `UNAUTHORIZED_SCOPE`, `NOT_FOUND`, `EMPTY_REASON`, `INVALID_SCOPE_REF`, `INVALID_SUPERSEDE_TARGET`, `TOPIC_COLLISION`, `NAME_COLLISION`, `INVALID_SUPERSEDE_SCOPE`, `SECRET_DETECTED`, `BLOCKED_PATH`, `BODY_PATH_BROKEN`, `OVERSIZED_SURVIVOR`, `MALFORMED_AUDIT_LINE`, and `INDEX_REBUILD_FAILED`.
   - **Suggested correction:** Correct the count to 15 and require one assertion for each code, including the loader-only warning codes where applicable.

3. **WI-07 — the `BLOCKED_PATH` acceptance example does not match the memory schema.**
   - **What's wrong:** WI-07 says `source_ref` to `.env` should trigger `BLOCKED_PATH`, but `MemoryRecord.source_ref` in the design is `{ kind, id }`, not a file path.
   - **Evidence:** Design §B.1 defines `source_ref.kind` as `inspection | task_report | stage_summary` plus an `id`. Design §C.3 separately talks about blocked source paths.
   - **Suggested correction:** Either add an explicit `source_path` / evidence-path field to the schema and design, or change the WI-07 test to cover body/key/topic scanning and blocked skill `body_path` inputs.

4. **§4 / WI-12 — built-in skill paths are written inconsistently.**
   - **What's wrong:** The deletion catalogue and files-touched list use `saivage/skills/...` even though, from the repo root, the current files are under `skills/...`.
   - **Evidence:** The current built-ins are in the repo's [skills](../../../skills) directory, while WI-12 lists `saivage/skills/coding/SKILL.md` and similar paths.
   - **Suggested correction:** Normalize all implementation-plan file paths to repo-relative paths, e.g. `skills/coding/SKILL.md` → `skills/builtin/coding/SKILL.md`, and reserve `saivage/` only for workspace-root references.

5. **WI-17 — the prod-bundle regression test should not hide a full build inside ordinary unit tests.**
   - **What's wrong:** `fr31a` says the test may invoke `pnpm build` itself. That is testable, but it will be slow and can make ordinary `vitest run` unexpectedly perform a web build and tsup build.
   - **Evidence:** [package.json](../../../package.json) defines `pnpm build` as `npm run build:web && tsup`, and [vitest.config.ts](../../../vitest.config.ts) includes all `src/**/*.test.ts` in the default run.
   - **Suggested correction:** Split this into a named integration script or make the regression test skip with a clear message unless `dist/skills/builtin` exists, then require `pnpm build && pnpm test:bundle` in CI/Phase-D validation.

6. **Big-picture granularity — WI-12 is too large once the missing runtime/init/lifecycle work is added.**
   - **What's wrong:** WI-12 is already the largest item, and the required corrections above would make it carry final naming, old deletion, built-in movement, project init, lifecycle hooks, and smoke-route exposure if left unsplit.
   - **Evidence:** WI-12 already deletes the old loader/handlers/tests, moves four built-ins, updates bundling, and flips BaseAgent. The missing WIs affect [src/mcp/runtime.ts](../../../src/mcp/runtime.ts), [src/runtime/dispatcher.ts](../../../src/runtime/dispatcher.ts), [src/store/project.ts](../../../src/store/project.ts), [src/mcp/plan-server.ts](../../../src/mcp/plan-server.ts), [src/agents/chat.ts](../../../src/agents/chat.ts), and [src/server/server.ts](../../../src/server/server.ts).
   - **Suggested correction:** Keep WI-12 as the final atomic deletion/swap, but split prerequisites into explicit build-safe WIs: runtime caller context, project init tree, lifecycle archival, and HTTP smoke route.

## Spot-check log

| Item checked | Result | Notes |
|---|---:|---|
| WI-01 knowledge types | PASS | Additive, testable, and tied to FR-2/3/4. |
| WI-03 store primitives | FAIL | Per-record mutex does not protect same-scope `index.json` rebuilds for distinct creates. |
| WI-04 permissions engine | FAIL | No role/stage/session context reaches MCP handlers today. |
| WI-05 loader | PASS | Loader scope/filter/scoring acceptance is coherent; no call-site risk until cutover. |
| WI-06 skill service | FAIL | Duplicate flat tool names and missing role-aware runtime context. |
| WI-07 memory service | FAIL | Missing role-aware runtime context; `source_ref` blocked-path example is schema-inconsistent. |
| WI-08 slash commands | PASS | The Chat-no-direct-write direction matches Design §H.1, assuming MCP routing is fixed. |
| WI-09 BaseAgent eager wiring | PASS | Flag-off sequencing is build-safe if imports/types are handled carefully. |
| WI-10 compaction integration | PASS | Correctly keeps `compaction.ts` pure and puts orchestration in `BaseAgent`. |
| WI-11 fsGuard | PASS | Directly closes the generic `write_file` escape hatch. |
| WI-12 cutover | FAIL | Missing init/lifecycle/runtime prerequisites; final swap cannot be safe as written. |
| WI-13 schema cleanup | PASS | Correctly ordered after old imports are removed. |
| WI-14 MCP integration tests | FAIL | Cannot assert runtime-level authorization without changing runtime call context; error count mismatch. |
| WI-15 concurrency tests | FAIL | Tests ask for distinct-create index integrity without a mechanism to guarantee it. |
| WI-16 agent-level tests | FAIL | Stage/session archive hooks are not implemented by earlier WIs. |
| WI-17 regression pins | FAIL | FR-27 read redaction is unpinned; prod-bundle test placement needs a clearer script. |
| FR-6 per-role MCP authoring | FAIL | Permission matrix cannot be enforced with current handler signature. |
| FR-9 stage-scoped archival | FAIL | No WI modifies the stage terminal path. |
| FR-15 survivor reinjection | PASS | WI-10/WI-16 cover the design's BaseAgent-side reinjection model. |
| FR-21 git-trackable scope policy | FAIL | `saivage init` and `.gitignore` updates are absent. |
| FR-24 built-ins load in prod | PASS | WI-05/WI-12/WI-17 cover walker, bundling, and prod-bundle assertion. |
| FR-27 no secrets in records | FAIL | Write refusal covered; read-time redaction not covered. |
| FR-29 concurrent-write safety | FAIL | Scope-level index writes need serialization. |
| FR-31a built-in load regression | PASS | Explicitly pinned against source and dist layouts. |
| FR-31e authorization/stub regression | FAIL | Authorization cannot originate in MCP runtime yet; final stub behavior needs runtime-context work. |
| FR-31g parallel writes regression | FAIL | Planned tests exceed the described locking mechanism. |
| Cutover: `/health` smoke | PASS | [src/server/server.ts](../../../src/server/server.ts) implements `/health`. |
| Cutover: `/api/mcp/tools` smoke | FAIL | No such route exists in [src/server/server.ts](../../../src/server/server.ts). |
| Cutover: empty knowledge trees | FAIL | [src/store/project.ts](../../../src/store/project.ts) does not initialize them. |
| Cutover: classic LXC operations | FAIL | §6 uses SSH-style commands instead of `lxc-attach` operations. |

## Writer's open-item decisions

| Open item | Verdict | Evidence |
|---|---|---|
| MCP service wire names: `skills`/`memory` vs `knowledge.skills`/`knowledge.memory` | Use final wire service names `skills` and `memory`. `knowledge.*` may be an internal module prefix only, not the shipped MCP service identity. | Design §C.2 says existing `skills.*` names are replaced with the new contract and `memory.*` stubs are deleted/replaced. Design §K rejects a shared `knowledge` MCP service. The plan's §4 also says the `skills` service name is explicitly kept. |
| Multi-instance defense: `.runtime.pid` check in WI-03 | Do not include it in the knowledge-store WI. | Design §C.3 and §K make cross-process concurrency an explicit non-goal. Current runtime already has a project-level single-instance guard via [src/runtime/recovery.ts](../../../src/runtime/recovery.ts) and [src/server/bootstrap.ts](../../../src/server/bootstrap.ts). Adding `.saivage/.runtime.pid` in WI-03 duplicates runtime ownership and broadens scope. |
| `/api/mcp/tools` endpoint existence | It does not exist today; the plan must either add it or remove that smoke step. | [src/server/server.ts](../../../src/server/server.ts) has no `/api/mcp/tools` route, and the route list contains no `/api/mcp` path. |