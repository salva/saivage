# G47 — Analysis (Round 1)

- **Issue**: [../G47-telegram-bot-auth-and-startup-issues.md](../G47-telegram-bot-auth-and-startup-issues.md)
- **Subsystem**: channels (Telegram)
- **Severity**: medium (security-shaped)

## 1. Restated finding

Three independent defects in [src/server/telegram-bot.ts](../../../../src/server/telegram-bot.ts) share one root: Telegram authorization is asymmetric — checked reactively on inbound message text but not on the proactive paths that actually consume LLM tokens.

1. **Silent drop on unauthorized inbound** — rejected users get no acknowledgement, only a server-side log line.
2. **`bot.start()` not awaited / start errors swallowed** — long-polling startup errors (bad token, network, 429) never surface to the caller.
3. **Boot hydration bypasses the allowlist** — every persisted `chatId` is rehydrated into a live `ChatAgent` session at boot without re-checking `allowedUserIds`. The persistence schema does not retain the originating `userId`, so revocation is structurally impossible without an out-of-band edit of the on-disk doc.

## 2. Evidence (current source, live line numbers)

| # | Location | Live lines | Notes |
|---|---|---|---|
| 1 | [src/server/telegram-bot.ts](../../../../src/server/telegram-bot.ts#L136-L140) | L136-L140 | `Rejected message ... return;` — no `ctx.reply`. |
| 2 | [src/server/telegram-bot.ts](../../../../src/server/telegram-bot.ts#L195-L200) | L195-L200 | `bot.start({ onStart: ... })` — return value (a Promise) discarded. `onStart` is a *per-poll* callback, not a startup contract; init errors (invalid token, 401, network) reject the promise and are lost. |
| 3 | [src/server/telegram-bot.ts](../../../../src/server/telegram-bot.ts#L188-L191) | L188-L191 | Hydration loop calls `getOrCreateSession(chatId)` for every persisted `chatId` with no `allowedUserIds` check. |
| 4 | [src/types.ts](../../../../src/types.ts#L82-L86) | L82-L86 | `TelegramSubscriptionsSchema = { chatIds: number[] }` — no `userId`, so post-hoc allowlist filtering is impossible. |
| 5 | [src/config.ts](../../../../src/config.ts#L130-L135) | L130-L135 | `telegram.allowedUserIds` is the only authz primitive: a flat `number[]`. |
| 6 | [src/server/cli.ts](../../../../src/server/cli.ts#L330-L339) | L330-L339 | Caller already wraps `startTelegramBot(runtime)` in `try/catch` and continues without Telegram on failure — so if `startTelegramBot` actually rejects on init error, the operator-visible behaviour is already correct; the missing piece is on the callee side. |
| 7 | [src/channels/websocket.ts](../../../../src/channels/websocket.ts), [src/server/server.ts](../../../../src/server/server.ts#L70-L78) | server.ts L70-L78, L663-L666 | The WebSocket channel uses an `SAIVAGE_API_TOKEN` env-var gate at HTTP upgrade time — fundamentally a different authz shape (capability token vs. identity allowlist). |

## 3. Symptom → root-cause map

| Symptom | Root cause |
|---|---|
| New collaborator types in Telegram, sees nothing happen. | Bug #1 — reactive authz path returns without replying. |
| `/api/state` reports `telegram: enabled`, but pushes never arrive. | Bug #2 — `startTelegramBot` resolves "successfully" while `bot.start()` is already rejecting; caller cannot distinguish "alive" from "dead". |
| Operator drops a user from `allowedUserIds` and restarts the daemon; that user keeps receiving notifications and consuming tokens. | Bug #3 — persisted subscriptions are hydrated without authz check; persisted doc has no `userId` to check against. |

All three reduce to: *Telegram channel authz is only enforced on inbound text, and the persistence schema is too thin to enforce it anywhere else.*

## 4. Live cross-channel comparison

- WebSocket channel: token-based (capability), checked at HTTP upgrade ([src/server/server.ts](../../../../src/server/server.ts#L663-L666)). No persistent subscription concept; if the token leaks or is revoked, the next reconnect fails.
- Telegram channel: identity-based (allowlist) + persistent subscriptions (push destinations). Revocation requires invalidating *both* the reactive gate and the persisted destination list.

The "level up" suggestion in the issue (single `ChannelAuthorizer` interface) is structurally tempting but the two channels' principals are different in kind (`{ userId }` vs. `{ apiToken }`). Unifying them would create a tagged-union interface whose only consumer at each call site picks one variant — i.e. a leaky abstraction. That work belongs in [G40 — auth documentation](../G40-auth-documentation-missing-saivage-api-token.md), not here.

## 5. Project-rule compliance check

The new project-wide principles apply as follows to this fix:

1. **No regex for parsing user intent — slash commands only.** Current parsing uses literal `text === "/subscribe" || text.startsWith("/subscribe ")` ([telegram-bot.ts L142, L155](../../../../src/server/telegram-bot.ts#L142)) — already compliant. The `replace(/^-/, "m")` in `telegramSessionId` ([telegram-bot.ts L214](../../../../src/server/telegram-bot.ts#L214)) is a single-char id-encoding substitution, not user-intent parsing — allowed.
2. **Avoid hardcoded values; prefer config.** The reply string and the SOFT message length limit (4096) are not configuration-shaped. The startup timeout is owned by the caller. No new hardcoded values are introduced.
3. **No fragile agent-tool-call heuristics.** N/A — this is a channel/auth fix, no agent-tool-call code is touched.

## 6. Scope boundaries

- **In scope**: `src/server/telegram-bot.ts`, `TelegramSubscriptionsSchema` shape in `src/types.ts`, telegram bot tests.
- **Out of scope**: WebSocket channel authz (G40), markdown-to-MarkdownV2 conversion in `src/channels/telegram.ts`, any change to `telegram.allowedUserIds` config shape.
- **Backward-compat policy**: per project rule, the persisted `telegram-subscriptions.json` schema is replaced; no migration shim. Operators re-issue `/subscribe` after upgrade. The existing test "boot with corrupt persisted file throws (fatal)" already documents that a malformed file is fatal — the schema rewrite extends this contract.

## 7. Open questions

- Should "Not authorized." be silent (log only) or visible? Issue text recommends visible; we go with visible — see design.
- Should hydration *drop* unknown-user entries from disk on boot, or just skip them in-memory? Going with on-disk rewrite — see design.
