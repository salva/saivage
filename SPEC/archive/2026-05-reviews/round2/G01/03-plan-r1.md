# G01 — Plan (r1, Design B)

## Implementation steps

1. **Add roster accessors.** Append to
   [src/agents/roster.ts](src/agents/roster.ts) (after the existing
   `getRosterByDispatchTool` at
   [src/agents/roster.ts](src/agents/roster.ts#L255-L257)):

   ```ts
   export function getAbortPriority(role: AgentRole): number | null {
     return getRoster(role).abortPriority;
   }

   export function getToolFilter(role: AgentRole): ToolFilterKind {
     return getRoster(role).toolFilter;
   }

   export function getDispatchToolsFor(parent: AgentRole): string[] {
     return ROSTER
       .filter((e) => e.dispatchTool !== null && e.dispatchableBy.includes(parent))
       .map((e) => e.dispatchTool as string);
   }

   export function isConcurrencyLimitedDispatch(role: DispatchableRole): boolean {
     return getRoster(role).worker;
   }
   ```

   No existing roster entry or field is mutated.

2. **Rewire supervisor (closes G01).** In
   [src/runtime/supervisor.ts](src/runtime/supervisor.ts):

   - Replace the `import type { AgentRole } from "../agents/types.js";`
     line with `import { getAbortPriority } from "../agents/roster.js";`
     alongside the existing type import.
   - Delete the `ABORT_PRIORITY` constant block at
     [src/runtime/supervisor.ts](src/runtime/supervisor.ts#L12-L22).
   - Rewrite `selectAbortTarget()` at
     [src/runtime/supervisor.ts](src/runtime/supervisor.ts#L152-L156):

     ```ts
     private selectAbortTarget(): { agentId: string; role: AgentRole; agent: BaseAgent } | null {
       const candidates = [...this.context.agentRegistry.entries()]
         .map(([agentId, agent]) => ({
           agentId,
           role: agent.role,
           agent,
           priority: getAbortPriority(agent.role),
         }))
         .filter((c): c is typeof c & { priority: number } => c.priority !== null)
         .sort((a, b) => a.priority - b.priority);
       return candidates[0] ?? null;
     }
     ```

   - Update the null-result log line at
     [src/runtime/supervisor.ts](src/runtime/supervisor.ts#L101-L104)
     from "Stuck threshold reached, but no lower-level agent is running"
     to "Stuck threshold reached, but no abortable agent is running".

3. **Rewire dispatcher (closes G02).** In
   [src/runtime/dispatcher.ts](src/runtime/dispatcher.ts):

   - Import `isConcurrencyLimitedDispatch` from `../agents/roster.js`
     alongside the existing `ROSTER, DispatchableRole` import at
     [src/runtime/dispatcher.ts](src/runtime/dispatcher.ts#L11).
   - In `enforceDispatchLimits` at
     [src/runtime/dispatcher.ts](src/runtime/dispatcher.ts#L265-L294),
     replace the `if (role === "coder" || role === "researcher" || role
     === "data_agent" || role === "reviewer")` branch with
     `if (isConcurrencyLimitedDispatch(role))`. Delete the four-name
     disjunction.

4. **Create tool-filter module (G03 part 1).** Create
   `src/agents/tool-filters.ts` containing the literal tool-name sets
   currently in [src/agents/base.ts](src/agents/base.ts#L1086-L1102) and
   one dispatch function:

   ```ts
   import type { ToolFilterKind } from "./roster.js";

   const READ_ONLY_TOOLS = new Set([
     "read_file", "list_dir", "search_files", "git_status", "git_log", "git_diff",
     "list_skills", "read_skill",
   ]);

   const PLAN_TOOLS = new Set([
     "plan_get", "plan_get_stage", "plan_get_current_stage",
     "plan_set_stages", "plan_add_stage", "plan_remove_stage",
     "plan_set_current", "plan_complete_stage",
     "plan_get_history", "plan_init", "plan_commit",
   ]);

   const WORKER_EXCLUDED_TOOLS = new Set<string>([
     ...PLAN_TOOLS,
     "create_skill", "update_skill",
   ]);

   export function applyToolFilter(
     kind: ToolFilterKind,
     tool: { name: string; service: string },
   ): boolean {
     const name = tool.name;
     switch (kind) {
       case "planner":
         return PLAN_TOOLS.has(name) || READ_ONLY_TOOLS.has(name) || name === "read_stash";
       case "inspector":
         return (
           READ_ONLY_TOOLS.has(name) ||
           name === "run_command" || name === "read_stash" ||
           name === "web_search" || name === "fetch_url" || name === "fetch_page_text"
         );
       case "reviewer":
         return READ_ONLY_TOOLS.has(name) || name === "run_command" || name === "read_stash";
       case "worker":
         return !WORKER_EXCLUDED_TOOLS.has(name);
       case "chat":
         return READ_ONLY_TOOLS.has(name) || name === "read_stash" ||
           name === "web_search" || name === "fetch_url" || name === "fetch_page_text";
     }
   }
   ```

   The `planner | inspector | reviewer | worker` branches are
   byte-equivalent to the four functions currently in `ROLE_TOOL_FILTER`
   at [src/agents/base.ts](src/agents/base.ts#L1107-L1122). The `chat`
   branch is **new behaviour**: today chat falls through to the
   un-filtered path; the roster declares
   `toolFilter: "chat"` at
   [src/agents/roster.ts](src/agents/roster.ts#L197) and the contract
   needs an implementation. The chosen set mirrors the chat agent's
   actual capability surface (read-only + web fetch; no shell, no plan,
   no write_file). If the reviewer prefers a different chat filter, that
   is the only behavioural decision in this finding outside the
   supervisor fix itself.

5. **Rewire base agent (G03 part 2).** In
   [src/agents/base.ts](src/agents/base.ts):

   - Add `import { applyToolFilter } from "./tool-filters.js";` and
     `import { getToolFilter } from "./roster.js";` alongside the
     existing roster import at
     [src/agents/base.ts](src/agents/base.ts#L22).
   - In `getToolSchemas()` at
     [src/agents/base.ts](src/agents/base.ts#L626-L635), replace the
     `roleFilter`/`filtered` logic with:

     ```ts
     const allTools = this.ctx.mcpRuntime.getAllTools();
     const kind = getToolFilter(this.role);
     const filtered = allTools.filter((t: RuntimeToolEntry) =>
       applyToolFilter(kind, { name: t.name, service: t.service }),
     );
     ```

   - Delete `const READ_ONLY_TOOLS`, `const PLAN_TOOLS`,
     `const WORKER_EXCLUDED_TOOLS`, `const ROLE_TOOL_FILTER` blocks at
     [src/agents/base.ts](src/agents/base.ts#L1086-L1123). These four
     constants and the role-keyed map are now owned by the new module.

6. **Rewire manager (closes G04).** In
   [src/agents/manager.ts](src/agents/manager.ts):

   - Add `import { getDispatchToolsFor } from "./roster.js";` after the
     existing imports.
   - Rewrite `validateFinalResponse` at
     [src/agents/manager.ts](src/agents/manager.ts#L110-L115):

     ```ts
     protected override validateFinalResponse(): string | null {
       if (this.hasUsedToolNamed(...getDispatchToolsFor("manager"))) {
         return null;
       }
       return "Invalid final stage response: you have not dispatched any worker yet.";
     }
     ```

   - Update the stale module-header comment at
     [src/agents/manager.ts](src/agents/manager.ts#L3-L5) only if the
     enumerated tool list there drifts again in future; leave untouched
     now (per "no new docstrings/comments in untouched code" rule — the
     comment is already correct).

7. **Rewrite supervisor tests.** In
   [src/runtime/runtime.test.ts](src/runtime/runtime.test.ts):

   - In the "aborts roles in the order ..." test at
     [src/runtime/runtime.test.ts](src/runtime/runtime.test.ts#L255-L281),
     change the `order` tuple to
     `["reviewer", "data_agent", "coder", "researcher", "designer",
     "manager"] as const` (six abortable roles only). Rename the test
     accordingly.
   - After the loop body, add:

     ```ts
     agentRegistry.set("planner-1", { role: "planner", cancel: vi.fn() });
     agentRegistry.set("inspector-1", { role: "inspector", cancel: vi.fn() });
     agentRegistry.set("chat-1", { role: "chat", cancel: vi.fn() });
     const callsBefore = router.chat.mock.calls.length;
     await supervisor.checkOnce();
     await supervisor.checkOnce();
     await supervisor.checkOnce();
     for (const id of ["planner-1", "inspector-1", "chat-1"]) {
       const entry = agentRegistry.get(id) as { cancel: ReturnType<typeof vi.fn> };
       expect(entry.cancel).not.toHaveBeenCalled();
     }
     expect(router.chat.mock.calls.length).toBe(callsBefore + 3);
     ```

   - In the planner-starvation test at
     [src/runtime/runtime.test.ts](src/runtime/runtime.test.ts#L283-L310),
     rewrite the expectation: instead of asserting planner is reached
     after chat closes, assert `planner.cancel` is never called even
     across nine `checkOnce()` rounds (three stuck triples) when chat
     and planner are the only registered agents.

8. **Add roster-contract tests.** In
   [src/agents/roster.test.ts](src/agents/roster.test.ts) (file exists
   per [SUBSYSTEM-MAP](../00-SUBSYSTEM-MAP.md); create the file if it
   does not), add:

   - `getAbortPriority(role)` returns the same value as
     `ROSTER.find(r => r.role === role)?.abortPriority` for every role
     in `ALL_ROLES`.
   - `getToolFilter(role)` returns the same value as
     `ROSTER.find(r => r.role === role)?.toolFilter` for every role.
   - `getDispatchToolsFor("manager")` returns the sorted set
     `["run_coder", "run_data_agent", "run_designer", "run_researcher",
     "run_reviewer"]`.
   - `getDispatchToolsFor("planner")` returns the sorted set
     `["run_inspector", "run_manager"]`.
   - `getDispatchToolsFor("chat")` returns `["run_inspector"]`.
   - For every entry in `ROSTER`, `isConcurrencyLimitedDispatch(role)`
     equals `entry.worker` whenever `entry.dispatchTool !== null`.

9. **Add tool-filter tests.** Create `src/agents/tool-filters.test.ts`
   with at minimum:

   - For each of the five `ToolFilterKind` values, assert one tool that
     must pass and one tool that must be excluded.
   - Specific regression coverage:
     - `applyToolFilter("worker", { name: "plan_get", ... })` → false.
     - `applyToolFilter("planner", { name: "run_command", ... })` → false.
     - `applyToolFilter("chat", { name: "run_command", ... })` → false.
     - `applyToolFilter("chat", { name: "read_file", ... })` → true.
     - `applyToolFilter("inspector", { name: "write_file", ... })` →
       false.

## Validation

Run from `/home/salva/g/ml/saivage` after each step group (steps 1–3,
4–6, 7–9):

```bash
npx tsc --noEmit
npx vitest run src/runtime/runtime.test.ts src/agents/roster.test.ts src/agents/tool-filters.test.ts
npx vitest run src/agents/agents.test.ts src/agents/manager.test.ts src/runtime/dispatcher.test.ts
npx vitest run
npm run build
```

Sweep `rg` commands (run from `/home/salva/g/ml/saivage`) — each must
return zero hits when the design is fully applied:

```bash
rg -n "ABORT_PRIORITY" src/
rg -n "ROLE_TOOL_FILTER" src/
rg -n "PLAN_TOOLS\b|READ_ONLY_TOOLS\b|WORKER_EXCLUDED_TOOLS\b" src/agents/base.ts
rg -n 'role === "coder" \|\| role === "researcher"' src/
rg -n '"run_coder", "run_researcher", "run_data_agent", "run_designer", "run_reviewer"' src/
```

The new file existence checks:

```bash
test -f src/agents/tool-filters.ts
test -f src/agents/tool-filters.test.ts
```

Deployment validation (per
[/memories/repo/saivage-validation-commands.json](../../../../../.github/skills/saivage-development-validation/SKILL.md)):

- After `npm run build` succeeds, restart the dedicated v2 harness only
  if the operator wants live validation:
  `sudo lxc-attach -n saivage-v3 -- systemctl restart saivage.service`
  then `curl -fsS http://10.0.3.112:8080/health`. The supervisor change
  only takes effect on a fresh process.

## Rollback

- The change is contained to seven files (`src/agents/roster.ts`,
  `src/runtime/supervisor.ts`, `src/runtime/dispatcher.ts`,
  `src/agents/base.ts`, `src/agents/manager.ts`,
  `src/agents/tool-filters.ts` [new], `src/runtime/runtime.test.ts`,
  `src/agents/roster.test.ts`, `src/agents/tool-filters.test.ts`
  [new]). Revert with `git revert <commit-sha>` (or `git reset --hard`
  before push) of the single G01 commit.
- The `saivage-v3` container running the v2 harness needs a service
  restart after rollback because the supervisor loop and tool-filter
  module are loaded once at process start:
  `sudo lxc-attach -n saivage-v3 -- systemctl restart saivage.service`.
- No on-disk state migration is involved. Plan files, runtime state,
  auth profiles, and knowledge store are untouched by this change, so
  rollback is loss-free.
- The `saivage` (v2-on-GetRich) and `saivage-v3-getrich-v2` containers
  do not run this version of the v2 harness and need no action.

## Cross-finding coordination

This design **subsumes**:

- **G02** ([G02-dispatcher-limits-omit-designer.md](../G02-dispatcher-limits-omit-designer.md))
  — `enforceDispatchLimits` rewrite (step 3) closes the designer
  omission. Metaplan should mark G02 "subsumed by G01; no independent
  writer/reviewer round".
- **G03** ([G03-role-tool-filter-ignores-roster.md](../G03-role-tool-filter-ignores-roster.md))
  — `ROLE_TOOL_FILTER` deletion + `applyToolFilter` rewrite (steps 4
  and 5) close the dead-`roster.toolFilter` field and the missing
  manager/designer/chat filters. Metaplan should mark G03 "subsumed by
  G01".
- **G04** ([G04-manager-validate-final-response-hardcoded-tools.md](../G04-manager-validate-final-response-hardcoded-tools.md))
  — `validateFinalResponse` rewrite (step 6) closes the hardcoded
  5-name list. Metaplan should mark G04 "subsumed by G01".

The metaplan should sequence G01 ahead of any roster-touching finding
that would otherwise re-add a hand-rolled table; specifically:

- Run G01 **before** any future role addition (e.g. if a new worker
  role is added to ROSTER), because the new accessors are what the new
  role consumes.
- G01 does not block or order against the async-fs class (G06, G30,
  G36, G37), the knowledge-store concurrency class (G38, G39), or the
  doc-drift class (G40, G44, G45).

If the reviewer rejects Design B for "too much scope", the fallback is
Design A (see [02-design-r1.md](02-design-r1.md)); G02, G03, G04 then
each need their own writer/reviewer round.

**Round-1 cross-link.** This regresses F23 ([../../review-2026-05/F23/APPROVED.md](../../review-2026-05/F23/APPROVED.md));
the round-1 design's "derive from roster" half was not implemented and
must not be redone in a parallel structure — Design B's
`getAbortPriority` is the implementation F23 specified.
