# G49 — Analysis (Round 1)

- **Issue**: [../G49-usewebsocket-send-leaky-envelope.md](../G49-usewebsocket-send-leaky-envelope.md)
- **Subsystem**: web UI WS hook + server WS channel
  - [web/src/composables/useWebSocket.ts](../../../../web/src/composables/useWebSocket.ts)
  - [web/src/components/ChatWindow.vue](../../../../web/src/components/ChatWindow.vue)
  - [src/channels/websocket.ts](../../../../src/channels/websocket.ts)
- **Severity (as filed)**: low (API hygiene / latent footgun)

## 1. Restated finding

The Saivage SPA talks to the server over a single WebSocket. The on-the-wire envelope is JSON, with a discriminator field `type`. The web composable [useWebSocket.ts](../../../../web/src/composables/useWebSocket.ts#L93-L97) exposes its outbound API as `send(content: string)`, which forwards the raw string straight to `ws.send`. There is no schema, no discriminated union, and no runtime validation. The only caller today, [ChatWindow.vue L157](../../../../web/src/components/ChatWindow.vue#L157), hand-encodes the envelope inline:

```ts
send(JSON.stringify({ type: "message", content: text }));
```

The server-side parser at [src/channels/websocket.ts L17-L27](../../../../src/channels/websocket.ts#L17-L27) tries `JSON.parse` and, on failure, silently treats the bytes as raw user prose. Inbound on the SPA side is symmetric: [useWebSocket.ts L63-L69](../../../../web/src/composables/useWebSocket.ts#L63-L69) parses every frame as `WsEvent` (`{ type: string; [k: string]: unknown }`) and, on parse failure, fabricates `{ type: "message", content: <raw bytes> }`.

Neither end has a single source of truth for what envelopes are legal. Every new caller of `send` is free to type-walk into a divergent shape, and every new server emitter is free to push a discriminator value that no SPA consumer handles. Both failures are silent.

## 2. Evidence (live line numbers)

| # | Location | Live lines | Notes |
|---|---|---|---|
| 1 | [web/src/composables/useWebSocket.ts](../../../../web/src/composables/useWebSocket.ts#L5-L8) | L5-L8 | `WsEvent` inbound shape: `{ type: string; [k: string]: unknown }`. No discriminator enumeration; every field except `type` is `unknown`. |
| 2 | [web/src/composables/useWebSocket.ts](../../../../web/src/composables/useWebSocket.ts#L33) | L33 | `const events = ref<WsEvent[]>([])` — array grows unbounded; no consumer trims it (sibling concern flagged in the issue's "Level up"). |
| 3 | [web/src/composables/useWebSocket.ts](../../../../web/src/composables/useWebSocket.ts#L62-L70) | L62-L70 | `onmessage` handler: `JSON.parse(event.data) as WsEvent` (no validation), and on parse failure pushes a synthesised `{type:"message", content:event.data}` — silently invents a frame that never came from the server. |
| 4 | [web/src/composables/useWebSocket.ts](../../../../web/src/composables/useWebSocket.ts#L93-L97) | L93-L97 | `send(content: string)` — accepts a raw string, no envelope, no schema check. |
| 5 | [web/src/components/ChatWindow.vue](../../../../web/src/components/ChatWindow.vue#L4) | L4 | Imports `useWebSocket`. |
| 6 | [web/src/components/ChatWindow.vue](../../../../web/src/components/ChatWindow.vue#L39) | L39 | Destructures `connected, status, events, send`. |
| 7 | [web/src/components/ChatWindow.vue](../../../../web/src/components/ChatWindow.vue#L71-L121) | L71-L121 | Inbound watcher — type-walks `ev.type` for `"session" / "thinking" / "message" / "system" / "event"`, all reading fields as `as string` or `as string \| undefined`. No exhaustiveness check; an unknown discriminator falls through silently. |
| 8 | [web/src/components/ChatWindow.vue](../../../../web/src/components/ChatWindow.vue#L157) | L157 | Only caller of `send` — hand-encodes the outbound envelope. |
| 9 | [src/channels/websocket.ts](../../../../src/channels/websocket.ts#L17-L27) | L17-L27 | Server-side inbound parser. Tries `JSON.parse`, falls back to "treat as raw text" silently if the shape does not match `{type:"message", content:string}`. |
| 10 | [src/channels/websocket.ts](../../../../src/channels/websocket.ts#L34-L43) | L34-L43 | Server-side outbound `send` / `sendEvent`. `sendEvent` accepts any `WsEvent` (same loose shape as the SPA's): the only contract is `JSON.stringify` of the bag. |
| 11 | [src/channels/websocket.ts](../../../../src/channels/websocket.ts#L4-L7) | L4-L7 | A second, independent declaration of `WsEvent` — the same name, the same loose shape, redeclared because the server and the SPA share no module. The two copies are free to drift. |
| 12 | [src/agents/chat.ts](../../../../src/agents/chat.ts#L209-L210) | L209-L210 | Server emitter — `ch.sendEvent?.({ type: "thinking" })`. Uses an optional-call escape hatch (`ChatChannel & { sendEvent?: … }`) to dodge the channel-interface type system. |
| 13 | [src/agents/chat.ts](../../../../src/agents/chat.ts#L388-L393) | L388-L393 | Server emitter — `eventChannel.sendEvent({ type: "message", content, ...source })`. Same escape hatch; `source` is a spread of arbitrary metadata fields the SPA reads as `as string \| undefined`. |
| 14 | [src/server/server.ts](../../../../src/server/server.ts#L693) | L693 | Server emitter — `channel.sendEvent({ type: "session", sessionId })`. Fired once per WS connection. |
| 15 | [src/channels/telegram.ts](../../../../src/channels/telegram.ts#L375) | L375 | Sibling channel with an independent `sendEvent({ type: string; [k: string]: unknown })`. Outside this issue's scope but confirms the pattern of "every channel re-declares the bag". |

## 3. Symptom → root-cause map

| Symptom | Root cause |
|---|---|
| A new SPA caller writes `send("hello")` and "the server ignores my message". | Server parser at [websocket.ts L17-L27](../../../../src/channels/websocket.ts#L17-L27) silently falls back to "raw text" when no envelope is present, but the `ChatAgent` queue only routes messages produced by the envelope branch — bare strings end up in the no-op branch (`msg = data.toString().trim()`, not extracted from envelope) and are routed as user prose. (Confirmed by re-reading L17-L27: bare strings DO reach `messageHandler` as raw bytes, which means the bug is *worse* than the issue states — bare-string sends are interpreted as **user prose**, not ignored.) Either way the SPA receives no clear signal. |
| A future server emitter publishes `{type:"toolCall", …}`. The SPA renders nothing. | `ChatWindow.vue` L71-L121 does not branch on `"toolCall"`, and `WsEvent` is `{type:string; [k:string]:unknown}` so TS cannot catch the missing case. |
| A field rename on the server side (`provider` → `providerId`) silently breaks the SPA badge. | SPA reads `ev.provider as string \| undefined` ([ChatWindow.vue L107-L110](../../../../web/src/components/ChatWindow.vue#L107-L110)); the cast suppresses any compile-time signal. |
| SPA receives malformed JSON. | `onmessage` catches and *fabricates* `{type:"message", content:rawBytes}` ([useWebSocket.ts L67-L69](../../../../web/src/composables/useWebSocket.ts#L67-L69)) — corrupted bytes are rendered to the user as if the agent said them. |

All four reduce to: *the WS envelope has no single, machine-checkable source of truth shared between server and SPA.*

## 4. Project-rule and new-principle compliance

The repository's architecture-first / no-backward-compat rule (user memory) requires that we fix the structural duplication of `WsEvent` and the type-erasing escape hatches, not paper over the leaky `send()` signature alone. The fix must:

1. **One schema, two consumers.** A single module declares the inbound (server→SPA) and outbound (SPA→server) discriminated unions, and both the server and the web bundle import it. Per project rule, we delete the two ad-hoc `WsEvent` declarations rather than keep them as aliases.
2. **Fail-loud on unknowns.** Both sides validate frames at the boundary. An unknown discriminator (or a known one with wrong fields) is logged with the offending frame and the connection is closed with a well-defined code; it is *not* coerced into a fallback shape. This deletes the silent fallbacks at [useWebSocket.ts L67-L69](../../../../web/src/composables/useWebSocket.ts#L67-L69) and [websocket.ts L23-L27](../../../../src/channels/websocket.ts#L23-L27).
3. **No regex for parsing user intent — slash commands only.** N/A here: the envelope is JSON, not user prose.
4. **Avoid hardcoded values; prefer config.** N/A — no thresholds or model names involved.
5. **No fragile agent-tool-call heuristics.** N/A — pure transport schema.

The "level up" sibling concern from the issue (unbounded `events.value` array, [useWebSocket.ts L33,L66](../../../../web/src/composables/useWebSocket.ts#L33)) is in scope because the same composable owns it and the schema rework already touches the inbound handler. The replacement pattern (an emitter-style API, `onEvent(cb)`) is also the natural shape for fail-loud routing — there is no longer a synthetic frame to push into an array on parse failure.

## 5. Scope boundaries

- **In scope**
  - The outbound `send` signature in [useWebSocket.ts L93-L97](../../../../web/src/composables/useWebSocket.ts#L93-L97).
  - The inbound parser in [useWebSocket.ts L62-L70](../../../../web/src/composables/useWebSocket.ts#L62-L70).
  - The events buffer in [useWebSocket.ts L33-L66](../../../../web/src/composables/useWebSocket.ts#L33-L66) (replaced with an emitter API).
  - The server-side WS channel's inbound parser and outbound sender in [src/channels/websocket.ts](../../../../src/channels/websocket.ts).
  - The three call sites in [src/agents/chat.ts L209-L210](../../../../src/agents/chat.ts#L209-L210), [L388-L393](../../../../src/agents/chat.ts#L388-L393), and [src/server/server.ts L693](../../../../src/server/server.ts#L693) — typed against the shared schema.
  - The one SPA consumer in [ChatWindow.vue L71-L157](../../../../web/src/components/ChatWindow.vue#L71-L157).
  - Adding `zod` to the web bundle (root `package.json` already depends on `zod` ^3.25; the web sub-package will add the same dep).
- **Out of scope**
  - [src/channels/telegram.ts L375](../../../../src/channels/telegram.ts#L375) — Telegram does not speak JSON envelopes; its `sendEvent` is a no-op shim. We re-type it to accept the shared union for symmetry but do not change Telegram's behaviour. (Sibling cleanup, not part of the G49 critical path; covered explicitly in the plan as an optional follow-up step.)
  - F35 (channel surface) and G44 (channels doc) — already covered by their own tickets.
  - G40 (web protocol documentation drift) — the schema this issue produces becomes the single source of truth that will *resolve* G40 in a follow-up.
- **Backward-compat policy**: per project rule, no compatibility shim. The old `WsEvent` declarations are deleted, the old `send(content: string)` signature is removed, the silent fallbacks are removed, and any frame that does not match the schema closes the WS with a defined code.

## 6. Test surface

The natural seam for regression coverage is the schema module itself plus a thin "round-trip through `JSON.parse(JSON.stringify(x))` then validate" assertion. That gives us:

- A pure-unit test that every member of the inbound and outbound unions round-trips through `parse(stringify(x))`.
- A pure-unit test that asserts known-malformed payloads (missing discriminator, unknown discriminator, wrong-typed field) fail validation with a stable error shape.
- An integration test that drives the real `WebSocketChannel` with a fake `ws` socket and asserts that:
  - sending an envelope from the SPA shape reaches `messageHandler` with the expected content;
  - sending a malformed frame closes the socket with the defined code and does not invoke `messageHandler`;
  - `sendEvent` of an out-of-schema bag throws synchronously (server-side fail-loud).
- A pure-unit test of the SPA composable using a `MockWebSocket` (a tiny class implementing `readyState`, `send`, `close`, `onopen/onmessage/onclose/onerror`) that asserts:
  - `send({type:"message", content:"hi"})` writes `JSON.stringify({type:"message", content:"hi"})` to the socket;
  - inbound malformed frame surfaces a parse error to the emitter callback and does **not** push a fabricated frame;
  - the emitter-style API delivers known frames once and does not retain them.

No flaky timer-based assertions: validation is synchronous, and the SPA-side reconnect/backoff logic is unchanged by this issue.

## 7. Open questions

- **Should the schema live under `src/channels/ws-schema.ts` (server tree) and be re-exported from `web/src/composables/wsSchema.ts`, or under a new shared module?** The Saivage repo today has no `shared/` tree; the web bundle imports from `../../src/...` is blocked by tsconfig `rootDir`. Going with: a new file `src/channels/ws-schema.ts` that is also added to the web Vite build via the existing alias pattern in [web/vite.config.ts](../../../../web/vite.config.ts) (or via a path alias in [web/tsconfig.json](../../../../web/tsconfig.json)). Confirmed feasible during design — the design doc lists the exact alias change.
- **WS close code for schema-violating frames.** Existing close codes in the composable: `1008`, `4401`, `4403` (auth). Going with `1003` ("unsupported data") for malformed inbound frames; the SPA already treats anything other than the three auth codes as "reconnect after backoff", so this slots in without new branches.
- **Should the SPA emitter API replace `events: Ref<WsEvent[]>` entirely, or coexist?** Project rule says no compat shim — replace entirely. ChatWindow.vue is the only consumer; the migration is mechanical (a single `onEvent(handler)` registration inside `onMounted`).
