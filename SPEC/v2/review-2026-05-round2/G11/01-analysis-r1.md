# G11 — Analysis r1

**Finding**: [../G11-chat-restart-regex-english-only.md](../G11-chat-restart-regex-english-only.md)
**Subsystem**: src/agents/chat.ts (post-slash-command fast path for Planner restart)
**Round-1 references**: F30 (slash command registry / `localCommands.ts`); cross-couples to G09 (heuristics in the control path) and G44/F35 (control-channel docs).

## 1. Where the regex lives

The shortcut is a two-stage regex test on the raw user text in `ChatAgent.tryHandleExplicitPlannerRestart` at [src/agents/chat.ts](../../../../src/agents/chat.ts#L352-L356):

```ts
private async tryHandleExplicitPlannerRestart(content: string): Promise<string | null> {
  if (!/\b(restart|reset|relaunch)\b/i.test(content)) return null;
  if (!/\bplanner\b/i.test(content)) return null;
  return restartPlanner(this.localCommandContext(), content);
}
```

The finding text quotes only the first stage; the second stage gates on the literal English word `planner`. Both stages use ASCII word boundaries (`\b`), the `i` flag, and operate on the trimmed user message directly.

The dispatch order in [src/agents/chat.ts](../../../../src/agents/chat.ts#L185-L205) is:

1. `tryHandleCommand(content)` — slash commands. Handles `/restart-planner` and its alias `/planner-restart` through `dispatchLocalCommand` at [src/chat/localCommands.ts](../../../../src/chat/localCommands.ts#L86-L99).
2. `tryHandleExplicitPlannerRestart(content)` — the regex fast path. Runs **only when no slash command matched**.
3. LLM dispatch.

The regex therefore lives in between the structured slash command (which already exists and works) and the LLM, on the raw user text. It calls `restartPlanner(ctx, content)` at [src/chat/localCommands.ts](../../../../src/chat/localCommands.ts#L139-L158) — i.e. the exact same handler the slash command uses — but passes the **entire user message as the restart reason**.

## 2. What the regex matches

- **Verb stage**: matches `restart`, `Restart`, `RESET`, `relaunch`, `Reset`, `Relaunched` (because `\b` allows a suffix), `Restarting`, etc. — any token whose lowercase form starts with one of the three roots is enough.
- **Noun stage**: matches `planner`, `Planner`, `PLANNER`, `planners`, `Planner's` (apostrophe is a word boundary).
- **Cross-stage**: the two tests are independent — the verb and noun do not need to be adjacent, in order, or even in the same clause. `"the planner relaunched yesterday"` matches; so does `"a quick reset of the dashboards (not the planner of course)"`.
- **Language**: ASCII English roots only. `\b` is ASCII-boundary on a regex without the `u` flag, so words containing non-ASCII letters still bound correctly, but the three roots themselves do not match any of: `reiniciar`, `reinicia`, `reanudar`, `reanuda`, `reinício`, `reinicia`, `relanzar`, `Neustart`, `neu starten`, `redémarrer`, `riavviare`, `перезапустить`, `重启`, `再起動`, `재시작`, etc.

## 3. False-positive surface (English inputs that wrongly trigger)

Both stages of the regex are loose enough that any sentence that *mentions* the planner together with one of the three verbs fires the destructive shortcut.

| User message | Why it matches | What the user actually meant |
|---|---|---|
| `Why did the planner relaunch yesterday?` | `relaunch` + `planner` | A question about history |
| `Reset the test fixtures, not the planner` | `reset` + `planner` | The opposite of restart |
| `Don't restart the planner.` | `restart` + `planner` | Explicit negation |
| `The planner restart logic in bootstrap.ts seems off` | `restart` + `planner` | A code-review comment |
| `/note the planner needs a restart sometime tomorrow` | `restart` + `planner`; `/note` is not in `LOCAL_CHAT_COMMANDS` because the canonical form is `/note <msg>`, but `/note the …` is a real `/note` invocation. **Actually safe** in the current code: `tryHandleCommand` strips it first. The risk is for unknown-but-related slash variants (e.g. `/n the planner needs a restart`) — those fall through to the regex. | A note to file |
| `Once the migration is done, please reset the planner config` | `reset` + `planner` | A scheduled action, not "do it now" |
| `relaunch is a bad name; planner-restart is clearer` | `relaunch` + `planner` (via `planner-restart`) | Naming discussion |

The fourth row (`Don't restart the planner.`) is the worst: a user explicitly asking the model *not* to restart triggers an immediate restart, with the user's negated sentence used verbatim as the restart `reason`.

## 4. False-negative surface (intents that should restart but don't)

The complement of §3 — anything outside the three English verbs or without the literal word `planner` is ignored. Examples that a reasonable user would expect to work:

- **Other English phrasings**: `reboot the planner`, `kill and respawn the planner`, `cycle the planner`, `boot the planner again`, `bring the planner back up`, `recreate the planner agent`, `bounce the planner`.
- **English with a pronoun**: `restart it` (after a turn about the Planner), `reset that` — no `planner` literal, ignored.
- **Spanish**: `reinicia el planner`, `reinicia el planificador`, `relanza el planner`, `vuelve a arrancar el planner`. The verbs are not English roots; the second sentence uses the Spanish noun `planificador`.
- **Portuguese / French / German / Italian / Chinese / Japanese**: every variant the finding lists. Saivage prompts and the chat surface are language-agnostic on the LLM side, so users from any locale can interact freely — the fast path is the only English-only choke point in the chat input pipeline.
- **Misspellings**: `restrt the planner`, `restartt planner`.

The conclusion is symmetric with §3: the regex is simultaneously too loose for the inputs it accepts and too narrow for the inputs it should accept. There is no plausible tightening of the regex that makes both error rates small — natural-language intent detection cannot be done with three word roots and one literal noun, in any language.

## 5. What happens when the regex fires

`restartPlanner(ctx, content)` at [src/chat/localCommands.ts](../../../../src/chat/localCommands.ts#L139-L158):

1. If `plannerControl` is absent (single-agent / inspect runtime), returns a graceful "not available" string. No side effects. The dispatch path in `handleUserMessage` still records that string as the assistant reply and **skips the LLM turn entirely** — so even the safe no-op branch silences the user's actual message.
2. If `plannerControl` is present, calls `plannerControl.requestRestart(reason, requestedBy)` (see [src/server/bootstrap.ts](../../../../src/server/bootstrap.ts) for the implementation), publishes a `plan_updated` event, and returns a "Planner restart requested" string. The current Planner turn is cancelled and a fresh Planner is spawned from disk. There is **no confirmation prompt** and **no undo**.

In both branches the user's message never reaches the LLM. The slash-command path that exists for the same action requires the user to type an explicit `/restart-planner` (or `/planner-restart`) and is unambiguous; the regex path bypasses both that explicitness and the LLM's intent classifier, which would otherwise handle the natural-language case correctly (and could, when appropriate, *suggest* the slash command instead of firing it).

## 6. Test coverage

- [src/chat/localCommands.test.ts](../../../../src/chat/localCommands.test.ts) — covers `/restart-planner` and its alias dispatch through `dispatchLocalCommand` only. The regex fast path in `ChatAgent` is not exercised by any test.
- No test file searches for `tryHandleExplicitPlannerRestart`; the method is private and untested. There is no regression test for either the false-positive or the false-negative behaviour in §3–§4.

## 7. Why this is the wrong shape

- **Duplicates an explicit, structured command.** `/restart-planner [reason]` already exists, has alias support, has a clean handler signature, is tested, and is rendered in `/help`. The regex is a fuzzy parallel path to the same action.
- **Heuristic in a destructive control path.** Same anti-pattern as G09 (regex termination protocol in the Planner): a security/control decision made by `\b…\b/i` over free text the user did not intend as a command.
- **Bypasses the LLM, which is the right classifier.** If a user writes "please reboot the planner", the LLM agent is far more capable of (a) understanding the intent, (b) confirming with the user, and (c) emitting the right tool call / suggesting `/restart-planner` than a 3-disjunction regex is.
- **i18n footgun.** Every other Chat surface accepts arbitrary languages (notes, free-form chat, `/note` body). The fast path is the only place where English is privileged, silently.
- **No-op branch still suppresses the LLM.** Even when `plannerControl` is unavailable and the regex fires harmlessly, the user's message is replaced by the "not available" string and never reaches the model — a free-text question about planner restarts becomes a dead-end reply.

## 8. Constraints for any remediation

- Architecture-first: do not add a language-detection or NLP-classifier dependency just to keep a fuzzy fast path alive.
- No backward compatibility: the regex is internal, not part of any public protocol; removing it is a clean cut.
- Restarting the Planner must remain a one-step affordance — `/restart-planner [reason]` already provides it, including the alias `/planner-restart`. Any replacement must not regress that path.
- Cross-finding G09: a separate fuzzy-regex control path is being removed in the Planner. G11 is the same pattern, smaller scope, in the Chat agent. Keep the solutions structurally consistent — both findings should converge on "explicit structured command, no regex over user text".
