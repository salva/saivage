# G11 — Plan r2

**Finding**: [../G11-chat-restart-regex-english-only.md](../G11-chat-restart-regex-english-only.md)
**Analysis**: [./01-analysis-r2.md](./01-analysis-r2.md)
**Design**: [./02-design-r2.md](./02-design-r2.md) — Proposal B (delete the regex; update prompt; add ChatAgent-level regression).
**Review of r1**: [./04-review-r1.md](./04-review-r1.md)

## r2 deltas vs r1

1. **Prompt edit added.** New step 4 below edits [prompts/chat.md](../../../../prompts/chat.md) in the same change as the code deletion.
2. **Regression test moved to ChatAgent.** Step 5 replaces the r1 `dispatchLocalCommand`-only test (which would not fail against the current bug) with a ChatAgent-level test in [src/agents/agents.test.ts](../../../../src/agents/agents.test.ts), using the fake-channel/router harness at [src/agents/agents.test.ts#L626-L655](../../../../src/agents/agents.test.ts#L626-L655).
3. **Regex semantics.** Plan no longer asserts properties of the regex that don't hold (suffix/plural matching, Unicode-aware `\b`); only the truthful failure modes — exact-token match on three English verbs and `planner` — drive the test cases in step 5.
4. **Transversal scope.** Prompt edits and the ChatAgent-level regression are first-class steps with their own validation lines in §Validation, not optional checklist items.

## Steps

### 1. Delete the regex method

In [src/agents/chat.ts](../../../../src/agents/chat.ts#L352-L355), remove the entire `tryHandleExplicitPlannerRestart` method:

```ts
private async tryHandleExplicitPlannerRestart(content: string): Promise<string | null> {
  if (!/\b(restart|reset|relaunch)\b/i.test(content)) return null;
  if (!/\bplanner\b/i.test(content)) return null;
  return restartPlanner(this.localCommandContext(), content);
}
```

### 2. Delete the call site

In [src/agents/chat.ts](../../../../src/agents/chat.ts#L197-L202), remove the block between the slash-command dispatch and `injectMessage`:

```ts
const restartResult = await this.tryHandleExplicitPlannerRestart(content.trim());
if (restartResult !== null) {
  await this.channel.send(restartResult);
  this.recordMessage("assistant", restartResult);
  await this.saveChatLog();
  return;
}
```

After deletion, `handleUserMessage` flows directly from the `tryHandleCommand` early-return at [src/agents/chat.ts#L188-L196](../../../../src/agents/chat.ts#L188-L196) into `this.injectMessage(content)` at the line that follows the deleted block.

### 3. Drop the now-unused import

In [src/agents/chat.ts](../../../../src/agents/chat.ts#L34-L38), remove `restartPlanner` from the named imports of `../chat/localCommands.js`. The remaining named imports must be `dispatchLocalCommand` and `LocalCommandContext` (both are still referenced in `chat.ts`):

```ts
import {
  dispatchLocalCommand,
  type LocalCommandContext,
} from "../chat/localCommands.js";
```

After the edit, `grep -n "restartPlanner" src/agents/chat.ts` must return no matches. `restartPlanner` itself remains exported from [src/chat/localCommands.ts#L137-L158](../../../../src/chat/localCommands.ts#L137-L158) for use by `dispatchLocalCommand` and the existing slash-command tests.

### 4. Update the Chat system prompt

Edit [prompts/chat.md](../../../../prompts/chat.md) in four places. The new contract: Chat cannot restart the Planner; on a clear restart intent in free text, Chat directs the user to type `/restart-planner <reason>` and does nothing else.

4a. [prompts/chat.md#L7](../../../../prompts/chat.md#L7) — in the paragraph beginning "Internally, this conversation is handled by the Chat capability, …", replace the example list `"I can restart the Planner", "I have relayed that to the Planner", and "I found this in the current plan"` with examples that drop the restart claim, e.g. `"I have relayed that to the Planner", "I found this in the current plan", and "I dispatched the Inspector to look into this"`. Chat must not say "I can restart the Planner" anywhere in this file.

4b. [prompts/chat.md#L33](../../../../prompts/chat.md#L33) — in the "What You Cannot Do" list, replace the existing "You can request a Planner restart only when the user explicitly asks for it. …" bullet with:

> - You cannot restart the Planner. The Planner restart is a slash-command-only action: when a user asks to restart, reset, relaunch, or abort the current plan, answer with a single sentence telling them to type `/restart-planner <reason>` themselves. Do not claim to have restarted the Planner, and do not file a note for the restart.

4c. [prompts/chat.md#L43](../../../../prompts/chat.md#L43) — in the "Your Role" responsibility list, replace item 5 ("Restart the Planner on explicit request: …") with:

> 5. **Direct the user to the restart command on explicit request**: If the user clearly asks to restart, reset, or relaunch the Planner, reply with a one-line instruction to type `/restart-planner <reason>`. Do not invoke restart yourself; do not relay the request as a note.

4d. [prompts/chat.md#L51](../../../../prompts/chat.md#L51) — under "CRITICAL: Relaying User Orders", replace the "Planner restart requests …" bullet with:

> - **Planner restart requests** (restart the planner, reset the planner, relaunch planning, abort current plan): do NOT create a note for this and do NOT claim you restarted the Planner. Reply with a one-line instruction to type `/restart-planner <reason>` instead. Restart is a slash-command-only action.

After the edit, `grep -nE "request a Planner restart|I can restart the Planner|deterministic command path|restart note" prompts/chat.md` must return no matches.

### 5. Add a ChatAgent-level regression test

In [src/agents/agents.test.ts](../../../../src/agents/agents.test.ts), inside the existing `describe("ChatAgent", ...)` block at [src/agents/agents.test.ts#L227-L271](../../../../src/agents/agents.test.ts#L227-L271), append a new `it(...)` after the queue-rejection test. Reuse the fixtures already defined in the file: `TestChatChannel` at [src/agents/agents.test.ts#L626-L655](../../../../src/agents/agents.test.ts#L626-L655), `makeChatContext`, `deferred<T>`, and the `ChatRequest`/`ChatResponse` imports already in use.

Sketch (the exact `import type` names and `PlannerControl` shape come from [src/server/bootstrap.ts](../../../../src/server/bootstrap.ts) — pull them in alongside the existing `ChatAgent` import if not already present):

```ts
it("does not restart the Planner on free-text containing 'planner' and 'restart' (G11)", async () => {
  const routerCalls: ChatRequest[] = [];
  const router = {
    getMaxContextTokens: () => 200_000,
    countTokens: () => 0,
    chat: async (request: ChatRequest): Promise<ChatResponse> => {
      routerCalls.push(request);
      return {
        content: "ok",
        toolCalls: [],
        finishReason: "end_turn",
        usage: { inputTokens: 1, outputTokens: 1 },
      };
    },
  };

  const restartCalls: Array<{ reason: string; requestedBy: string }> = [];
  const plannerControl = {
    requestRestart: (reason: string, requestedBy: string) => {
      restartCalls.push({ reason, requestedBy });
      return { requestedAt: new Date().toISOString() };
    },
  } as unknown as PlannerControl;

  const bus = new EventBus();
  const publishedRestartEvents: string[] = [];
  const originalPublish = bus.publish.bind(bus);
  bus.publish = async (event) => {
    if (
      event.type === "plan_updated" &&
      typeof event.summary === "string" &&
      event.summary.startsWith("Planner restart requested from")
    ) {
      publishedRestartEvents.push(event.summary);
    }
    return originalPublish(event);
  };

  const channel = new TestChatChannel();
  const agent = new ChatAgent(
    makeChatContext(tmpDir, router),
    { channel: "web", sessionId: "web-1" },
    channel,
    bus,
    undefined,
    plannerControl,
  );

  const runPromise = agent.run();
  await channel.waitForHandler();

  await channel.receive("Why did the planner restart yesterday?");

  expect(restartCalls).toHaveLength(0);
  expect(publishedRestartEvents).toHaveLength(0);
  expect(routerCalls).toHaveLength(1);
  expect(JSON.stringify(routerCalls[0].messages)).toContain(
    "Why did the planner restart yesterday?",
  );

  channel.close();
  await runPromise;
});
```

This test fails against `main` (the buggy branch at [src/agents/chat.ts#L197-L202](../../../../src/agents/chat.ts#L197-L202) intercepts the message: `restartCalls.length` becomes 1, `publishedRestartEvents.length` becomes 1, and `routerCalls.length` stays 0). It passes only after both the call site and the method body are removed.

Do not add a parallel test to [src/chat/localCommands.test.ts](../../../../src/chat/localCommands.test.ts): `dispatchLocalCommand` already returns `null` for any input not starting with `/` ([src/chat/localCommands.ts#L86-L97](../../../../src/chat/localCommands.ts#L86-L97)), so any test at that layer would pass regardless of whether the ChatAgent bug is fixed.

### 6. Validation: type-check, lint, focused tests, full tests, build

From `/home/salva/g/ml/saivage`:

```bash
npx tsc --noEmit
npx eslint .
npx vitest run src/agents/agents.test.ts src/chat/localCommands.test.ts
npx vitest run
npm run build
```

- `npx tsc --noEmit` must report no errors. A surviving reference to `tryHandleExplicitPlannerRestart` or `restartPlanner` inside `chat.ts` is a hard error here.
- `npx eslint .` must report no errors. The unused-import case (if step 3 was missed) is caught by `no-unused-vars`.
- The focused `vitest run` over `src/agents/agents.test.ts` and `src/chat/localCommands.test.ts` must pass; the new G11 case in particular must pass (and on a checkout of `main` without the deletion, must fail with the assertions documented in step 5).
- The full `vitest run` must pass — no other test references `tryHandleExplicitPlannerRestart`, but the full run is required to catch any unanticipated coupling.
- `npm run build` must produce a fresh `dist/cli.js`.

### 7. Validation: prompt-edit grep

The prompt edit is not type-checked. Verify it with the negative greps listed in step 4 (no matches), plus:

```bash
grep -nE "/restart-planner <reason>" prompts/chat.md
```

This must match in at least three places (one per rewritten bullet at 4b, 4c, 4d).

### 8. Validation: live deployment smoke test

Per workspace handoff, only the `saivage-v3` container (10.0.3.112) is the validation target for v2-on-v3 work. After `npm run build`:

```bash
ssh root@10.0.3.112 systemctl restart saivage.service
ssh root@10.0.3.112 systemctl is-active saivage.service
curl -fsS http://10.0.3.112:8080/health
```

Manual smoke against the web UI chat panel on 10.0.3.112:

1. Send `Why did the planner restart yesterday?` — verify the LLM replies as a normal answer; verify no "Planner restart requested" assistant message is produced.
2. Send `Don't restart the planner.` — same.
3. Send `reinicia el planner` — verify the LLM replies, directing the user to `/restart-planner <reason>` per the new prompt contract; verify no restart fires.
4. Send `/restart-planner verify G11 fix` — verify the explicit command still produces the "Planner restart requested at …" reply and triggers a real restart.
5. Send `/planner-restart alias check` — verify the alias still works identically.

Runtime log inspection: `ssh root@10.0.3.112 journalctl -u saivage.service -f` during steps 1–3 must show no `plan_updated` event with summary starting `Planner restart requested from`. During steps 4–5, exactly one such event per command.

Do not restart `saivage.service` on `saivage` (10.0.3.111) or `diedrico` (10.0.3.113); those host other projects.

## Validation summary

| Check | Command | Pass criterion |
|---|---|---|
| Type-check | `npx tsc --noEmit` | no errors |
| Lint | `npx eslint .` | no errors |
| Focused tests | `npx vitest run src/agents/agents.test.ts src/chat/localCommands.test.ts` | all pass, including the new G11 ChatAgent test |
| Full tests | `npx vitest run` | all pass |
| Build | `npm run build` | fresh `dist/cli.js` produced |
| Prompt edit (negative grep) | `grep -nE "request a Planner restart\|I can restart the Planner\|deterministic command path\|restart note" prompts/chat.md` | no matches |
| Prompt edit (positive grep) | `grep -nE "/restart-planner <reason>" prompts/chat.md` | at least 3 matches |
| Runtime smoke | manual steps 1–5 in §8 | restart fires only on slash commands |

## Rollback

Single-commit, single-revert change. No persistent state is touched (no schema migration, no on-disk format change, no MCP tool addition), so rollback is bit-for-bit identical to the pre-change runtime.

```bash
cd /home/salva/g/ml/saivage
git revert --no-edit <commit-sha>     # or: git checkout HEAD~1 -- src/agents/chat.ts prompts/chat.md src/agents/agents.test.ts
npm run build
ssh root@10.0.3.112 systemctl restart saivage.service
```

After revert: the regex shortcut returns, the prompt's "request a Planner restart" lines return, the new ChatAgent regression test is gone, and the runtime behaves exactly as `main` did before the fix. No further cleanup needed.

## Cross-finding

- **G09** (planner `PLAN_COMPLETE` text protocol): same anti-pattern (regex-as-control-surface), same architectural fix shape (delete the heuristic, rely on the structured tool). Independent files; can ship in any order. Joint check after both ship: `git grep -nE "\b/(\b\(restart\|reset\|relaunch\)\b|/i" src/` must return no matches.
- **F30** (`localCommands.ts` dispatcher): already in place; no change required.
- **G44 / F35** (control-channel docs): `git grep -nE "tryHandleExplicitPlannerRestart|restart the planner" docs/ specs/ prompts/` must return no matches outside of [prompts/chat.md](../../../../prompts/chat.md) (which is rewritten per step 4) and SPEC review files (G11 review trail itself).
