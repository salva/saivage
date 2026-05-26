# G49 — Plan (Round 2)

- **Round 1**: [03-plan-r1.md](03-plan-r1.md)
- **Round 2**: [01-analysis-r2.md](01-analysis-r2.md), [02-design-r2.md](02-design-r2.md)
- **Review**: [04-review-r1.md](04-review-r1.md)

This r2 plan supersedes [03-plan-r1.md](03-plan-r1.md) only on the points raised by [04-review-r1.md](04-review-r1.md). Steps 1, 2, 4, 5, 6, and 8 are unchanged. Steps 3, 7, 9, and 10 are replaced below. Two new steps (11 and 12) cover Vitest wiring and an explicit validation block. The order-of-file-edits list (r1 §2) is updated at the end.

## Replaced Step 3 — Server channel: schema-validated I/O, strict outbound, error inbound

Edit [src/channels/websocket.ts](../../../../src/channels/websocket.ts):

- Delete the redeclared `WsEvent` interface at [L4-L7](../../../../src/channels/websocket.ts#L4-L7).
- Add imports: `import { parseInbound, WsOutbound, WsOutboundSchema } from "./ws-schema.js";` and `import { log } from "../utils/log.js";` (or whatever logger path the codebase uses; verify during the edit — server-side modules use `src/utils/log.ts` consistently).
- Rewrite the `ws.on("message", …)` block at [L17-L27](../../../../src/channels/websocket.ts#L17-L27) per [design §3](02-design-r2.md#3-amended-server-channel-shape-replaces-r1-b4):
  - Drop the `data.toString().trim()` empty-frame guard; let `parseInbound("")` produce a normal `ok:false`.
  - On `ok:false`: `log.warn(…)` and `this.ws.close(1003, "schema-violation")`. Return.
  - On `ok:true` with `r.value.type === "message"`: call `this.messageHandler?.(r.value.content)`.
  - On `ok:true` with `r.value.type === "error"`: `log.warn(…)` only. Do **not** call `messageHandler`.
- Rewrite `send(message)` at [L34-L37](../../../../src/channels/websocket.ts#L34-L37) to delegate to `sendEvent({ type: "message", content: message })`. (Unchanged vs r1.)
- Rewrite `sendEvent` at [L40-L43](../../../../src/channels/websocket.ts#L40-L43):
  - `const parsed = WsOutboundSchema.parse(event);`
  - `if (this.ws.readyState === this.ws.OPEN) this.ws.send(JSON.stringify(parsed));`
  - The `.parse` deliberately throws on drift; server-side bug callers go through the existing chat-agent async error path.

## Replaced Step 7 — Web composable rework, with runtime `send` validation and browser-safe close

Edit [web/src/composables/useWebSocket.ts](../../../../web/src/composables/useWebSocket.ts) per [design §2](02-design-r2.md#2-amended-spa-composable-shape-replaces-r1-b3):

- Delete the `WsEvent` interface at [L5-L8](../../../../web/src/composables/useWebSocket.ts#L5-L8).
- Add imports: `import { WsInbound, WsInboundSchema, WsOutbound, parseOutbound } from "@channels/ws-schema";`.
- Replace `const events = ref<WsEvent[]>([]);` at [L33](../../../../web/src/composables/useWebSocket.ts#L33) with:
  - `const handlers = new Set<(ev: WsOutbound) => void>();`
  - `const errors = ref<{ raw: string; reason: string }[]>([]);`
  - `const ERRORS_CAP = 8;`
  - Helper `pushError(reason, raw)` that pushes and trims via `errors.value.splice(0, errors.value.length - ERRORS_CAP)` when over cap.
  - Helper `emitErrorUpstream(reason, raw)` that, only when `ws?.readyState === WebSocket.OPEN`, calls `ws.send(JSON.stringify({ type: "error", reason, raw: raw.length > 512 ? raw.slice(0, 512) + "…" : raw }))`.
- Rewrite `ws.onmessage` at [L62-L70](../../../../web/src/composables/useWebSocket.ts#L62-L70):
  - `const raw = typeof event.data === "string" ? event.data : "";`
  - `const r = parseOutbound(raw);`
  - On `ok:false`: `pushError(r.error, r.raw); console.warn("[ws] schema violation from server:", r.error, { raw: r.raw }); emitErrorUpstream(r.error, r.raw); ws?.close(); return;` — `ws.close()` **with no argument**; the browser sends a normal-closure frame.
  - On `ok:true`: `for (const h of handlers) h(r.value);`.
- Replace `send(content: string)` at [L93-L97](../../../../web/src/composables/useWebSocket.ts#L93-L97) with:
  ```ts
  function send(msg: WsInbound): void {
    const parsed = WsInboundSchema.parse(msg); // runtime fail-loud
    if (ws?.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify(parsed));
  }
  ```
- Add:
  ```ts
  function onEvent(h: (ev: WsOutbound) => void): () => void {
    handlers.add(h);
    return () => handlers.delete(h);
  }
  ```
- Return value at [L138](../../../../web/src/composables/useWebSocket.ts#L138) becomes `{ connected, status, errors, onEvent, send, disconnect, reconnect }`. The `events` field is removed.

## Replaced Step 9 — Regression tests

Add three test files. Test bodies that did not change from r1 are not re-listed; only the deltas (T7 removed, T7' added, T8a added, T12 tightened, T16 amended, T18 amended, T19 added) are shown.

### 9.1 Schema unit tests — [src/channels/ws-schema.test.ts](../../../../src/channels/ws-schema.test.ts)

Cases T1–T6 unchanged from r1.

**T7 (removed).** r1's "outbound silent drop" assertion is deleted.

**T7' (new). Outbound rejects extra fields (strict).**

```ts
const ev = { type: "message", content: "hi", bogus: "x" } as any;
expect(parseOutbound(JSON.stringify(ev))).toMatchObject({ ok: false });
```

**T7'' (new). Inbound `error` variant round-trip.**

```ts
const enc = JSON.stringify({ type: "error", reason: "bad-frame", raw: "{" });
expect(parseInbound(enc)).toEqual({ ok: true, value: { type: "error", reason: "bad-frame", raw: "{" } });
```

**T7''' (new). Inbound `error` rejects missing reason.**

```ts
expect(parseInbound(JSON.stringify({ type: "error" }))).toMatchObject({ ok: false });
```

### 9.2 Server channel tests — [src/channels/websocket.test.ts](../../../../src/channels/websocket.test.ts)

Cases T8, T9, T10, T11, T13 unchanged from r1.

**T8a (new). Inbound `error` envelope is logged and NOT routed to messageHandler.**

```ts
const seen: string[] = [];
ch.onMessage((m) => seen.push(m));
const warnings: string[] = [];
vi.spyOn(log, "warn").mockImplementation((m: string) => { warnings.push(m); });
fakeWs.emit("message", Buffer.from(JSON.stringify({ type: "error", reason: "bad-frame" })));
expect(seen).toEqual([]);
expect(warnings.some(w => w.includes("client reported schema violation"))).toBe(true);
expect(fakeWs.closed).toBe(false);
```

**T12 (tightened). `sendEvent` of a drifting shape throws AND writes nothing.**

```ts
fakeWs.readyState = fakeWs.OPEN;
expect(() => ch.sendEvent({ type: "toolCall" } as any)).toThrow();
expect(fakeWs.sent).toHaveLength(0);
```

**T13a (new). `sendEvent` of an event with an extra field throws (strict outbound).**

```ts
fakeWs.readyState = fakeWs.OPEN;
expect(() =>
  ch.sendEvent({ type: "session", sessionId: "abc", extra: 1 } as any),
).toThrow();
expect(fakeWs.sent).toHaveLength(0);
```

### 9.3 SPA composable tests — [web/src/composables/useWebSocket.test.ts](../../../../web/src/composables/useWebSocket.test.ts)

File header: `// @vitest-environment happy-dom`.

Test seam: a `MockWebSocket` class assigned to `globalThis.WebSocket` for the duration of each test. The composable is invoked from a one-line wrapper component:

```ts
import { defineComponent, h } from "vue";
import { createApp } from "vue";

function mountComposable(setup: () => unknown) {
  let api: any = null;
  const app = createApp(defineComponent({
    setup() { api = setup(); return () => h("div"); },
  }));
  const host = document.createElement("div");
  app.mount(host);
  return { api, unmount: () => app.unmount() };
}
```

Cases T14, T15, T17 unchanged from r1.

**T16 (amended). Inbound malformed frame: errors entry + `ws.close()` with no args + error envelope sent upstream.**

```ts
const { api } = mountComposable(() => useWebSocket("ws://test"));
mockWs.simulateOpen();
mockWs.simulateMessage("not-json");
expect(api.errors.value.at(-1).raw).toBe("not-json");
expect(mockWs.closeCalls.at(-1)).toEqual([]);          // browser-safe close, no code
expect(mockWs.sent.at(-1)).toMatch(/^\{"type":"error","reason":/);
```

**T18 (amended). No `events` field on the returned API.**

```ts
const { api } = mountComposable(() => useWebSocket("ws://test"));
expect("events" in api).toBe(false);
// @ts-expect-error events is removed from the public surface
api.events;
```

**T19 (new). `send` validates at runtime: drifting payload throws and writes nothing.**

```ts
const { api } = mountComposable(() => useWebSocket("ws://test"));
mockWs.simulateOpen();
expect(() => api.send({ type: "toolCall" } as any)).toThrow();
expect(mockWs.sent).toHaveLength(0);
```

**T20 (new). `send` with valid envelope writes exactly the JSON of the parsed value.**

```ts
const { api } = mountComposable(() => useWebSocket("ws://test"));
mockWs.simulateOpen();
api.send({ type: "message", content: "hi" });
expect(mockWs.sent.at(-1)).toBe('{"type":"message","content":"hi"}');
```

## Replaced Step 10 — Build + smoke

Old step 10 conflated build, test, and grep gates and asked for a nonexistent `globalThis.__ws`. Replaced by two distinct steps:

- Step 11 (Validation) is the executable invariant block.
- Step 12 (Manual smoke) is the human-driven end-to-end check.

```bash
cd /home/salva/g/ml/saivage
npm run typecheck          # tsc --noEmit
npm run build              # build:web && tsup (no grep here)
npm test                   # vitest, including the three new specs
cd web && npm run build    # exercises the Vite alias + zod resolution
```

## New Step 11 — Validation invariants (explicit, not build-gated)

The following greps must all return zero matches after the change. They are a manual PR-checklist gate, not part of `npm run build`. Run from `/home/salva/g/ml/saivage`:

```bash
# 1. No leftover WsEvent declarations or references.
grep -rn '\bWsEvent\b' src/ web/src/        # zero matches

# 2. No escape-hatch casts onto ChatChannel.
grep -rn 'as ChatChannel & {' src/          # zero matches

# 3. No loose [key: string]: unknown bags in channels.
grep -rn '\[key: string\]: unknown' src/channels/  # zero matches

# 4. Composable no longer exposes events.
grep -rn 'events\.value' web/src/           # zero matches

# 5. No hand-encoded outbound envelopes outside the composable's
#    error path.
grep -rn 'JSON\.stringify({ type:' web/src/components/   # zero matches
#    (The composable's emitErrorUpstream is allowed; it is in
#    web/src/composables/, not web/src/components/.)
```

These five lines are the single source of truth for "did the migration land cleanly". A reviewer copy-pastes the block; non-zero output is a block on merge.

## New Step 12 — Manual smoke (replaces r1 §4 last bullet)

The smoke test exercises the server-side fail-loud path with a real socket. There is no `globalThis.__ws`.

1. Start a dev server against a fresh project:
   ```bash
   cd /home/salva/g/ml/saivage
   npm run dev -- serve /tmp/smoke-project
   ```
2. In another terminal, open a raw WebSocket as the auth client would and send a malformed frame:
   ```bash
   node -e '
   import("ws").then(({ default: WS }) => {
     const ws = new WS("ws://127.0.0.1:8080/ws?token=" + process.env.SAIVAGE_TOKEN);
     ws.on("open",  () => { ws.send("garbage"); });
     ws.on("close", (code, reason) => {
       console.log("close", code, reason.toString());
       process.exit(0);
     });
   });'
   ```
   Expected: `close 1003 schema-violation` on stdout, and the server log line `[ws] dropping malformed inbound frame: invalid-json: …`.
3. In the same dev server, open the SPA in a browser, send a normal chat message — the round-trip works (regression check on the happy path).
4. With the SPA still open, in the server-side dev shell, run a one-shot script that injects a malformed outbound frame from the server channel to the connected client. Easiest seam: temporarily edit [src/server/server.ts L693](../../../../src/server/server.ts#L693) to call `channel.sendEvent({ type: "toolCall" } as any)` on a debug endpoint, hit that endpoint, and confirm the server throws synchronously in the existing chat-agent error path. Revert the temp edit. (This step is optional; T12 covers the same property in unit tests. List it for the human reviewer who wants to see fail-loud at the wire.)

## Updated order of file edits (replaces r1 §2)

1. [src/channels/ws-schema.ts](../../../../src/channels/ws-schema.ts) (new).
2. [web/package.json](../../../../web/package.json), [web/tsconfig.json](../../../../web/tsconfig.json), [web/vite.config.ts](../../../../web/vite.config.ts).
3. [package.json](../../../../package.json) — add `happy-dom` devDependency. Lockfile update.
4. [vitest.config.ts](../../../../vitest.config.ts) — extend `include` to cover `web/src/**/*.test.ts`.
5. [src/channels/types.ts](../../../../src/channels/types.ts).
6. [src/channels/websocket.ts](../../../../src/channels/websocket.ts).
7. [src/channels/telegram.ts](../../../../src/channels/telegram.ts) — typed `switch` body, not a no-op.
8. [src/agents/chat.ts](../../../../src/agents/chat.ts).
9. [web/src/composables/useWebSocket.ts](../../../../web/src/composables/useWebSocket.ts).
10. [web/src/components/ChatWindow.vue](../../../../web/src/components/ChatWindow.vue).
11. [src/channels/ws-schema.test.ts](../../../../src/channels/ws-schema.test.ts) (new).
12. [src/channels/websocket.test.ts](../../../../src/channels/websocket.test.ts) (new).
13. [web/src/composables/useWebSocket.test.ts](../../../../web/src/composables/useWebSocket.test.ts) (new).

The tree is compilable after step 1 (leaf module). Steps 6–10 must land together to avoid an intermediate state in which the server and SPA disagree on the envelope.

## Acceptance checklist (replaces r1 §4)

- [ ] [src/channels/ws-schema.ts](../../../../src/channels/ws-schema.ts) exports `WsInboundSchema` and `WsOutboundSchema` with `.strict()` on every variant, plus the two inferred types and the two `parseInbound`/`parseOutbound` helpers.
- [ ] `WsInboundSchema` includes the `{type:"error", reason, raw?}` variant.
- [ ] `WebSocketChannel.sendEvent` serialises the value returned by `WsOutboundSchema.parse`, not the original argument (verified by reading the file diff).
- [ ] `useWebSocket.send` calls `WsInboundSchema.parse(msg)` before `ws.send`.
- [ ] `useWebSocket` `onmessage` malformed-frame path calls `ws.close()` with no arguments.
- [ ] The server-side close on malformed inbound stays `ws.close(1003, "schema-violation")`.
- [ ] `vitest.config.ts` `include` lists `web/src/**/*.test.ts`.
- [ ] `web/package.json` has **no** `test` script and no test-framework dep.
- [ ] `package.json` adds `happy-dom` to `devDependencies`.
- [ ] `npm test` runs and passes 20 tests (T1–T20, including the new T7', T7'', T7''', T8a, T13a, T19, T20; T7 deleted).
- [ ] `cd web && npm run build` succeeds with the Vite alias.
- [ ] Web bundle gzipped size delta vs. main is < 25 KB (documented in PR description).
- [ ] All five grep invariants in Step 11 return zero matches.
- [ ] Telegram `sendEvent` still forwards `{type:"message", content}` to `this.send(content)` (regression check by inspecting the file diff, not by adding a test — Telegram tests are out of scope).
- [ ] Manual smoke per Step 12: raw `ws.send("garbage")` from a Node client elicits a server close with code `1003` and reason `schema-violation`.

## Out of scope (unchanged from r1 §5)

Same as r1 §5.
