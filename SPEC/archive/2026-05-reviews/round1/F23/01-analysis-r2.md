# F23 — Analysis (r2)

## Changes from r1

- Added a dedicated section on chat cancellation semantics. r1 treated chat
  registration as sufficient; the reviewer correctly flagged that `ChatAgent.run()`
  resolves from a channel-close callback and that the inherited
  `BaseAgent.cancel()` only flips a flag the chat loop never reads.
- Expanded the "Constraints any solution must respect" section to record the
  contract a chat abort must satisfy (close channel, resolve `run()`, allow the
  server-side wrapper to deregister) and the planner-starvation hazard that
  follows if chat is registered without an honest cancel path.
- No factual claims from r1 changed; the additions strengthen the contract
  without contradicting the prior file:line references.

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

## Chat cancellation semantics (new in r2)

`ChatAgent.run()` does **not** participate in the inherited `BaseAgent.runLoop()`
cancellation contract. Two concrete consequences:

1. `BaseAgent.cancel()` just sets `this.cancelled = true`
   ([src/agents/base.ts](src/agents/base.ts#L208-L211)). The flag is only read
   from inside `runLoop()` ([src/agents/base.ts](src/agents/base.ts#L217-L221)),
   which ChatAgent does not use as its outer loop.
2. `ChatAgent.run()` builds a `Promise<AgentResult>` that resolves **only** from
   the `channel.onClose` callback
   ([src/agents/chat.ts](src/agents/chat.ts#L213-L233)). It is therefore
   driven by the transport, not by the cancel flag.

The supervisor's cancel path is `target.agent.cancel()` followed by a 10-minute
force-cancel timer ([src/runtime/supervisor.ts](src/runtime/supervisor.ts#L101-L115)).
With the inherited `cancel()`, calling it on a `ChatAgent` produces zero
observable effect: the channel stays open, `run()` does not resolve, the server
wrapper's `finally` never runs (see step 2 in `03-plan-r2.md`), and the
registry entry persists indefinitely. The supervisor would then keep picking
the same chat session on every subsequent stuck triple, because
`selectAbortTarget` only consults the registry and the priority order — it has
no "already-cancelled, skip" memory.

This is the planner-starvation hazard the reviewer raised: if `chat` is given a
priority slot ahead of `planner` (which it must, because cancelling the
strategist is the most expensive last resort), then a non-honest chat cancel
keeps the planner permanently masked.

The honest chat abort contract is therefore:

- `ChatAgent.cancel()` must invoke `super.cancel()` **and** close the underlying
  channel ([src/channels/types.ts](src/channels/types.ts#L5-L17)).
- Closing the channel triggers the existing `onClose` handler at
  [src/agents/chat.ts](src/agents/chat.ts#L223-L232), which already runs
  `cleanup()` and resolves the run promise.
- Resolving the run promise lets the server's IIFE wrapper's `finally` block
  remove the entry from `runtime.agentRegistry`. After that, the supervisor's
  next pass sees a smaller registry and selects the next live target — in the
  worst case, `planner`.

All four existing `ChatChannel` implementations expose a synchronous-or-async
`close()` method, and all four wire `onClose` from the transport's actual
disconnect event:

- [src/channels/websocket.ts](src/channels/websocket.ts#L30-L55) — `close()`
  calls `ws.close()`, which triggers `ws.on("close")`, which fires the
  registered closeHandler.
- [src/channels/cli.ts](src/channels/cli.ts#L7-L60) — `close()` ends stdin /
  raises the closeHandler.
- [src/channels/oneshot.ts](src/channels/oneshot.ts#L6-L40) — single-shot
  channel; `close()` fires the handler.
- [src/channels/telegram.ts](src/channels/telegram.ts#L82-L160) — `close()`
  unhooks the bot polling and invokes the closeHandler.

So `this.channel.close()` is a uniform, supported call.

## Contract

`ROLE_ABORT_PRIORITY` is consumed exclusively by `RuntimeSupervisor.selectAbortTarget`. Its behavioural contract is:

- Input: `runtime.agentRegistry: Map<string, BaseAgent>` (the currently live agents) plus the static priority list.
- Output: either the first `{agentId, role, agent}` whose `role` matches the earliest priority entry that has a live agent, or `null`.
- Effect on caller: when non-null, `target.agent.cancel()` is invoked and a 10-minute force-cancel timer is scheduled ([src/runtime/supervisor.ts](src/runtime/supervisor.ts#L101-L115)).

The added chat contract piggy-backs on the same callsite:

- For chat, `agent.cancel()` is the trigger that eventually causes the entry to
  leave `agentRegistry`. The supervisor remains the sole consumer; no new API
  surface is introduced.

Lifecycle: `agentRegistry` entries are added in the dispatcher (workers, manager, inspector, reviewer at [src/server/bootstrap.ts](src/server/bootstrap.ts#L373-L376)) and in `runPlanner` ([src/server/bootstrap.ts](src/server/bootstrap.ts#L480)), and removed in their `finally` blocks ([src/server/bootstrap.ts](src/server/bootstrap.ts#L394-L398) and [src/server/bootstrap.ts](src/server/bootstrap.ts#L493-L498)). Chat sessions are currently never inserted into the registry; r2 closes that gap with the same `set`/`delete` pattern.

## Call sites & dependencies

- Only `RuntimeSupervisor.selectAbortTarget` ([src/runtime/supervisor.ts](src/runtime/supervisor.ts#L143-L152)) reads `ROLE_ABORT_PRIORITY`. No tests, no other modules.
- Existing supervisor tests assert priority ordering using the current 5-role list: [src/runtime/runtime.test.ts](src/runtime/runtime.test.ts#L128-L260).
- The dispatcher key map covers six roles and similarly omits planner and chat: [src/runtime/dispatcher.ts](src/runtime/dispatcher.ts#L25-L32) (cross-referenced by F02).
- The supervisor LLM verdict pipeline that feeds into the abort decision is the subject of F05; it can suppress legitimate `stuck=true` verdicts, which means in practice `selectAbortTarget` runs even less often than its threshold suggests.
- Chat lifecycle consumers of `ChatAgent` (the WebSocket route at
  [src/server/server.ts](src/server/server.ts#L673-L712), CLI at
  [src/cli/run.ts](src/cli/run.ts) via `CLIChannel`, Telegram via
  `TelegramChannel`) all rely on `channel.onClose` firing to end the session.
  Overriding `ChatAgent.cancel()` to call `this.channel.close()` reuses that
  existing path — no new wiring is added at the channel layer.

## Actual operational gap

The user-visible bug is two-layered, with the chat sub-task itself split into
two parts:

1. **Roster gap**: even if every agent were registered, the priority list omits `inspector`, `planner`, and `chat`, so a stuck Planner / Inspector cannot be aborted.
2. **Registration gap**: `ChatAgent` is not inserted into `agentRegistry` ([src/server/server.ts](src/server/server.ts#L680-L711) vs. dispatcher in [src/server/bootstrap.ts](src/server/bootstrap.ts#L373-L376)), so even if `"chat"` were added to the priority list, the supervisor would still not see live chat sessions. This is a roster-drift symptom related to F02.
3. **Honest-cancel gap (new in r2)**: even if `chat` were registered, calling
   the inherited `BaseAgent.cancel()` on a `ChatAgent` does nothing observable.
   The supervisor would mark chat as the selected target on every triple
   without ever clearing the slot, starving `planner` of its last-resort
   priority.

## Constraints any solution must respect

- The priority list and the `AgentRole` union must agree by construction; reintroducing two lists that can drift is forbidden (project guideline #1, plus operator note on F02).
- Project guideline #1: no migration shims, no "old + new during rollout", no deprecation aliases. The fix replaces the static array in place.
- Project guideline #2: no abstractions used only once and no premature configurability. The priority must remain a code constant, not a config knob — there is one consumer, the supervisor.
- The planner must be cancellable but should be the last-resort target: cancelling the strategist halts the autonomous loop until `RECOVERY_PROMPT` (in [src/server/bootstrap.ts](src/server/bootstrap.ts#L515-L525)) restarts it. Workers/manager/reviewer/inspector must come first.
- **Chat-abort contract (new in r2)**: if `chat` appears in `ABORT_PRIORITY`,
  `ChatAgent.cancel()` must drive `ChatAgent.run()` to resolution and clear the
  registry entry through the server-side wrapper. The minimal honest path is to
  call `super.cancel()` (sets the flag so any later `runLoop()` checks bail
  immediately) and `this.channel.close()` (triggers the existing onClose path).
  Anything weaker (flag-only, throw-only) keeps the registry slot live and
  recreates the planner-starvation hazard.
- Out-of-scope: skills/memory subsystems are not touched by any candidate fix.
- F05 may delete the supervisor module entirely. If F05 is applied first, F23 becomes a no-op and the file disappears with it; the plan in `03-plan-rN.md` notes the ordering. F23 is still worth resolving on its own because F05 is currently `CHANGES_REQUESTED`-able and the operator's note on F05 ("you can just remove this agent") is a discretionary call, not a hard requirement.
