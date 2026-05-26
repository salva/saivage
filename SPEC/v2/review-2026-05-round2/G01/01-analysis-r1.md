# G01 — Analysis (r1)

## Functional analysis

The runtime supervisor's job is to detect a stuck system and, once
`consecutiveStuck >= threshold`, abort the lowest-priority running agent so
the planner can recover. The roster's `abortPriority: number | null` field
([src/agents/roster.ts](src/agents/roster.ts#L25-L26)) is the contract that
encodes "lower numbers are aborted first; `null` means not abortable".

The supervisor reimplements that contract as a private constant
`ABORT_PRIORITY: Record<AgentRole, number>` at
[src/runtime/supervisor.ts](src/runtime/supervisor.ts#L12-L22) and uses it
in `selectAbortTarget()` at
[src/runtime/supervisor.ts](src/runtime/supervisor.ts#L152-L156). The
constant has two independent bugs:

1. **Drift.** The numbers are off-by-one against the roster
   (supervisor.reviewer=0 vs roster.reviewer=1, supervisor.manager=5 vs
   roster.manager=6, etc.). Relative ordering of the six abortable roles
   still matches by accident, so the bug is silent today; any future
   re-numbering will produce an undetected disagreement.
2. **Contract violation.** Roles the roster declares non-abortable
   (`planner`, `inspector`, `chat` — all `abortPriority: null` in
   [src/agents/roster.ts](src/agents/roster.ts#L46),
   [src/agents/roster.ts](src/agents/roster.ts#L175),
   [src/agents/roster.ts](src/agents/roster.ts#L197)) are assigned finite
   numbers (`inspector=6`, `chat=7`, `planner=8`) in the supervisor table.
   Whenever the supervisor's stuck triple fires and the only registered
   agents are non-abortable (the common idle state — planner is always
   registered at [src/server/bootstrap.ts](src/server/bootstrap.ts#L504),
   chat is registered at
   [src/server/server.ts](src/server/server.ts#L697) and
   [src/server/telegram-bot.ts](src/server/telegram-bot.ts#L100)),
   `selectAbortTarget()` returns the lowest-numbered surviving entry and
   the supervisor cancels Planner, Inspector, or Chat — exactly the three
   roles the contract forbids cancelling.

The pre-existing supervisor test at
[src/runtime/runtime.test.ts](src/runtime/runtime.test.ts#L255-L281)
encodes the drifted order as ground truth (`reviewer -> data_agent ->
coder -> researcher -> designer -> manager -> inspector -> chat ->
planner`), masking the contract violation as expected behaviour.

This is a regression of F23 (round 1), which approved Proposal B: derive
the priority from roster and add chat abort plumbing
([../review-2026-05/F23/APPROVED.md](../review-2026-05/F23/APPROVED.md),
[../review-2026-05/F23/02-design-r3.md](../review-2026-05/F23/02-design-r3.md#L48-L71)).
The chat registration plumbing (`agentRegistry.set/delete` at both chat
construction sites; `ChatAgent.cancel()` override) survived the merge;
the typed-record table did not get rewired to the roster as the round-1
design intended — only the inline literal was preserved, with `chat`,
`inspector`, and `planner` added as cancellable. The structural-derivation
half of F23 was lost.

The same drift class affects three sibling sites:

- **G02** ([src/runtime/dispatcher.ts](src/runtime/dispatcher.ts#L265-L294)):
  `enforceDispatchLimits` hand-lists `coder | researcher | data_agent |
  reviewer` and silently omits `designer` (added to ROSTER in F01 of round
  one but never propagated here).
- **G03** ([src/agents/base.ts](src/agents/base.ts#L1104-L1123)):
  `ROLE_TOOL_FILTER` hand-rolls per-role filters and ignores
  `roster.toolFilter`; `manager`, `designer`, and `chat` are absent from
  the map and silently receive the full MCP toolset.
- **G04** ([src/agents/manager.ts](src/agents/manager.ts#L110-L115)):
  `validateFinalResponse` hardcodes the five dispatch-tool names instead
  of consulting `ROSTER.dispatchableBy === "manager"`.

All four findings share the root cause "roster declares the contract, a
private table at the consumer reimplements it, the two drift". A level-up
design that adds typed roster accessors (`getAbortPriority`,
`getToolFilter`, `getDispatchToolsFor`, `getDispatchConcurrencyLimit`)
collapses all four into one fix.

## Affected code

Primary site (the bug):

- [src/runtime/supervisor.ts](src/runtime/supervisor.ts#L12-L22) —
  `ABORT_PRIORITY` constant duplicating
  [src/agents/roster.ts](src/agents/roster.ts#L25-L26).
- [src/runtime/supervisor.ts](src/runtime/supervisor.ts#L152-L156) —
  `selectAbortTarget()` consumer.
- [src/runtime/runtime.test.ts](src/runtime/runtime.test.ts#L255-L281) —
  test that locks in the drifted ordering and the chat/inspector/planner
  cancellation behaviour the contract forbids.
- [src/runtime/runtime.test.ts](src/runtime/runtime.test.ts#L283-L310) —
  "does not starve planner" test that should be reframed: once the fix
  lands, planner is never selectable at all, not "deprioritised below
  chat".

Sibling drift sites (cross-finding, see G02/G03/G04):

- [src/runtime/dispatcher.ts](src/runtime/dispatcher.ts#L265-L294) — G02.
- [src/agents/base.ts](src/agents/base.ts#L1104-L1123) — G03 (hand-rolled
  `ROLE_TOOL_FILTER`).
- [src/agents/base.ts](src/agents/base.ts#L627-L635) — G03 consumer
  (`getToolSchemas`).
- [src/agents/manager.ts](src/agents/manager.ts#L110-L115) — G04.

Roster already exposes:

- `ROSTER` literal with `abortPriority`, `toolFilter`, `dispatchTool`,
  `dispatchableBy` per entry ([src/agents/roster.ts](src/agents/roster.ts#L41-L210)).
- `getRoster(role)` lookup
  ([src/agents/roster.ts](src/agents/roster.ts#L249-L253)).
- `getRosterByDispatchTool(name)` lookup
  ([src/agents/roster.ts](src/agents/roster.ts#L255-L257)).
- `DISPATCH_ROLE_MAP` derived from ROSTER in dispatcher
  ([src/runtime/dispatcher.ts](src/runtime/dispatcher.ts#L17-L22)) — proves
  the derivation pattern is already idiomatic at one site.

## Constraints from project guidelines

- Architecture-first, no backward compatibility: the duplicated
  `ABORT_PRIORITY` constant must be deleted, not soft-deprecated. The
  sibling hand-rolled tables (G02 `enforceDispatchLimits` switch, G03
  `ROLE_TOOL_FILTER`, G04 hardcoded tool-name list) likewise must be
  deleted, not aliased, if the level-up design subsumes them.
- No over-engineering: do not add roster fields or helpers beyond what the
  four findings require. The minimum set needed to subsume G01–G04 is
  four pure-function accessors over the existing roster fields plus one
  numeric field (`maxConcurrentDispatches`) for G02 that is currently
  hardcoded.
- No new docstrings/comments in untouched code.
- All in-document file references use repo-relative markdown links with
  line numbers.

## Open questions

1. **Scope of the level-up design.** Should this finding's design pull in
   G02/G03/G04 (because the root cause is identical and the per-issue
   fixes will keep diverging if done independently), or stay surgical and
   let the metaplan stack them? Recommendation in
   [02-design-r1.md](02-design-r1.md) picks the level-up because the four
   sites all live in the same `roster` consumer surface and the metaplan
   can otherwise collapse G02/G03/G04 into "noops, subsumed by G01".
2. **Where does the concurrency limit for `enforceDispatchLimits` live?**
   The current code hardcodes "max 1 of each worker" with no roster field.
   Option (a): add a `maxConcurrentDispatches: number` field to every
   roster entry (workers get 1, dispatchers like `manager` get
   `Infinity`). Option (b): derive it from `worker: boolean` —
   `worker === true` ⇒ 1, else unbounded. (b) is smaller and matches
   today's behaviour exactly; (a) is more expressive but introduces a
   field not strictly needed. Recommendation: (b).
3. **Does `selectAbortTarget` log a distinct message when all running
   agents are non-abortable, separate from "no lower-level agent is
   running"?** Current code at
   [src/runtime/supervisor.ts](src/runtime/supervisor.ts#L101-L104) logs
   "Stuck threshold reached, but no lower-level agent is running" when
   the result is `null`. After the fix, that message will fire when the
   roster has filtered out every registered agent — which is operator-
   relevant. Recommendation: keep one branch but reword to "Stuck
   threshold reached, but no abortable agent is running"; do not add a
   second branch.
4. **Test rewrite scope.** The existing ordering test at
   [src/runtime/runtime.test.ts](src/runtime/runtime.test.ts#L255-L281)
   asserts cancellation of `inspector`, `chat`, `planner`. After the fix,
   those three rows must be deleted and replaced with a single assertion
   "supervisor returns null when only non-abortable roles are
   registered". This is a *behavioural* change, not just a refactor; the
   reviewer must confirm the contract change is intended (it is — it is
   exactly what the round-1 F23 design and the round-2 G01 issue
   describe).
