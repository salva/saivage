# F23 — Plan (r2, Proposal B)

## Changes from r1

- Added a new edit step (step 3) to override `ChatAgent.cancel()` so that
  `super.cancel()` runs and `this.channel.close()` is invoked. This is the
  honest abort path the reviewer required.
- Step 2 (registry set/delete) is unchanged in shape but cross-references the
  new step 3 so the two reads/writes are reviewed together.
- Step 4 (existing step 3 in r1, supervisor tests) gains an explicit chat
  lifecycle unit test using a fake `ChatChannel`, plus a planner-starvation
  regression test that asserts `planner` becomes selectable after the chat
  entry is removed by the cancel chain.
- The "no new chat-registration test is mandatory" paragraph from r1 is
  deleted; the reviewer correctly noted that registry membership alone is not
  the contract.
- Validation commands gain the `src/agents/chat.test.ts` Vitest target.

## Ordered edit steps

### 1. Replace the priority list with a typed record (supervisor)

File: [src/runtime/supervisor.ts](src/runtime/supervisor.ts#L13-L19) and [src/runtime/supervisor.ts](src/runtime/supervisor.ts#L143-L152).

- Delete the existing `const ROLE_ABORT_PRIORITY: AgentRole[] = [...]` block.
- Add a `Record<AgentRole, number>` named `ABORT_PRIORITY` in the same location:

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

- Rewrite `selectAbortTarget` to a single sort over the registry:

  ```ts
  private selectAbortTarget(): { agentId: string; role: AgentRole; agent: BaseAgent } | null {
    const sorted = [...this.context.agentRegistry.entries()]
      .map(([agentId, agent]) => ({ agentId, role: agent.role, agent }))
      .sort((a, b) => ABORT_PRIORITY[a.role] - ABORT_PRIORITY[b.role]);
    return sorted[0] ?? null;
  }
  ```

- No other code in `supervisor.ts` changes.

### 2. Register `ChatAgent` in `runtime.agentRegistry`

File: [src/server/server.ts](src/server/server.ts#L680-L711).

- After constructing `chatAgent`, before `chatAgent.run()`, insert:

  ```ts
  runtime.agentRegistry.set(ctx.agentId, chatAgent);
  ```

  No cast is needed: `ChatAgent` extends `BaseAgent`, which is the registry's
  value type.

- Replace the unstructured `chatAgent.run().catch(...)` with a wrapper that removes the registration in a `finally`:

  ```ts
  void (async () => {
    try {
      await chatAgent.run();
    } catch (err) {
      log.error(`[server] Chat agent error: ${err}`);
    } finally {
      runtime.agentRegistry.delete(ctx.agentId);
    }
  })();
  ```

- The same pattern is used for `runPlanner` at [src/server/bootstrap.ts](src/server/bootstrap.ts#L478-L498); this mirrors it.
- Do **not** add tracker `agentStarted/agentStopped` calls here — chat sessions intentionally stay outside the operator tracker (web view shows them through a different surface). This plan touches only registry membership.

### 3. Override `ChatAgent.cancel()` to drive an honest abort

File: [src/agents/chat.ts](src/agents/chat.ts#L132-L240) (the class body).

- Add a single method override on `ChatAgent`:

  ```ts
  // src/agents/chat.ts — inside class ChatAgent
  override cancel(): void {
    super.cancel();
    void this.channel.close();
  }
  ```

- Rationale:
  - `super.cancel()` keeps the inherited contract (`this.cancelled = true`),
    which is observed by any future code path that re-enters `BaseAgent.runLoop()`
    (none today, but it is the documented contract at
    [src/agents/base.ts](src/agents/base.ts#L208-L211)).
  - `this.channel.close()` is the actual trigger. Every `ChatChannel`
    implementation wires `close()` to its transport's disconnect event, which
    fires the `onClose` handler registered at
    [src/agents/chat.ts](src/agents/chat.ts#L223-L232). That handler runs
    `cleanup()` (unsubscribes from the event bus) and resolves the run
    promise, which lets the server's IIFE wrapper from step 2 reach its
    `finally` and remove the registry entry.
  - `void` is correct: `close()` may return `void | Promise<void>` per
    [src/channels/types.ts](src/channels/types.ts#L5-L17), but the supervisor
    does not await `agent.cancel()` ([src/runtime/supervisor.ts](src/runtime/supervisor.ts#L101-L115)),
    and the 10-minute force-cancel timer is the documented safety net if a
    transport ever fails to close.

- No other code in `chat.ts` changes. Do not modify `run()`, `cleanup()`, or
  the existing `onClose` wiring — they already do the right thing once
  `close()` is called.

### 4. Update / add supervisor tests

File: [src/runtime/runtime.test.ts](src/runtime/runtime.test.ts#L128-L260).

- The "cancels the lowest-level running agent after three stuck verdicts" test (currently at [src/runtime/runtime.test.ts](src/runtime/runtime.test.ts#L150-L177)) already exercises `coder` < `manager`. Keep it.
- Add a new test asserting the full ordering. The test seeds the registry with one agent per role and asserts the supervisor cancels them in the documented order across successive `checkOnce()` triples. Pseudocode:

  ```ts
  it("aborts roles in the order reviewer -> data_agent -> coder -> researcher -> manager -> inspector -> chat -> planner", async () => {
    const order = ["reviewer", "data_agent", "coder", "researcher", "manager", "inspector", "chat", "planner"] as const;
    const cancels = Object.fromEntries(order.map((r) => [r, vi.fn()]));
    const agentRegistry = new Map<string, any>(
      order.map((role) => [`${role}-1`, { role, cancel: cancels[role] }]),
    );
    const router = { chat: vi.fn(async () => ({
      content: JSON.stringify({ stuck: true, confidence: 0.95, reason: "persistent retry loop", evidence: [] }),
      toolCalls: [], finishReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1 },
    })) };
    const supervisor = new RuntimeSupervisor(makeSupervisorConfig(), { router: router as any, agentRegistry });
    for (const role of order) {
      cancels[role].mockClear();
      await supervisor.checkOnce();
      await supervisor.checkOnce();
      await supervisor.checkOnce();
      expect(cancels[role]).toHaveBeenCalledTimes(1);
      agentRegistry.delete(`${role}-1`);
    }
  });
  ```

- Add a planner-starvation regression test that uses a fake whose `cancel()`
  *deletes itself* (mirroring the real chat lifecycle once steps 2 + 3 are in
  place):

  ```ts
  it("does not starve planner when chat is the highest-priority live entry", async () => {
    const planner = { role: "planner", cancel: vi.fn() };
    const agentRegistry = new Map<string, any>();
    const chat = {
      role: "chat",
      cancel: vi.fn(() => { agentRegistry.delete("chat-1"); }),
    };
    agentRegistry.set("chat-1", chat);
    agentRegistry.set("planner-1", planner);

    const router = { chat: vi.fn(async () => ({
      content: JSON.stringify({ stuck: true, confidence: 0.95, reason: "...", evidence: [] }),
      toolCalls: [], finishReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1 },
    })) };
    const supervisor = new RuntimeSupervisor(makeSupervisorConfig(), { router: router as any, agentRegistry });

    // First triple: chat is the highest-priority live role -> cancelled, removed.
    await supervisor.checkOnce(); await supervisor.checkOnce(); await supervisor.checkOnce();
    expect(chat.cancel).toHaveBeenCalledTimes(1);
    expect(planner.cancel).not.toHaveBeenCalled();

    // Second triple: only planner is left -> finally cancelled as last resort.
    await supervisor.checkOnce(); await supervisor.checkOnce(); await supervisor.checkOnce();
    expect(planner.cancel).toHaveBeenCalledTimes(1);
  });
  ```

- Keep the existing "prefers cancelling a running coder over a running planner"
  test from r1 (still useful as a focused last-resort assertion):

  ```ts
  it("prefers cancelling a running coder over a running planner", async () => {
    const planner = { role: "planner", cancel: vi.fn() };
    const coder = { role: "coder", cancel: vi.fn() };
    const agentRegistry = new Map<string, any>([
      ["planner-1", planner], ["coder-1", coder],
    ]);
    // three stuck verdicts -> coder cancelled, planner untouched.
    expect(coder.cancel).toHaveBeenCalledTimes(1);
    expect(planner.cancel).not.toHaveBeenCalled();
  });
  ```

No existing test needs structural rewriting; the new tests are additions.

### 5. Add a focused chat lifecycle test

File: new `src/agents/chat.lifecycle.test.ts` (sibling to the existing
`src/agents/*.test.ts`). The test does **not** need a WebSocket harness; it
uses a fake `ChatChannel`.

- Define a `FakeChannel implements ChatChannel`:
  - `send`, `onMessage` are no-ops / stub setters.
  - `onClose(handler)` records the handler.
  - `close()` invokes the recorded handler synchronously and marks itself
    closed (idempotent on second call).
- Construct a `ChatAgent` against the fake channel using a minimal
  `AgentContext` stub (the existing chat tests already build one; reuse the
  helper or copy its shape — see `src/agents/*.test.ts`). Use a stub
  `EventBus` with a `subscribe` that returns a no-op unsubscribe.
- Drive the lifecycle end-to-end:

  ```ts
  it("closes the channel and resolves run() when cancel() is called", async () => {
    const channel = new FakeChannel();
    const agent = new ChatAgent(ctx, input, channel, eventBus);
    const runPromise = agent.run();
    agent.cancel();
    const result = await runPromise;
    expect(channel.closed).toBe(true);
    expect(result.kind).toBe("success");
  });
  ```

- Add a registry-deregistration test that mirrors the server wrapper:

  ```ts
  it("server-style IIFE removes the chat entry from the registry after cancel()", async () => {
    const channel = new FakeChannel();
    const agent = new ChatAgent(ctx, input, channel, eventBus);
    const registry = new Map<string, BaseAgent>();
    registry.set(ctx.agentId, agent);
    const wrapper = (async () => {
      try { await agent.run(); }
      finally { registry.delete(ctx.agentId); }
    })();
    agent.cancel();
    await wrapper;
    expect(registry.has(ctx.agentId)).toBe(false);
  });
  ```

These two tests prove the chain documented in step 3 actually fires end-to-end
without needing a real WebSocket.

### 6. No other consumers to update

`ROLE_ABORT_PRIORITY` is referenced only inside `supervisor.ts`; `grep -R ROLE_ABORT_PRIORITY src` (verify before commit) must return only the deleted lines. `ChatAgent.cancel` does not exist before this change; `grep -R "ChatAgent" src` should still match the same call sites it does today (constructor, type imports) — no new wiring is added.

## Test strategy

**Existing coverage**: [src/runtime/runtime.test.ts](src/runtime/runtime.test.ts#L128-L260) already exercises:
- stuck threshold of 3,
- "not-stuck verdict resets the counter",
- throttling pass-through,
- long-running-external-work pass-through,
- coder-preferred-over-manager ordering.

After this change, the coder-over-manager test continues to pass without modification.

**New coverage**:
- Full priority ordering across all eight roles (step 4).
- Planner-starvation regression: a chat fake whose `cancel()` removes itself
  proves the supervisor unblocks planner on the next triple (step 4).
- Chat lifecycle unit tests (step 5):
  - `cancel()` closes the channel and resolves `run()`.
  - A server-style IIFE wrapper deletes the registry entry after `cancel()`.

The chat lifecycle test is **mandatory** under r2 (overriding the r1 claim
that registry membership alone was sufficient). It is the smallest test that
exercises the contract introduced in step 3.

## Validation commands

Run from the repo root `/home/salva/g/ml/saivage`:

```bash
npm run typecheck
npx vitest run src/runtime/runtime.test.ts
npx vitest run src/agents/chat.lifecycle.test.ts
npx vitest run src/runtime src/agents
npm run build
```

The `npm run typecheck` step is the load-bearing one for the supervisor side:
if a future PR adds a role to `AgentRole` without updating `ABORT_PRIORITY`,
this command fails with a "Property 'foo' is missing in type" error. That is
the structural guarantee Proposal B is paying for.

The `npx vitest run src/agents/chat.lifecycle.test.ts` step is the load-bearing
one for the chat side: it catches any future change to `ChatAgent.cancel()` or
to `ChatChannel.close()` semantics that would re-open the planner-starvation
hazard.

## Rollback strategy

Single commit, easy revert. The change is confined to:
- `src/runtime/supervisor.ts`,
- `src/server/server.ts`,
- `src/agents/chat.ts`,
- `src/runtime/runtime.test.ts`,
- new `src/agents/chat.lifecycle.test.ts`.

Reverting restores the previous priority list, the unregistered ChatAgent,
and removes the cancel override and its test. No persisted state, no on-disk
format, no config schema is touched. No channel implementation changes.

## Cross-issue ordering

- **Independent of**: F02 (roster drift). F02 will consolidate the four roster sources; this plan does not block on it and does not pre-empt it. After F02 lands, the `Record<AgentRole, number>` here continues to compile against whatever shape `AgentRole` becomes.
- **Affected by**: F05 (supervisor regex). If F05 is resolved by removing the supervisor entirely, the supervisor-side edits here go away with it. The chat-side edits (registry registration, `cancel()` override, lifecycle test) survive an F05 deletion of the supervisor — they are independently useful (chat session-leak surface, future test harness). Per project guideline #1, no migration shim is preserved in the meantime.
- **Does not block**: any other F-issue.
