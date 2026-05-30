# G49 — Plan (Round 1)

- **Analysis**: [01-analysis-r1.md](01-analysis-r1.md)
- **Design**: [02-design-r1.md](02-design-r1.md)

## 1. Sequenced steps

### Step 1 — Add the schema module

Create [src/channels/ws-schema.ts](../../../../src/channels/ws-schema.ts) per [design §B.2](02-design-r1.md). Exports:

- `WsInboundSchema`, `WsInbound` (Zod schema + inferred type) — strict; only `{type:"message", content:string}` today.
- `WsOutboundSchema`, `WsOutbound` — discriminated union of `{type:"session", sessionId}`, `{type:"thinking"}`, `{type:"message", content, provider?, model?, modelSpec?, requestedModelSpec?}`.
- `parseInbound(raw)`, `parseOutbound(raw)` — wrap `JSON.parse` + `safeParse`, return `{ok:true,value} | {ok:false,error,raw}`.
- No runtime imports beyond `zod`. No imports from `src/` or `web/` — this is a leaf module.

### Step 2 — Wire the schema into the web bundle

1. [web/package.json](../../../../web/package.json#L11-L13) — add `"zod": "^3.25.76"` to `dependencies`. Match the root pin at [package.json L39](../../../../package.json#L39). Run `npm install` from `web/`.
2. [web/tsconfig.json](../../../../web/tsconfig.json#L13-L17) — add `"@channels/ws-schema": ["../src/channels/ws-schema.ts"]` to `compilerOptions.paths`, and add `"../src/channels/ws-schema.ts"` to `include`.
3. [web/vite.config.ts](../../../../web/vite.config.ts#L4) — add `resolve: { alias: { "@channels/ws-schema": new URL("../src/channels/ws-schema.ts", import.meta.url).pathname } }` so dev server + production build resolve identically.

### Step 3 — Server channel: schema-validated I/O

Edit [src/channels/websocket.ts](../../../../src/channels/websocket.ts):

- Delete the redeclared `WsEvent` interface at [L4-L7](../../../../src/channels/websocket.ts#L4-L7).
- Replace `import type { WebSocket } from "ws";` block (top of file) with the imports above plus `import { parseInbound, WsOutbound, WsOutboundSchema } from "./ws-schema.js";`.
- Rewrite the `ws.on("message", …)` block at [L17-L27](../../../../src/channels/websocket.ts#L17-L27) per [design §B.4](02-design-r1.md): call `parseInbound(raw)`, close with code `1003` on failure, route `r.value.content` to `messageHandler` on success.
- Rewrite `send(message)` at [L34-L37](../../../../src/channels/websocket.ts#L34-L37) to delegate to `sendEvent({type:"message", content:message})`.
- Rewrite `sendEvent` at [L40-L43](../../../../src/channels/websocket.ts#L40-L43) to call `WsOutboundSchema.parse(event)` first, then `JSON.stringify` + `ws.send`. The `parse` call deliberately throws (it is a server-side bug if a Saivage emitter drifts).
- Logging uses the existing `log.warn` import path used elsewhere in the channel module (verify the import path during the edit — the current file does not log; the test in §3 covers the "drop + close" wiring rather than the exact log line).

### Step 4 — Channel interface: lift `sendEvent` out of escape hatches

1. Edit [src/channels/types.ts](../../../../src/channels/types.ts) — add `sendEvent?(event: WsOutbound): void` to the `ChatChannel` interface; add `import type { WsOutbound } from "./ws-schema.js";` to the top of the file.
2. Edit [src/agents/chat.ts](../../../../src/agents/chat.ts):
   - [L209-L210](../../../../src/agents/chat.ts#L209-L210) — drop the `as ChatChannel & { sendEvent?: … }` cast; call `this.channel.sendEvent?.({ type: "thinking" })`.
   - [L388-L393](../../../../src/agents/chat.ts#L388-L393) — drop the `eventChannel` local; call `this.channel.sendEvent?.({ type: "message", content, ...source })` directly. `source` keeps its existing shape — the union member already lists the four legal provenance fields.

### Step 5 — Retype Telegram's no-op `sendEvent`

Edit [src/channels/telegram.ts L375](../../../../src/channels/telegram.ts#L375) — change the signature from `sendEvent(event: { type: string; [key: string]: unknown })` to `sendEvent(event: WsOutbound)`. Body remains the no-op it is today. Add `import type { WsOutbound } from "./ws-schema.js";` at the top of the file.

### Step 6 — Server call site type-check

[src/server/server.ts L693](../../../../src/server/server.ts#L693) — `channel.sendEvent({ type: "session", sessionId })` is already structurally compatible with `WsOutbound`. No code edit; the build is the test.

### Step 7 — Web composable rework

Edit [web/src/composables/useWebSocket.ts](../../../../web/src/composables/useWebSocket.ts) per [design §B.3](02-design-r1.md):

- Delete `WsEvent` interface at [L5-L8](../../../../web/src/composables/useWebSocket.ts#L5-L8).
- Add `import { WsInbound, WsOutbound, parseOutbound } from "@channels/ws-schema";`.
- Replace `const events = ref<WsEvent[]>([]);` at [L33](../../../../web/src/composables/useWebSocket.ts#L33) with:
  - `const handlers = new Set<(ev: WsOutbound) => void>();`
  - `const errors = ref<{ raw: string; reason: string }[]>([]);` (capped at 8 entries via a `pushError` helper that splices the front).
- Rewrite `ws.onmessage` at [L62-L70](../../../../web/src/composables/useWebSocket.ts#L62-L70) to call `parseOutbound`. On `ok:false`, push to `errors`, `ws.close(1003, "schema-violation")`, return. On `ok:true`, iterate `handlers` and call each with `r.value`.
- Replace `send(content: string)` at [L93-L97](../../../../web/src/composables/useWebSocket.ts#L93-L97) with `send(msg: WsInbound)` that `JSON.stringify`s the union and forwards to `ws.send`.
- Add `function onEvent(h: (ev: WsOutbound) => void): () => void { handlers.add(h); return () => handlers.delete(h); }`.
- Return value at [L138](../../../../web/src/composables/useWebSocket.ts#L138) becomes `{ connected, status, errors, onEvent, send, disconnect, reconnect }`. The old `events` field is removed.

### Step 8 — Migrate the single SPA consumer

Edit [web/src/components/ChatWindow.vue](../../../../web/src/components/ChatWindow.vue):

- [L39](../../../../web/src/components/ChatWindow.vue#L39) — change destructure to `const { connected, status, onEvent, send } = useWebSocket();`.
- [L71-L121](../../../../web/src/components/ChatWindow.vue#L71-L121) — replace the `watch(() => events.value.length, …)` block with a single `onMounted(() => { const off = onEvent((ev) => { /* switch (ev.type) */ }); onUnmounted(off); })` (or equivalent: `onUnmounted` already imported). The body uses a `switch (ev.type)` so TS exhaustiveness is checked.
- Drop the `as string` and `as string | undefined` casts at [L82, L87, L100-L110](../../../../web/src/components/ChatWindow.vue#L82-L110) — `WsOutbound` types each branch precisely.
- Delete the dead `"system"` / `"event"` branch at [L112-L121](../../../../web/src/components/ChatWindow.vue#L112-L121) — no emitter exists in the current codebase (verified by grep, see [analysis §2 row 7](01-analysis-r1.md)).
- [L157](../../../../web/src/components/ChatWindow.vue#L157) — replace `send(JSON.stringify({ type: "message", content: text }))` with `send({ type: "message", content: text })`.

### Step 9 — Regression tests

Add three test files:

- [src/channels/ws-schema.test.ts](../../../../src/channels/ws-schema.test.ts) — schema round-trip + rejection.
- [src/channels/websocket.test.ts](../../../../src/channels/websocket.test.ts) — server channel with a fake `ws`.
- [web/src/composables/useWebSocket.test.ts](../../../../web/src/composables/useWebSocket.test.ts) — SPA composable with a `MockWebSocket`.

Test bodies are spelled out in §3 below.

### Step 10 — Build + grep invariants

```bash
cd saivage
npm run build              # server
cd web && npm run build    # SPA bundle, exercises Vite alias
cd ..
npm test                   # vitest, including new specs

# Invariants — these must all be empty after the change.
grep -rn 'WsEvent\b' src/ web/src/                 # only schema-internal references allowed
grep -rn 'as ChatChannel & {' src/                 # no escape-hatch casts
grep -rn '\[key: string\]: unknown' src/channels/  # no loose bag types
grep -rn 'events\.value' web/src/                  # composable no longer exposes events
grep -rn 'JSON\.stringify({ type:' web/src/        # no hand-encoded envelopes outside the composable
```

## 2. Order of file edits

1. [src/channels/ws-schema.ts](../../../../src/channels/ws-schema.ts) (new).
2. [web/package.json](../../../../web/package.json), [web/tsconfig.json](../../../../web/tsconfig.json), [web/vite.config.ts](../../../../web/vite.config.ts).
3. [src/channels/types.ts](../../../../src/channels/types.ts).
4. [src/channels/websocket.ts](../../../../src/channels/websocket.ts).
5. [src/channels/telegram.ts](../../../../src/channels/telegram.ts).
6. [src/agents/chat.ts](../../../../src/agents/chat.ts).
7. [web/src/composables/useWebSocket.ts](../../../../web/src/composables/useWebSocket.ts).
8. [web/src/components/ChatWindow.vue](../../../../web/src/components/ChatWindow.vue).
9. [src/channels/ws-schema.test.ts](../../../../src/channels/ws-schema.test.ts) (new).
10. [src/channels/websocket.test.ts](../../../../src/channels/websocket.test.ts) (new).
11. [web/src/composables/useWebSocket.test.ts](../../../../web/src/composables/useWebSocket.test.ts) (new).

This order keeps the tree compilable after step 1 (leaf module, no consumers yet) and then introduces the schema's importers one tier at a time. Steps 4–8 must land together to avoid an intermediate state where the server and SPA disagree on the envelope.

## 3. Regression test plan

### 3.1 Schema unit tests — [src/channels/ws-schema.test.ts](../../../../src/channels/ws-schema.test.ts)

T1. **Inbound round-trip**:
```ts
const enc = JSON.stringify({ type: "message", content: "hi" });
expect(parseInbound(enc)).toEqual({ ok: true, value: { type: "message", content: "hi" } });
```

T2. **Inbound rejects unknown discriminator**:
```ts
expect(parseInbound(JSON.stringify({ type: "ping" }))).toMatchObject({ ok: false });
```

T3. **Inbound rejects extra fields (strict)**:
```ts
expect(parseInbound(JSON.stringify({ type: "message", content: "hi", extra: 1 })))
  .toMatchObject({ ok: false });
```

T4. **Inbound rejects empty content**:
```ts
expect(parseInbound(JSON.stringify({ type: "message", content: "" })))
  .toMatchObject({ ok: false });
```

T5. **Inbound rejects non-JSON**:
```ts
expect(parseInbound("hello world")).toMatchObject({ ok: false, raw: "hello world" });
```

T6. **Outbound round-trip for all three variants**:
```ts
for (const ev of [
  { type: "session", sessionId: "abc" },
  { type: "thinking" },
  { type: "message", content: "hi", provider: "p", model: "m" },
]) {
  expect(parseOutbound(JSON.stringify(ev))).toEqual({ ok: true, value: ev });
}
```

T7. **Outbound rejects unknown provenance fields by silently dropping** — confirms the design choice: non-strict on the outbound shape (provenance fields are listed; unknown extras are not retained but do not fail). Documented as a guarantee; if a future change tightens this, the test must change in lockstep:
```ts
const ev = { type: "message", content: "hi", bogus: "x" };
const r = parseOutbound(JSON.stringify(ev));
expect(r.ok).toBe(true);
expect((r as any).value.bogus).toBeUndefined();
```

### 3.2 Server channel tests — [src/channels/websocket.test.ts](../../../../src/channels/websocket.test.ts)

Test seam: a `FakeWs` class implementing the `ws` types subset the channel uses (`on`, `send`, `close`, `readyState`, `OPEN`). Tests instantiate `new WebSocketChannel(fakeWs as unknown as WebSocket)`.

T8. **Inbound: schema-conformant frame routes to messageHandler**:
```ts
const ch = new WebSocketChannel(fakeWs as any);
const seen: string[] = [];
ch.onMessage((m) => { seen.push(m); });
fakeWs.emit("message", Buffer.from(JSON.stringify({ type: "message", content: "hi" })));
expect(seen).toEqual(["hi"]);
expect(fakeWs.closed).toBe(false);
```

T9. **Inbound: bare-string sent by a misbehaving client closes the socket with 1003 and does NOT reach messageHandler**:
```ts
const seen: string[] = [];
ch.onMessage((m) => { seen.push(m); });
fakeWs.emit("message", Buffer.from("hello"));
expect(seen).toEqual([]);
expect(fakeWs.closeCalls[0]).toEqual([1003, "schema-violation"]);
```

T10. **Inbound: unknown-discriminator frame is dropped with 1003**:
```ts
fakeWs.emit("message", Buffer.from(JSON.stringify({ type: "ping" })));
expect(fakeWs.closeCalls.at(-1)).toEqual([1003, "schema-violation"]);
```

T11. **Outbound: `send("msg")` writes a schema-valid envelope**:
```ts
fakeWs.readyState = fakeWs.OPEN;
ch.send("hello");
expect(JSON.parse(fakeWs.sent[0])).toEqual({ type: "message", content: "hello" });
```

T12. **Outbound: `sendEvent` of a drifting shape throws synchronously**:
```ts
expect(() => ch.sendEvent({ type: "toolCall" } as any)).toThrow();
expect(fakeWs.sent).toHaveLength(0);
```

T13. **Outbound: `sendEvent({type:"session",…})` round-trips through the wire**:
```ts
ch.sendEvent({ type: "session", sessionId: "abc" });
expect(JSON.parse(fakeWs.sent.at(-1)!)).toEqual({ type: "session", sessionId: "abc" });
```

### 3.3 SPA composable tests — [web/src/composables/useWebSocket.test.ts](../../../../web/src/composables/useWebSocket.test.ts)

Test seam: a `MockWebSocket` class assigned to `globalThis.WebSocket` for the duration of each test. Tests run inside `defineComponent` shells using `@vue/test-utils` (already a transitive dep via vite; if not present, add to `web/devDependencies`).

T14. **`send({type:"message",…})` writes the JSON envelope**:
```ts
const { send } = useWebSocket("ws://test");
mockWs.simulateOpen();
send({ type: "message", content: "hi" });
expect(mockWs.lastSent).toBe('{"type":"message","content":"hi"}');
```

T15. **TypeScript rejects `send("hi")`** — compile-only assertion (kept as a `// @ts-expect-error` in the test file):
```ts
// @ts-expect-error send must take a WsInbound, not a string
send("hi");
```

T16. **Inbound malformed frame surfaces an `errors` entry and closes the socket**:
```ts
const { errors } = useWebSocket("ws://test");
mockWs.simulateOpen();
mockWs.simulateMessage("not-json");
expect(errors.value.at(-1)?.raw).toBe("not-json");
expect(mockWs.closeCalls.at(-1)).toEqual([1003, "schema-violation"]);
```

T17. **`onEvent` delivers a known frame to every subscriber exactly once**:
```ts
const { onEvent } = useWebSocket("ws://test");
const a: WsOutbound[] = [], b: WsOutbound[] = [];
const offA = onEvent((e) => a.push(e));
const offB = onEvent((e) => b.push(e));
mockWs.simulateMessage(JSON.stringify({ type: "thinking" }));
expect(a).toEqual([{ type: "thinking" }]);
expect(b).toEqual([{ type: "thinking" }]);
offA(); offB();
```

T18. **No unbounded retention** — assert the composable never reaches for the old `events` ref:
```ts
const api = useWebSocket("ws://test");
expect((api as any).events).toBeUndefined();
```

### 3.4 Build-level invariants

Section 10 of the steps above (grep checks) runs in CI as part of the existing `npm run build` flow. Treat them as gates, not informational output: a non-empty result fails the build script.

## 4. Acceptance checklist

- [ ] [src/channels/ws-schema.ts](../../../../src/channels/ws-schema.ts) exists, exports the two schemas + two parse helpers + the two inferred types.
- [ ] Web bundle builds with the new alias (`cd web && npm run build`) and the production bundle size delta is documented in the PR. (Acceptance: < 25 KB gzipped over today.)
- [ ] `grep -rn 'WsEvent\b' src/ web/src/` returns only references inside [ws-schema.ts](../../../../src/channels/ws-schema.ts) (or zero — the design renames to `WsOutbound`/`WsInbound`).
- [ ] `grep -rn 'as ChatChannel & {' src/` returns zero.
- [ ] `grep -rn 'JSON\.stringify({ type:' web/src/` returns zero (no hand-encoded envelopes outside the composable).
- [ ] [web/src/composables/useWebSocket.ts](../../../../web/src/composables/useWebSocket.ts) no longer exposes `events`.
- [ ] [web/src/components/ChatWindow.vue](../../../../web/src/components/ChatWindow.vue) compiles with no `as string` casts on the WS-event branches.
- [ ] All 18 tests pass under `npm test`.
- [ ] Manual smoke: `npm run serve` against a fresh project, open the SPA, send a chat message — round-trip works; open devtools, evaluate `globalThis.__ws?.send("garbage")` — the socket closes with code `1003` and the SPA reconnects after backoff.

## 5. Out of scope (deferred follow-ups)

- G40 (web-protocol doc drift) — the new schema is the single source of truth that G40's doc edit will reference. Tracked separately.
- Generating an AsyncAPI / OpenAPI artefact from the Zod schema for external consumers. Deferred.
- Replacing Telegram's no-op `sendEvent` with a real notification stream. Sibling improvement, not part of this fix.
- Migrating `errors` from a bounded `ref` to the upcoming SPA diagnostic surface (Debug tab) — wait for the Debug tab redesign tracked in G46/G47.
