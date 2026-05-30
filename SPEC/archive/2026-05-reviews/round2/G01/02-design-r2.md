# G01 — Design (r2)

## Round 2 deltas vs r1

Reviewer required one design change:
[04-review-r1.md](04-review-r1.md#L25-L29) asked that `applyToolFilter()`
be exhaustive over `ToolFilterKind` so a future filter kind cannot
silently fall through to "no filter". The r2 design pins this with a
typed `Record<ToolFilterKind, (name: string) => boolean>` table inside
`src/agents/tool-filters.ts`. The record cannot be constructed without
covering every member of the union, so the drift class G03 closes is
mechanically inexpressible.

Everything else (Design A vs B selection, helper signatures, consumer
rewrites, deletion list, public-API surface, recommendation) is
identical to [02-design-r1.md](02-design-r1.md). The full design is
restated below.

---

## Design A — Focused fix

**Idea.** Delete the duplicated `ABORT_PRIORITY` constant in
`supervisor.ts` and derive the cancellation decision directly from
`roster.abortPriority`. Filter out non-abortable roles before sorting.
Do not touch G02/G03/G04 sites.

**Edits.**

1. [src/runtime/supervisor.ts](src/runtime/supervisor.ts#L12-L22) —
   delete the `ABORT_PRIORITY` constant entirely. Import `getRoster`
   from `../agents/roster.js`.
2. [src/runtime/supervisor.ts](src/runtime/supervisor.ts#L152-L156) —
   rewrite `selectAbortTarget()` to:

   ```ts
   private selectAbortTarget(): { agentId: string; role: AgentRole; agent: BaseAgent } | null {
     const candidates = [...this.context.agentRegistry.entries()]
       .map(([agentId, agent]) => {
         const priority = getRoster(agent.role).abortPriority;
         return { agentId, role: agent.role, agent, priority };
       })
       .filter((c): c is typeof c & { priority: number } => c.priority !== null)
       .sort((a, b) => a.priority - b.priority);
     return candidates[0] ?? null;
   }
   ```

3. [src/runtime/supervisor.ts](src/runtime/supervisor.ts#L101-L104) —
   reword the "no lower-level agent is running" log to "no abortable
   agent is running".

**Files touched.** 1 (`src/runtime/supervisor.ts`).

**Public API impact.** None. `ABORT_PRIORITY` was a module-private
constant.

**Deletion list (architecture-first).**

- `const ABORT_PRIORITY: Record<AgentRole, number> = { ... }` block at
  [src/runtime/supervisor.ts](src/runtime/supervisor.ts#L12-L22).

**Test impact.** Same as Design B step 7 (see plan r2).

**Does not subsume G02/G03/G04.** Each remains a separate finding with
its own hand-rolled table.

## Design B — One conceptual level up

**Idea.** Make `ROSTER` the single source of truth for *every*
roster-derived consumer table. Add four typed pure-function accessors on
roster.ts and rewrite each of the four consumer sites (G01, G02, G03,
G04) to call them. Delete the four hand-rolled tables outright.

**New helpers on [src/agents/roster.ts](src/agents/roster.ts).**

```ts
// G01: replaces supervisor's ABORT_PRIORITY
export function getAbortPriority(role: AgentRole): number | null {
  return getRoster(role).abortPriority;
}

// G03: replaces base.ts's ROLE_TOOL_FILTER and consumes the existing
// `toolFilter: ToolFilterKind` field on every roster entry.
export function getToolFilter(role: AgentRole): ToolFilterKind {
  return getRoster(role).toolFilter;
}

// G04: replaces manager.ts's hardcoded 5-name list and base.ts's
// per-role dispatch schema map.
export function getDispatchToolsFor(parent: AgentRole): string[] {
  return ROSTER
    .filter((e) => e.dispatchTool !== null && e.dispatchableBy.includes(parent))
    .map((e) => e.dispatchTool as string);
}

// G02: replaces dispatcher.ts's hardcoded role check
// "if role is coder|researcher|data_agent|reviewer enforce max 1".
// Derived from the existing `worker: boolean` roster field; designer
// is `worker: true` so the regression closes automatically.
export function isConcurrencyLimitedDispatch(role: DispatchableRole): boolean {
  return getRoster(role).worker;
}
```

`ToolFilterKind` is already exported from
[src/agents/roster.ts](src/agents/roster.ts#L13). `getRoster` is already
exported at [src/agents/roster.ts](src/agents/roster.ts#L249-L253).
`DispatchableRole` is already exported at
[src/agents/roster.ts](src/agents/roster.ts#L214-L220).

**Consumer rewrites.**

1. **G01 — supervisor.**

   - Delete `ABORT_PRIORITY` at
     [src/runtime/supervisor.ts](src/runtime/supervisor.ts#L12-L22).
   - Rewrite `selectAbortTarget` as in Design A but call
     `getAbortPriority(agent.role)` rather than re-importing `getRoster`.
   - Reword the null-result log message at
     [src/runtime/supervisor.ts](src/runtime/supervisor.ts#L101-L104).

2. **G02 — dispatcher.**

   - In `enforceDispatchLimits` at
     [src/runtime/dispatcher.ts](src/runtime/dispatcher.ts#L265-L294),
     replace the `if (role === "coder" || role === "researcher" || ... )`
     condition with `if (isConcurrencyLimitedDispatch(role))`. Delete
     the hardcoded 4-name disjunction.

3. **G03 — base agent tool filtering, exhaustive over `ToolFilterKind`.**

   - Delete the entire `ROLE_TOOL_FILTER` map plus `READ_ONLY_TOOLS`,
     `PLAN_TOOLS`, `WORKER_EXCLUDED_TOOLS` constants at
     [src/agents/base.ts](src/agents/base.ts#L1086-L1123).
   - Move the actual filter implementations into a new
     `src/agents/tool-filters.ts` module keyed by `ToolFilterKind`. The
     dispatch is implemented as a `Record<ToolFilterKind, (name: string)
     => boolean>` so the compiler refuses to build the file unless every
     member of the union is covered. New union members force a compile
     error at the table, not a silent fall-through at the caller:

     ```ts
     import type { ToolFilterKind } from "./roster.js";

     const READ_ONLY_TOOLS = new Set<string>([ /* … */ ]);
     const PLAN_TOOLS = new Set<string>([ /* … */ ]);
     const WORKER_EXCLUDED_TOOLS = new Set<string>([
       ...PLAN_TOOLS,
       "create_skill", "update_skill",
     ]);
     const READ_STASH = "read_stash";
     const WEB_TOOLS = new Set<string>([ "web_search", "fetch_url", "fetch_page_text" ]);

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

     Equivalent alternative if a `switch` is preferred:

     ```ts
     import { assertExhaustive } from "./roster.js";
     // …
     switch (kind) {
       case "planner": return /* … */;
       case "worker":  return /* … */;
       case "reviewer":return /* … */;
       case "inspector":return /* … */;
       case "chat":    return /* … */;
       default: return assertExhaustive(kind);
     }
     ```

     The chosen form is the `Record` table because (a) it is a single
     declaration site that the type system audits whenever
     `ToolFilterKind` gains a member, (b) it is shorter than the switch,
     and (c) `assertExhaustive` already exists for the rare cases where
     a switch is unavoidable
     ([src/agents/roster.ts](src/agents/roster.ts#L259-L261)).

   - Rewrite `getToolSchemas()` at
     [src/agents/base.ts](src/agents/base.ts#L626-L635) to call
     `applyToolFilter(getToolFilter(this.role), { name: t.name, service:
     t.service })`. Because `getToolFilter` is total over `AgentRole`,
     the "missing entry" class (today: manager, designer, chat fall
     through to no filter) becomes impossible.

4. **G04 — manager validate-final-response.**

   - In `ManagerAgent.validateFinalResponse` at
     [src/agents/manager.ts](src/agents/manager.ts#L110-L115), replace
     `this.hasUsedToolNamed("run_coder", "run_researcher",
     "run_data_agent", "run_designer", "run_reviewer")` with
     `this.hasUsedToolNamed(...getDispatchToolsFor("manager"))`.
   - Spread is safe because `hasUsedToolNamed` is variadic
     ([src/agents/base.ts](src/agents/base.ts#L688-L691)).

5. **Bonus consumer (no separate finding).** The `ROLE_DISPATCH_TOOLS`
   table at [src/agents/base.ts](src/agents/base.ts#L1064-L1078) already
   derives from ROSTER via an IIFE; it stays, because it maps tool name
   to a `ToolSchema` (input-schema metadata that is not roster data).

**Files touched (Design B).** Production code: 5 files modified, 1 file
added.

- [src/agents/roster.ts](src/agents/roster.ts) — append four exported
  helpers. No existing field added; no existing entry mutated.
- [src/runtime/supervisor.ts](src/runtime/supervisor.ts) — delete
  `ABORT_PRIORITY`; rewrite `selectAbortTarget`; reword one log line.
- [src/runtime/dispatcher.ts](src/runtime/dispatcher.ts) — replace one
  disjunction with one helper call inside `enforceDispatchLimits`.
- [src/agents/base.ts](src/agents/base.ts) — delete four constants
  (`READ_ONLY_TOOLS`, `PLAN_TOOLS`, `WORKER_EXCLUDED_TOOLS`,
  `ROLE_TOOL_FILTER`); rewrite `getToolSchemas()`.
- `src/agents/tool-filters.ts` (new) — the exhaustive
  `Record<ToolFilterKind, …>` table and the `applyToolFilter` entry
  point.
- [src/agents/manager.ts](src/agents/manager.ts) — one-line change in
  `validateFinalResponse`.

**Public API impact.** `src/agents/roster.ts` gains four pure-function
exports. No existing export is removed, renamed, or changed in
signature. The new `src/agents/tool-filters.ts` is an internal module
not exposed through `src/index.ts`.

**Deletion list (architecture-first).**

- `const ABORT_PRIORITY` block at
  [src/runtime/supervisor.ts](src/runtime/supervisor.ts#L12-L22).
- Hardcoded role disjunction inside `enforceDispatchLimits` at
  [src/runtime/dispatcher.ts](src/runtime/dispatcher.ts#L281-L289).
- `const READ_ONLY_TOOLS` at
  [src/agents/base.ts](src/agents/base.ts#L1086-L1089).
- `const PLAN_TOOLS` at
  [src/agents/base.ts](src/agents/base.ts#L1092-L1097).
- `const WORKER_EXCLUDED_TOOLS` at
  [src/agents/base.ts](src/agents/base.ts#L1100-L1102).
- `const ROLE_TOOL_FILTER` at
  [src/agents/base.ts](src/agents/base.ts#L1104-L1123).
- Hardcoded 5-name argument list in
  [src/agents/manager.ts](src/agents/manager.ts#L111).

Seven concrete deletions; no aliases, no deprecated re-exports.

**Test impact (overview; full plan in [03-plan-r2.md](03-plan-r2.md)).**

Tests are added at three levels:

1. **Accessor tests** in
   [src/agents/roster.test.ts](src/agents/roster.test.ts) covering each
   new pure helper.
2. **Filter dispatch tests** in `src/agents/tool-filters.test.ts` (new)
   covering every `ToolFilterKind` branch and the regression cases the
   reviewer requires.
3. **Consumer-level integration tests** — required by
   [04-review-r1.md](04-review-r1.md#L37-L39):
   - In [src/runtime/runtime.test.ts](src/runtime/runtime.test.ts), a
     dispatcher test that drives `Dispatcher.processToolCalls` with two
     `run_designer` calls in the same batch and asserts exactly one is
     allowed and one is rejected. This proves
     `enforceDispatchLimits()` sees `designer` as concurrency-limited
     through `isConcurrencyLimitedDispatch`, closing G02 end-to-end.
   - In `src/agents/tool-filters.test.ts`, a `getToolSchemas()`
     integration test that instantiates a real `BaseAgent` subclass
     (using the existing test harness in
     [src/agents/agents.test.ts](src/agents/agents.test.ts#L418)) for
     each role and asserts the returned schema set matches the
     `getToolFilter(role)` contract. Specifically: `manager`,
     `designer`, and `chat` must each return a *filtered* schema set
     today they receive the full toolset, proving the consumer wiring
     for G03, not only the pure dispatch table.

**Subsumes G02, G03, G04?** Yes, all three. The metaplan can mark them
"subsumed by G01" and skip independent writer/reviewer rounds for them
**only after** the consumer-level tests above land and the daemon
rollback coverage in [03-plan-r2.md](03-plan-r2.md) is recorded. See
also the cross-finding section of [03-plan-r2.md](03-plan-r2.md).

## Recommendation

**Design B.** Justification unchanged from r1:

- The root cause is identical at all four sites ("roster declares
  contract, consumer reimplements it, the two drift"). Fixing one site
  in isolation guarantees the other three will continue to rot and
  surface as future findings.
- The total work for Design B is only one new file plus five short
  edits; the per-finding cost is *lower* than four parallel Design A
  fixes because the helper accessors are written once and reused.
- The four new helpers are pure functions over fields that already
  exist on `RosterEntry`. No new roster fields. No new architectural
  concept — the roster literal stays the single source of truth.
- Architecture-first / no-backward-compat: Design B deletes seven
  concrete duplications; Design A deletes one.
- The exhaustive `Record<ToolFilterKind, …>` (r2 addition) closes the
  one remaining drift surface the design previously left open, at no
  extra implementation cost.

The only argument for Design A is "smaller blast radius if reverted".
That is a backward-compat-shaped argument that the project guidelines
explicitly reject.
