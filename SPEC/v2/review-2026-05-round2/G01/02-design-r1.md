# G01 — Design (r1)

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

**Test impact.**

- [src/runtime/runtime.test.ts](src/runtime/runtime.test.ts#L255-L281)
  ordering test: drop `inspector`, `chat`, `planner` rows from the
  `order` tuple; add a new assertion that after the abortable roles are
  exhausted, `selectAbortTarget()` returns `null` and no further `cancel`
  is invoked even after three more stuck triples.
- [src/runtime/runtime.test.ts](src/runtime/runtime.test.ts#L283-L310)
  planner-starvation test: reframe as "planner is never selected even
  when it is the only registered agent" (today it asserts planner is
  reached *eventually* after chat closes; the new contract is planner is
  never selected at all).
- New unit test in the same file: "selectAbortTarget returns null when
  only non-abortable roles are registered" — seed the registry with
  one of each of `planner`, `inspector`, `chat`, run three stuck
  triples, assert no `cancel` was called.

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

3. **G03 — base agent tool filtering.**

   - Delete the entire `ROLE_TOOL_FILTER` map plus `READ_ONLY_TOOLS`,
     `PLAN_TOOLS`, `WORKER_EXCLUDED_TOOLS` constants at
     [src/agents/base.ts](src/agents/base.ts#L1086-L1123).
   - Move the actual filter implementations into a new
     `src/agents/tool-filters.ts` module keyed by `ToolFilterKind`. The
     module exports `applyToolFilter(kind: ToolFilterKind, tool: { name:
     string; service: string }): boolean`. The five `ToolFilterKind`
     branches (`planner | worker | reviewer | inspector | chat`) own the
     tool-name sets that today live as `READ_ONLY_TOOLS` etc. The new
     module is the only place the literal tool-name lists exist.
   - Rewrite `getToolSchemas()` at
     [src/agents/base.ts](src/agents/base.ts#L626-L635) to call
     `applyToolFilter(getToolFilter(this.role), t)`. Because
     `getToolFilter` is total over `AgentRole`, the "missing entry"
     class (today: manager, designer, chat fall through to no filter)
     becomes impossible.

4. **G04 — manager validate-final-response.**

   - In `ManagerAgent.validateFinalResponse` at
     [src/agents/manager.ts](src/agents/manager.ts#L110-L115), replace
     `this.hasUsedToolNamed("run_coder", "run_researcher",
     "run_data_agent", "run_designer", "run_reviewer")` with
     `this.hasUsedToolNamed(...getDispatchToolsFor("manager"))`.
   - Spread is safe because `hasUsedToolNamed` is variadic
     ([src/agents/base.ts](src/agents/base.ts#L688-L691)).

5. **Bonus consumer (no separate finding, but free).** The
   `ROLE_DISPATCH_TOOLS` table at
   [src/agents/base.ts](src/agents/base.ts#L1064-L1078) already derives
   from ROSTER via an IIFE; it stays, because it maps tool name to a
   `ToolSchema` (input-schema metadata that is not roster data). No
   change.

**Files touched (Design B).**

- [src/agents/roster.ts](src/agents/roster.ts) — append four exported
  helpers. No existing field added; no existing entry mutated.
- [src/runtime/supervisor.ts](src/runtime/supervisor.ts) — delete
  `ABORT_PRIORITY`; rewrite `selectAbortTarget`; reword one log line.
- [src/runtime/dispatcher.ts](src/runtime/dispatcher.ts) — replace one
  disjunction with one helper call inside `enforceDispatchLimits`.
- [src/agents/base.ts](src/agents/base.ts) — delete four constants
  (`READ_ONLY_TOOLS`, `PLAN_TOOLS`, `WORKER_EXCLUDED_TOOLS`,
  `ROLE_TOOL_FILTER`); rewrite `getToolSchemas()`.
- `src/agents/tool-filters.ts` (new) — the five `ToolFilterKind`
  implementations.
- [src/agents/manager.ts](src/agents/manager.ts) — one-line change in
  `validateFinalResponse`.

Total: 5 edits + 1 new file.

**Public API impact.** `ROSTER`-exporting module gains four pure-function
exports. No existing export removed, renamed, or changed in signature.
The new `src/agents/tool-filters.ts` is an internal module not exposed
through `src/index.ts`.

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

**Test impact.**

- [src/runtime/runtime.test.ts](src/runtime/runtime.test.ts#L255-L281)
  ordering test: same rewrite as Design A (drop the three non-abortable
  rows; add the null-result assertion).
- [src/runtime/runtime.test.ts](src/runtime/runtime.test.ts#L283-L310)
  planner-starvation test: same reframe as Design A.
- New unit test in
  [src/agents/roster.test.ts](src/agents/roster.test.ts) (file exists)
  that asserts the four contract invariants:

  - For every roster entry, `getAbortPriority(role)` returns `entry.abortPriority`.
  - `getDispatchToolsFor("manager")` equals
    `["run_coder", "run_researcher", "run_data_agent", "run_designer",
    "run_reviewer"]` (asserted as a sorted set to avoid ordering noise).
  - `getDispatchToolsFor("planner")` equals `["run_manager",
    "run_inspector"]`.
  - For every roster entry, `getToolFilter(role)` returns
    `entry.toolFilter`.
  - For every entry with `worker: true`,
    `isConcurrencyLimitedDispatch(entry.role)` returns true; for
    non-worker dispatchable roles (`manager`, `inspector`), returns
    false.

- New unit test in `src/agents/tool-filters.test.ts` (new file) — three
  cases per `ToolFilterKind`, mirroring the existing behaviour of the
  four entries in the deleted `ROLE_TOOL_FILTER` map plus explicit
  coverage for `manager`, `designer`, and `chat` (the three previously
  un-filtered roles). The new tests will fail today (manager/designer/
  chat get the full toolset); they pass after the design is applied.
- Existing agent tests in
  [src/agents/agents.test.ts](src/agents/agents.test.ts) and
  [src/runtime/dispatcher.test.ts](src/runtime/dispatcher.test.ts) (if
  present) must continue to pass; the manager dispatch-then-validate
  flow is exercised at
  [src/agents/agents.test.ts](src/agents/agents.test.ts#L418).

**Subsumes G02, G03, G04?** Yes, all three. The metaplan can mark them
"subsumed by G01" and skip independent writer/reviewer rounds for them.
The G01 design owns the deletions and the new tests at all four sites.

## Recommendation

**Design B.** Justification:

- The root cause is identical at all four sites ("roster declares
  contract, consumer reimplements it, the two drift"). Fixing one site
  in isolation guarantees the other three will continue to rot and
  surface as future findings. Design A leaves three of the four
  hand-rolled tables in place.
- The total work for Design B is only one new file plus five short
  edits; the per-finding cost is *lower* than four parallel Design A
  fixes because the helper accessors are written once and reused.
- The four new helpers are pure functions over fields that already exist
  on `RosterEntry`. No new roster fields. No new architectural concept
  (no `RoleRegistry` singleton, no `RoleContract` wrapper object) — the
  roster literal stays the single source of truth and the new helpers
  are typed thin wrappers, matching the existing pattern set by
  `getRoster`, `getRosterByDispatchTool`, `DISPATCH_ROLE_MAP`, and
  `ROLE_DISPATCH_TOOLS`.
- Architecture-first / no-backward-compat: Design B deletes seven
  concrete duplications; Design A deletes one.
- The metaplan saves three full writer/reviewer cycles (G02, G03, G04).

The only argument for Design A is "smaller blast radius if reverted".
That is a backward-compat-shaped argument that the project guidelines
explicitly reject.
