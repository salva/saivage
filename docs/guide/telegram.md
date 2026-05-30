# Telegram Channel

Saivage ships a Telegram chat channel via the `grammy` bot framework. Each
authorized Telegram user gets a private chat session with a Chat agent.

## Configuration

Add to `saivage.json`:

```jsonc
"telegram": {
  "botToken": "${TELEGRAM_BOT_TOKEN}",
  "allowedUserIds": [123456789]
}
```

Set `TELEGRAM_BOT_TOKEN` in the environment of the daemon.

`allowedUserIds` is an allow-list of Telegram numeric user IDs. Anyone not in a
non-empty list receives `Not authorized.` and is ignored. If the list is empty,
Saivage accepts identifiable Telegram users and logs a warning. Use
`@userinfobot` to discover your user ID.

To enable notifications via Telegram, add `"telegram"` to
`notifications.channels` in runtime config:

```jsonc
"notifications": {
  "channels": ["web", "telegram"],
  "filters": { "min_severity": "warning", "categories": [] }
}
```

## Running

The bot is launched automatically when `saivage serve` boots if
`telegram.botToken` is set.

The bot uses **long polling** — it does not expose a webhook and does not
require a public-facing URL.

## Commands

The Chat agent in Telegram understands free-form messages. It can:

- Answer questions about the plan, stage, current task.
- Create user notes (mark them urgent or permanent).
- Dispatch the Inspector with a free-form scope.

Telegram also supports the local Chat slash commands plus subscription
commands:

| Command | Effect |
|---------|--------|
| `/subscribe` | Persist this chat as a project notification destination. |
| `/unsubscribe` | Remove this chat from persisted notifications and close the session. |
| `/help` | Show local chat commands. |
| `/status` | Show runtime status, active agents, and current stage. |
| `/plan` | Show the active plan. |
| `/history [N]` | Show completed stage history. |
| `/replan [REASON]` | Create an urgent Planner note. |
| `/restart-planner REASON` | Cancel the current Planner turn and restart from persisted state. |
| `/note MESSAGE` / `/note! MESSAGE` / `/notep MESSAGE` | Create normal, urgent, or permanent Planner notes. |

## Architecture note

A single Chat agent instance is created per Telegram user (per `chatId`).
Sessions are isolated; one user can't see another's conversation. The Chat
agent has read-only access to project state and can only mutate via
`create_note()` and `run_inspector()`.

See [Channels](/internals/server/channels) for the implementation.
