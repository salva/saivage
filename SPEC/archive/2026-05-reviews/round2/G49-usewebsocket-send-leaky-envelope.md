# G49 — `useWebSocket.send` accepts a raw string, forcing every caller to hand-encode the envelope

- **Subsystem**: web UI (`web/src/composables/useWebSocket.ts`,
  `web/src/components/ChatWindow.vue`)
- **Category**: API design / maintainability
- **Severity**: low

## Summary

The `useWebSocket` composable exposes `send(content: string)` which forwards
the raw string to `ws.send`. The Saivage server speaks JSON envelopes
(`{type:"message", content:…}`, `{type:"interrupt"}`) on this WS — so every
caller must `JSON.stringify` an envelope before calling `send()`. There is
exactly one caller today (`ChatWindow.vue`) and it does this duplication
inline. The composable already defines the inbound `WsEvent` shape; the
outbound shape is symmetric, but the API does not enforce it. Any new caller
that calls `send("hello")` will silently desync from the server-side parser,
which falls back to `{type:"unknown", raw:"hello"}` — a confusing failure
mode.

## Evidence

Composable signature:

```ts
function send(content: string) {
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(content);
  }
}
```

[web/src/composables/useWebSocket.ts](web/src/composables/useWebSocket.ts#L93-L98)

Only caller has to repeat the envelope schema:

```ts
send(JSON.stringify({ type: "message", content: text }));
```

[web/src/components/ChatWindow.vue](web/src/components/ChatWindow.vue#L157)

Server-side parser falls back silently for non-JSON / unknown shapes — see
[src/channels/websocket.ts](src/channels/websocket.ts#L20-L50).

## Why this matters

The leak shows up the moment a second caller appears (e.g. a planned
"interrupt button" elsewhere in the SPA, or a generic Debug-tab "send raw
frame" tool). Each new caller will either re-implement the JSON envelope
inline (lots of small duplications, each free to drift) or pass the wrong
shape and chase a confusing "the server ignored my message" bug.

Symmetrically, the composable already defines the *inbound* type as
`WsEvent`; the outbound API should be the matching discriminated union, not
`string`.

## Rough remediation direction

Replace `send(content: string)` with two narrow methods (or a single
discriminated-union one):

```ts
export type WsOut =
  | { type: "message"; content: string }
  | { type: "interrupt" };

function send(msg: WsOut) {
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}
```

Update `ChatWindow.vue` to call `send({ type: "message", content: text })`.
Export `WsOut` so future callers cannot drift.

**Level up**: while restructuring, also fix the unbounded growth of
`events.value` (it pushes every inbound frame into a `ref([])` array that is
never trimmed; on long-running sessions this leaks memory in the SPA). This
is a sibling concern but the composable is small enough that it makes sense
to address both in one pass: either cap the array at the last N frames, or
move from `ref<WsEvent[]>` to an emitter-style API (`onEvent(cb)`) so
consumers own their retention policy.

## Cross-links

- G40 — the WS protocol is documented incorrectly; both bugs disappear once
  the protocol has one source of truth (a typed schema consumed by both
  ends).
- F26 — SPA auth state duplication; same architectural pattern of "shared
  concern duplicated across consumers".
