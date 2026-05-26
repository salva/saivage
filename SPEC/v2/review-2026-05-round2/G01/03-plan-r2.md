# G01 — Plan (r2, Design B)

## Round 2 deltas vs r1

Four reviewer-mandated changes
([04-review-r1.md](04-review-r1.md#L46-L60)) are applied here:

1. **Exhaustive `applyToolFilter()`** — step 4 below now constructs a
   typed `Record<ToolFilterKind, (name: string) => boolean>` table so
   the TypeScript compiler refuses to build the file unless every
   `ToolFilterKind` member is covered.
2. **Validation/test plan fixed** — the previously-named non-existent
   targeted Vitest paths (`src/runtime/dispatcher.test.ts`,
   `src/agents/manager.test.ts`) are dropped; the targeted command now
   names only files that exist or are created by this plan. The
   blast-radius count is corrected: **5 production files modified, 1
   production file added, 2 test files modified, 1 test file added** —
   nine paths total. Steps 7–10 add CONSUMER-level tests for duplicate
   designer-dispatch rejection and role tool-schema filtering, not
   only pure accessor tests.
3. **Rollback covers every running v2 harness** — verified by direct
   inspection: containers `saivage` (10.0.3.111), `saivage-v3`
   (10.0.3.112), and `diedrico` (10.0.3.113) ALL bind-mount host
   `/home/salva/g/ml/saivage` to `/opt/saivage`, so all three load the
   modified `dist/cli.js` on next start. The `saivage-v3-getrich-v2`
   container (10.0.3.170) runs Saivage v3 and is not affected. The
   `git reset --hard` fallback is removed.
4. **Cross-finding metaplan note tightened** — the cross-finding
   section now states G02/G03/G04 may be collapsed into G01 only after
   the new consumer tests (steps 7c, 9c) and the daemon rollback
   coverage (rollback section) land with G01.

---

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

   - Add `import { getAbortPriority } from "../agents/roster.js";`
     alongside the existing imports.
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
     alongside the existing imports.
   - In `enforceDispatchLimits` at
     [src/runtime/dispatcher.ts](src/runtime/dispatcher.ts#L265-L294),
     replace the `if (role === "coder" || role === "researcher" || role
     === "data_agent" || role === "reviewer")` branch with
     `if (isConcurrencyLimitedDispatch(role))`. Delete the four-name
     disjunction.

4. **Create exhaustive tool-filter module (G03 part 1).** Create
   `src/agents/tool-filters.ts` with the literal tool-name sets
   currently in [src/agents/base.ts](src/agents/base.ts#L1086-L1102) and
   an exhaustive `Record<ToolFilterKind, (name: string) => boolean>`
   table so the TypeScript compiler enforces coverage of every union
   member:

   ```ts
   import type { ToolFilterKind } from "./roster.js";

   const READ_ONLY_TOOLS = new Set<string>([
     "read_file", "list_dir", "search_files", "git_status", "git_log", "git_diff",
     "list_skills", "read_skill",
   ]);

   const PLAN_TOOLS = new Set<string>([
     "plan_get", "plan_get_stage", "plan_get_current_stage",
     "plan_set_stages", "plan_add_stage", "plan_remove_stage",
     "plan_set_current", "plan_complete_stage",
     "plan_get_history", "plan_init", "plan_commit",
   ]);

   const WORKER_EXCLUDED_TOOLS = new Set<string>([
     ...PLAN_TOOLS,
     "create_skill", "update_skill",
   ]);

   const READ_STASH = "read_stash";
   const WEB_TOOLS = new Set<string>(["web_search", "fetch_url", "fetch_page_text"]);

   const TOOL_FILTERS: Record<ToolFilterKind, (name: string) => boolean> = {
     planner: (n) => PLAN_TOOLS.has(n) || READ_ONLY_TOOLS.has(n) || n === READ_STASH,
     worker:  (n) => !WORKER_EXCLUDED_TOOLS.has(n),
     reviewer:(n) => READ_ONLY_TOOLS.has(n) || n === "run_command" || n === READ_STASH,
     inspector:(n) =>
       READ_ONLY_TOOLS.has(n) || n === "run_command" || n === READ_STASH || WEB_TOOLS.has(n),
     chat:    (n) =>
       READ_ONLY_TOOLS.has(n) || n === READ_STASH || WEB_TOOLS.has(n),
   };

   export function applyToolFilter(
     kind: ToolFilterKind,
     tool: { name: string; service: string },
   ): boolean {
     return TOOL_FILTERS[kind](tool.name);
   }
   ```

   Notes:

   - The `Record<ToolFilterKind, …>` declaration is the exhaustiveness
     anchor. If a future commit adds (say) `"observer"` to
     `ToolFilterKind` at
     [src/agents/roster.ts](src/agents/roster.ts#L13), `tsc --noEmit`
     fails at this file with `Property 'observer' is missing in type …`.
     No silent fall-through is reachable.
   - The `planner | inspector | reviewer | worker` branches are
     behaviourally equivalent to the four functions currently in
     `ROLE_TOOL_FILTER` at
     [src/agents/base.ts](src/agents/base.ts#L1107-L1122).
   - The `chat` branch is **new behaviour**: today chat falls through to
     the un-filtered path; the roster declares `toolFilter: "chat"` at
     [src/agents/roster.ts](src/agents/roster.ts#L197) and the contract
     needs an implementation. The chosen set mirrors the chat agent's
     actual capability surface (read-only + web fetch; no shell, no
     plan, no write_file). If the reviewer prefers a different chat
     filter, that is the only behavioural decision in this finding
     outside the supervisor fix itself.

5. **Rewire base agent (G03 part 2).** In
   [src/agents/base.ts](src/agents/base.ts):

   - Add `import { applyToolFilter } from "./tool-filters.js";` and
     `import { getToolFilter } from "./roster.js";` alongside the
     existing roster import.
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
     constants and the role-keyed map are now owned by
     `src/agents/tool-filters.ts`.

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

   - The module-header comment is already correct and is not edited (no
     new docstrings/comments in untouched code).

7. **Rewrite supervisor tests + add CONSUMER dispatcher test.** In
   [src/runtime/runtime.test.ts](src/runtime/runtime.test.ts):

   - **(7a)** In the "aborts roles in the order …" test at
     [src/runtime/runtime.test.ts](src/runtime/runtime.test.ts#L255-L281),
     change the `order` tuple to
     `["reviewer", "data_agent", "coder", "researcher", "designer",
     "manager"] as const` (six abortable roles only). Rename the test
     accordingly.
   - **(7b)** After the loop body, register the three non-abortable
     roles and assert they are never cancelled:

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

   - **(7c) NEW — CONSUMER test for G02 duplicate-designer rejection.**
     Add a top-level `describe("Dispatcher.enforceDispatchLimits via
     processToolCalls", …)` block. Construct a `Dispatcher` (the class
     is already imported at
     [src/runtime/runtime.test.ts](src/runtime/runtime.test.ts#L20))
     with a stub `McpRuntime` that resolves every dispatch tool. Drive
     `dispatcher.processToolCalls(...)` with two
     `{ name: "run_designer", arguments: { … } }` entries in a single
     batch. Assert: exactly one is invoked end-to-end (via the
     `ChildSpawner` stub), one is reported as rejected with the
     `"Rejecting duplicate designer dispatch — max 1 per batch"` log
     line, and the dispatcher's invalid-call counter is *not* incremented
     (the rejection path is the warn branch, not the error branch).
     This test fails on `main` because `designer` is missing from the
     hardcoded disjunction; it passes after step 3 lands.

   - **(7d)** In the planner-starvation test at
     [src/runtime/runtime.test.ts](src/runtime/runtime.test.ts#L283-L310),
     rewrite the expectation: instead of asserting planner is reached
     after chat closes, assert `planner.cancel` is never called even
     across nine `checkOnce()` rounds (three stuck triples) when chat
     and planner are the only registered agents.

8. **Add roster-contract tests.** In the existing
   [src/agents/roster.test.ts](src/agents/roster.test.ts), append:

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
   - For every entry in `ROSTER` with `dispatchTool !== null` and
     `role` in `DISPATCHABLE_ROLES`,
     `isConcurrencyLimitedDispatch(role)` equals `entry.worker`.

9. **Add tool-filter unit + CONSUMER tests.** Create
   `src/agents/tool-filters.test.ts` with:

   - **(9a) Pure dispatch coverage.** For each of the five
     `ToolFilterKind` values, assert one tool that must pass and one
     tool that must be excluded.
   - **(9b) Regression coverage.**
     - `applyToolFilter("worker", { name: "plan_get", service: "plan" })` → false.
     - `applyToolFilter("planner", { name: "run_command", service: "shell" })` → false.
     - `applyToolFilter("chat", { name: "run_command", service: "shell" })` → false.
     - `applyToolFilter("chat", { name: "read_file", service: "fs" })` → true.
     - `applyToolFilter("inspector", { name: "write_file", service: "fs" })` → false.
   - **(9c) NEW — CONSUMER test for G03 role tool-schema filtering.**
     Add a `describe("BaseAgent.getToolSchemas — role-driven filtering
     via roster", …)` block that reuses the test harness from
     [src/agents/agents.test.ts](src/agents/agents.test.ts#L418) (a
     real `BaseAgent` subclass instantiated with a stub `McpRuntime`
     whose `getAllTools()` returns a fixed set covering `read_file`,
     `write_file`, `run_command`, `plan_get`, and `web_search`). For
     each of `manager`, `designer`, and `chat`, instantiate the agent
     and assert the returned `getToolSchemas()` set matches the
     `getToolFilter(role)` contract. Specifically: today these three
     roles return the entire tool set; after the fix, `chat` returns
     only `{read_file, web_search, read_stash}`, `designer` returns the
     worker set (`write_file`, `run_command`, `read_file`, …), and
     `manager` returns the worker set as well. The test fails on
     `main` because the old `ROLE_TOOL_FILTER` has no entry for those
     three roles; it passes after steps 4–5 land.

10. **Verify no test imports the deleted constants.** Run
    `rg -n "ROLE_TOOL_FILTER|ABORT_PRIORITY" src/` and confirm zero
    hits. Any remaining hit is a test that needs to be migrated.

## Validation

Run from `/home/salva/g/ml/saivage` after each step group (steps 1–3,
4–6, 7–9):

```bash
npx tsc --noEmit
npx vitest run src/runtime/runtime.test.ts src/agents/roster.test.ts src/agents/tool-filters.test.ts src/agents/agents.test.ts
npx vitest run
npm run build
```

The targeted Vitest command names only files that exist after this plan
is applied: `runtime.test.ts`, `roster.test.ts`, and `agents.test.ts`
exist today; `tool-filters.test.ts` is created in step 9. The previous
r1 command named `src/runtime/dispatcher.test.ts` and
`src/agents/manager.test.ts`, both of which were nonexistent — those
paths are removed.

Sweep `rg` commands (run from `/home/salva/g/ml/saivage`) — each must
return zero hits when the plan is fully applied:

```bash
rg -n "ABORT_PRIORITY" src/
rg -n "ROLE_TOOL_FILTER" src/
rg -n "PLAN_TOOLS\b|READ_ONLY_TOOLS\b|WORKER_EXCLUDED_TOOLS\b" src/agents/base.ts
rg -n 'role === "coder" \|\| role === "researcher"' src/
rg -n '"run_coder", "run_researcher", "run_data_agent", "run_designer", "run_reviewer"' src/
```

New file existence checks:

```bash
test -f src/agents/tool-filters.ts
test -f src/agents/tool-filters.test.ts
```

### Deployment validation — every running v2 harness

Three running containers bind-mount host `/home/salva/g/ml/saivage` to
container `/opt/saivage` and run `node dist/cli.js …`, so all three load
the rebuilt `dist/` on next start. The fourth container
(`saivage-v3-getrich-v2` at 10.0.3.170) runs Saivage v3 and is
**unaffected** by changes to this v2 source tree. Verified by direct
inspection of `/proc/1/mounts` on each container and by
[/.github/copilot-instructions.md](.github/copilot-instructions.md#L15-L21).

Pre-deploy bind-mount + service verification (read-only; safe to run at
any time):

```bash
for ip in 10.0.3.111 10.0.3.112 10.0.3.113; do
  echo "=== $ip ==="
  ssh root@$ip 'cat /proc/1/mounts | grep -E "saivage|work/(getrich|saivage-v3|diedrico)"'
  ssh root@$ip 'systemctl is-active saivage.service; head -5 /etc/systemd/system/saivage.service'
done
```

Expected mounts:

- `10.0.3.111` (saivage, GetRich v1):
  host `/home/salva/g/ml/saivage` → `/opt/saivage`,
  host `/home/salva/g/ml/getrich` → `/work/getrich`.
  Service command: `node dist/cli.js serve /work/getrich`.
- `10.0.3.112` (saivage-v3, v2 harness on Saivage v3):
  host `/home/salva/g/ml/saivage` → `/opt/saivage`,
  host `/home/salva/g/ml/saivage-v3` → `/work/saivage-v3`.
  Service command: `node dist/cli.js serve /work/saivage-v3`.
- `10.0.3.113` (diedrico, v2 harness on diedrico):
  host `/home/salva/g/ml/saivage` → `/opt/saivage`,
  host `/home/salva/g/ml/diedrico` → `/work/diedrico`.
  Service command: `node dist/cli.js serve /work/diedrico`.

After `npm run build` succeeds on the host, restart each harness the
operator wants on the new code (operator-gated; do not blanket-restart
without confirmation because each restart aborts the harness's
in-progress planner/manager work):

```bash
for ip in 10.0.3.111 10.0.3.112 10.0.3.113; do
  ssh root@$ip 'systemctl restart saivage.service'
  sleep 2
  curl -fsS http://$ip:8080/health || echo "HEALTH FAILED on $ip"
done
```

Health endpoint must return 200 with a JSON body on each container.
Tail `journalctl -u saivage.service -n 100` on any container that fails
the health probe; the supervisor + tool-filter code paths run during
startup so any TypeScript runtime mismatch surfaces in the first ~30s.

## Rollback

Rollback steps are operator-gated. The change is contained to nine
paths:

Production (6):

- [src/agents/roster.ts](src/agents/roster.ts) (modified)
- [src/runtime/supervisor.ts](src/runtime/supervisor.ts) (modified)
- [src/runtime/dispatcher.ts](src/runtime/dispatcher.ts) (modified)
- [src/agents/base.ts](src/agents/base.ts) (modified)
- [src/agents/manager.ts](src/agents/manager.ts) (modified)
- `src/agents/tool-filters.ts` (new)

Tests (3):

- [src/runtime/runtime.test.ts](src/runtime/runtime.test.ts) (modified)
- [src/agents/roster.test.ts](src/agents/roster.test.ts) (modified)
- `src/agents/tool-filters.test.ts` (new)

Total: **5 modified production files + 1 new production file + 2
modified test files + 1 new test file = 9 paths**.

Revert procedure (non-destructive only — `git reset --hard` is **not**
used; the operator has not authorized destructive local cleanup):

```bash
# 1. Revert the G01 commit. This adds a new commit that undoes the
#    change; no working-tree state is discarded.
cd /home/salva/g/ml/saivage
git revert <G01-commit-sha>

# 2. Rebuild the dist that all three v2 harnesses load from
#    /opt/saivage/dist/cli.js (bind-mounted from host).
npm run build

# 3. Re-verify bind mounts and service state on each affected
#    container before restart (read-only probe).
for ip in 10.0.3.111 10.0.3.112 10.0.3.113; do
  ssh root@$ip 'cat /proc/1/mounts | grep /opt/saivage; systemctl is-active saivage.service'
done

# 4. Restart each affected v2 harness so the reverted dist/cli.js is
#    loaded into the live Node process. The supervisor's ABORT_PRIORITY
#    constant and base.ts's ROLE_TOOL_FILTER are module-level
#    constants, so the live process keeps the post-change behaviour
#    until restart.
for ip in 10.0.3.111 10.0.3.112 10.0.3.113; do
  ssh root@$ip 'systemctl restart saivage.service'
  sleep 2
  curl -fsS http://$ip:8080/health || echo "HEALTH FAILED on $ip — investigate before continuing"
done
```

If a partial rollback is required (e.g., keep G01 supervisor fix, drop
G03 tool-filter rewrite), revert at the level of individual files with
`git checkout <pre-G01-sha> -- src/agents/base.ts src/agents/tool-filters.ts`
and rebuild. The roster accessor exports added in step 1 are pure and
unused by the reverted consumers; leaving them in place is harmless.

No on-disk state migration is involved. Plan files, runtime state, auth
profiles, and knowledge store are untouched by this change, so rollback
is loss-free.

The `saivage-v3-getrich-v2` container at 10.0.3.170 runs Saivage v3
(`saivage-v3-getrich.service`), does **not** bind-mount the v2 source
tree, and needs no action during rollback. Verify with
`ssh root@10.0.3.170 'systemctl status saivage-v3-getrich.service | head'`
if uncertain.

## Cross-finding coordination

This design **subsumes** G02, G03, and G04 **only after** the
consumer-level tests and the daemon rollback coverage below land
together with G01. The metaplan must not collapse the siblings into
G01 if step 7c, step 9c, or the deployment-validation/rollback sections
are dropped during merge.

- **G02** ([G02-dispatcher-limits-omit-designer.md](../G02-dispatcher-limits-omit-designer.md))
  — `enforceDispatchLimits` rewrite (step 3) plus the duplicate-designer
  CONSUMER test (step 7c) close the designer omission end-to-end.
  Metaplan: "subsumed by G01; gated on step 7c being present in the G01
  commit".
- **G03** ([G03-role-tool-filter-ignores-roster.md](../G03-role-tool-filter-ignores-roster.md))
  — `ROLE_TOOL_FILTER` deletion + exhaustive `Record<ToolFilterKind,
  …>` (steps 4–5) plus the `getToolSchemas()` CONSUMER test (step 9c)
  close the dead-`roster.toolFilter` field and the missing
  manager/designer/chat filters. Metaplan: "subsumed by G01; gated on
  step 9c being present".
- **G04** ([G04-manager-validate-final-response-hardcoded-tools.md](../G04-manager-validate-final-response-hardcoded-tools.md))
  — `validateFinalResponse` rewrite (step 6) plus the
  `getDispatchToolsFor("manager")` accessor test (step 8) close the
  hardcoded 5-name list. Metaplan: "subsumed by G01; gated on the
  step 8 accessor assertion that pins the exact 5-tool set".

Additionally, the metaplan note must include: "G01 rollback verified
against all three v2 harnesses (`saivage`, `saivage-v3`, `diedrico`);
the `git reset --hard` fallback originally proposed in r1 was removed."

The metaplan should sequence G01 ahead of any roster-touching finding
that would otherwise re-add a hand-rolled table; specifically:

- Run G01 **before** any future role addition (e.g. if a new worker
  role is added to ROSTER), because the new accessors are what the
  new role consumes.
- G01 does not block or order against the async-fs class (G06, G30,
  G36, G37), the knowledge-store concurrency class (G38, G39), or the
  doc-drift class (G40, G44, G45).

**Round-1 cross-link.** This regresses F23 ([../../review-2026-05/F23/APPROVED.md](../../review-2026-05/F23/APPROVED.md));
the round-1 design's "derive from roster" half was not implemented and
must not be redone in a parallel structure — Design B's
`getAbortPriority` is the implementation F23 specified.
