# F23 — Analysis (r3)

## Changes from r2

- Removed the false CLI claim. There is no `src/cli/run.ts`; the actual CLI
  entrypoint is [src/server/cli.ts](src/server/cli.ts) and it does not
  construct `ChatAgent` at all (`grep -R "new ChatAgent" src` returns only
  [src/server/server.ts](src/server/server.ts#L694) and
  [src/server/telegram-bot.ts](src/server/telegram-bot.ts#L89), plus two
  test sites in [src/agents/agents.test.ts](src/agents/agents.test.ts#L170)
  and [src/agents/agents.test.ts](src/agents/agents.test.ts#L214)). The
  CLI-as-chat-consumer paragraph has been deleted, not rewritten — there is
  no live CLI chat path to document.
- Corrected the channel-inventory claim. r2 stated that all four
  `ChatChannel` implementations wire `close()` to the registered `onClose`
  handler. That is true for `WebSocketChannel`, `CLIChannel`, and
  `TelegramChannel`, but **false** for `OneShotChannel`: its `close()` is a
  no-op and its `onClose()` is explicitly documented as "No-op — we control
  lifecycle via onDone" ([src/channels/oneshot.ts](src/channels/oneshot.ts#L31-L36)).
  `OneShotChannel` is also not used as a `ChatAgent` transport anywhere
  (only the `export` in [src/channels/index.ts](src/channels/index.ts#L3);
  no `new OneShotChannel(...)` exists). The inventory now lists only the
  three real `ChatAgent` transports, and the honest-cancel proof excludes
  `OneShotChannel` on the grounds that no `ChatAgent` is ever constructed
  against it.
- Added a second registration site to the chat-lifecycle gap. Telegram
  constructs and runs `ChatAgent` instances at
  [src/server/telegram-bot.ts](src/server/telegram-bot.ts#L89-L101) and
  does **not** insert them into `runtime.agentRegistry`. r2 only named the
  WebSocket route; r3 names both.

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
- Chat is launched directly by the HTTP server and the Telegram bot, and is the only role that is **not** put into `runtime.agentRegistry` at either site ([src/server/server.ts](src/server/server.ts#L694-L711), [src/server/telegram-bot.ts](src/server/telegram-bot.ts#L89-L101)).

## Chat cancellation semantics

`ChatAgent.run()` does **not** participate in the inherited `BaseAgent.runLoop()`
cancellation contract. Two concrete consequences:

1. `BaseAgent.cancel()` just sets `this.cancelled = true`
   ([src/agents/base.ts](src/agents/base.ts#L208-L211)). The flag is only read
   from inside `runLoop()` ([src/agents/base.ts](src/agents/base.ts#L217-L221)),
   which `ChatAgent` does not use as its outer loop.
2. `ChatAgent.run()` builds a `Promise<AgentResult>` that resolves **only** from
   the `channel.onClose` callback
   ([src/agents/chat.ts](src/agents/chat.ts#L222-L233)). It is therefore
   driven by the transport, not by the cancel flag.

The supervisor's cancel path is `target.agent.cancel()` followed by a 10-minute
force-cancel timer ([src/runtime/supervisor.ts](src/runtime/supervisor.ts#L101-L115)).
With the inherited `cancel()`, calling it on a `ChatAgent` produces zero
observable effect: the channel stays open, `run()` does not resolve, the
server/Telegram wrapper's `finally` never runs (see plan steps 2 and 2b), and
the registry entry persists indefinitely. The supervisor would then keep
picking the same chat session on every subsequent stuck triple, because
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
  [src/agents/chat.ts](src/agents/chat.ts#L222-L233), which already runs
  `cleanup()` and resolves the run promise.
- Resolving the run promise lets the server/Telegram IIFE wrapper's `finally`
  block remove the entry from `runtime.agentRegistry`. After that, the
  supervisor's next pass sees a smaller registry and selects the next live
  target — in the worst case, `planner`.

### Channel inventory (corrected)

The three `ChatChannel` implementations actually used as `ChatAgent`
transports each wire `close()` to their transport's disconnect event and fire
the registered close handler:

- [src/channels/websocket.ts](src/channels/websocket.ts#L30-L55) — `close()`
  calls `ws.close()`, which triggers `ws.on("close")`, which fires the
  registered closeHandler.
- [src/channels/cli.ts](src/channels/cli.ts#L43-L48) — `close()` calls
  `this.rl.close()`, which triggers the `rl.on("close")` listener registered
  in the constructor and fires the closeHandler.
- [src/channels/telegram.ts](src/channels/telegram.ts#L153-L161) — `close()`
  sets `closed = true` and synchronously invokes `closeHandler`.

`OneShotChannel` is **excluded** from this inventory. Its `close()` is a
no-op and it deliberately controls lifecycle via a separate `onDone`
callback ([src/channels/oneshot.ts](src/channels/oneshot.ts#L31-L40)). It is
also never instantiated as a `ChatAgent` transport — `grep -R
"new OneShotChannel" src` returns no results, and the only reference to it
outside its own file is the `export` in
[src/channels/index.ts](src/channels/index.ts#L3). For the purposes of F23 it
is not part of the proof that "every `ChatAgent` transport supports the
cancel chain", because no `ChatAgent` is ever constructed against it. The
type-system declaration of `OneShotChannel implements ChatChannel` is
misleading on its own, but fixing or removing it is outside F23 (it does not
contribute to the supervisor-priority bug). The plan's chat-lifecycle test
uses the WebSocket pattern through a `FakeChannel`, not `OneShotChannel`.

### CLIChannel is unused

`CLIChannel` is exported ([src/channels/index.ts](src/channels/index.ts#L2))
but never instantiated against a `ChatAgent` (`grep -R "new CLIChannel" src`
returns no results). The reviewer is correct that there is no CLI chat
consumer to document. F23 does not touch `CLIChannel`; it remains as a
transport implementation that satisfies `ChatChannel.close() -> onClose`
correctly should a future caller wire it up.

## Contract

`ROLE_ABORT_PRIORITY` is consumed exclusively by `RuntimeSupervisor.selectAbortTarget`. Its behavioural contract is:

- Input: `runtime.agentRegistry: Map<string, BaseAgent>` (the currently live agents) plus the static priority list.
- Output: either the first `{agentId, role, agent}` whose `role` matches the earliest priority entry that has a live agent, or `null`.
- Effect on caller: when non-null, `target.agent.cancel()` is invoked and a 10-minute force-cancel timer is scheduled ([src/runtime/supervisor.ts](src/runtime/supervisor.ts#L101-L115)).

The added chat contract piggy-backs on the same callsite:

- For chat, `agent.cancel()` is the trigger that eventually causes the entry to
  leave `agentRegistry`. The supervisor remains the sole consumer; no new API
  surface is introduced.

Lifecycle: `agentRegistry` entries are added in the dispatcher (workers, manager, inspector, reviewer at [src/server/bootstrap.ts](src/server/bootstrap.ts#L373-L376)) and in `runPlanner` ([src/server/bootstrap.ts](src/server/bootstrap.ts#L480)), and removed in their `finally` blocks ([src/server/bootstrap.ts](src/server/bootstrap.ts#L394-L398) and [src/server/bootstrap.ts](src/server/bootstrap.ts#L493-L498)). Chat sessions are currently never inserted into the registry at either the WebSocket route or the Telegram bot; r3 closes both gaps with the same `set`/`delete` pattern.

## Call sites & dependencies

- Only `RuntimeSupervisor.selectAbortTarget` ([src/runtime/supervisor.ts](src/runtime/supervisor.ts#L143-L152)) reads `ROLE_ABORT_PRIORITY`. No tests, no other modules.
- Existing supervisor tests assert priority ordering using the current 5-role list: [src/runtime/runtime.test.ts](src/runtime/runtime.test.ts#L128-L260).
- The dispatcher key map covers six roles and similarly omits planner and chat: [src/runtime/dispatcher.ts](src/runtime/dispatcher.ts#L25-L32) (cross-referenced by F02).
- The supervisor LLM verdict pipeline that feeds into the abort decision is the subject of F05; it can suppress legitimate `stuck=true` verdicts, which means in practice `selectAbortTarget` runs even less often than its threshold suggests.
- Chat lifecycle consumers of `ChatAgent` are exactly two:
  - WebSocket at [src/server/server.ts](src/server/server.ts#L673-L712) (uses `WebSocketChannel`).
  - Telegram at [src/server/telegram-bot.ts](src/server/telegram-bot.ts#L46-L107) (uses `TelegramChannel`; the bot module receives `runtime: SaivageRuntime` and therefore has access to `runtime.agentRegistry`).
  Both rely on `channel.onClose` firing to end the session. Overriding
  `ChatAgent.cancel()` to call `this.channel.close()` reuses that existing
  path; no new wiring is added at the channel layer.

## Actual operational gap

The user-visible bug is three-layered:

1. **Roster gap**: even if every agent were registered, the priority list omits `inspector`, `planner`, and `chat`, so a stuck Planner / Inspector cannot be aborted.
2. **Registration gap**: `ChatAgent` is not inserted into `agentRegistry` at either chat construction site — WebSocket ([src/server/server.ts](src/server/server.ts#L694-L711)) or Telegram ([src/server/telegram-bot.ts](src/server/telegram-bot.ts#L89-L101)). Even if `"chat"` were added to the priority list, the supervisor would still not see live chat sessions. This is a roster-drift symptom related to F02.
3. **Honest-cancel gap**: even if `chat` were registered, calling
   the inherited `BaseAgent.cancel()` on a `ChatAgent` does nothing observable.
   The supervisor would mark chat as the selected target on every triple
   without ever clearing the slot, starving `planner` of its last-resort
   priority.

## Constraints any solution must respect

- The priority list and the `AgentRole` union must agree by construction; reintroducing two lists that can drift is forbidden (project guideline #1, plus operator note on F02).
- Project guideline #1: no migration shims, no "old + new during rollout", no deprecation aliases. The fix replaces the static array in place.
- Project guideline #2: no abstractions used only once and no premature configurability. The priority must remain a code constant, not a config knob — there is one consumer, the supervisor.
- The planner must be cancellable but should be the last-resort target: cancelling the strategist halts the autonomous loop until `RECOVERY_PROMPT` (in [src/server/bootstrap.ts](src/server/bootstrap.ts#L515-L525)) restarts it. Workers/manager/reviewer/inspector must come first.
- **Chat-abort contract**: if `chat` appears in `ABORT_PRIORITY`,
  `ChatAgent.cancel()` must drive `ChatAgent.run()` to resolution and clear the
  registry entry through the per-site wrapper. The minimal honest path is to
  call `super.cancel()` (sets the flag so any later `runLoop()` checks bail
  immediately) and `this.channel.close()` (triggers the existing onClose path).
  Anything weaker (flag-only, throw-only) keeps the registry slot live and
  recreates the planner-starvation hazard.
- **Both construction sites must register**: WebSocket and Telegram must
  follow the same `set`-before-run / `delete`-in-`finally` pattern. Leaving
  Telegram unregistered while WebSocket is registered would mean the
  supervisor's `chat` priority slot quietly applies to web sessions only —
  a silent half-fix that re-introduces drift between construction sites.
- Out-of-scope: skills/memory subsystems are not touched by any candidate fix.
- F05 may delete the supervisor module entirely. If F05 is applied first, F23 becomes a no-op and the file disappears with it; the plan in `03-plan-rN.md` notes the ordering. F23 is still worth resolving on its own because F05 is currently `CHANGES_REQUESTED`-able and the operator's note on F05 ("you can just remove this agent") is a discretionary call, not a hard requirement.
