# G11 — Analysis r2

**Finding**: [../G11-chat-restart-regex-english-only.md](../G11-chat-restart-regex-english-only.md)
**Subsystem**: src/agents/chat.ts (post-slash-command fast path for Planner restart), prompts/chat.md (LLM contract for restart intents).
**Round-1 references**: F30 (slash command registry / localCommands.ts); cross-couples to G09 (heuristics in the control path) and G44/F35 (control-channel docs).

## r2 deltas vs r1

The reviewer's four required changes are addressed across r2 as follows:

1. *Prompt edit is required, not optional.* §6 below treats [prompts/chat.md](../../../../prompts/chat.md) as part of the bug surface: while the code shortcut implements a fuzzy restart, the prompt actively encourages the LLM to "request a Planner restart" and treat free-text restart phrases as an interrupt path ([prompts/chat.md#L7](../../../../prompts/chat.md#L7), [prompts/chat.md#L33](../../../../prompts/chat.md#L33), [prompts/chat.md#L43](../../../../prompts/chat.md#L43), [prompts/chat.md#L51](../../../../prompts/chat.md#L51)). The design and plan in r2 require the prompt edit in the same change as the code deletion.
2. *Test layer correction.* §7 below documents that a `dispatchLocalCommand`-only test cannot fail against the current bug, because [src/chat/localCommands.ts#L86-L97](../../../../src/chat/localCommands.ts#L86-L97) already returns `null` for non-slash content. The r2 design moves the regression to ChatAgent dispatch, using the fake-channel/router harness at [src/agents/agents.test.ts#L227-L271](../../../../src/agents/agents.test.ts#L227-L271) and [src/agents/agents.test.ts#L626-L655](../../../../src/agents/agents.test.ts#L626-L655).
3. *Regex semantics corrected.* §3 below removes false claims that `\b(restart|reset|relaunch)\b` matches `Relaunched`/`Restarting` and that `\bplanner\b` matches `planners`. Those are false in JavaScript; the false-positive surface is rewritten around the actual semantics. The r2 design (rejected Proposal A) likewise drops the false claim that the `u` flag makes `\b` Unicode-aware.
4. *Transversal scope widened.* §8 below treats prompt + ChatAgent-level test as first-class required work alongside the source deletion, not optional cleanup.

## 1. Where the regex lives

The shortcut is a two-stage regex test on the raw user text in `ChatAgent.tryHandleExplicitPlannerRestart` at [src/agents/chat.ts#L352-L355](../../../../src/agents/chat.ts#L352-L355):

```ts
private async tryHandleExplicitPlannerRestart(content: string): Promise<string | null> {
  if (!/\b(restart|reset|relaunch)\b/i.test(content)) return null;
  if (!/\bplanner\b/i.test(content)) return null;
  return restartPlanner(this.localCommandContext(), content);
}
```

Both stages use ASCII word boundaries (`\b`) and the case-insensitive flag `i`. The method runs on the trimmed user message.

The dispatch order in `handleUserMessage` is, at [src/agents/chat.ts#L188-L206](../../../../src/agents/chat.ts#L188-L206):

1. `tryHandleCommand(content)` — slash commands. Handles `/restart-planner` and its alias `/planner-restart` through `dispatchLocalCommand` at [src/chat/localCommands.ts#L86-L97](../../../../src/chat/localCommands.ts#L86-L97).
2. `tryHandleExplicitPlannerRestart(content)` — the regex fast path. Runs only when no slash command matched (i.e. on any free-text input the user typed).
3. `injectMessage` + LLM dispatch.

The regex therefore lives between the structured slash command (which already exists and works) and the LLM, on raw user text. It calls `restartPlanner(ctx, content)` at [src/chat/localCommands.ts#L137-L158](../../../../src/chat/localCommands.ts#L137-L158) — the exact handler the slash command uses — but passes the entire user message as the restart `reason`.

## 2. What `\b` actually matches here (regex semantics)

JavaScript word boundaries are ASCII by default: `\b` is the boundary between `[A-Za-z0-9_]` and any other character. With the `i` flag and no `u` flag (the live code uses neither), the following hold:

- `\b(restart|reset|relaunch)\b` matches **only** the three exact tokens (case-insensitive). It does **not** match `restarting`, `restarts`, `restarted`, `relaunched`, `resetting`, `relaunching`, etc., because the trailing letter sits on the inside of the word and there is no `\b` between two word characters.
- `\bplanner\b` matches the exact token `planner` (case-insensitive). It does **not** match `planners` or `planner's` — the `s` and the apostrophe are word characters / not at a boundary in a way that would let the trailing `\b` succeed against the literal `planner`.
- Adding the `u` flag does **not** turn `\b` into a Unicode-aware word boundary. In JavaScript (and unlike some other regex engines), `\b` remains ASCII-only even with `u`; the `u` flag only affects Unicode escapes, surrogate pairs, and a few class semantics. Any "multilingual" extension to this regex must rely on explicit alternations, not on `\b` doing Unicode work.

These corrections matter because r1 cited derived forms (`Relaunched`, `Restarting`, `planners`) as part of the false-positive surface; they are not. The real false-positive surface is large enough without them, and is documented honestly in §3.

## 3. False-positive surface (English inputs that wrongly trigger)

Both stages require the literal tokens. Co-occurrence in any order anywhere in the message is enough — the verb and noun do not need to be adjacent, in the same clause, or in any grammatical relation. Examples that actually match the live regex:

| User message | Why it matches (both stages succeed) | What the user actually meant |
|---|---|---|
| `Why did the planner restart yesterday?` | `restart` + `planner` | A question about history |
| `Reset the test fixtures, not the planner` | `reset` + `planner` | The opposite of restart |
| `Don't restart the planner.` | `restart` + `planner` | Explicit negation |
| `The planner restart logic in bootstrap.ts seems off` | `restart` + `planner` | A code-review comment |
| `Once the migration is done, please reset the planner config` | `reset` + `planner` | A scheduled future action, not "do it now" |
| `relaunch is a bad name; planner-restart is clearer` | `relaunch` + `planner` (via the literal hyphenated token) | Naming discussion |

Note that the slash-command form `/note the planner needs a restart sometime tomorrow` is **not** in this list: it is intercepted by `tryHandleCommand` at step 1, which dispatches `/note` cleanly. Slash-prefixed text never reaches the regex stage.

The third row (`Don't restart the planner.`) is the worst: a user explicitly asking the model *not* to restart triggers an immediate restart, with the negated sentence used verbatim as the restart `reason`.

## 4. False-negative surface (intents that should restart but don't)

The complement of §3 — anything outside the three English roots, or without the literal token `planner`, is ignored:

- **Other English phrasings**: `reboot the planner`, `kill and respawn the planner`, `cycle the planner`, `bring the planner back up`, `recreate the planner agent`, `bounce the planner`.
- **English derived forms**: `restarting the planner`, `relaunched the planner` — these are not matched (see §2). The current behaviour is "fires on the bare verb only".
- **English with a pronoun**: `restart it` (after a turn about the Planner), `reset that` — no `planner` literal, ignored.
- **Spanish**: `reinicia el planner`, `reinicia el planificador`, `relanza el planner`, `vuelve a arrancar el planner`.
- **Portuguese / French / German / Italian / CJK**: every variant the finding lists. Saivage prompts and the chat surface are language-agnostic on the LLM side; the fast path is the only English-only choke point in the chat input pipeline.
- **Misspellings**: `restrt the planner`, `restartt planner`.

The conclusion is symmetric with §3: simultaneously too loose for the inputs it accepts and too narrow for the inputs it should accept. There is no plausible tightening of the regex that makes both error rates small — natural-language intent detection cannot be done with three exact verb tokens and one exact noun token, in any language.

## 5. What happens when the regex fires

`restartPlanner(ctx, content)` at [src/chat/localCommands.ts#L137-L158](../../../../src/chat/localCommands.ts#L137-L158):

1. If `plannerControl` is absent (single-agent / inspect runtime), returns a graceful "not available" string. No side effects. The dispatch path in `handleUserMessage` still records that string as the assistant reply and skips the LLM turn entirely — so even the safe no-op branch silences the user's actual message.
2. If `plannerControl` is present, calls `plannerControl.requestRestart(reason, requestedBy)`, publishes a `plan_updated` event, and returns a "Planner restart requested" string. The current Planner turn is cancelled and a fresh Planner is spawned from disk. There is **no confirmation prompt** and **no undo**.

In both branches the user's message never reaches the LLM. The slash-command path that exists for the same action requires the user to type an explicit `/restart-planner` (or `/planner-restart`) and is unambiguous; the regex path bypasses both that explicitness and the LLM's intent classifier, which would otherwise handle the natural-language case correctly (and could, when appropriate, suggest the slash command instead of firing it).

## 6. Prompt contract is part of this bug

The Chat system prompt at [prompts/chat.md](../../../../prompts/chat.md) currently tells the LLM that it can restart the Planner directly and treats natural-language restart requests as an interrupt path:

- [prompts/chat.md#L7](../../../../prompts/chat.md#L7) — "Use first-person system language such as 'I can restart the Planner', …".
- [prompts/chat.md#L33](../../../../prompts/chat.md#L33) — "You can request a Planner restart only when the user explicitly asks for it. Do not restart the Planner implicitly …".
- [prompts/chat.md#L43](../../../../prompts/chat.md#L43) — "Restart the Planner on explicit request: … use the deterministic command path when available or tell the user to use '/restart-planner <reason>'".
- [prompts/chat.md#L51](../../../../prompts/chat.md#L51) — "Planner restart requests … : request a Planner restart and include the user's reason in the restart note. This is the explicit interrupt path …".

Today these instructions are partly implemented by the regex fast path: when a free-text restart request arrives, the code intercepts it before the LLM ever sees it, so the prompt's "request a Planner restart" sentence is effectively a no-op for the model. After deleting the code shortcut, the same free-text request flows into the LLM turn at [src/agents/chat.ts#L207-L213](../../../../src/agents/chat.ts#L207-L213). If the prompt is left as-is, the LLM is free to claim it restarted the Planner (it cannot — there is no `restart_planner` tool exposed to it) or to file the restart as a note (the wrong control surface). Either is a regression.

The prompt must be edited in the same change as the code deletion so the LLM contract matches the new runtime behaviour: natural-language restart requests are answered by directing the user to `/restart-planner <reason>`, and Chat must not claim to have restarted the Planner.

## 7. Test coverage and where the regression must live

- [src/chat/localCommands.test.ts](../../../../src/chat/localCommands.test.ts) — covers `/restart-planner` and its alias dispatch through `dispatchLocalCommand` only. The regex fast path in `ChatAgent` is not exercised by any test.
- No test file references `tryHandleExplicitPlannerRestart`; the method is private and untested.

A negative regression added at the `dispatchLocalCommand` layer would not test the bug. The dispatcher already returns `null` for any input that does not start with `/`, at [src/chat/localCommands.ts#L86-L97](../../../../src/chat/localCommands.ts#L86-L97). A `dispatchLocalCommand("Why did the planner restart yesterday?", ctx)` call would return `null` *whether or not* the buggy fuzzy branch in `ChatAgent` was deleted, because the dispatcher never sees the free-text path at all — the regex branch is on `ChatAgent`, after `tryHandleCommand` returns.

The regression must therefore run against `ChatAgent` itself. The existing harness for this is already in the repo: the `TestChatChannel` helper at [src/agents/agents.test.ts#L626-L655](../../../../src/agents/agents.test.ts#L626-L655) and the `ChatAgent` test suite at [src/agents/agents.test.ts#L227-L271](../../../../src/agents/agents.test.ts#L227-L271) drive a real `ChatAgent` through a fake channel and a fake router and assert which messages reach the router. A new test in that suite can:

- Construct a `ChatAgent` with a `plannerControl` stub whose `requestRestart` records calls and a fake `EventBus` whose `publish` records events.
- Send the free-text message `Why did the planner restart yesterday?` through `TestChatChannel.receive(...)`.
- Assert that the router was called exactly once with the user message in the conversation, that `plannerControl.requestRestart` was **not** called, and that no `plan_updated` event with a `Planner restart requested` summary was published.

That assertion fails today (the buggy branch intercepts the message, calls `restartPlanner`, and never reaches the router) and passes only after both the call site at [src/agents/chat.ts#L197-L202](../../../../src/agents/chat.ts#L197-L202) and the method at [src/agents/chat.ts#L352-L355](../../../../src/agents/chat.ts#L352-L355) are removed.

## 8. Required transversal impact

This is no longer a one-method, source-only change. The full surface for the fix is:

- **Code**: delete the call site and the method in [src/agents/chat.ts](../../../../src/agents/chat.ts), and drop the now-unused `restartPlanner` import.
- **Prompt**: rewrite the four lines in [prompts/chat.md](../../../../prompts/chat.md) listed in §6 so the LLM contract matches the new behaviour (direct the user to `/restart-planner`, never claim to have restarted, never file restart-as-a-note).
- **Tests**: add a ChatAgent-level regression in [src/agents/agents.test.ts](../../../../src/agents/agents.test.ts) per §7. Do not add a `dispatchLocalCommand`-only test as the primary regression — it would not test the bug.

All three are first-class required work for this finding; none is optional.

## 9. Why this is the wrong shape

- **Duplicates an explicit, structured command.** `/restart-planner [reason]` already exists, has alias support, has a clean handler signature, is tested, and is rendered in `/help` via [src/agents/conventions.ts#L73-L84](../../../../src/agents/conventions.ts#L73-L84). The regex is a fuzzy parallel path to the same action.
- **Heuristic in a destructive control path.** Same anti-pattern as G09 (regex termination protocol in the Planner): a control decision made by `\b…\b/i` over free text the user did not intend as a command.
- **Bypasses the LLM, which is the right classifier.** If a user writes "please reboot the planner", the LLM agent is far more capable of (a) understanding the intent, (b) confirming with the user, and (c) suggesting `/restart-planner` than a 3-disjunction regex is.
- **i18n footgun.** Every other Chat surface accepts arbitrary languages. The fast path is the only place where English is privileged, silently.
- **No-op branch still suppresses the LLM.** Even when `plannerControl` is unavailable and the regex fires harmlessly, the user's message is replaced by the "not available" string and never reaches the model — a free-text question about planner restarts becomes a dead-end reply.

## 10. Constraints for any remediation

- Architecture-first, no backward compatibility, no migration shim. The regex is internal; removing it is a clean cut.
- Restarting the Planner must remain a one-step affordance — `/restart-planner [reason]` already provides it, including the alias `/planner-restart`.
- Cross-finding G09: same shape, same architectural fix; both findings should converge on "explicit structured command, no regex over user text".
- Per workspace handoff, `/home/salva/g/ml/saivage/src` is bind-mounted into three v2 containers; only `saivage-v3` (10.0.3.112) is the validation target for v2-on-v3 work.
