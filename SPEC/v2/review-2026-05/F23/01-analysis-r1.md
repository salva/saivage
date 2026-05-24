# F23 — Analysis (r1)

## Problem restated

`RuntimeSupervisor.selectAbortTarget` is the only mechanism that turns a "stuck" verdict into an actual abort. It walks the registered agents in the order declared by `ROLE_ABORT_PRIORITY`:

[src/runtime/supervisor.ts](src/runtime/supervisor.ts#L13-L19)
```ts
const ROLE_ABORT_PRIORITY: AgentRole[] = [
  "reviewer",
  "data_agent",
  "coder",
  "researcher",
  "manager",
];
```

The supervisor's abort path is gated on this list:

[src/runtime/supervisor.ts](src/runtime/supervisor.ts#L94-L116) and [src/runtime/supervisor.ts](src/runtime/supervisor.ts#L143-L152)

If no registered agent matches one of those five roles, `selectAbortTarget` returns `null` and the supervisor logs `"Stuck threshold reached, but no lower-level agent is running"` ([src/runtime/supervisor.ts](src/runtime/supervisor.ts#L96-L100)) and goes back to sleep.

The full set of registered roles in `BaseAgent` / `AgentContext` is the 8-element `AgentRole` union:

[src/agents/types.ts](src/agents/types.ts#L20-L29)
```ts
export type AgentRole =
  | "planner"
  | "manager"
  | "coder"
  | "researcher"
  | "data_agent"
  | "reviewer"
  | "inspector"
  | "chat";
```

So `planner`, `inspector`, and `chat` are unreachable by the supervisor's abort path. They are the three long-running role classes the supervisor most needs to be able to cancel:

- Planner is the long-lived strategist (`runPlanner` registers it with `role: "planner"` at [src/server/bootstrap.ts](src/server/bootstrap.ts#L463-L497)).
- Inspector is a one-shot deep-analysis run dispatched through the child spawner at [src/server/bootstrap.ts](src/server/bootstrap.ts#L362-L398).
- Chat is launched directly by the HTTP server and is the only role that is **not** put into `runtime.agentRegistry` at all ([src/server/server.ts](src/server/server.ts#L680-L711)).

## Contract

`ROLE_ABORT_PRIORITY` is consumed exclusively by `RuntimeSupervisor.selectAbortTarget`. Its behavioural contract is:

- Input: `runtime.agentRegistry: Map<string, BaseAgent>` (the currently live agents) plus the static priority list.
- Output: either the first `{agentId, role, agent}` whose `role` matches the earliest priority entry that has a live agent, or `null`.
- Effect on caller: when non-null, `target.agent.cancel()` is invoked and a 10-minute force-cancel timer is scheduled ([src/runtime/supervisor.ts](src/runtime/supervisor.ts#L101-L115)).

Lifecycle: `agentRegistry` entries are added in the dispatcher (workers, manager, inspector, reviewer at [src/server/bootstrap.ts](src/server/bootstrap.ts#L373-L376)) and in `runPlanner` ([src/server/bootstrap.ts](src/server/bootstrap.ts#L480)), and removed in their `finally` blocks ([src/server/bootstrap.ts](src/server/bootstrap.ts#L394-L398) and [src/server/bootstrap.ts](src/server/bootstrap.ts#L493-L498)). Chat sessions are never inserted into the registry.

## Call sites & dependencies

- Only `RuntimeSupervisor.selectAbortTarget` ([src/runtime/supervisor.ts](src/runtime/supervisor.ts#L143-L152)) reads `ROLE_ABORT_PRIORITY`. No tests, no other modules.
- Existing supervisor tests assert priority ordering using the current 5-role list: [src/runtime/runtime.test.ts](src/runtime/runtime.test.ts#L128-L260).
- The dispatcher key map covers six roles and similarly omits planner and chat: [src/runtime/dispatcher.ts](src/runtime/dispatcher.ts#L25-L32) (cross-referenced by F02).
- The supervisor LLM verdict pipeline that feeds into the abort decision is the subject of F05; it can suppress legitimate `stuck=true` verdicts, which means in practice `selectAbortTarget` runs even less often than its threshold suggests.

## Actual operational gap

The user-visible bug is two-layered:

1. **Roster gap**: even if every agent were registered, the priority list omits `inspector`, `planner`, and `chat`, so a stuck Planner / Inspector cannot be aborted.
2. **Registration gap**: `ChatAgent` is not inserted into `agentRegistry` ([src/server/server.ts](src/server/server.ts#L680-L711) vs. dispatcher in [src/server/bootstrap.ts](src/server/bootstrap.ts#L373-L376)), so even if `"chat"` were added to the priority list, the supervisor would still not see live chat sessions. This is a roster-drift symptom related to F02.

## Constraints any solution must respect

- The priority list and the `AgentRole` union must agree by construction; reintroducing two lists that can drift is forbidden (project guideline #1, plus operator note on F02).
- Project guideline #1: no migration shims, no "old + new during rollout", no deprecation aliases. The fix replaces the static array in place.
- Project guideline #2: no abstractions used only once and no premature configurability. The priority must remain a code constant, not a config knob — there is one consumer, the supervisor.
- The planner must be cancellable but should be the last-resort target: cancelling the strategist halts the autonomous loop until `RECOVERY_PROMPT` (in [src/server/bootstrap.ts](src/server/bootstrap.ts#L515-L525)) restarts it. Workers/manager/reviewer/inspector must come first.
- Out-of-scope: skills/memory subsystems are not touched by any candidate fix.
- F05 may delete the supervisor module entirely. If F05 is applied first, F23 becomes a no-op and the file disappears with it; the plan in `03-plan-rN.md` notes the ordering. F23 is still worth resolving on its own because F05 is currently `CHANGES_REQUESTED`-able and the operator's note on F05 ("you can just remove this agent") is a discretionary call, not a hard requirement.
