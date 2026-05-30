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

  /** Send a structured transport event to the user. */
  sendEvent(event: WsOutbound): void | Promise<void>;

  /** Register handler for incoming user messages */
  onMessage(handler: (message: string) => void | Promise<void>): void;

  /** Register handler for disconnection */
  onClose(handler: () => void): void;

  /** Close the channel */
  close(): void | Promise<void>;
}
```

- `send(message)` — push a plain-text user-visible message
  ([`types.ts` L9](https://github.com/salva/saivage/blob/main/src/channels/types.ts#L9)).
- `sendEvent(event)` — push a typed outbound event from
  `src/channels/ws-schema.ts`
  ([`types.ts` L12](https://github.com/salva/saivage/blob/main/src/channels/types.ts#L12)).
- `onMessage(handler)` — register a callback invoked for each incoming
  user message
  ([`types.ts` L13](https://github.com/salva/saivage/blob/main/src/channels/types.ts#L13)).
- `onClose(handler)` — register a callback invoked when the transport
  disconnects
  ([`types.ts` L16](https://github.com/salva/saivage/blob/main/src/channels/types.ts#L16)).
- `close()` — tear down the transport from the runtime side
  ([`types.ts` L19](https://github.com/salva/saivage/blob/main/src/channels/types.ts#L19)).

## Typed events and channel-specific members

The shipped channels share `sendEvent(event)` as part of the interface and
Telegram exposes one channel-specific member:

- `sendEvent(event)` — both shipped channels implement it
  ([`websocket.ts` L40-L44](https://github.com/salva/saivage/blob/main/src/channels/websocket.ts#L40-L44),
  [`telegram.ts` L376-L386](https://github.com/salva/saivage/blob/main/src/channels/telegram.ts#L376-L386))
  and the runtime invokes it from three sites:
    - ChatAgent emits a `thinking` envelope before each LLM turn
      ([`chat.ts` L211-L212](https://github.com/salva/saivage/blob/main/src/agents/chat.ts#L211-L212)).
    - ChatAgent emits the assistant `message` envelope on non-Telegram
      channels
      ([`chat.ts` L385-L388](https://github.com/salva/saivage/blob/main/src/agents/chat.ts#L385-L388)).
    - The WebSocket route emits a `session` envelope once per connection
      ([`server.ts` L757-L758](https://github.com/salva/saivage/blob/main/src/server/server.ts#L757-L758)).
  On Telegram, `sendEvent` only forwards `message` events; `thinking`
  and other internal types are discarded
  ([`telegram.ts` L376-L386](https://github.com/salva/saivage/blob/main/src/channels/telegram.ts#L376-L386)).
- `chatId: number` — Telegram-only readonly identifier exposed for
  routing
  ([`telegram.ts` L360-L362](https://github.com/salva/saivage/blob/main/src/channels/telegram.ts#L360-L362)).
  Not a cross-channel concept.

`chatId` is not part of the `ChatChannel` contract in
[`types.ts` L7-L21](https://github.com/salva/saivage/blob/main/src/channels/types.ts#L7-L21),
so a new channel implementation is not obliged to provide it.

## WebSocket channel

[`src/channels/websocket.ts`](https://github.com/salva/saivage/blob/main/src/channels/websocket.ts)
is the channel used by the dashboard.

- One instance per connected client.
- `send(message)` emits a JSON envelope `{ type: "message", content }`
  on the socket
  ([`websocket.ts` L36-L37](https://github.com/salva/saivage/blob/main/src/channels/websocket.ts#L36-L37)).
- `sendEvent(event)` serialises any typed envelope and writes it when
  the socket is open
  ([`websocket.ts` L40-L44](https://github.com/salva/saivage/blob/main/src/channels/websocket.ts#L40-L44));
  see the [typed events and channel-specific members](#typed-events-and-channel-specific-members)
  section for the cross-channel contract.
- Incoming frames are parsed as schema-validated JSON envelopes. Valid
  inbound frames are `{ type: "message", content }` and
  `{ type: "error", reason, raw? }`; malformed frames close the socket with
  code 1003
  ([`websocket.ts` L14-L28](https://github.com/salva/saivage/blob/main/src/channels/websocket.ts#L14-L28)).

## Telegram channel

[`src/channels/telegram.ts`](https://github.com/salva/saivage/blob/main/src/channels/telegram.ts)
is the channel used by the Telegram bot.

- One instance per Telegram chat.
- `send(message)` converts the input to MarkdownV2 via
  `telegramify-markdown` and uses a source-side splitter to respect the
  4096-byte Telegram message limit
  ([`telegram.ts` L365-L369](https://github.com/salva/saivage/blob/main/src/channels/telegram.ts#L365-L369)).
- `chatId: number` is the readonly Telegram chat identifier
  ([`telegram.ts` L360-L362](https://github.com/salva/saivage/blob/main/src/channels/telegram.ts#L360-L362)).
- `sendEvent(event)` filters to `message` events only and discards
  internal envelopes
  ([`telegram.ts` L376-L386](https://github.com/salva/saivage/blob/main/src/channels/telegram.ts#L376-L386)).

Slash-command wiring lives in `src/server/telegram-bot.ts` if a reader
needs the registration code.

## Adding a channel

1. Implement the five-method `ChatChannel` contract from
  [`types.ts` L7-L21](https://github.com/salva/saivage/blob/main/src/channels/types.ts#L7-L21).
2. Map `sendEvent(event)` to the transport's typed-envelope semantics; the
  dashboard forwards all outbound WebSocket events, while Telegram forwards
  only human-readable `message` events.
3. Wire the channel into the bootstrap path that owns its transport
   (the WebSocket setup at
  [`server.ts` L757-L758](https://github.com/salva/saivage/blob/main/src/server/server.ts#L757-L758),
   Telegram in `src/server/telegram-bot.ts`).
4. Add any credentials or allow-lists to `saivage.json` if the transport
   needs them.

## State

Channels are stateless across daemon restarts; their connections drop
when the daemon stops and reconnect on resume. Chat session history is
owned by the ChatAgent, not by the channel — see the Sessions section of
[Chat](../agents/chat) for the on-disk layout.
