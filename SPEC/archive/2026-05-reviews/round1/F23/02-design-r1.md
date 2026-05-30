# F23 — Design (r1)

## Proposal A — Focused fix: extend the priority list to cover the full roster

**Scope**: [src/runtime/supervisor.ts](src/runtime/supervisor.ts#L13-L19) and the matching tests in [src/runtime/runtime.test.ts](src/runtime/runtime.test.ts#L128-L260). Optionally [src/server/server.ts](src/server/server.ts#L680-L711) to register `ChatAgent` so the new `"chat"` entry is reachable.

**What gets added**: Three roles appended to `ROLE_ABORT_PRIORITY` in the order `inspector`, `chat`, `planner`. Rationale for ordering:

- Workers/reviewer remain first — they are the cheapest to lose and the most likely culprit.
- `manager` stays in its current slot.
- `inspector` is added after `manager` because it is a one-shot diagnostic and losing it is recoverable.
- `chat` follows because killing a chat session is annoying but does not stall the autonomous loop.
- `planner` is last — only cancelled as a true last resort, since cancelling it triggers `RECOVERY_PROMPT` restart from [src/server/bootstrap.ts](src/server/bootstrap.ts#L515-L525).

**What gets removed**: Nothing. No deprecations.

**Registration fix (sub-task)**: `ChatAgent` is currently launched at [src/server/server.ts](src/server/server.ts#L694-L711) without ever being inserted into `runtime.agentRegistry`. To make the new `"chat"` entry actually reach a live agent, the registration/deregistration pattern from `runPlanner` ([src/server/bootstrap.ts](src/server/bootstrap.ts#L478-L498)) is mirrored at the chat session start/end points.

**Risk**: Low. The priority list grows; existing tests that enumerate it need updates, but no semantic change for the 5 currently-listed roles.

**What it enables**: Supervisor can now actually abort a stuck Planner or Inspector. Resolves the user-visible "stuck verdict reached but nothing aborted" log.

**What it forbids**: It does not stop the same drift recurring. A future ninth `AgentRole` will silently fall off the list again. That is the gap Proposal B closes.

**Cross-links**: Touches F02 (roster drift) only at the priority-list site; does not resolve F02's broader four-source disagreement.

**Recommendation note**: Acceptable as a minimum viable fix, but it does not address the root cause that produced this bug.

## Proposal B — One conceptual level up: derive the priority from `AgentRole` with an explicit ordering map (RECOMMENDED)

**Scope**: [src/runtime/supervisor.ts](src/runtime/supervisor.ts#L13-L19), [src/runtime/supervisor.ts](src/runtime/supervisor.ts#L143-L152), [src/runtime/runtime.test.ts](src/runtime/runtime.test.ts#L128-L260), and [src/server/server.ts](src/server/server.ts#L680-L711) for the chat-registration sub-task.

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

3. Register `ChatAgent` into `runtime.agentRegistry` in [src/server/server.ts](src/server/server.ts#L694-L711) using the same `set`/`delete` pattern as `runPlanner`. The chat session id is already unique enough to serve as the registry key; reusing `ctx.agentId` keeps it consistent with planner/worker registrations.

**What gets removed**: The unused `ROLE_ABORT_PRIORITY` array. No deprecation alias is kept (per project guideline #1).

**Risk**: Slightly higher than A because of the chat-registration change, but localized; the chat lifecycle is short and straightforward at the WebSocket open/close points.

**What it enables**:

- Closes the F23 bug.
- Forces compile-time roster sync: adding `"designer"` (the orphaned role from F01) or any new role to `AgentRole` becomes a noisy refactor instead of a silent drift. Hard-wires roster discipline that F02 calls for at this consumer.
- Makes the supervisor visible to chat sessions, which is a prerequisite for future supervisor features (chat-session leak detection, etc.) without re-opening the registration question.

**What it forbids**: A future contributor cannot add a new role without giving it an abort priority. They also cannot accidentally "soft-disable" supervision of a role by removing it from the list while leaving it in the union; the type system rejects partial maps. This is the desired property.

**Cross-links**:

- F02 (roster drift): this is a partial structural fix at the supervisor edge. F02 still needs to consolidate the four roster sources, but the supervisor side is now machine-checked.
- F05 (supervisor regex undermines verdict): if F05 ultimately removes the supervisor module entirely, this change vanishes with it. Until then, this fix improves an in-use module.

**Recommendation note**: Pick this one. The cost over Proposal A is one record literal and 10 lines of refactor; the win is type-system-enforced correctness for a class of bug we have already seen happen.

## Proposal C — Delete the supervisor module

**Scope**: Removes `src/runtime/supervisor.ts`, the supervisor bootstrap in [src/server/bootstrap.ts](src/server/bootstrap.ts#L247-L255), `config.supervisor` from `SaivageConfig`, and the tests in [src/runtime/runtime.test.ts](src/runtime/runtime.test.ts#L128-L260).

**Rationale**: F05 carries an operator comment that says "You can just remove this agent." If the operator decides to take that path, F23 is moot. Listing it here for completeness.

**Risk**: This is an architectural decision, not a bug fix. It must be driven by F05's resolution, not by F23.

**What it enables**: Eliminates `ROLE_ABORT_PRIORITY` and the entire abort-priority concept along with it.

**What it forbids**: Saivage loses any automated stuck-detection / abort. The operator note on F05 suggests this is acceptable.

**Cross-links**: F05 (primary), F04 (hardcoded supervisor model — also disappears).

**Recommendation note**: Not the F23 decision. F23 should fix the bug under the assumption that supervisor stays; if F05 later removes it, F23's change is reverted along with the file. Project guideline #1 keeps this clean — there is no migration debt to unwind.

## Recommendation

**Proposal B**. It costs one extra type-checked record, fixes the bug, and structurally prevents the same class of drift at this consumer point. Proposal A leaves a known footgun; Proposal C is contingent on a decision that belongs to F05.
