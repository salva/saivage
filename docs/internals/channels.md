# Channels

[`src/channels/`](https://github.com/salva/saivage/tree/main/src/channels)

A channel is a transport that connects a user to a Chat agent. Channels
share a common interface (`Channel` in `src/channels/types.ts`) so the
runtime can manage them uniformly.

## Channel interface

```ts
interface Channel {
  name: string;                    // "web" | "telegram" | "cli" | "oneshot"
  start(runtime: SaivageRuntime): Promise<void>;
  stop(): Promise<void>;
  publish(event: SystemEvent): void;
}
```

`publish` allows the EventBus to push notifications to the channel; the
channel decides how to render them (web → WS frame, Telegram → message,
CLI → stdout line).

## CLI channel

`channels/cli.ts` implements ad-hoc Chat invocations bound to stdin/stdout.
Used implicitly by the `saivage` CLI for commands like `inspect` that
need a one-off Chat-style interaction.

## One-shot channel

`channels/oneshot.ts` is a synchronous variant: open Chat, send one
message, await the reply, close. Used by `saivage inspect <scope>` to
render a single Inspector dispatch on stdout.

## WebSocket channel

`channels/websocket.ts` is the workhorse for the dashboard.

- One Chat instance per connected client.
- JSON envelope protocol (see [Web Dashboard](/guide/web-ui#websocket-protocol)).
- Streaming responses — partial LLM deltas are forwarded as
  `{ "type": "chat-chunk", "payload": { sessionId, delta } }`.
- Subscribes to `EventBus` with the user's notification filter and pushes
  `{ "type": "event" }` envelopes.

## Telegram channel

`channels/telegram.ts` uses `grammy`. Long-polling, allow-listed users,
single Chat per Telegram user. Slash commands are wired in
`server/telegram-bot.ts`.

## Adding a channel

1. Implement `Channel`.
2. Wire it into `bootstrap()` (after the web/telegram registration block).
3. Decide the channel's notification filter source (project vs. runtime
   defaults).
4. Add a config block in `saivage.json` if you need credentials.

## State

Channels are stateless across daemon restarts — their connections drop
when the daemon stops and reconnect on resume. Chat session history is
stored under `.saivage/tmp/chats/` for debugging only.
