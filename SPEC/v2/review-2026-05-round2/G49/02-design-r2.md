# G49 — Design (Round 2)

- **Round 1**: [01-analysis-r1.md](01-analysis-r1.md), [02-design-r1.md](02-design-r1.md), [03-plan-r1.md](03-plan-r1.md)
- **Round 2 analysis**: [01-analysis-r2.md](01-analysis-r2.md)
- **Review**: [04-review-r1.md](04-review-r1.md)

This r2 design supersedes [02-design-r1.md](02-design-r1.md) only on the points raised by [04-review-r1.md](04-review-r1.md). Proposal A (status-quo narrowing) and the recommendation to go with Proposal B (full schema) stand. The file inventory in r1 §B.1 stands except where the rows are amended below. The migration order in r1 §3 stands.

## 1. Amended schema shape (replaces r1 §B.2)

Both unions are `.strict()`. `WsInbound` gains a typed `error` variant.

```ts
// src/channels/ws-schema.ts
import { z } from "zod";

// SPA → server.
export const WsInboundSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("message"),
    content: z.string().min(1),
  }).strict(),
  z.object({
    type: z.literal("error"),
    reason: z.string().min(1),
    raw: z.string().optional(),
  }).strict(),
]);
export type WsInbound = z.infer<typeof WsInboundSchema>;

// server → SPA. Provenance keys are listed explicitly; the union is strict.
export const WsOutboundSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("session"),  sessionId: z.string().min(1) }).strict(),
  z.object({ type: z.literal("thinking") }).strict(),
  z.object({
    type: z.literal("message"),
    content: z.string(),
    provider: z.string().optional(),
    model: z.string().optional(),
    modelSpec: z.string().optional(),
    requestedModelSpec: z.string().optional(),
  }).strict(),
]);
export type WsOutbound = z.infer<typeof WsOutboundSchema>;

export type ParseResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string; raw: string };

export function parseInbound(raw: string): ParseResult<WsInbound> {
  let json: unknown;
  try { json = JSON.parse(raw); }
  catch (e) { return { ok: false, error: `invalid-json: ${(e as Error).message}`, raw }; }
  const r = WsInboundSchema.safeParse(json);
  return r.success
    ? { ok: true, value: r.data }
    : { ok: false, error: r.error.issues.map(i => `${i.path.join(".")}: ${i.message}`).join("; "), raw };
}

export function parseOutbound(raw: string): ParseResult<WsOutbound> { /* mirror of parseInbound */ }
```

Behavioural consequences of the strict change:

- Server emitter `sendEvent({type:"message", content, ...source})` ([chat.ts L390-L392](../../../../src/agents/chat.ts#L390-L392)) only succeeds when every key in `source` is one of `provider`/`model`/`modelSpec`/`requestedModelSpec`. Today the `source` object is built by the chat agent from `provider`/`model`/`modelSpec`/`requestedModelSpec`; the strict schema therefore matches today's emitter exactly. A future emitter that adds a fifth provenance key must add it to the schema first — the desired fail-loud.
- The two ad-hoc `WsEvent` declarations in [src/channels/websocket.ts L4-L7](../../../../src/channels/websocket.ts#L4-L7) and [web/src/composables/useWebSocket.ts L5-L8](../../../../web/src/composables/useWebSocket.ts#L5-L8) are deleted. Consumers import `WsInbound`/`WsOutbound` from the schema module.

## 2. Amended SPA composable shape (replaces r1 §B.3)

```ts
import { WsInbound, WsInboundSchema, WsOutbound, parseOutbound } from "@channels/ws-schema";

const ERRORS_CAP = 8;

export function useWebSocket(url?: string) {
  const connected = ref(false);
  const status = ref<WsStatus>("connecting");
  const handlers = new Set<(ev: WsOutbound) => void>();
  const errors = ref<{ raw: string; reason: string }[]>([]);
  let ws: WebSocket | null = null;
  // …auth/backoff bookkeeping unchanged from live…

  function pushError(reason: string, raw: string) {
    errors.value.push({ raw, reason });
    if (errors.value.length > ERRORS_CAP) errors.value.splice(0, errors.value.length - ERRORS_CAP);
  }

  function emitErrorUpstream(reason: string, raw: string) {
    // Best-effort: socket may already be CLOSING. We do not validate this
    // path through Zod a second time because the envelope is built from
    // typed string constants on this line; the server still re-validates.
    if (ws?.readyState === WebSocket.OPEN) {
      const truncated = raw.length > 512 ? raw.slice(0, 512) + "…" : raw;
      ws.send(JSON.stringify({ type: "error", reason, raw: truncated }));
    }
  }

  ws.onmessage = (event) => {
    const raw = typeof event.data === "string" ? event.data : "";
    const r = parseOutbound(raw);
    if (!r.ok) {
      pushError(r.error, r.raw);
      console.warn("[ws] schema violation from server:", r.error, { raw: r.raw });
      emitErrorUpstream(r.error, r.raw);
      ws?.close(); // browser-allowed close; the server records 1006 on this side
      return;
    }
    for (const h of handlers) h(r.value);
  };

  function send(msg: WsInbound): void {
    // Runtime fail-loud: a caller that bypasses TypeScript still cannot
    // smuggle a non-conforming frame.
    const parsed = WsInboundSchema.parse(msg);
    if (ws?.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify(parsed));
  }

  function onEvent(h: (ev: WsOutbound) => void): () => void {
    handlers.add(h);
    return () => handlers.delete(h);
  }

  return { connected, status, errors, onEvent, send, disconnect, reconnect };
}
```

Notes:

- **Browser close code**: `ws.close()` without arguments. The browser sends close code `1005` ("no status received") on the wire; the server observes a clean close. The schema-violation reason lives in (a) the SPA's `errors` ring, (b) the `console.warn` log, and (c) the `error` envelope sent to the server immediately before closing. The server-side close stays `1003`.
- **Outbound runtime validation**: `WsInboundSchema.parse(msg)` runs in every build (dev + prod). The schema is ~12 KB gzipped already; the parse cost is negligible at human chat rates.
- **`emitErrorUpstream`** uses a hand-encoded JSON literal that is, by construction, a `WsInbound["error"]` value. We do not call `WsInboundSchema.parse` here because (i) the constructor is fully typed at the literal, and (ii) recursive validation in an error path is a recipe for stack-on-stack failures. The server's `parseInbound` still re-validates on receipt.

## 3. Amended server channel shape (replaces r1 §B.4)

```ts
import { parseInbound, WsOutbound, WsOutboundSchema } from "./ws-schema.js";

ws.on("message", (data) => {
  const raw = data.toString();
  const r = parseInbound(raw);
  if (!r.ok) {
    log.warn(`[ws] dropping malformed inbound frame: ${r.error}`);
    this.ws.close(1003, "schema-violation");
    return;
  }
  if (r.value.type === "message") {
    this.messageHandler?.(r.value.content);
    return;
  }
  if (r.value.type === "error") {
    log.warn(`[ws] client reported schema violation: ${r.value.reason}` +
             (r.value.raw ? ` (raw=${r.value.raw})` : ""));
    return;
  }
});

sendEvent(event: WsOutbound): void {
  // .parse throws on drift. We serialise the parsed value so any field
  // that survives a future schema loosening still requires a schema edit.
  const parsed = WsOutboundSchema.parse(event);
  if (this.ws.readyState === this.ws.OPEN) {
    this.ws.send(JSON.stringify(parsed));
  }
}

send(message: string): void {
  this.sendEvent({ type: "message", content: message });
}
```

Notes:

- **`JSON.stringify(parsed)`**, not `JSON.stringify(event)`. This is the core fix to r1 review finding 2 — the wire bytes are always a strict subset of the schema, regardless of what shape the caller passed in.
- **`error` inbound** is logged at `warn` level and does not feed `messageHandler`. The chat agent never sees the SPA's error envelopes as user prose. Server-side fail-loud is still the close-with-1003 path; the SPA's error envelope is a courtesy diagnostic, not a control message.
- **Trim removed**: r1's design dropped the existing `data.toString().trim()` and empty-string skip. We restore that as part of the JSON parse boundary: `JSON.parse("")` throws → `parseInbound` returns `ok:false` with `error: "invalid-json: …"`. A purely-whitespace frame closes the socket. This is a behaviour change vs. the live code (which silently ignored empty/whitespace frames); the project rule (no shim) says: take the strict path. A SPA today never sends whitespace-only frames.

## 4. Amended file inventory (delta from r1 §B.1)

Only the rows that change versus r1 are listed.

| File | Change vs. r1 |
|---|---|
| [src/channels/ws-schema.ts](../../../../src/channels/ws-schema.ts) | `.strict()` on every variant of both unions. `WsInbound` adds the `error` variant. |
| [src/channels/websocket.ts](../../../../src/channels/websocket.ts) | Adds the `error` branch in the inbound switch. `sendEvent` serialises `WsOutboundSchema.parse(event)`, not the original argument. |
| [web/src/composables/useWebSocket.ts](../../../../web/src/composables/useWebSocket.ts) | `send` calls `WsInboundSchema.parse(msg)` before write. `onmessage` close is `ws.close()` (no code, no reason). Emits an `error` envelope upstream before closing. |
| [src/channels/telegram.ts](../../../../src/channels/telegram.ts#L375) | Body stays as a typed `switch (event.type)` that forwards `"message"` content to `this.send(content)`; other branches are no-ops with explicit comments. Not a no-op overall, contrary to r1. |
| [vitest.config.ts](../../../../vitest.config.ts) | NEW row vs. r1: `include` becomes `["src/**/*.test.ts", "tests/**/*.test.ts", "web/src/**/*.test.ts"]`. |
| [package.json](../../../../package.json) | NEW row vs. r1: add `"happy-dom": "^15.0.0"` to `devDependencies` for the SPA composable test environment. |

All other rows in r1 §B.1 are unchanged (web tsconfig alias, Vite alias, web package zod, channel types `sendEvent`, chat.ts cast removal, server call-site, ChatWindow.vue migration).

## 5. Updated failure-mode table (replaces r1 §2 table)

| Failure | Today | Under r2 |
|---|---|---|
| Bare string `send("hi")` from a new SPA caller. | Server treats `"hi"` as user prose. | TS compile error (`send` requires `WsInbound`). If circumvented at runtime, the SPA `WsInboundSchema.parse` throws **before** the bytes leave the browser; if even that is bypassed (`ws.send(...)` directly), the server `parseInbound` returns `ok:false` and closes `1003`. |
| Server emitter publishes `{type:"toolCall",…}`. | SPA renders nothing silently. | `WsOutboundSchema.parse` throws on the server side; the frame never reaches the wire. |
| Field rename `provider` → `providerId` on the server. | SPA reads `ev.provider as string \| undefined` → silent break. | Strict outbound: `providerId` is rejected at `WsOutboundSchema.parse` on the server. Build-time TS error first, runtime throw second. |
| Malformed wire bytes (server → SPA). | SPA fabricates `{type:"message", content:rawBytes}` and renders garbage. | SPA `parseOutbound` returns `ok:false`; pushes to bounded `errors`, emits `{type:"error", reason}` upstream (best-effort), closes the socket with `ws.close()` (browser-allowed). Reconnect/backoff fires normally. |
| Malformed wire bytes (SPA → server). | Server treats them as raw user prose. | Server `parseInbound` returns `ok:false`; logs `[ws] dropping malformed inbound frame: …`; closes `1003`. |
| SPA developer using `(send as any)("hi")`. | r1 design: lands on the wire, server closes. | Runtime: SPA throws inside `send` before `ws.send`; nothing reaches the wire. |
| Slow memory leak from long sessions. | `events.value` unbounded. | `events.value` deleted; `errors` ring buffer capped at `ERRORS_CAP = 8`. |

## 6. Migration order (unchanged from r1 §3)

Same as r1 §3 with two additions:

11. [vitest.config.ts](../../../../vitest.config.ts) — extend `include` to cover `web/src/**/*.test.ts`. This is a separate, mechanical step; it can go anywhere after step 1, but pinning it next to the test files (steps 9-10) keeps the diff readable.
12. [package.json](../../../../package.json) — add `happy-dom` devDependency; run `npm install` to update the lockfile.

The PR remains atomic: there is no intermediate state in which two `WsEvent` shapes coexist or one end validates while the other does not.

## 7. Open items deferred (unchanged from r1 §4)

- Asynchronous Telegram event stream — out of scope.
- AsyncAPI / OpenAPI publication of the schema — G40 follow-up.
- `parseOutbound` opt-out in prod — explicitly rejected in r1; r2 keeps validation in all builds for both directions.
