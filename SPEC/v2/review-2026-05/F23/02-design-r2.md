# F23 — Design (r2)

## Changes from r1

- Proposal B now folds the chat-abort contract into the recommended fix. The
  registration sub-task gains an explicit `ChatAgent.cancel()` override that
  calls `super.cancel()` and `this.channel.close()`, which is the only way the
  registered entry will ever leave `runtime.agentRegistry`.
- Proposal A is updated for symmetry: if chat is added to the priority list,
  the registration *and* the cancel override come with it; otherwise chat is
  not added to the priority list at all (the reviewer's "don't include chat
  if you can't honor the contract" alternative).
- The "What it forbids" sections now name the planner-starvation hazard
  explicitly and explain how each proposal prevents it.
- Proposal C unchanged; still listed for completeness, still not the F23
  decision.

## Proposal A — Focused fix: extend the priority list to cover the full roster (and only the roles that can honestly be aborted)

**Scope**: [src/runtime/supervisor.ts](src/runtime/supervisor.ts#L13-L19) and the matching tests in [src/runtime/runtime.test.ts](src/runtime/runtime.test.ts#L128-L260). If chat is included, also [src/server/server.ts](src/server/server.ts#L680-L711) and [src/agents/chat.ts](src/agents/chat.ts#L208-L211) to register `ChatAgent` and override its `cancel()`.

**What gets added**: Roles appended to `ROLE_ABORT_PRIORITY` so that every
abortable role is reachable. Two sub-variants, depending on whether the chat
abort contract is implemented in this issue:

- A1 (chat included, with honest cancel): `inspector`, `chat`, `planner`
  appended in that order. Requires the registration + cancel-override sub-task
  (see Proposal B for the concrete edits — identical here).
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
Inspector (both variants). In A1, also chat.

**What it forbids**: It does not stop the same drift recurring. A future ninth `AgentRole` will silently fall off the list again. That is the gap Proposal B closes.

**Cross-links**: Touches F02 (roster drift) only at the priority-list site; does not resolve F02's broader four-source disagreement.

**Recommendation note**: Acceptable as a minimum viable fix, but it does not address the root cause that produced this bug. A2 is the smallest possible patch — it leaves chat unsupervised by the abort path but does not create the planner-starvation hazard.

## Proposal B — One conceptual level up: derive the priority from `AgentRole` with an explicit ordering map and add a real chat abort path (RECOMMENDED)

**Scope**: [src/runtime/supervisor.ts](src/runtime/supervisor.ts#L13-L19), [src/runtime/supervisor.ts](src/runtime/supervisor.ts#L143-L152), [src/runtime/runtime.test.ts](src/runtime/runtime.test.ts#L128-L260), [src/server/server.ts](src/server/server.ts#L680-L711), and [src/agents/chat.ts](src/agents/chat.ts#L208-L211) for the chat lifecycle sub-task.

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

3. Register `ChatAgent` into `runtime.agentRegistry` in [src/server/server.ts](src/server/server.ts#L694-L711) using the same `set`/`delete` pattern as `runPlanner` at [src/server/bootstrap.ts](src/server/bootstrap.ts#L478-L498). The chat session id is already unique enough to serve as the registry key; reusing `ctx.agentId` keeps it consistent with planner/worker registrations.

4. **Chat-abort contract (new in r2)**: override `cancel()` on `ChatAgent` so
   that the supervisor's call to `agent.cancel()` actually drives the chat
   session to closure:

   ```ts
   // src/agents/chat.ts — inside class ChatAgent
   override cancel(): void {
     super.cancel();
     // Close the transport; the existing onClose handler at run() will
     // resolve the run promise and the server wrapper's finally clause
     // will remove the registry entry.
     void this.channel.close();
   }
   ```

   The chain is: supervisor `agent.cancel()` -> `ChatAgent.cancel()` sets the
   inherited `cancelled` flag and calls `channel.close()` -> the channel's
   `close()` triggers its internal close event (e.g. `ws.on("close")` in
   [src/channels/websocket.ts](src/channels/websocket.ts#L30-L33)) -> the
   registered closeHandler fires the chat agent's `onClose` callback at
   [src/agents/chat.ts](src/agents/chat.ts#L223-L232) -> `run()` resolves ->
   the IIFE wrapper in the server's WebSocket route deletes the entry from
   `runtime.agentRegistry`.

   `void` is acceptable because the channel's close path is idempotent across
   all four implementations and the supervisor does not await the result.
   The 10-minute force-cancel timer at
   [src/runtime/supervisor.ts](src/runtime/supervisor.ts#L101-L115) remains the
   ultimate fallback if a channel implementation ever stalls on close.

**What gets removed**: The unused `ROLE_ABORT_PRIORITY` array. No deprecation alias is kept (per project guideline #1). The pre-existing direct `chatAgent.run().catch(...)` invocation at [src/server/server.ts](src/server/server.ts#L708-L710) is replaced (not aliased) by the IIFE wrapper with a `finally`.

**Risk**: Slightly higher than Proposal A because of the chat sub-task, but the
extra surface is narrow: one `override cancel()` method, one `set`/`delete`
pair, and the IIFE wrapper. No channel implementation changes; all four
already implement `close()` correctly.

**What it enables**:

- Closes the F23 bug at both layers (roster + chat registration + honest
  cancel).
- Forces compile-time roster sync: adding `"designer"` (the orphaned role from F01) or any new role to `AgentRole` becomes a noisy refactor instead of a silent drift. Hard-wires roster discipline that F02 calls for at this consumer.
- Makes the supervisor visible to chat sessions, which is a prerequisite for
  future supervisor features (chat-session leak detection, etc.) without
  re-opening the registration question.
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

**Cross-links**:

- F02 (roster drift): this is a partial structural fix at the supervisor edge. F02 still needs to consolidate the four roster sources, but the supervisor side is now machine-checked.
- F05 (supervisor regex undermines verdict): if F05 ultimately removes the supervisor module entirely, this change vanishes with it. Until then, this fix improves an in-use module. Note that the `ChatAgent.cancel()` override and the registry registration are independently useful (telegram/web-UI session leak surface, future test harness), so they survive an F05 deletion of the supervisor.

**Recommendation note**: Pick this one. The cost over Proposal A1 is zero (A1 implies the same chat work). The cost over Proposal A2 is one record literal, one `override cancel()` method, one IIFE wrapper, and ~10 lines of refactor; the win is type-system-enforced correctness for a class of bug we have already seen happen, plus a real abort path for chat instead of a registry phantom.

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
cancel override, fixes the bug at every layer (roster, registration, honest
abort), and structurally prevents the same class of drift at this consumer
point. Proposal A1 does the same chat work without the type-system safety;
A2 leaves a known footgun and an unsupervised long-running role; C is
contingent on a decision that belongs to F05.
