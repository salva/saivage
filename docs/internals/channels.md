# Channels

[`src/channels/`](https://github.com/salva/saivage/tree/main/src/channels)

A channel bridges a user transport to a Chat agent. The runtime ships
two implementations and they share the contract defined in
[`src/channels/types.ts`](https://github.com/salva/saivage/blob/main/src/channels/types.ts).

## Interface

```ts
export interface ChatChannel {
  /** Send a message to the user */
  send(message: string): void | Promise<void>;

  /** Register handler for incoming user messages */
  onMessage(handler: (message: string) => void | Promise<void>): void;

  /** Register handler for disconnection */
  onClose(handler: () => void): void;

  /** Close the channel */
  close(): void | Promise<void>;
}
```

- `send(message)` — push a plain-text user-visible message
  ([`types.ts` L7](https://github.com/salva/saivage/blob/main/src/channels/types.ts#L7)).
- `onMessage(handler)` — register a callback invoked for each incoming
  user message
  ([`types.ts` L10](https://github.com/salva/saivage/blob/main/src/channels/types.ts#L10)).
- `onClose(handler)` — register a callback invoked when the transport
  disconnects
  ([`types.ts` L13](https://github.com/salva/saivage/blob/main/src/channels/types.ts#L13)).
- `close()` — tear down the transport from the runtime side
  ([`types.ts` L16](https://github.com/salva/saivage/blob/main/src/channels/types.ts#L16)).

## Concrete channel extensions

The shipped channels expose two members beyond the four-method
interface:

- `sendEvent(event)` — both shipped channels implement it
  ([`websocket.ts` L39-L43](https://github.com/salva/saivage/blob/main/src/channels/websocket.ts#L39-L43),
  [`telegram.ts` L373-L378](https://github.com/salva/saivage/blob/main/src/channels/telegram.ts#L373-L378))
  but it is not part of the interface, so callers reach it through the
  structural-type cast
  `ChatChannel & { sendEvent?: (e: Record<string, unknown>) => void }`.
  The runtime invokes it from three sites:
    - ChatAgent emits a `thinking` envelope before each LLM turn
      ([`chat.ts` L208-L210](https://github.com/salva/saivage/blob/main/src/agents/chat.ts#L208-L210)).
    - ChatAgent emits the assistant `message` envelope on non-Telegram
      channels
      ([`chat.ts` L388-L394](https://github.com/salva/saivage/blob/main/src/agents/chat.ts#L388-L394)).
    - The WebSocket route emits a `session` envelope once per connection
      ([`server.ts` L692-L693](https://github.com/salva/saivage/blob/main/src/server/server.ts#L692-L693)).
  On Telegram, `sendEvent` only forwards `message` events; `thinking`
  and other internal types are discarded
  ([`telegram.ts` L373-L378](https://github.com/salva/saivage/blob/main/src/channels/telegram.ts#L373-L378)).
- `chatId: number` — Telegram-only readonly identifier exposed for
  routing
  ([`telegram.ts` L358-L362](https://github.com/salva/saivage/blob/main/src/channels/telegram.ts#L358-L362)).
  Not a cross-channel concept.

Neither extension is part of the `ChatChannel` contract in
[`types.ts` L5-L17](https://github.com/salva/saivage/blob/main/src/channels/types.ts#L5-L17),
so a new channel implementation is not obliged to provide either — but a
channel intended for the dashboard's typed front-end should implement
`sendEvent` to avoid falling back to plain-text frames.

## WebSocket channel

[`src/channels/websocket.ts`](https://github.com/salva/saivage/blob/main/src/channels/websocket.ts)
is the channel used by the dashboard.

- One instance per connected client.
- `send(message)` emits a JSON envelope `{ type: "message", content }`
  on the socket
  ([`websocket.ts` L34-L37](https://github.com/salva/saivage/blob/main/src/channels/websocket.ts#L34-L37)).
- `sendEvent(event)` serialises any typed envelope and writes it when
  the socket is open
  ([`websocket.ts` L39-L43](https://github.com/salva/saivage/blob/main/src/channels/websocket.ts#L39-L43));
  see the [Concrete channel extensions](#concrete-channel-extensions)
  section for the cross-channel contract.
- Incoming frames are parsed as `{ type: "message", content }` JSON
  envelopes; non-JSON payloads fall back to raw text
  ([`websocket.ts` L17-L28](https://github.com/salva/saivage/blob/main/src/channels/websocket.ts#L17-L28)).

## Telegram channel

[`src/channels/telegram.ts`](https://github.com/salva/saivage/blob/main/src/channels/telegram.ts)
is the channel used by the Telegram bot.

- One instance per Telegram chat.
- `send(message)` converts the input to MarkdownV2 via
  `telegramify-markdown` and uses a source-side splitter to respect the
  4096-byte Telegram message limit
  ([`telegram.ts` L1-L20](https://github.com/salva/saivage/blob/main/src/channels/telegram.ts#L1-L20)).
- `chatId: number` is the readonly Telegram chat identifier
  ([`telegram.ts` L358-L362](https://github.com/salva/saivage/blob/main/src/channels/telegram.ts#L358-L362)).
- `sendEvent(event)` filters to `message` events only and discards
  internal envelopes
  ([`telegram.ts` L373-L378](https://github.com/salva/saivage/blob/main/src/channels/telegram.ts#L373-L378)).

Slash-command wiring lives in `src/server/telegram-bot.ts` if a reader
needs the registration code.

## Adding a channel

1. Implement the four-method `ChatChannel` contract from
   [`types.ts` L5-L17](https://github.com/salva/saivage/blob/main/src/channels/types.ts#L5-L17).
2. Optionally implement `sendEvent(event)` if the channel's front-end
   consumes typed envelopes (the dashboard does; Telegram is a
   message-only example).
3. Wire the channel into the bootstrap path that owns its transport
   (the WebSocket setup at
   [`server.ts` L692-L693](https://github.com/salva/saivage/blob/main/src/server/server.ts#L692-L693),
   Telegram in `src/server/telegram-bot.ts`).
4. Add any credentials or allow-lists to `saivage.json` if the transport
   needs them.

## State

Channels are stateless across daemon restarts; their connections drop
when the daemon stops and reconnect on resume. Chat session history is
owned by the ChatAgent, not by the channel — see the Sessions section of
[Chat](./agent-chat) for the on-disk layout.
