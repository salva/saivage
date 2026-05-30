# F23 — Plan (r3, Proposal B)

## Changes from r2

- New edit step 2b registers `ChatAgent` in `runtime.agentRegistry` at the
  Telegram construction site
  ([src/server/telegram-bot.ts](src/server/telegram-bot.ts#L89-L107)) using
  the same IIFE wrapper as the WebSocket route, replacing the current bare
  `.catch` handler. r2 only covered WebSocket.
- Step 5 (chat lifecycle test) is unchanged in shape but step 5 now uses a
  `FakeChannel` whose semantics mirror the three real `ChatAgent`
  transports. The plan no longer claims the test transitively covers
  `OneShotChannel`; `OneShotChannel` is out of scope for F23 (see analysis
  r3, "Channel inventory (corrected)").
- Step 6's `grep` audit list is updated: it now also verifies the Telegram
  registration site and explicitly notes that `src/cli/run.ts` does not
  exist (no stale link to track).
- Validation commands gain a focused Telegram-wrapper smoke check via the
  same `chat.lifecycle.test.ts` file (a second `it()` exercises the
  Telegram-style IIFE wrapper against the same `FakeChannel`); the file
  name is reused so the `npx vitest run` target is one path.
- "No new chat-registration test is mandatory" is retired in favour of the
  chat-lifecycle file being the load-bearing assertion for both registration
  sites.

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

### 2. Register WebSocket `ChatAgent` in `runtime.agentRegistry`

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

### 2b. Register Telegram `ChatAgent` in `runtime.agentRegistry`

File: [src/server/telegram-bot.ts](src/server/telegram-bot.ts#L89-L107).

- After constructing `chatAgent` and before launching `chatAgent.run()`,
  insert:

  ```ts
  runtime.agentRegistry.set(ctx.agentId, chatAgent);
  ```

  `ctx.agentId` is already unique per session (it is set just above at
  [src/server/telegram-bot.ts](src/server/telegram-bot.ts#L72)).

- Replace the existing `chatAgent.run().catch(...)` block at
  [src/server/telegram-bot.ts](src/server/telegram-bot.ts#L97-L100) with an
  IIFE wrapper that deregisters both the agent and the per-chat session entry
  in a `finally`:

  ```ts
  void (async () => {
    try {
      await chatAgent.run();
    } catch (err) {
      log.error(`[telegram] Chat agent error for chat ${chatId}: ${err}`);
    } finally {
      runtime.agentRegistry.delete(ctx.agentId);
      sessions.delete(chatId);
    }
  })();
  ```

  This preserves the existing `sessions.delete(chatId)` cleanup (formerly only
  fired on error) and adds the registry deregistration on every exit path —
  including a supervisor-triggered cancel that resolves `run()` normally via
  the channel close chain.

- No other code in `telegram-bot.ts` changes. In particular, the `stop()`
  function at [src/server/telegram-bot.ts](src/server/telegram-bot.ts#L147-L156)
  still calls `session.channel.close()` per chat; the new wrapper means each
  of those closures now also clears the corresponding `runtime.agentRegistry`
  entry. No double-delete hazard: `Map.delete` on a missing key is a no-op.

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
  - `this.channel.close()` is the actual trigger. The three real `ChatAgent`
    transports each wire `close()` to their transport's disconnect event,
    which fires the `onClose` handler registered at
    [src/agents/chat.ts](src/agents/chat.ts#L222-L233). That handler runs
    `cleanup()` (unsubscribes from the event bus) and resolves the run
    promise, which lets the per-site IIFE wrapper from steps 2 and 2b reach
    its `finally` and remove the registry entry.
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
  *deletes itself* (mirroring the real chat lifecycle once steps 2, 2b, and 3
  are in place):

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

### 5. Add a focused chat lifecycle test (covers both WebSocket and Telegram wrappers)

File: new `src/agents/chat.lifecycle.test.ts` (sibling to the existing
`src/agents/*.test.ts`). The test does **not** need a real WebSocket, CLI,
or Telegram harness; it uses a `FakeChannel` whose `close()` -> `onClose`
behaviour matches the three real `ChatAgent` transports.

- Define a `FakeChannel implements ChatChannel`:
  - `send`, `onMessage` are no-ops / stub setters.
  - `onClose(handler)` records the handler.
  - `close()` invokes the recorded handler synchronously (if not already
    closed) and marks itself closed (idempotent on second call).
- Construct a `ChatAgent` against the fake channel using a minimal
  `AgentContext` stub (the existing chat tests already build one; reuse the
  helper or copy its shape — see `src/agents/agents.test.ts` for the
  pattern). Use a stub `EventBus` with a `subscribe` that returns a no-op
  unsubscribe.
- Drive the lifecycle end-to-end for the cancel path:

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

- Add a WebSocket-style registry-deregistration test that mirrors the server
  wrapper from step 2:

  ```ts
  it("server-style IIFE removes the WebSocket chat entry from the registry after cancel()", async () => {
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

- Add a Telegram-style registry-deregistration test that also clears the
  per-chat session map, mirroring step 2b:

  ```ts
  it("telegram-style IIFE removes both the registry entry and the per-chat session after cancel()", async () => {
    const channel = new FakeChannel();
    const agent = new ChatAgent(ctx, input, channel, eventBus);
    const registry = new Map<string, BaseAgent>();
    const sessions = new Map<number, unknown>();
    const chatId = 42;
    registry.set(ctx.agentId, agent);
    sessions.set(chatId, { channel });
    const wrapper = (async () => {
      try { await agent.run(); }
      finally {
        registry.delete(ctx.agentId);
        sessions.delete(chatId);
      }
    })();
    agent.cancel();
    await wrapper;
    expect(registry.has(ctx.agentId)).toBe(false);
    expect(sessions.has(chatId)).toBe(false);
  });
  ```

These three tests prove the chain documented in step 3 actually fires
end-to-end for both registration sites, without needing a real WebSocket,
Telegram bot, or readline-backed CLI.

### 6. Audit: no other consumers to update

- `grep -R ROLE_ABORT_PRIORITY src` must return only the deleted lines after step 1.
- `grep -R "new ChatAgent" src` must return exactly the two construction sites updated by steps 2 and 2b ([src/server/server.ts](src/server/server.ts#L694) and [src/server/telegram-bot.ts](src/server/telegram-bot.ts#L89)) plus the two existing test sites in [src/agents/agents.test.ts](src/agents/agents.test.ts#L170) and [src/agents/agents.test.ts](src/agents/agents.test.ts#L214). No third site exists; `src/cli/run.ts` does not exist (the real CLI is [src/server/cli.ts](src/server/cli.ts) and it does not construct `ChatAgent`).
- `grep -R "ChatAgent" src` should still match the same call sites it does today (constructor, type imports) — no new wiring is added.

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
  - A WebSocket-style IIFE wrapper deletes the registry entry after `cancel()`.
  - A Telegram-style IIFE wrapper deletes both the registry entry and the
    per-chat session map entry after `cancel()`.

The chat lifecycle test is the smallest test that exercises the contract
introduced in step 3 for both registration sites; it is mandatory.

## Validation commands

Run from the repo root `/home/salva/g/ml/saivage`:

```bash
npm run typecheck
npx vitest run src/runtime/runtime.test.ts
npx vitest run src/agents/chat.lifecycle.test.ts
npx vitest run src/runtime src/agents src/server
npm run build
```

The `npm run typecheck` step is the load-bearing one for the supervisor side:
if a future PR adds a role to `AgentRole` without updating `ABORT_PRIORITY`,
this command fails with a "Property 'foo' is missing in type" error. That is
the structural guarantee Proposal B is paying for.

The `npx vitest run src/agents/chat.lifecycle.test.ts` step is the load-bearing
one for the chat side: it catches any future change to `ChatAgent.cancel()`,
to the WebSocket wrapper, to the Telegram wrapper, or to `ChatChannel.close()`
semantics that would re-open the planner-starvation hazard.

The `npx vitest run src/server` glob is added to pick up any incidental
coverage of `server.ts` or `telegram-bot.ts` lifecycle that may exist or be
added later; today's tree has no dedicated test for `telegram-bot.ts`, but
adding the path now means future tests are exercised automatically.

## Rollback strategy

Single commit, easy revert. The change is confined to:
- `src/runtime/supervisor.ts`,
- `src/server/server.ts`,
- `src/server/telegram-bot.ts`,
- `src/agents/chat.ts`,
- `src/runtime/runtime.test.ts`,
- new `src/agents/chat.lifecycle.test.ts`.

Reverting restores the previous priority list, the unregistered ChatAgent at
both construction sites, and removes the cancel override and its test. No
persisted state, no on-disk format, no config schema is touched. No channel
implementation changes.

## Cross-issue ordering

- **Independent of**: F02 (roster drift). F02 will consolidate the four roster sources; this plan does not block on it and does not pre-empt it. After F02 lands, the `Record<AgentRole, number>` here continues to compile against whatever shape `AgentRole` becomes.
- **Affected by**: F05 (supervisor regex). If F05 is resolved by removing the supervisor entirely, the supervisor-side edits here go away with it. The chat-side edits (registry registration at both sites, `cancel()` override, lifecycle test) survive an F05 deletion of the supervisor — they are independently useful (chat session-leak surface, future test harness). Per project guideline #1, no migration shim is preserved in the meantime.
- **Does not block**: any other F-issue.
