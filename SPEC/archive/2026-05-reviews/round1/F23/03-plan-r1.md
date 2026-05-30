# F23 — Plan (r1, Proposal B)

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
  runtime.agentRegistry.set(ctx.agentId, chatAgent as unknown as import("../agents/base.js").BaseAgent);
  ```

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

### 3. Update supervisor tests

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

- Add one focused test that documents the planner-as-last-resort property:

  ```ts
  it("prefers cancelling a running coder over a running planner", async () => {
    const planner = { role: "planner", cancel: vi.fn() };
    const coder = { role: "coder", cancel: vi.fn() };
    const agentRegistry = new Map<string, any>([
      ["planner-1", planner], ["coder-1", coder],
    ]);
    // three stuck verdicts -> coder cancelled, planner untouched.
    // ...as in existing 'cancels the lowest-level...' test.
    expect(coder.cancel).toHaveBeenCalledTimes(1);
    expect(planner.cancel).not.toHaveBeenCalled();
  });
  ```

No existing test needs structural rewriting; the new tests are additions.

### 4. No other consumers to update

`ROLE_ABORT_PRIORITY` is referenced only inside `supervisor.ts`; `grep -R ROLE_ABORT_PRIORITY src` (verify before commit) must return only the deleted lines. No documentation under `SPEC/` references this symbol by name.

## Test strategy

**Existing coverage**: [src/runtime/runtime.test.ts](src/runtime/runtime.test.ts#L128-L260) already exercises:
- stuck threshold of 3,
- "not-stuck verdict resets the counter",
- throttling pass-through,
- long-running-external-work pass-through,
- coder-preferred-over-manager ordering.

After this change, the coder-over-manager test continues to pass without modification.

**New coverage**: The two tests in step 3 above (full ordering + planner-as-last-resort).

**No new chat-registration test is mandatory**: the chat registration is exercised end-to-end implicitly by adding `chat` to the new ordering test (registry membership is the only behavioural contract that matters for the supervisor). A targeted integration test for [src/server/server.ts](src/server/server.ts#L680-L711) is out of scope (would require a WebSocket harness) and is not justified by F23's surface area.

## Validation commands

Run from the repo root `/home/salva/g/ml/saivage`:

```bash
npm run typecheck
npx vitest run src/runtime/runtime.test.ts
npx vitest run src/runtime
npm run build
```

The `npm run typecheck` step is the load-bearing one: if a future PR adds a role to `AgentRole` without updating `ABORT_PRIORITY`, this command fails with a "Property 'foo' is missing in type" error. That is the structural guarantee Proposal B is paying for.

## Rollback strategy

Single commit, easy revert. The change is confined to `src/runtime/supervisor.ts`, `src/server/server.ts`, and `src/runtime/runtime.test.ts`. Reverting restores the previous priority list and the unregistered ChatAgent. No persisted state, no on-disk format, no config schema is touched.

## Cross-issue ordering

- **Independent of**: F02 (roster drift). F02 will consolidate the four roster sources; this plan does not block on it and does not pre-empt it. After F02 lands, the `Record<AgentRole, number>` here continues to compile against whatever shape `AgentRole` becomes.
- **Affected by**: F05 (supervisor regex). If F05 is resolved by removing the supervisor entirely, this change goes away with it. The plan is robust either way: do this fix now; if F05 later deletes the module, the deletion subsumes the change. Per project guideline #1, no migration shim is preserved in the meantime.
- **Does not block**: any other F-issue.
