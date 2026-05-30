# G11 — Design r1

**Finding**: [../G11-chat-restart-regex-english-only.md](../G11-chat-restart-regex-english-only.md)
**Analysis**: [./01-analysis-r1.md](./01-analysis-r1.md)

Two proposals. A widens the regex to common non-English verbs and patches the worst false-positive cases. B removes the regex shortcut entirely and relies on the existing `/restart-planner` slash command (the F30 `localCommands` pattern) plus the LLM's natural-language understanding. Recommendation in §3.

---

## Proposal A — Multilingual regex + negation guards

### Shape

Keep `tryHandleExplicitPlannerRestart` but rewrite it so the verb stage covers the most common languages and the noun stage tolerates the local-language word for "planner". Add a negation guard for English so `Don't restart the planner.` no longer fires. Add a structured test matrix.

Concretely:

- Replace the two-stage regex at [src/agents/chat.ts](../../../../src/agents/chat.ts#L352-L356) with a small `detectExplicitPlannerRestart(text: string): boolean` helper in a new module `src/chat/restartHeuristic.ts`. The helper:
  - Normalises `text` with `text.normalize("NFKD").toLowerCase()`.
  - Verb stage: matches any of `restart | reset | relaunch | reboot | reinici[ao] | reinicia | reanud[ao] | relanza | redemarr | redemarrer | riavvi | neu start | neustart | 重启 | 再起動 | 재시작`. (The exact list is the union of the verbs enumerated in [./01-analysis-r1.md](./01-analysis-r1.md#L48-L57).)
  - Noun stage: matches `planner | planificador | planejador | planificateur | pianificatore | planer | 计划器 | プランナー | 플래너`.
  - Negation guard: if any of `don't | do not | dont | no | not | don't restart | nunca | jamás | jamas | nie | nicht | non` appears within 4 tokens *before* the verb match, return `false`. (A small finite-state scan, not a real parser.)
- Use the Unicode-aware `u` flag on the regex so `\b` and the character classes behave correctly on non-ASCII letters.
- The helper is called by `ChatAgent.tryHandleExplicitPlannerRestart`, which is otherwise unchanged.

### Files touched

- [src/chat/restartHeuristic.ts](../../../../src/chat/restartHeuristic.ts) — new file, ≈80 lines: verb list, noun list, negation list, the scan, plus exported `detectExplicitPlannerRestart`.
- [src/agents/chat.ts](../../../../src/agents/chat.ts#L352-L356) — body becomes `if (!detectExplicitPlannerRestart(content)) return null; return restartPlanner(this.localCommandContext(), content);`. Import the helper.
- New test file [src/chat/restartHeuristic.test.ts](../../../../src/chat/restartHeuristic.test.ts) — matrix of ≈30 cases covering the §3–§4 examples from the analysis (false positives that must now return `false`, intended English/Spanish/Portuguese/French/German/Italian/CJK phrases that must now return `true`, negation guards, edge cases like `restartt` and `relaunched`).

### Deletion list

- The inline two-stage regex at [src/agents/chat.ts](../../../../src/agents/chat.ts#L353-L354). Replaced by the helper call.
- Nothing else: `tryHandleExplicitPlannerRestart`, its call site at [src/agents/chat.ts](../../../../src/agents/chat.ts#L197-L201), `restartPlanner`, and the `/restart-planner` slash command all remain.

### Test impact

- ≈30 unit tests on `detectExplicitPlannerRestart` (pure function, no I/O, no router).
- No change to existing `localCommands.test.ts` — the slash-command path is unaffected.
- No build/integration test changes; no LXC restart needed beyond the standard rebuild.

### What this does *not* fix

- **The duplication of an explicit command.** `/restart-planner` still exists; the regex still re-exposes the same destructive action through a parallel, fuzzy, hand-rolled NLP path.
- **The architectural anti-pattern.** Heuristics-in-the-control-path (the same shape called out in G09) is preserved; the regex is just bigger.
- **The maintenance burden.** Adding "what about the user who writes `please bounce the planner`?" / "what about Hindi?" / "what about negation in Russian?" is unbounded. Every new locale or phrasing is a new entry in three lists.
- **Confirmation.** A destructive action still fires immediately on a heuristic match, with the entire user message used verbatim as the restart `reason`. The "Don't restart the planner." case is fixed by the negation guard; "Reset the test fixtures, not the planner" requires more sophisticated scope parsing that an ad-hoc scanner cannot do.
- **The no-op suppression bug.** When `plannerControl` is absent, the user's message is still replaced by the "not available" string and never reaches the LLM. Proposal A does not touch that.

---

## Proposal B — Delete the regex, keep `/restart-planner`, let the LLM handle natural language

### Shape

Remove `tryHandleExplicitPlannerRestart` and its call site entirely. The user-visible affordance for restarting the Planner becomes exactly the existing slash command:

```
/restart-planner [reason]      # canonical
/planner-restart [reason]      # alias
```

These are dispatched through `dispatchLocalCommand` at [src/chat/localCommands.ts](../../../../src/chat/localCommands.ts#L86-L99), which already calls the same `restartPlanner(ctx, reason)` handler the regex fast path was calling. No new code paths, no new tools, no new heuristics.

For users who type natural language ("please reboot the planner", "reinicia el planner", "Don't restart the planner."), the message falls through to the standard LLM dispatch — the same path every other free-text input takes. The model is much better at intent classification than a regex disjunction; in the "I want to restart" case it can answer with a suggestion to use `/restart-planner [reason]` rather than firing the destructive action itself. If a confirmation flow is ever wanted, it belongs in the LLM turn (which can ask "Do you want me to restart the Planner? Reply `/restart-planner <reason>` to confirm.") — not in a regex.

This matches the F30 design exactly: structured slash commands are the control surface; free text goes to the model.

Mechanism:

1. **Delete the method.** Remove `tryHandleExplicitPlannerRestart` at [src/agents/chat.ts](../../../../src/agents/chat.ts#L352-L356) and the four-line call block at [src/agents/chat.ts](../../../../src/agents/chat.ts#L197-L202). After deletion, `handleUserMessage` flows directly from `tryHandleCommand` (slash commands) to `injectMessage` + LLM turn.
2. **Help-text reaffirmation.** The `/restart-planner [reason]` row already appears in `/help` via the `LOCAL_CHAT_COMMANDS` registry at [src/agents/conventions.ts](../../../../src/agents/conventions.ts#L73-L86); no change needed there.
3. **Prompt nudge (optional, separate stage).** The Chat system prompt may be tightened to instruct the LLM: "If a user appears to ask for a Planner restart in free text, do not invoke the restart yourself — answer by suggesting they use `/restart-planner <reason>`." This is one prompt edit, not part of the architectural fix and can be deferred or batched with other prompt updates; the implementation plan below does **not** require it.

Everything else — `restartPlanner` handler, `PlannerControl.requestRestart`, the recovery loop, event publishing, dashboard formatting, slash-command tests — is unchanged.

### Files touched

- [src/agents/chat.ts](../../../../src/agents/chat.ts) — delete the call site at lines 197–202 and the method body at lines 352–356. No new imports; `restartPlanner` import at line 36 is no longer used by `ChatAgent`, so the import line is removed too. `localCommandContext()` remains (the slash command path still uses it).
- Nothing else in `src/`.

### Deletion list

- The block at [src/agents/chat.ts](../../../../src/agents/chat.ts#L197-L202):
  ```ts
  const restartResult = await this.tryHandleExplicitPlannerRestart(content.trim());
  if (restartResult !== null) {
    await this.channel.send(restartResult);
    this.recordMessage("assistant", restartResult);
    await this.saveChatLog();
    return;
  }
  ```
- The method at [src/agents/chat.ts](../../../../src/agents/chat.ts#L352-L356):
  ```ts
  private async tryHandleExplicitPlannerRestart(content: string): Promise<string | null> {
    if (!/\b(restart|reset|relaunch)\b/i.test(content)) return null;
    if (!/\bplanner\b/i.test(content)) return null;
    return restartPlanner(this.localCommandContext(), content);
  }
  ```
- The `restartPlanner` import in `ChatAgent` at [src/agents/chat.ts](../../../../src/agents/chat.ts#L36). (`restartPlanner` is still exported by `src/chat/localCommands.ts` and used by `dispatchLocalCommand` and the `localCommands.test.ts` direct-call tests; only the *import* into `chat.ts` becomes unused.)

No backward-compatibility shim. There is no public protocol around the regex (it is a private method on `ChatAgent`); users who relied on the natural-language shortcut will hit the LLM, which is the right outcome. Per the workspace architecture-first guideline, no deprecation path.

### Test impact

- No existing tests reference `tryHandleExplicitPlannerRestart` (it is private and untested), so nothing breaks.
- `src/chat/localCommands.test.ts` continues to cover `/restart-planner` and `/planner-restart`; no edits needed.
- **New negative test** added to `src/chat/localCommands.test.ts` (or a sibling file scoped to `ChatAgent`'s dispatch order): assert that a free-text message containing `restart` and `planner` together — e.g. `"Why did the planner restart yesterday?"` — when passed through `dispatchLocalCommand` (not through `ChatAgent` itself, which would still require booting the agent) returns `null` (no slash command match) and therefore *would* fall through to the LLM. This codifies the architectural decision: only slash commands trigger restart.
- A small `ChatAgent` integration-style test is **not** added: booting `ChatAgent` requires the full agent context (`ctx.mcpRuntime`, `eventBus`, `plannerControl`, etc.) and the value-per-line-of-test-code is low once `dispatchLocalCommand` is already covered. The architectural invariant is enforced by deletion, not by a test.

### What this does *not* fix

- The "natural-language restart UX" is now slower by one turn: the user types "please reboot the planner", the model replies "Run `/restart-planner [reason]` to do that", the user types the slash command. This is a feature, not a regression — it removes a destructive action behind a fuzzy heuristic and gives the user one explicit click/keypress between intent and action. If product wants a single-turn UX, the right shape is an LLM-emitted tool call to a `propose_restart` MCP tool with a confirmation event surfaced in the UI, **not** a regex. That is out of scope for G11.
- The `plannerControl`-absent no-op suppression in §5 of the analysis is fixed *automatically* by deletion: the regex method is the only thing that produced the "not available" reply on free text, and once it is gone, free-text messages flow to the LLM in all runtimes, including ones without `plannerControl`.

---

## 3. Recommendation

**Adopt B.**

The finding's own remediation direction is explicit ("delete the regex-based shortcut entirely"). The workspace architecture-first guideline rules out Proposal A: keeping a fuzzy heuristic that duplicates a deterministic command, just because the heuristic exists, is exactly the "preservation of structures that no longer hold" pattern the guideline forbids. The cross-coupled finding G09 retires a structurally identical regex in the Planner with the same shape (delete the heuristic, rely on the structured surface); G11 should follow suit for consistency across the v2 control path.

Proposal A is also larger in net code (≈80 new lines of multilingual lists, ≈30 new tests, plus the unbounded future maintenance) than Proposal B (≈10 lines deleted, 0 new lines, 0 new dependencies, 1 new negative test).

Concrete caveats for the implementer:

1. The `restartPlanner` import on [src/agents/chat.ts](../../../../src/agents/chat.ts#L36) becomes unused after the method is deleted. Drop it; `eslint`'s `no-unused-vars` rule will flag it otherwise.
2. `localCommandContext()` at [src/agents/chat.ts](../../../../src/agents/chat.ts#L283-L294) **stays** — the slash command dispatcher still needs it.
3. The deleted call block is between the slash-command branch and the `injectMessage(content)` call. After deletion, verify the surrounding control flow still saves the chat log and signals `thinking` correctly: the LLM path at [src/agents/chat.ts](../../../../src/agents/chat.ts#L203-L223) already does both. No additional work needed.
4. Cross-finding G09 is shipping a similar deletion at the same time. Stages can run in either order; there is no shared file.
5. Per workspace handoff, `/home/salva/g/ml/saivage/src` is bind-mounted into three v2 containers (`saivage` 10.0.3.111, `saivage-v3` 10.0.3.112, `diedrico` 10.0.3.113). After rebuild, only restart `saivage.service` on `saivage-v3` for validation; other containers are out of scope.
6. No prompt changes are required for the fix itself. If the LLM is observed to fire its own restart attempts after deletion (it cannot today — restart is not exposed as a tool), revisit; otherwise leave the Chat system prompt alone.
