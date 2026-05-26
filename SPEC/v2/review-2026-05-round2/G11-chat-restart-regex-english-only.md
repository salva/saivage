# G11 — Chat explicit-restart detection uses English-only regex

**Subsystem:** src/chat/, src/agents/
**Category:** correctness / i18n / heuristics-in-control-path
**Severity:** medium
**Transversality:** local (one method), but on a control path

## Summary

`ChatAgent.tryHandleExplicitPlannerRestart` short-circuits user messages that look like Planner-restart requests by matching `/\b(restart|reset|relaunch)\b/i` against the raw user text. Anything not in English never triggers the fast path; anything containing the word "restart" in an unrelated context (e.g. "the test suite restart logic is broken") triggers a spurious Planner restart. The fast path bypasses the normal LLM dispatch — so a false positive immediately tears down and respawns the Planner, which is a destructive operation, with no confirmation step.

## Evidence

`src/agents/chat.ts` (~line 354) — the active method body:

```ts
private async tryHandleExplicitPlannerRestart(content: string): Promise<string | null> {
  // English regex over raw user text
  if (!/\b(restart|reset|relaunch)\b/i.test(content)) return null;
  // ... extracts reason, calls plannerControl.requestRestart(...)
}
```

The same control path is exposed cleanly through `/restart-planner` ([src/chat/localCommands.ts](src/chat/localCommands.ts#L65-L66)), which is the structured, opt-in command that resolves to `restartPlanner(ctx, reason)` ([src/chat/localCommands.ts](src/chat/localCommands.ts#L139-L158)). That path is unambiguous: it requires a slash command and an explicit reason argument. The regex shortcut effectively re-exposes the same destructive action through fuzzy NLP heuristics on top of a deterministic command.

Failure modes:

- "Necesito reiniciar el planner" (Spanish) — does not trigger restart; user has to learn English keywords.
- "Reset the test fixtures, not the planner" — triggers restart anyway because `\breset\b` matched.
- "Why did the planner relaunch yesterday?" (a question, not a request) — triggers restart.
- "/note Look into restart loops" (a note, not a slash command for restart) — triggers restart, bypassing the explicit `/note` handler.

The third and fourth examples are particularly bad: the heuristic fires inside `dispatchToChat`-style entry points where the user explicitly *wasn't* trying to invoke the slash command, and there's no confirmation prompt.

## Why this matters

- Restarting the Planner is destructive: the current Planner turn is cancelled and a fresh one is spawned from disk state. Doing it on a false positive interrupts in-flight work.
- The English-only regex is an i18n footgun in a system that already accepts free-form user notes in any language.
- The whole feature *duplicates* the explicit `/restart-planner` command, which is the right control surface. The regex is a redundant, less-safe path to the same action.

## Rough remediation direction

Architectural: delete the regex-based shortcut entirely. Users who want to restart the Planner have `/restart-planner [reason]`; the LLM-handled path can suggest that command when the model thinks the user is asking for it (the LLM is much better at intent classification than a 3-word disjunction).

If a "natural language restart" fast path is genuinely desired, it should:

1. Run on the LLM-classified intent, not a regex.
2. Require an interactive confirmation step (UI banner: "Restart Planner? [confirm]"). Auto-firing destructive actions from free text is a UX anti-pattern.

Add a test that asserts the chat path does *not* restart the Planner when the user message is `"Reset the test fixtures, not the planner"` or `"Why did the planner restart yesterday?"`.

## Cross-links

- Touches the same surface as `/restart-planner` in [src/chat/localCommands.ts](src/chat/localCommands.ts#L139).
- Same "heuristics in the control path" anti-pattern as G09 (planner regex).
