# G47 — Analysis (Round 3)

- **Issue**: [../G47-telegram-bot-auth-and-startup-issues.md](../G47-telegram-bot-auth-and-startup-issues.md)
- **Round 2**: [01-analysis-r2.md](01-analysis-r2.md)
- **Round 2 review**: [04-review-r2.md](04-review-r2.md) — VERDICT: CHANGES_REQUESTED

## 1. Carry-over from round 2

The three-defect diagnosis is unchanged (silent unauthorized drop, unawaited bot.start, allowlist-bypass at hydration) and all evidence anchors in [01-analysis-r2.md §1](01-analysis-r2.md) remain valid. The denial uses ctx.reply, the schema rewrite stays without a shim, and §3-§5 of r2 carry forward verbatim.

This round revises only the **startup-contract framing** in r2 §2 to remove the conflation between `onStart` firing and the first `getUpdates` request succeeding.

## 2. Why r2's framing was wrong

The r2 review ([04-review-r2.md finding 1](04-review-r2.md)) is correct: round 2 described the boundary `onStart` resolves on as "the first long-poll opens" / "first poll setup". The installed grammY does not match that description.

Evidence from the installed grammY:

- The typedoc on `BotConfig.onStart` ([../../../../node_modules/grammy/out/bot.d.ts](../../../../node_modules/grammy/out/bot.d.ts#L40-L52)) says it runs "after the setup of the bot has completed, and **immediately before** the first updates are being fetched".
- The compiled implementation ([../../../../node_modules/grammy/out/bot.js](../../../../node_modules/grammy/out/bot.js#L295-L320)) `await`s `init` + `deleteWebhook` retries, *then* `await options.onStart?.(this.botInfo)`, *then* `await this.loop(options)`. The `loop` call (which issues `getUpdates`) is not awaited by the path that ultimately resolves `onStart`.

So the rejection paths fan out as:

| Phase of `bot.start` | Where it rejects from | When relative to onStart |
|---|---|---|
| bot is already inited (or init via signal) | inside `Promise.all(setup)` | before onStart |
| `deleteWebhook` (with retries) fails | inside `Promise.all(setup)` | before onStart |
| `onStart` callback itself throws | `await options.onStart?.(...)` | onStart did not fully run |
| `validateAllowedUpdates` throws | sync, after onStart | after onStart |
| First `getUpdates` (and every subsequent one) fails non-retriably | inside `this.loop(options)` | after onStart |

Round 2 grouped the last row under "first-poll setup", implying r2's catch arm propagates it as a startup rejection. It does not: the catch arm is `if (!started) reject(err); else log.error(...)`, and `started` flips to `true` synchronously inside `onStart` *before* `this.loop` runs. A first `getUpdates` failure (the canonical case is a 409 polling conflict against an already-running bot) therefore lands in the `else log.error` branch, reproducing the originally diagnosed "dead-but-reported-started" shape for that specific failure mode.

## 3. Architecture-first decision — option (a)

Two options on the table:

- **(a)** Reframe the readiness contract: `onStart` only proves init + grammY-internal polling-startup (deleteWebhook + the polling loop has been entered). It does **not** prove the first `getUpdates` succeeded. Document the gap explicitly, keep the existing post-`onStart` `.catch` arm as the documented handler for first-poll-and-beyond failures (log-only via `log.error`, plus operator-visible because `cli.ts` keeps the server up regardless).
- **(b)** Wait for the first successful `getUpdates` response before resolving the readiness promise. grammY exposes no public hook on `Bot` for the first successful update fetch. The closest viable wiring is to instrument the `Api` middleware via `bot.api.config.use(...)` to observe the first successful `getUpdates` response code, then resolve. This adds an Api-transformer dependency, a buffering edge case (`getUpdates` long-polls for ~30s and an empty result is still a success), and a new test surface.

Pick **(a)**.

Rationale (architecture-first, minimal-diff against r2 §3):

- The user-visible behaviour on a real polling conflict is already correct: `log.error("[telegram] Polling stopped with error: ...")` plus the rest of the server keeping working. The CLI caller does not promise "Telegram is up" anywhere user-visible beyond that log line.
- Option (b) wires production logic to an internal `Api` transformer hook that grammY does not document as a readiness primitive; doing so to gain one log-line of fidelity is over-engineering by the [preferences.md](file:///memories/preferences.md) "no over-engineering" rule.
- The originally filed issue ([../G47-telegram-bot-auth-and-startup-issues.md](../G47-telegram-bot-auth-and-startup-issues.md)) asks for startup-failure propagation; it does not require that every post-setup polling rejection rejects the caller. The pre-`onStart` rejection arm already covers token-invalid, network-down-at-startup, and `deleteWebhook`-rejected — which is the realistic operator-noticeable set.
- A 409 polling conflict is a deployment-pairing bug; the right fix surface for it is the log line plus operator awareness, not synchronous startup failure. The runtime continues to serve non-Telegram surfaces.

## 4. Restated readiness contract

The contract `startTelegramBot` resolves on:

- `bot.init` resolved → token validated via `getMe`, `bot.botInfo` populated.
- `bot.start` reached the point where `onStart` is invoked → `deleteWebhook` completed and grammY has marked the bot as running (`bot.isRunning() === true` per the typedoc, [../../../../node_modules/grammy/out/bot.d.ts](../../../../node_modules/grammy/out/bot.d.ts#L48-L52)).

The contract `startTelegramBot` rejects on:

- `bot.init` rejection (invalid token, network, etc.).
- Any `bot.start` rejection that occurs **before** `onStart` is invoked — i.e. `deleteWebhook` failure or its retry budget exhausted, or `init` failure when bot.start does the init itself via signal.

What the contract explicitly does **not** guarantee, and how it is handled:

- A first `getUpdates` failure (e.g. 409 conflict, mid-startup network blip) lands in `this.loop(options)` after `onStart` resolved the readiness promise. The existing `.catch` arm logs it via `log.error("[telegram] Polling stopped with error: ...")`. The caller has already received a `{ stop }` handle and the rest of the server keeps running. This is an accepted gap, documented here and in [02-design-r3.md](02-design-r3.md).
- A revoked-token / persistent network partition at steady state: same path, same handler.

These two non-rejection cases share one log line by design; an operator inspecting logs sees `Polling stopped with error: ...` and can correlate with deployment topology to distinguish a first-poll conflict from a runtime stop.

## 5. Test impact

The r2 tests T8 / T8a / T8b stay, but their names and intent are reframed:

- T8 was "bot.start rejection during polling startup". Reframe to "bot.start rejection **before onStart fires** (pre-loop setup failure)". The mock continues to reject without invoking `opts.onStart`, which is the correct model of a `deleteWebhook` retry-budget failure or signal-aborted `init`.
- T8a was "bot.start rejection after onStart does NOT reject". Reframe to "bot.start rejection **after onStart fires** is logged, not propagated; this is the documented first-poll failure handler".
- T8b stays as-is.

No code change to the production startup block from r2 §3 is required — the framing is what was wrong, not the behaviour the code expresses.

## 6. Scope (unchanged)

- **In scope**: [src/server/telegram-bot.ts](../../../../src/server/telegram-bot.ts), [src/types.ts](../../../../src/types.ts#L82-L86), [src/server/telegram-bot.test.ts](../../../../src/server/telegram-bot.test.ts).
- **Out of scope**: WebSocket auth (G40), markdown-to-MarkdownV2 conversion, telegram allowlist config shape, instrumenting an `Api` transformer for first-`getUpdates`-success readiness (option (b), rejected in §3).
- **Backward-compat policy**: schema rewrite stays — `{ chatIds: number[] }` → `{ entries: { chatId, userId, subscribedAt }[] }` with no migration shim.
