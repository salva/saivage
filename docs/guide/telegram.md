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

`allowedUserIds` is a hard allow-list of Telegram numeric user IDs. Anyone
not in the list is silently ignored. Use `@userinfobot` to discover your
user ID.

To enable notifications via Telegram, add `"telegram"` to
`notifications.channels` in either project or runtime config:

```jsonc
"notifications": {
  "channels": ["web", "telegram"],
  "filters": { "min_severity": "warning", "categories": [] }
}
```

## Running

The bot is launched automatically when `saivage serve` boots if both
`telegram.botToken` and `telegram.allowedUserIds` are set.

The bot uses **long polling** — it does not expose a webhook and does not
require a public-facing URL.

## Commands

The Chat agent in Telegram understands free-form messages. It can:

- Answer questions about the plan, stage, current task.
- Create user notes (mark them urgent or permanent).
- Dispatch the Inspector with a free-form scope.

There are also a few built-in slash commands:

| Command | Effect |
|---------|--------|
| `/start` | Show a brief help message. |
| `/status` | Same as `saivage status` — current plan + stage. |
| `/stop` | Same as `request-shutdown` — Planner exits gracefully. |
| `/inspect <scope>` | Dispatches the Inspector and streams the report. |

## Architecture note

A single Chat agent instance is created per Telegram user (per `chatId`).
Sessions are isolated; one user can't see another's conversation. The Chat
agent has read-only access to project state and can only mutate via
`create_note()` and `run_inspector()`.

See [Channels](/internals/channels) for the implementation.
