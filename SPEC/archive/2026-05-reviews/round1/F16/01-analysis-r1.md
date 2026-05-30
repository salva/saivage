# F16 — Analysis (r1)

## Problem restated

The Telegram bot bootstraps notifications by treating every entry in `config.telegram.allowedUserIds` as a chat id, even though Telegram user-ids and chat-ids live in different namespaces. At [src/server/telegram-bot.ts](src/server/telegram-bot.ts#L134-L137) the loop does:

```ts
if (allowedUserIds.size > 0) {
  for (const userId of allowedUserIds) getOrCreateSession(userId);
  log.info(`[telegram] Pre-subscribed ${allowedUserIds.size} allowed user(s) for project notifications`);
}
```

`getOrCreateSession(chatId: number)` at [src/server/telegram-bot.ts](src/server/telegram-bot.ts#L46-L109) keys the session map by `chatId`, builds a `TelegramChannel(chatId, sendFn)` whose `sendFn` calls `bot.api.sendMessage(chatId, …)`, instantiates a `ChatAgent`, and immediately subscribes that agent to the `EventBus` via `ChatAgent`'s constructor at [src/agents/chat.ts](src/agents/chat.ts#L184-L189).

Consequences once the bot starts:

1. A live `ChatAgent` is created for every value in `allowedUserIds` before the operator has ever sent a message.
2. Each agent immediately subscribes to the `EventBus`, so every published system event (stage completion/failure/escalation) is fan-routed to `bot.api.sendMessage(userId, …)`. For a user-id that does not match an existing private chat (e.g. an operator listed someone who never started the bot, a Telegram group id mistakenly typed in, or a channel id) the API call fails for every notification and the failure is just logged at [src/server/telegram-bot.ts](src/server/telegram-bot.ts#L58-L62).
3. When the value happens to coincide with a valid private-DM chat-id (which is the only "happy path" Telegram offers — private DMs use `chatId == userId`), notifications stream into that DM before the user opts in. If the same person is supposed to receive notifications in a group context (where `chatId` is negative and unrelated to `userId`), they instead get them in their DM.
4. The model conflates two semantically distinct concepts: "who is allowed to talk to the bot" (a `from.id` allow-list on inbound messages) and "where notifications should be sent" (a chat-id list for outbound events). The current code treats them as one set with the wrong type, which is what makes the misuse possible.

The inbound path is already correct and does the right thing: at [src/server/telegram-bot.ts](src/server/telegram-bot.ts#L113-L124) the handler checks `allowedUserIds.has(ctx.from?.id)` (user-id namespace) and then keys the session by `ctx.chat.id` (chat-id namespace), so groups, supergroups and DMs all work as long as an allow-listed user sends the first message. The bug is exclusively in the pre-subscribe bootstrap.

## Actual differences

Not a duplication issue.

## Contract

`startTelegramBot(runtime)` contract today:
- Inputs: `runtime.config.telegram.botToken` (string), `runtime.config.telegram.allowedUserIds` (number[]).
- Side effects: starts long-polling, subscribes one `ChatAgent` per `allowedUserIds` entry at boot, registers a `message:text` handler, returns `{ stop }`.
- Failure modes: empty `botToken` throws; unknown `userId` on inbound message is rejected and logged; outbound `sendMessage` failures are logged but do not stop the bot.

Telegram namespace facts the contract must respect:
- `from.id` is always a positive bot-API user-id.
- `chat.id` is positive for private chats (equal to the peer's `user.id`), negative for groups/supergroups (no relation to any user-id), and negative for channels.
- Bot API calls like `sendMessage(chatId, …)` require a chat-id, not a user-id.

## Call sites & dependencies

- `startTelegramBot` is wired from [src/server/bootstrap.ts](src/server/bootstrap.ts) (started when `config.notifications.channels` includes `"telegram"`). The bot is independent of the WebSocket/HTTP path: the only shared state is `runtime.eventBus`, `runtime.plannerControl` and `runtime.routing`.
- `ChatAgent` consumes the channel object via the constructor at [src/agents/chat.ts](src/agents/chat.ts#L148-L189); the `eventBus.subscribe` call happens unconditionally in the constructor, so creating a `ChatAgent` is the act that wires a destination into the event bus. There is no "register channel but stay dormant" mode.
- The `TelegramChannel` constructor at [src/channels/telegram.ts](src/channels/telegram.ts#L86-L94) takes a `chatId` and a `sendFn` that already closes over a chat-id; nothing downstream knows whether that chat-id corresponds to a private chat, group, or channel.
- Tests: [src/channels/telegram.test.ts](src/channels/telegram.test.ts) only covers the markdown→HTML conversion and the message-splitter. There are no tests for `telegram-bot.ts`.

## Constraints any solution must respect

- No backward compatibility for the current `allowedUserIds`-as-chatIds behaviour. If the meaning of the config field changes, the old field is removed in the same change (project guideline 1).
- `getOrCreateSession` must remain keyed by `ctx.chat.id` so groups continue to work for reactive messages.
- `ChatAgent.run()` must not be invoked until a real chat-id is known (subscribing it earlier always couples the lifecycle to a guessed destination — that is the underlying class of bug here).
- The `EventBus` is in-process and fan-outs to every active subscription; therefore the rule "agent ⇄ destination chat-id" must hold at subscription time, not later. There is no mechanism to "re-target" an existing subscription.
- The fix must not regress the allow-list check on inbound messages: `from.id` against a user-id set.
- Out-of-scope: any change to `src/skills/*`, `SPEC/v2/skills*/` and the memory subsystem.
