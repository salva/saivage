# G11 — Plan r1

**Finding**: [../G11-chat-restart-regex-english-only.md](../G11-chat-restart-regex-english-only.md)
**Analysis**: [./01-analysis-r1.md](./01-analysis-r1.md)
**Design**: [./02-design-r1.md](./02-design-r1.md) — Proposal B (delete the regex; rely on `/restart-planner`).

## Steps

1. **Delete the regex method.** In [src/agents/chat.ts](../../../../src/agents/chat.ts#L352-L356), remove the entire `tryHandleExplicitPlannerRestart` method:

   ```ts
   private async tryHandleExplicitPlannerRestart(content: string): Promise<string | null> {
     if (!/\b(restart|reset|relaunch)\b/i.test(content)) return null;
     if (!/\bplanner\b/i.test(content)) return null;
     return restartPlanner(this.localCommandContext(), content);
   }
   ```

2. **Delete the call site.** In [src/agents/chat.ts](../../../../src/agents/chat.ts#L197-L202), remove the block between the slash-command dispatch and `injectMessage`:

   ```ts
   const restartResult = await this.tryHandleExplicitPlannerRestart(content.trim());
   if (restartResult !== null) {
     await this.channel.send(restartResult);
     this.recordMessage("assistant", restartResult);
     await this.saveChatLog();
     return;
   }
   ```

   `handleUserMessage` now flows directly from `tryHandleCommand` to `this.injectMessage(content)` at the line that follows the deleted block.

3. **Drop the now-unused import.** In [src/agents/chat.ts](../../../../src/agents/chat.ts#L36), remove `restartPlanner` from the named imports of `../chat/localCommands.js`. Keep `dispatchLocalCommand`, `LocalCommandContext`, and any other names that remain referenced (`tryHandleCommand` already uses `dispatchLocalCommand` at [src/agents/chat.ts](../../../../src/agents/chat.ts#L259)). After the edit, run `npx tsc --noEmit` to confirm no other reference to `restartPlanner` exists inside `chat.ts`.

4. **Add a negative regression test.** In [src/chat/localCommands.test.ts](../../../../src/chat/localCommands.test.ts), add a new `describe` block after the existing `dispatchLocalCommand — restart-planner alias` block (around [src/chat/localCommands.test.ts](../../../../src/chat/localCommands.test.ts#L187-L199)):

   ```ts
   describe("dispatchLocalCommand — no fuzzy restart on free text (G11)", () => {
     it.each([
       "Why did the planner restart yesterday?",
       "Reset the test fixtures, not the planner",
       "Don't restart the planner.",
       "please reboot the planner",
       "reinicia el planner",
     ])("returns null for free text %p", async (text) => {
       const ctx = makeCtx();
       const reply = await dispatchLocalCommand(text, ctx);
       expect(reply).toBeNull();
       expect(ctx._restartCalls).toHaveLength(0);
       expect(ctx._publishCalls).toHaveLength(0);
     });
   });
   ```

   This codifies the architectural invariant: only slash commands trigger the restart handler. Free-text messages — including ones containing the literal words `restart` and `planner` — must fall through (`dispatchLocalCommand` returns `null`) so the caller can hand them to the LLM.

5. **Type-check, lint, unit-test, build.** From `/home/salva/g/ml/saivage`:

   ```bash
   npx tsc --noEmit
   npx eslint .
   npx vitest run src/chat/localCommands.test.ts src/agents/chat.ts
   npm run build
   ```

   `tsc` must report no errors (this catches a stale `restartPlanner` import or any other reference to the deleted method). `eslint` catches the unused-import case if step 3 was missed. `vitest` runs the new negative tests plus the existing slash-command alias tests. `npm run build` produces a fresh `dist/cli.js` for the deployment in step 6.

6. **Deploy to the v2-on-v3 harness only.** Per workspace handoff, `/home/salva/g/ml/saivage/src` and `dist` are bind-mounted into all three v2 containers, but only `saivage-v3` (10.0.3.112) is the validation target for v2-on-v3 work. Restart `saivage.service` there and confirm the runtime is healthy:

   ```bash
   ssh root@10.0.3.112 systemctl restart saivage.service
   ssh root@10.0.3.112 systemctl is-active saivage.service
   curl -fsS http://10.0.3.112:8080/health
   ```

   Do **not** restart `saivage.service` on `saivage` (10.0.3.111) or `diedrico` (10.0.3.113); those deployments host other projects and are out of scope.

## Validation

- **Static**: `npx tsc --noEmit` and `npx eslint .` from `/home/salva/g/ml/saivage` both clean. A surviving reference to `tryHandleExplicitPlannerRestart` or `restartPlanner` inside `chat.ts` is a hard error.
- **Unit**: `npx vitest run src/chat/localCommands.test.ts` — all existing tests pass; the new G11 negative tests pass; no fuzzy restart fires on any of the five free-text inputs in step 4.
- **Manual smoke (live `saivage-v3` harness on 10.0.3.112)**:
  1. Open the web UI's chat panel.
  2. Send `Why did the planner restart yesterday?` — verify the LLM replies normally (and *does not* respond with a "Planner restart requested" message).
  3. Send `Don't restart the planner.` — verify the same.
  4. Send `reinicia el planner` — verify the LLM handles it as free text; no restart fires.
  5. Send `/restart-planner verify G11 fix` — verify the explicit command still produces the "Planner restart requested at …" reply and triggers a real restart (the runtime log should show the Planner cancelling and respawning).
  6. Send `/planner-restart alias check` — verify the alias still works identically.
- **Runtime log inspection**: tail `journalctl -u saivage.service` on `saivage-v3` during steps (b)–(d) and assert no `plan_updated` event with summary starting `Planner restart requested from` is published. During steps (e)–(f) assert exactly one such event per command.

## Rollback

Single-commit, single-file revert is enough. Restore `src/agents/chat.ts` from the previous commit (`git checkout HEAD~1 -- src/agents/chat.ts`), drop the new tests added in step 4 (`git checkout HEAD~1 -- src/chat/localCommands.test.ts`), rebuild (`npm run build`), and restart `saivage.service` on `saivage-v3`. No persistent state is touched by this change (no schema migration, no on-disk format change, no MCP tool addition), so rollback is bit-for-bit identical to the pre-change runtime.

## Cross-finding

- **G09** (planner `PLAN_COMPLETE` text protocol): same anti-pattern (regex-as-control-surface), same architectural fix shape (delete the heuristic, rely on the structured tool). Independent files; can ship in any order. Joint validation message: after both ship, there is no `/\b(...)\b/i.test(user_input)` pattern remaining in either the Planner termination path or the Chat dispatch path.
- **F30** (`localCommands.ts` dispatcher): the design relies on F30's slash-command registry being the canonical control surface. F30 already ships; no change required.
- **G44 / F35** (control-channel docs): if any user-facing doc described the fuzzy restart shortcut, update it in the same commit. A repo-wide search for `tryHandleExplicitPlannerRestart` and for the phrase "restart the planner" in `docs/` and `prompts/` should be part of the implementer's checklist; if no docs reference it, this cross-link is a no-op.
