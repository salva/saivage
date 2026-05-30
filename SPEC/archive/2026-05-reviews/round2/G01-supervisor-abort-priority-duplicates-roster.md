# G01 — Supervisor ABORT_PRIORITY duplicates and drifts from `ROSTER.abortPriority`

**Subsystem:** src/runtime/
**Category:** architecture / single-source-of-truth violation
**Severity:** high
**Transversality:** architectural (cross-module roster contract violation)

## Summary

The runtime supervisor hand-maintains a second `ABORT_PRIORITY: Record<AgentRole, number>` table that is supposed to be derived from `ROSTER.abortPriority`. The values have already drifted off-by-one from the roster, and roles the roster explicitly marks as **non-abortable** (`abortPriority: null` — planner, inspector, chat) are assigned finite numbers in the supervisor and will therefore be aborted when they sort to the lowest priority. This is a regression of round-1 finding F23 (supervisor priority-derivation fix).

## Evidence

Roster contract: [src/agents/roster.ts](src/agents/roster.ts#L25-L26) declares the field with the rule *"Lower numbers are aborted first by the supervisor; null means not abortable"*. Concrete values in [src/agents/roster.ts](src/agents/roster.ts#L46) (planner=null), [src/agents/roster.ts](src/agents/roster.ts#L64) (manager=6), [src/agents/roster.ts](src/agents/roster.ts#L82) (coder=3), [src/agents/roster.ts](src/agents/roster.ts#L100) (researcher=4), [src/agents/roster.ts](src/agents/roster.ts#L118) (data_agent=2), [src/agents/roster.ts](src/agents/roster.ts#L137) (reviewer=1), [src/agents/roster.ts](src/agents/roster.ts#L156) (designer=5), [src/agents/roster.ts](src/agents/roster.ts#L175) (inspector=null), [src/agents/roster.ts](src/agents/roster.ts#L197) (chat=null).

Supervisor duplicate at [src/runtime/supervisor.ts](src/runtime/supervisor.ts#L12-L22):

```ts
const ABORT_PRIORITY: Record<AgentRole, number> = {
  reviewer: 0,     // roster: 1
  data_agent: 1,   // roster: 2
  coder: 2,        // roster: 3
  researcher: 3,   // roster: 4
  designer: 4,     // roster: 5
  manager: 5,      // roster: 6
  inspector: 6,    // roster: null  ← contract says NOT abortable
  chat: 7,         // roster: null  ← contract says NOT abortable
  planner: 8,      // roster: null  ← contract says NOT abortable
};
```

Used by `selectAbortTarget()` at [src/runtime/supervisor.ts](src/runtime/supervisor.ts#L152-L156), which sorts every registered agent — including planner, chat, inspector — by this table and returns the lowest. When only "non-abortable" agents are registered (the typical idle state with planner+chat running), the supervisor will pick one of them after `consecutiveStuck >= threshold`.

The `Record<AgentRole, number>` type forces the table to be exhaustive over `AgentRole`, but cannot express the "not abortable" contract. The supervisor and the roster have no compile-time link.

## Why this matters

- The whole point of `abortPriority: null` (Planner, Chat, Inspector) is that the supervisor must never kill them — Planner is the long-lived orchestrator, Inspector is a one-shot diagnostic that does not deserve preemption, Chat is the operator's last line of control. The current code silently violates that contract.
- F23 in round 1 was supposed to wire the supervisor to the roster. The duplication came back. Without a structural derivation, this regression class will keep recurring whenever someone "fixes a number" in one of the two tables.
- The off-by-one ordering hasn't caused user-visible breakage only because the *relative* ordering of the four worker roles is preserved by accident; any future re-numbering will silently disagree.

## Rough remediation direction

Architectural, single source: delete `ABORT_PRIORITY` from supervisor.ts. Add a helper to [src/agents/roster.ts](src/agents/roster.ts) such as `getAbortPriority(role: AgentRole): number | null` that returns `entry.abortPriority` directly. `selectAbortTarget()` should:

1. Filter registered agents to those whose priority is non-null.
2. Sort the remainder by that priority.
3. Return the first, or `null` if the filter is empty (and log "supervisor stuck threshold reached, but all running agents are non-abortable" instead of preempting Planner).

A `roster.test.ts` assertion that "every role with `null` priority must be filtered out before sort" + a unit test that `selectAbortTarget` returns `null` when only planner/chat/inspector are registered would prevent the next regression.

## Cross-links

- Reinforces / regresses round-1 finding F23 (supervisor priority derivation).
- Related to G03 (`ROLE_TOOL_FILTER` ignores `roster.toolFilter`) — same anti-pattern.
- Related to G02 (`enforceDispatchLimits` omits designer) — same drift class.
