# G11 — Design r3

**Finding**: [../G11-chat-restart-regex-english-only.md](../G11-chat-restart-regex-english-only.md)
**Analysis**: [./01-analysis-r3.md](./01-analysis-r3.md)
**Review of r2**: [./04-review-r2.md](./04-review-r2.md)

Two proposals. B (recommended, unchanged direction from r1/r2) deletes the fuzzy restart shortcut, rewrites the five Chat-system-prompt directives that say Chat can restart the Planner, and adds a ChatAgent-level regression test. A is retained only as the explicitly rejected focused alternative, with the regex semantics corrected.

## r3 deltas vs r2

1. **Prompt edit widened to five places.** §B.2 now lists [prompts/chat.md#L73](../../../../prompts/chat.md#L73) ("Restart cautiously: Only restart the Planner …") alongside the four r2 references. The "Guidelines" bullet is deleted outright — see §B.2.e — because after the code shortcut is gone Chat has no restart action to be cautious about. §B.4 and §B.5 mirror this.
2. **Regex semantics in Proposal A.** §A.1 below acknowledges the live code's `i` flag and corrects the `\bplanner\b` claim: it matches the `planner` prefix in `planner's` (apostrophe is not a JS word char). The example list in §A.1 also drops the false-negative "planners" wording.
3. **Cross-finding grep replaced.** The cross-finding check in §B.5 and in [./03-plan-r3.md](./03-plan-r3.md) is rewritten around literal markers that actually appear in the live source: `tryHandleExplicitPlannerRestart`, `restartPlanner(this.localCommandContext(`, and the regex source `\\b(restart|reset|relaunch)\\b`. The shape-based regex in r2 was a no-op against the live code.

The r2 deltas vs r1 (prompt required, regression at ChatAgent layer, regex-semantics correction, transversal scope widened) carry forward unchanged.

---

## Proposal A — Multilingual regex + negation guards (rejected)

### A.1 Shape

Keep `tryHandleExplicitPlannerRestart` but rewrite the verb stage to cover the most common languages and the noun stage to tolerate the local-language word for "planner". Add a negation guard for English so `Don't restart the planner.` no longer fires.

Concretely:

- Move the regex into a small `detectExplicitPlannerRestart(text: string): boolean` helper in a new module `src/chat/restartHeuristic.ts`. The helper normalises the input with `text.normalize("NFKD").toLowerCase()` and uses explicit alternations (no reliance on `\b` for word-segmentation in non-ASCII scripts).
- Verb stage: explicit alternation of `restart | reset | relaunch | reboot | reinici(?:a|ar|o) | reanud(?:a|ar) | relanza(?:r)? | redemarr(?:er)? | riavvi(?:a|are) | neu[ \t]?start(?:en)? | 重启 | 再起動 | 재시작`. Boundary handling for non-ASCII letters is done by surrounding word characters with explicit `(?:^|[^\p{L}\p{N}])` and `(?:[^\p{L}\p{N}]|$)` lookarounds under the `u` flag, **not** by `\b`. (`\b` in JavaScript is ASCII-only even with the `u` flag, so it cannot be used as a Unicode word boundary here.)
- Noun stage: explicit alternation of `planner | planificador | planejador | planificateur | pianificatore | planer | 计划器 | プランナー | 플래너`, with the same `\p{L}\p{N}` lookaround discipline. Note that the live `/\bplanner\b/i` at [src/agents/chat.ts#L354](../../../../src/agents/chat.ts#L354) already matches the `planner` prefix in `planner's` (the apostrophe is not a JS word char, so `\b` succeeds between `r` and `'`); any "tightening" of the noun stage has to acknowledge that and either preserve or deliberately drop that match.
- Negation guard: if any of `don't | do not | dont | not | nunca | jamás | jamas | nie | nicht | non` appears within 4 tokens before the verb match, return `false`. A small finite-state scan, not a real parser.

### A.2 Files touched

- New `src/chat/restartHeuristic.ts` (≈100 lines).
- [src/agents/chat.ts#L352-L355](../../../../src/agents/chat.ts#L352-L355) — body becomes a one-liner call into the helper. Import the helper.
- New `src/chat/restartHeuristic.test.ts` — ≈30 unit cases covering the §3–§4 examples from the analysis.

### A.3 What this does *not* fix

- **The duplication of an explicit command.** `/restart-planner` still exists; the regex still re-exposes the same destructive action through a fuzzy parallel path.
- **The architectural anti-pattern.** Heuristics-in-the-control-path (G09's shape) is preserved; the heuristic is just bigger.
- **Unbounded maintenance.** Every new locale, phrasing, negation form, or scope construct is a new entry in three lists. "What about Hindi?" / "What about `bounce the planner`?" / "What about `Reset the test fixtures, not the planner` where the negation is on the noun side?" all remain open.
- **Confirmation.** A destructive action still fires immediately on a heuristic match, with the user message used verbatim as the restart `reason`. The negation guard catches `Don't restart the planner.` but not scope-shifting constructions like the second example above.
- **The no-op suppression bug.** When `plannerControl` is absent, the user's message is still replaced by the "not available" string and never reaches the LLM.
- **The prompt contract.** Proposal A does not address [prompts/chat.md](../../../../prompts/chat.md) at all; the LLM still believes it can restart the Planner. If the regex misses (i18n input, derived verb forms, pronouns), the model may then claim it restarted the Planner when in fact nothing happened.

**Rejected.** Proposal A multiplies code and tests in exchange for a smaller — but still non-zero — false-positive/false-negative surface, and leaves every architectural problem in place. The workspace architecture-first guideline forbids keeping the heuristic to preserve an existing structure.

---

## Proposal B — Delete the regex, rewrite the prompt contract, add a ChatAgent-level regression (recommended)

### B.1 Shape

Remove `tryHandleExplicitPlannerRestart` and its call site entirely. The user-visible affordance for restarting the Planner becomes exactly the existing slash commands:

```
/restart-planner [reason]      # canonical
/planner-restart [reason]      # alias
```

dispatched through `dispatchLocalCommand` at [src/chat/localCommands.ts#L86-L97](../../../../src/chat/localCommands.ts#L86-L97), which calls `restartPlanner(ctx, reason)` at [src/chat/localCommands.ts#L137-L158](../../../../src/chat/localCommands.ts#L137-L158). No new code paths, no new tools, no new heuristics.

For users who type natural language (`please reboot the planner`, `reinicia el planner`, `Don't restart the planner.`, `Why did the planner restart yesterday?`), the message falls through to the standard LLM dispatch path at [src/agents/chat.ts#L207-L213](../../../../src/agents/chat.ts#L207-L213). The model handles intent classification; on a clear restart intent, it directs the user to `/restart-planner <reason>` rather than firing the destructive action. This requires a matching prompt edit — see §B.2.

This matches the F30 design: structured slash commands are the control surface; free text goes to the model.

### B.2 Prompt edit (required, in-scope, five places)

The Chat system prompt at [prompts/chat.md](../../../../prompts/chat.md) currently encodes a contract the runtime can no longer fulfill once the code shortcut is removed. The five references must be rewritten in the same change as the code deletion. After the edits, no instruction anywhere in this file may say or imply that Chat itself restarts the Planner.

a. [prompts/chat.md#L7](../../../../prompts/chat.md#L7) — the example phrase "I can restart the Planner" must be removed from the first-person examples. Chat cannot restart the Planner directly; only the `/restart-planner` slash command can. Replace with a neutral first-person example (e.g. "I have relayed that to the Planner", "I found this in the current plan").

b. [prompts/chat.md#L33](../../../../prompts/chat.md#L33) — rewrite the "You can request a Planner restart only when the user explicitly asks for it" bullet. New text: Chat cannot restart the Planner. When a user asks for a restart, answer with a single sentence directing them to type `/restart-planner <reason>` themselves. Do not claim the restart has been performed, and do not file the restart request as a note.

c. [prompts/chat.md#L43](../../../../prompts/chat.md#L43) — rewrite responsibility item 5. New text: "Direct the user to the restart command on explicit request: if the user clearly asks to restart the Planner, reply with a one-line instruction to type `/restart-planner <reason>`." Drop "use the deterministic command path when available" (that path is being removed).

d. [prompts/chat.md#L51](../../../../prompts/chat.md#L51) — rewrite the "Planner restart requests" bullet under "CRITICAL: Relaying User Orders". New text: "Planner restart requests (restart, reset, relaunch, abort current plan): do NOT create a note for this and do NOT claim to have restarted the Planner. Reply with the instruction to type `/restart-planner <reason>` instead. Restart is a slash-command-only action."

e. [prompts/chat.md#L73](../../../../prompts/chat.md#L73) — the "Restart cautiously: Only restart the Planner when the user explicitly asks to restart it. Explain that the new Planner reloads plan/history from disk and continues from persistent state." guideline bullet is **deleted outright**. After the code change, Chat has no restart action to be cautious about; the positive instruction (direct the user to the slash command) is already present at the rewritten 4c/4d lines. The remaining "Guidelines" bullets (Be concise, Be factual, Relay promptly, Contextualize notifications, Don't interfere, Understand corrective actions) are unchanged.

Constraints on the prompt edit:

- Do not have Chat claim it restarted the Planner under any phrasing.
- Do not have Chat file the restart request as a note (that is a separate, wrong control surface; the slash command is the only path).
- Do not add multilingual matching to the prompt either — the LLM already handles arbitrary languages; the contract just needs to be unambiguous about who can issue the restart.
- After all edits, the file must contain no occurrence of the phrases "I can restart the Planner", "request a Planner restart", "deterministic command path", "Restart cautiously", or "Only restart the Planner". These are the negative-grep markers verified in [./03-plan-r3.md](./03-plan-r3.md).

### B.3 Test impact (regression at the ChatAgent layer)

A new regression test is added to the existing `describe("ChatAgent", ...)` block at [src/agents/agents.test.ts#L227-L271](../../../../src/agents/agents.test.ts#L227-L271), reusing the `TestChatChannel` and fake-router fixtures already defined at [src/agents/agents.test.ts#L626-L655](../../../../src/agents/agents.test.ts#L626-L655). The new `it(...)`:

1. Builds an `EventBus` and a `plannerControl` stub whose `requestRestart` records calls and returns a fixed `{ requestedAt }` value; the bus's `publish` is wrapped to record `plan_updated` events with summary starting `Planner restart requested from`.
2. Builds a fake router whose `chat(...)` records the incoming `messages` and returns a benign assistant reply.
3. Constructs a `ChatAgent` via the constructor signature already exercised at [src/agents/agents.test.ts#L255-L262](../../../../src/agents/agents.test.ts#L255-L262), passing the new `plannerControl` stub through the optional `plannerControl` parameter.
4. Calls `channel.receive("Why did the planner restart yesterday?")` and waits for `runPromise` quiescence (the existing tests already use `firstResponse.resolve(...)` + `await pending` for this).
5. Asserts:
   - `routerCalls.length === 1` — the user message reached the router.
   - The recorded user message in `routerCalls[0].messages` contains the literal `"Why did the planner restart yesterday?"`.
   - `plannerControl.requestRestart` was **not** called.
   - No `plan_updated` event with summary starting `Planner restart requested from` was published.

This test fails today (the buggy branch at [src/agents/chat.ts#L197-L202](../../../../src/agents/chat.ts#L197-L202) intercepts the message, calls `restartPlanner`, publishes the event, and never reaches the router) and passes only after both the call site and the method body at [src/agents/chat.ts#L352-L355](../../../../src/agents/chat.ts#L352-L355) are removed.

The r1 negative test in [src/chat/localCommands.test.ts](../../../../src/chat/localCommands.test.ts) is **not** added. `dispatchLocalCommand` already returns `null` for any input not starting with `/` ([src/chat/localCommands.ts#L86-L97](../../../../src/chat/localCommands.ts#L86-L97)), so a test there would pass whether or not the bug was fixed. It would not test the bug and is therefore not in scope.

The existing slash-command coverage in [src/chat/localCommands.test.ts](../../../../src/chat/localCommands.test.ts) for `/restart-planner` and `/planner-restart` is unchanged.

### B.4 Files touched

- [src/agents/chat.ts](../../../../src/agents/chat.ts) — delete the call site at L197-L202 and the method body at L352-L355. Drop `restartPlanner` from the named imports of `../chat/localCommands.js` at [src/agents/chat.ts#L34-L38](../../../../src/agents/chat.ts#L34-L38) (keep `dispatchLocalCommand` and `LocalCommandContext`). `localCommandContext()` at [src/agents/chat.ts#L283-L294](../../../../src/agents/chat.ts#L283-L294) stays — the slash-command path still uses it.
- [prompts/chat.md](../../../../prompts/chat.md) — apply the five edits enumerated in §B.2 (rewrite a–d, delete e).
- [src/agents/agents.test.ts](../../../../src/agents/agents.test.ts) — add the regression test described in §B.3, inside the existing `describe("ChatAgent", ...)` block, after the queue-rejection test. Reuse `TestChatChannel`, `makeChatContext`, and `deferred<T>`.

### B.5 Deletion list

- The block at [src/agents/chat.ts#L197-L202](../../../../src/agents/chat.ts#L197-L202):
  ```ts
  const restartResult = await this.tryHandleExplicitPlannerRestart(content.trim());
  if (restartResult !== null) {
    await this.channel.send(restartResult);
    this.recordMessage("assistant", restartResult);
    await this.saveChatLog();
    return;
  }
  ```
- The method at [src/agents/chat.ts#L352-L355](../../../../src/agents/chat.ts#L352-L355):
  ```ts
  private async tryHandleExplicitPlannerRestart(content: string): Promise<string | null> {
    if (!/\b(restart|reset|relaunch)\b/i.test(content)) return null;
    if (!/\bplanner\b/i.test(content)) return null;
    return restartPlanner(this.localCommandContext(), content);
  }
  ```
- The `restartPlanner` symbol from the named import at [src/agents/chat.ts#L34-L38](../../../../src/agents/chat.ts#L34-L38).
- The five prompt-line edits in §B.2 (rewrite at L7, L33, L43, L51; delete at L73).

After the change lands, the following greps must each return zero matches in the repo (the cross-finding check from r2 is replaced because the r2 pattern would not have matched the live regex at all):

```bash
git grep -nE "tryHandleExplicitPlannerRestart" src/
git grep -nE "restartPlanner\(this\.localCommandContext\(" src/
git grep -nF '\b(restart|reset|relaunch)\b' src/
```

Each of these matches at least once on `main` (the first two in `src/agents/chat.ts`, the third in the regex literal at L353), so they are real positive controls for "is the fix landed".

No backward-compatibility shim. There is no public protocol around the regex (it is a private method on `ChatAgent`); users who relied on the natural-language shortcut will hit the LLM, which is the right outcome. Per the workspace architecture-first guideline, no deprecation path.

### B.6 What this does *not* fix

- The natural-language restart UX is now slower by one turn: the user types a restart phrase, the model replies "Type `/restart-planner <reason>` to do that", the user types the slash command. This is a feature, not a regression — it removes a destructive action behind a fuzzy heuristic and gives the user one explicit confirmation step between intent and action. A single-turn UX would belong in a `propose_restart` MCP tool with a UI confirmation event, not in a regex; that is out of scope for G11.
- The `plannerControl`-absent no-op suppression in §5 of the analysis is fixed automatically by deletion: the regex method is the only producer of the "not available" reply on free text. Once it is gone, free-text messages flow to the LLM in all runtimes, including ones without `plannerControl`.

---

## 3. Recommendation

**Adopt Proposal B.**

The finding's own remediation direction is explicit: delete the regex shortcut. The workspace architecture-first guideline rules out Proposal A, which preserves a fuzzy heuristic that duplicates a deterministic command. Cross-finding G09 retires a structurally identical regex in the Planner with the same shape (delete the heuristic, rely on the structured surface); G11 follows suit for consistency.

Proposal B's net cost is small: ≈10 lines deleted in `src/agents/chat.ts`, five short prompt edits in `prompts/chat.md` (four rewrites + one deletion), and ≈30–50 lines of new test code in `src/agents/agents.test.ts`. Proposal A's net cost is ≈100 new lines of multilingual lookup tables, ≈30 new tests, plus unbounded maintenance, and leaves every architectural and prompt-contract problem in place.

Concrete caveats for the implementer:

1. After dropping the import, `npx tsc --noEmit` will catch any stale `restartPlanner(...)` call inside `chat.ts`; `eslint`'s `no-unused-vars` rule catches the import case if step 3 of the plan was missed.
2. `localCommandContext()` stays — the slash command dispatcher still needs it.
3. After the deleted block, the surrounding control flow at [src/agents/chat.ts#L207-L213](../../../../src/agents/chat.ts#L207-L213) already saves the chat log and signals `thinking` correctly. No additional work needed.
4. The L73 prompt bullet is deleted, not rewritten — verify the surrounding "Guidelines" list still parses (each remaining bullet starts with `- **`).
5. Cross-finding G09 is shipping a similar deletion at the same time. Stages can run in either order; there is no shared file.
6. Per workspace handoff, only restart `saivage.service` on `saivage-v3` (10.0.3.112) for validation; other containers are out of scope.
