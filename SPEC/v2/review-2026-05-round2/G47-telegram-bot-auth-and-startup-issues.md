# G47 — Telegram bot: silent unauthorized drop, unawaited `bot.start()`, and boot rehydration bypasses the allowlist

- **Subsystem**: channels (`src/server/telegram-bot.ts`)
- **Category**: bug, security-relevant
- **Severity**: medium

## Summary

Three independent issues in the same file, each individually low-medium but
together they form one coherent class of bug: the Telegram bot's
authorization story is asymmetric and lossy.

1. Messages from unauthorized users are silently dropped — they receive no
   error, no acknowledgement, nothing. The bot looks broken from the user's
   side.
2. `bot.start()` is called without `await`. If long-polling fails to
   initialise (bad token, network error, telegram API rate-limit), the start
   error is never surfaced and `startTelegramBot` resolves successfully while
   the bot is in fact dead.
3. The boot-time subscription-hydration loop calls `getOrCreateSession()` for
   every persisted `chatId` *without* consulting `allowedUserIds`. Tightening
   the allowlist does not retroactively close existing notification
   destinations; chats that were authorized at subscribe-time keep receiving
   pushes and keep consuming LLM tokens on every notification.

## Evidence

Unauthorized silent drop:

```ts
if (allowedUserIds.size > 0 && (!userId || !allowedUserIds.has(userId))) {
  log.warn(`[telegram] Rejected message from unauthorized user ${userId}`);
  return;
}
```

[src/server/telegram-bot.ts](src/server/telegram-bot.ts#L127-L131)

`bot.start()` not awaited (the call returns a Promise that resolves when
polling stops, but here we want to surface startup *errors* — the standard
grammy pattern is to handle the start error via `bot.catch` plus a `try/await`
around `bot.start()` with `drop_pending_updates` etc.):

```ts
log.info("[telegram] Starting Telegram bot (long polling)...");
bot.start({
  onStart: (botInfo) => {
    log.info(`[telegram] Bot started: @${botInfo.username} (${botInfo.id})`);
  },
});

return {
  stop: async () => { … },
};
```

[src/server/telegram-bot.ts](src/server/telegram-bot.ts#L186-L200)

Boot hydration bypasses allowlist:

```ts
// Boot: hydrate persisted subscriptions (notification destinations).
const persisted = await readSubs();
for (const chatId of persisted.chatIds) await getOrCreateSession(chatId);
```

[src/server/telegram-bot.ts](src/server/telegram-bot.ts#L181-L185)

Note `getOrCreateSession` does *not* re-check `allowedUserIds` — the only
authorization gate is in the `bot.on("message:text")` handler, which is a
*reactive* path. Push notifications spawned via the hydration loop are
pro-active and unchecked.

## Why this matters

- The silent drop is operator-hostile: the bot is the primary user-visible
  failure mode when adding a new collaborator (admin forgot to add their
  Telegram id to `allowedUserIds`) and they get *zero feedback*. Logs are not
  visible to the affected user.
- The unawaited start is a stealth-failure path: the daemon reports
  `telegram: enabled` in `/api/state`, but in fact the bot is silent. The
  Telegram bot is the headline notification channel, so this directly
  degrades the "Saivage tells me when stages finish" contract.
- The allowlist bypass is a privilege-escalation-shaped bug: the operator's
  remediation for "remove a user's access" is to drop them from
  `allowedUserIds`, but they will keep receiving notifications until the
  daemon restarts AND the operator also edits the on-disk
  `telegramSubscriptions` doc. Nothing in the docs warns about this.

## Rough remediation direction

1. Send a one-line response on unauthorized: `await ctx.reply("Not
   authorized.")` (or, more discreetly, the same with `parse_mode: undefined`
   and no link previews). The log line remains for the operator.
2. Wrap `bot.start({ … })` in a `try/await`, surface failures by rejecting
   the `startTelegramBot` Promise, and let the caller (in `server.ts`) decide
   whether the daemon should die or continue without Telegram. The current
   `onStart` callback is a per-poll callback, not the startup contract.
3. Filter `persisted.chatIds` through `allowedUserIds` before hydrating.
   Either drop disallowed chat ids silently with a warning, or — better —
   persist the *user id* alongside the chat id at subscribe time, and
   re-validate on hydrate. The current persistence schema (`{ chatIds }`)
   does not retain the originating user id, which is the deeper problem.

**Level up**: the Telegram channel is the only place in the codebase that
performs authorization as a string-id allowlist + reactive gate. Generalise
into a single `ChannelAuthorizer` interface that gets called on *every*
session creation event (reactive *or* hydrated), and reuse it for the
WebSocket channel (which today relies on `SAIVAGE_API_TOKEN` at upgrade time
only). That gives the operator one mental model and one place to revoke
access.

## Cross-links

- G40 — auth documentation is missing entirely (the SAIVAGE_API_TOKEN gate),
  same root concern: channel auth has no coherent story.
- F26 — SPA auth-state duplication; this issue is the channel-side analogue.
