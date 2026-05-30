# F16 — Telegram bot pre-subscribes allow-listed users using `userId` as `chatId`

**Category**: unsafe-pattern
**Severity**: high
**Transversality**: local

## Summary

The Telegram bot iterates `allowedUserIds` and calls `getOrCreateSession(userId)` with the user id used as both the session key **and** the chat id. In Telegram, private chats happen to have `chatId == userId`, but group chats do not. If an operator adds a group's `userId` to the allow-list (a reasonable mistake), the bot creates a session that will send replies into the user's private chat — not into the group where the bot was authorised.

## Evidence

- Pre-subscribe loop and call shape: [src/server/telegram-bot.ts](src/server/telegram-bot.ts).
- The session map is keyed by `chatId`, not `userId`: see `getOrCreateSession` and surrounding state in the same file.

## Why this matters

Beyond the correctness bug, the lookup also leaks: any allow-listed user-id that the bot pre-subscribes will see system event notifications even before they message the bot, including content that may discuss other tenants. The right invariant is "create session lazily on first authenticated message from a chat" — never pre-subscribe.

## Related

- (no other findings target Telegram specifically)
