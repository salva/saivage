# F23 — Design (r3)

## Changes from r2

- Proposal B's scope now explicitly includes the Telegram construction site
  at [src/server/telegram-bot.ts](src/server/telegram-bot.ts#L89-L107). r2
  only listed the WebSocket route, which left a real class of chat sessions
  invisible to the supervisor.
- The chat-channel proof now lists only the three real `ChatAgent`
  transports (WebSocket, CLI, Telegram). `OneShotChannel` is documented as
  out-of-scope: it is not used as a `ChatAgent` transport anywhere, so the
  honest-cancel chain does not need to be defended for it. Fixing the
  `OneShotChannel.close()` no-op is left out of F23 because it does not
  contribute to the supervisor-priority bug; the project-guideline-clean
  alternative (deleting `OneShotChannel` outright, since it is dead code)
  is noted but deferred to its own issue if anyone files one.
- Proposal A's sub-variants are tightened: A1 must now register chat at
  both WebSocket and Telegram sites. There is no version of "chat in the
  priority list" that registers only one site.
- Proposal C unchanged.

## Proposal A — Focused fix: extend the priority list to cover the full roster (and only the roles that can honestly be aborted)

**Scope**: [src/runtime/supervisor.ts](src/runtime/supervisor.ts#L13-L19) and the matching tests in [src/runtime/runtime.test.ts](src/runtime/runtime.test.ts#L128-L260). If chat is included, also [src/server/server.ts](src/server/server.ts#L680-L711), [src/server/telegram-bot.ts](src/server/telegram-bot.ts#L46-L107), and [src/agents/chat.ts](src/agents/chat.ts#L132-L240) to register `ChatAgent` at both construction sites and override its `cancel()`.

**What gets added**: Roles appended to `ROLE_ABORT_PRIORITY` so that every
abortable role is reachable. Two sub-variants, depending on whether the chat
abort contract is implemented in this issue:

- A1 (chat included, with honest cancel and both registration sites):
  `inspector`, `chat`, `planner` appended in that order. Requires the
  registration sub-task at **both** WebSocket and Telegram, plus the
  cancel-override (see Proposal B for the concrete edits — identical here).
- A2 (chat excluded, no cancel override): only `inspector` and `planner`
  appended. `chat` stays off the list because no honest abort path is added
  in this issue.

Rationale for ordering (A1):

- Workers/reviewer remain first — they are the cheapest to lose and the most likely culprit.
- `manager` stays in its current slot.
- `inspector` is added after `manager` because it is a one-shot diagnostic and losing it is recoverable.
- `chat` follows because killing a chat session is annoying but does not stall the autonomous loop.
- `planner` is last — only cancelled as a true last resort, since cancelling it triggers `RECOVERY_PROMPT` restart from [src/server/bootstrap.ts](src/server/bootstrap.ts#L515-L525).

**What gets removed**: Nothing. No deprecations.

**Risk**: Low for A2; same as Proposal B for A1 (the chat sub-task is the
only non-trivial part).

**What it enables**: Supervisor can now actually abort a stuck Planner or
Inspector (both variants). In A1, also chat at both WebSocket and Telegram.

**What it forbids**: It does not stop the same drift recurring. A future ninth `AgentRole` will silently fall off the list again. That is the gap Proposal B closes.

**Cross-links**: Touches F02 (roster drift) only at the priority-list site; does not resolve F02's broader four-source disagreement.

**Recommendation note**: Acceptable as a minimum viable fix, but it does not address the root cause that produced this bug. A2 is the smallest possible patch — it leaves chat unsupervised by the abort path but does not create the planner-starvation hazard.

## Proposal B — One conceptual level up: derive the priority from `AgentRole` with an explicit ordering map and add a real chat abort path at both construction sites (RECOMMENDED)

**Scope**:

- [src/runtime/supervisor.ts](src/runtime/supervisor.ts#L13-L19) and [src/runtime/supervisor.ts](src/runtime/supervisor.ts#L143-L152) — typed priority map and simplified selector.
- [src/runtime/runtime.test.ts](src/runtime/runtime.test.ts#L128-L260) — extended supervisor tests.
- [src/server/server.ts](src/server/server.ts#L680-L711) — WebSocket chat lifecycle wrapper.
- [src/server/telegram-bot.ts](src/server/telegram-bot.ts#L86-L107) — Telegram chat lifecycle wrapper.
- [src/agents/chat.ts](src/agents/chat.ts#L132-L240) — `ChatAgent.cancel()` override.
- New `src/agents/chat.lifecycle.test.ts` — fake-channel lifecycle proof.

**What gets added**:

1. In [src/runtime/supervisor.ts](src/runtime/supervisor.ts), replace `ROLE_ABORT_PRIORITY: AgentRole[]` with a `Record<AgentRole, number>` of `ABORT_PRIORITY` (lower number = aborted first). Because the record's index signature is the full `AgentRole` union, TypeScript will fail to compile if a new role is added to `AgentRole` without a priority. This is the type-system enforcement that prevents future drift.

   ```ts
   const ABORT_PRIORITY: Record<AgentRole, number> = {
     reviewer: 0,
     data_agent: 1,
     coder: 2,
     researcher: 3,
     manager: 4,
     inspector: 5,
     chat: 6,
     planner: 7,
   };
   ```

2. `selectAbortTarget` is reduced to a single sort + first-match:

   ```ts
   private selectAbortTarget(): { agentId: string; role: AgentRole; agent: BaseAgent } | null {
     const sorted = [...this.context.agentRegistry.entries()]
       .map(([agentId, agent]) => ({ agentId, role: agent.role, agent }))
       .sort((a, b) => ABORT_PRIORITY[a.role] - ABORT_PRIORITY[b.role]);
     return sorted[0] ?? null;
   }
   ```

3. Register `ChatAgent` into `runtime.agentRegistry` at **both** construction sites:

   - **WebSocket** at [src/server/server.ts](src/server/server.ts#L694-L711): use the same `set`/`delete` pattern as `runPlanner` at [src/server/bootstrap.ts](src/server/bootstrap.ts#L478-L498), keyed by `ctx.agentId`.
   - **Telegram** at [src/server/telegram-bot.ts](src/server/telegram-bot.ts#L89-L107): same pattern, same `ctx.agentId` key. The existing `sessions.delete(chatId)` cleanup in the current `.catch` handler is replaced by an IIFE wrapper that both deregisters from `runtime.agentRegistry` and deletes the per-chat session entry in a `finally`.

4. **Chat-abort contract**: override `cancel()` on `ChatAgent` so that the
   supervisor's call to `agent.cancel()` actually drives the chat session to
   closure:

   ```ts
   // src/agents/chat.ts — inside class ChatAgent
   override cancel(): void {
     super.cancel();
     // Close the transport; the existing onClose handler at run() will
     // resolve the run promise and the per-site wrapper's finally clause
     // will remove the registry entry.
     void this.channel.close();
   }
   ```

   The chain is: supervisor `agent.cancel()` -> `ChatAgent.cancel()` sets the
   inherited `cancelled` flag and calls `channel.close()` -> the channel's
   `close()` triggers its internal close event (e.g. `ws.on("close")` in
   [src/channels/websocket.ts](src/channels/websocket.ts#L30-L33),
   `rl.on("close")` in [src/channels/cli.ts](src/channels/cli.ts#L26-L29),
   or the direct synchronous `closeHandler?.()` call in
   [src/channels/telegram.ts](src/channels/telegram.ts#L157-L161)) -> the
   registered closeHandler fires the chat agent's `onClose` callback at
   [src/agents/chat.ts](src/agents/chat.ts#L222-L233) -> `run()` resolves ->
   the per-site IIFE wrapper deletes the entry from `runtime.agentRegistry`.

   `void` is acceptable because the three real `ChatAgent` transports each
   make `close()` idempotent, and the supervisor does not await the result.
   The 10-minute force-cancel timer at
   [src/runtime/supervisor.ts](src/runtime/supervisor.ts#L101-L115) remains the
   ultimate fallback if a channel implementation ever stalls on close.

**What gets removed**: The unused `ROLE_ABORT_PRIORITY` array. No deprecation alias is kept (per project guideline #1). The pre-existing direct `chatAgent.run().catch(...)` invocations at [src/server/server.ts](src/server/server.ts#L708-L710) and [src/server/telegram-bot.ts](src/server/telegram-bot.ts#L97-L100) are replaced (not aliased) by IIFE wrappers with `finally` blocks.

**Risk**: Slightly higher than Proposal A because of the chat sub-task, but the
extra surface is narrow: one `override cancel()` method, two `set`/`delete`
pairs (WebSocket + Telegram), and two IIFE wrappers. No channel implementation
changes; the three real `ChatAgent` transports already implement `close()`
correctly.

**What it enables**:

- Closes the F23 bug at every layer: roster, chat registration at **both**
  construction sites, and honest cancel.
- Forces compile-time roster sync: adding `"designer"` (the orphaned role from F01) or any new role to `AgentRole` becomes a noisy refactor instead of a silent drift. Hard-wires roster discipline that F02 calls for at this consumer.
- Makes the supervisor visible to chat sessions across both transports, which is a prerequisite for future supervisor features (chat-session leak detection, etc.) without re-opening the registration question.
- Removes the planner-starvation hazard: after a chat session is selected and
  cancelled, its registry slot empties within one close round-trip, so the
  supervisor's next triple correctly selects the next live role and `planner`
  remains the genuine last resort.

**What it forbids**:

- A future contributor cannot add a new role without giving it an abort
  priority. They also cannot accidentally "soft-disable" supervision of a role
  by removing it from the list while leaving it in the union; the type system
  rejects partial maps. This is the desired property.
- A future contributor cannot subclass `BaseAgent` for a new transport-driven
  agent and add it to the priority list without also providing an honest
  `cancel()`; the planner-starvation regression is now documented and tested.
- A future contributor cannot add a third chat construction site without
  noticing the registry wiring — the WebSocket and Telegram wrappers serve as
  the obvious template.

**Cross-links**:

- F02 (roster drift): this is a partial structural fix at the supervisor edge. F02 still needs to consolidate the four roster sources, but the supervisor side is now machine-checked.
- F05 (supervisor regex undermines verdict): if F05 ultimately removes the supervisor module entirely, this change vanishes with it. Until then, this fix improves an in-use module. Note that the `ChatAgent.cancel()` override and the registry registration are independently useful (telegram/web-UI session leak surface, future test harness), so they survive an F05 deletion of the supervisor.

**Recommendation note**: Pick this one. The cost over Proposal A1 is zero (A1 implies the same chat work). The cost over Proposal A2 is one record literal, one `override cancel()` method, two IIFE wrappers, and ~10 lines of refactor; the win is type-system-enforced correctness for a class of bug we have already seen happen, plus a real abort path for chat at both construction sites instead of a registry phantom.

## Proposal C — Delete the supervisor module

**Scope**: Removes `src/runtime/supervisor.ts`, the supervisor bootstrap in [src/server/bootstrap.ts](src/server/bootstrap.ts#L247-L255), `config.supervisor` from `SaivageConfig`, and the tests in [src/runtime/runtime.test.ts](src/runtime/runtime.test.ts#L128-L260).

**Rationale**: F05 carries an operator comment that says "You can just remove this agent." If the operator decides to take that path, F23 is moot. Listing it here for completeness.

**Risk**: This is an architectural decision, not a bug fix. It must be driven by F05's resolution, not by F23.

**What it enables**: Eliminates `ROLE_ABORT_PRIORITY` and the entire abort-priority concept along with it.

**What it forbids**: Saivage loses any automated stuck-detection / abort. The operator note on F05 suggests this is acceptable.

**Cross-links**: F05 (primary), F04 (hardcoded supervisor model — also disappears).

**Recommendation note**: Not the F23 decision. F23 should fix the bug under the assumption that supervisor stays; if F05 later removes it, F23's change is reverted along with the file. Project guideline #1 keeps this clean — there is no migration debt to unwind.

## Recommendation

**Proposal B**. It costs one extra type-checked record plus a small chat-side
cancel override and two per-site IIFE wrappers, fixes the bug at every layer
(roster, registration at both WebSocket and Telegram, honest abort), and
structurally prevents the same class of drift at this consumer point.
Proposal A1 does the same chat work without the type-system safety; A2 leaves
a known footgun and an unsupervised long-running role; C is contingent on a
decision that belongs to F05.
