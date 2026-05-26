# G49 — Analysis (Round 2)

- **Round 1**: [01-analysis-r1.md](01-analysis-r1.md), [02-design-r1.md](02-design-r1.md), [03-plan-r1.md](03-plan-r1.md)
- **Review**: [04-review-r1.md](04-review-r1.md)
- **Issue**: [../G49-usewebsocket-send-leaky-envelope.md](../G49-usewebsocket-send-leaky-envelope.md)

This r2 analysis supersedes [01-analysis-r1.md](01-analysis-r1.md) only on the four points raised by [04-review-r1.md](04-review-r1.md). The restated finding, the evidence table (Sections 1–2 of r1), the symptom→root-cause map (Section 3), the project-rule compliance discussion (Section 4), and the scope boundaries (Section 5) are unchanged.

## 1. Corrections to r1 framings

### 1.1 Browser `WebSocket.close()` cannot carry a `1003` code

[Round 1 §B.3](02-design-r1.md) tells the SPA to call `ws.close(1003, "schema-violation")` when the inbound parser rejects a frame. The browser WebSocket API rejects that call: the [WHATWG WebSocket spec](https://websockets.spec.whatwg.org/#dom-websocket-close) and every shipping browser only accept `1000` or codes in `3000-4999` from page script; anything else throws `InvalidAccessError`. r1's plan therefore *makes* the schema violation throw on the browser side instead of recovering from it.

**Correction.** The server side keeps `ws.close(1003, "schema-violation")` (the Node `ws` library accepts `1003`; the close-frame is what the spec calls a "protocol error" and that is the correct meaning here). The browser side uses `ws.close()` with no argument — the SPA emits a normal-closure frame to the server. Before closing, the SPA records a structured diagnostic and (best-effort) emits a typed `error` envelope upstream so the server's log shows the SPA's reason. The browser does not need to encode the policy violation in the close code; the server does, because the server-side code is the one a SPA developer sees when debugging.

### 1.2 The outbound schema must be strict, not loose

r1 made `WsOutboundSchema` non-strict so the server-side `sendEvent({type:"message", content, ...source})` spread in [src/agents/chat.ts L388-L393](../../../../src/agents/chat.ts#L388-L393) would round-trip without listing every provenance key as strict. r1 also asserted (test T7) that unknown outbound fields are silently dropped.

Both choices contradict the issue's stated goal. A field rename like `provider` → `providerId` on the server is exactly the failure r1 is supposed to catch, and a non-strict union means the rename round-trips through validation with the new field silently retained on the wire and the old field silently `undefined` on the SPA. r1's own sketch makes this worse: it calls `WsOutboundSchema.parse(event)` and then sends `JSON.stringify(event)` — so even when the schema rejects extras, the rejected extras still go out, because the original (unparsed) object is the one serialised. The validation step has no effect on the wire bytes.

**Correction.** Every variant of `WsOutboundSchema` is `.strict()`. The single source of provenance keys is the discriminator member `{type:"message", content, provider?, model?, modelSpec?, requestedModelSpec?}` — new provenance forces a schema edit, which is the intended outcome. The server sender uses the *parsed* value from the schema (`schema.parse(event)` returns a typed object containing only the declared keys) as the argument to `JSON.stringify`, so the wire is always a subset of the schema. r1's T7 ("unknown outbound fields silently drop") is removed and replaced by T7' below ("server-side `sendEvent` of a drifting shape throws synchronously and writes nothing").

### 1.3 The SPA outbound `send` boundary must validate at runtime, not only at compile time

r1's composable sketch types `send` as `(msg: WsInbound) => void` and then unconditionally `JSON.stringify(msg)`. The TypeScript signature is good defence against ordinary callers, but the project rule is fail-loud at the boundary, not fail-loud-where-the-compiler-happens-to-look. A caller that uses `as any`, a future raw/debug path, a test helper, or a third-party plug-in can still emit a drifting frame; the server's `parseInbound` would reject it (good), but the SPA boundary would have already accepted it (bad — the symmetric guarantee fails).

**Correction.** The composable calls `WsInboundSchema.parse(msg)` before `ws.send`. A drifting outbound throws synchronously inside `send`. The composable rethrows; no `try/catch` is added because the chat agent's existing async error path is the right place to surface it. r1's T15 (a `// @ts-expect-error` compile-only assertion) is kept; T19 below adds the runtime counterpart.

### 1.4 The web composable tests will not run under the current Vitest config

r1 placed [web/src/composables/useWebSocket.test.ts](../../../../web/src/composables/useWebSocket.test.ts) and claimed `npm test` runs it. The live [vitest.config.ts](../../../../vitest.config.ts) only includes `src/**/*.test.ts` and `tests/**/*.test.ts`. The web package has no `test` script and no test framework dep ([web/package.json L1-L21](../../../../web/package.json#L1-L21)). G46 r2/r3 settled this same problem by extending the root `vitest.config.ts` include glob to `web/src/**/*.test.ts` and keeping the web package framework-free; r1 missed that precedent.

**Correction.** Step 10 (Vitest wiring) is added to the round-2 plan: extend `vitest.config.ts` `include` to `["src/**/*.test.ts", "tests/**/*.test.ts", "web/src/**/*.test.ts"]`. No `test` script is added to `web/package.json`; no `@vue/test-utils` dep is added. The composable tests use a tiny `MockWebSocket` class and the composable's pure return shape — `defineComponent` is not needed because every value the test inspects is a `Ref` or a function the composable hands back. Vue's `onMounted`/`onUnmounted` are exercised by wrapping the composable in a one-line `defineComponent({ setup() { return useWebSocket(...) } })` and mounting with the `vue` package's own `createApp(...).mount(...)` against a detached DOM node from `happy-dom`. `happy-dom` is added to `devDependencies` of the *root* package because Vitest discovers it; the web package stays framework-free.

(Alternative considered: mark the test `// @vitest-environment node` and skip Vue lifecycle by calling `useWebSocket` outside `setup()`. Rejected — Vue's `onMounted` registers against the current instance and is a no-op when no instance is active; the test would silently exercise a different code path. The lightweight `happy-dom` + `defineComponent` shell is what G46 r3's composable tests already use.)

### 1.5 Telegram `sendEvent` is not a no-op

r1's design and plan repeatedly call Telegram's `sendEvent` a no-op and tell the implementer to keep the body empty. The live implementation at [src/channels/telegram.ts L375-L380](../../../../src/channels/telegram.ts#L375-L380) forwards `{type:"message", content}` events to `this.send(content)` and discards everything else. That is observable behaviour: Telegram users see the chat-agent reply because of this forwarding.

**Correction.** The retype to `(event: WsOutbound) => void` keeps the existing dispatch. The body becomes a `switch (event.type)` that calls `this.send(event.content)` on the `"message"` variant and is exhaustive over the other branches (`"session"`, `"thinking"`, `"error"`) — those have no Telegram surface and the explicit cases document that.

### 1.6 The grep invariants are not wired to anything

r1 claimed the grep invariants run "in CI as part of the existing `npm run build` flow". The live root `build` script is `npm run build:web && tsup` ([package.json L13](../../../../package.json#L13)); no grep happens there. r1 also asked the smoke step to run `globalThis.__ws?.send("garbage")`, but neither the composable nor the design exposes the WS on `globalThis`.

**Correction.** The grep invariants move into an explicit, copy-pastable validation block (named `Step 11 — Validation`) in [03-plan-r2.md](03-plan-r2.md#step-11). No build-time gate is claimed; the block is documented as a manual or PR-checklist gate. The manual smoke step's `globalThis.__ws?.send("garbage")` is replaced by a server-side injection: a one-shot Node snippet that opens a raw `ws` connection to the running dev server with the auth token query, sends `"garbage"`, and asserts the server closes the socket with `1003`. The composable's own malformed-frame path is covered by T18.

## 2. Updated test surface

The round-1 test inventory is kept with these adjustments:

- **Remove T7** (outbound silent-drop assertion). It contradicted the strict-outbound rule.
- **Replace T12 wording**: it already asserted that `sendEvent({type:"toolCall"} as any)` throws; round-2 keeps T12 but tightens it to also assert that *no bytes are written*, since the server sketch must use the parsed value.
- **Add T7'** to [src/channels/ws-schema.test.ts](../../../../src/channels/ws-schema.test.ts): "Outbound rejects extra fields (strict)" — round-trip a `{type:"message", content:"hi", bogus:"x"}` and expect `ok:false`.
- **Add T19** to [web/src/composables/useWebSocket.test.ts](../../../../web/src/composables/useWebSocket.test.ts): `send({type:"message", content:""} as any)` throws synchronously; `mockWs.lastSent` stays `undefined`.
- **Adjust T16** (SPA inbound malformed → close): assert `mockWs.closeCalls.at(-1)` equals `[]` (no args; browser-side normal close) instead of `[1003, "schema-violation"]`. Additionally assert `mockWs.sent.at(-1)` equals `JSON.stringify({type:"error", reason:<string>})` to document the best-effort upstream notification.
- **Adjust T9, T10** (server inbound malformed): the server-side close stays at `[1003, "schema-violation"]`. r1's assertions remain correct.
- **Adjust T18**: instead of asserting `(api as any).events).toBeUndefined()`, prefer a TypeScript-only `// @ts-expect-error api.events` plus a runtime `expect("events" in api).toBe(false)` for symmetry.

## 3. Updated test wiring

The round-2 wiring matches the G46 r3 approach:

- [vitest.config.ts](../../../../vitest.config.ts) `include` becomes `["src/**/*.test.ts", "tests/**/*.test.ts", "web/src/**/*.test.ts"]`. The `passWithNoTests: true`, `testTimeout`, and `hookTimeout` lines are left untouched.
- A single root devDependency is added: `"happy-dom": "^15.0.0"` (Vitest auto-picks the env via `// @vitest-environment happy-dom` at the top of the SPA test file). No env globalisation; the server-side tests stay node.
- The web package stays free of test framework deps. `web/package.json` is **not** edited.

## 4. Updated `error` envelope

A typed `error` variant is added to `WsInboundSchema` so the SPA can notify the server before closing. Server treats it as informational (logs and continues to close the socket itself if the SPA does not close fast enough). This is the optional "structured error envelope to server before close" requested in the round-2 brief.

```ts
// WsInbound — both variants are .strict()
z.discriminatedUnion("type", [
  z.object({ type: z.literal("message"), content: z.string().min(1) }).strict(),
  z.object({ type: z.literal("error"),   reason: z.string().min(1), raw: z.string().optional() }).strict(),
])
```

The server's `parseInbound` happily routes `{type:"error", reason}` to a new dedicated handler — by default a `log.warn` line; the server does **not** call `messageHandler` for error envelopes. This is enforced by a new test T8a in [03-plan-r2.md](03-plan-r2.md#step-9).

## 5. Items unchanged from r1

- Single Zod schema module at [src/channels/ws-schema.ts](../../../../src/channels/ws-schema.ts), exporting `WsInbound`/`WsOutbound` and `parseInbound`/`parseOutbound`. (§B.2 of r1.)
- Vite + tsconfig path alias `@channels/ws-schema`. (§B.1 of r1, Step 2.)
- Web bundle adds `zod` ^3.25.76. (Step 2 of r1.)
- `sendEvent` lifted onto `ChatChannel`, both escape-hatch casts at [src/agents/chat.ts L209, L390](../../../../src/agents/chat.ts#L209-L393) deleted. (Step 4 of r1.)
- `events: Ref<WsEvent[]>` deleted, replaced by `onEvent(handler) → unsubscribe`. (§B.3 of r1.)
- The `"system"` and `"event"` discriminator branches in [ChatWindow.vue L112-L121](../../../../web/src/components/ChatWindow.vue#L112-L121) are removed; no live emitter exists for them. (Step 8 of r1.)
- Atomic PR; no compat shim. (§4 of r1.)
- Bounded `errors` ring buffer (cap 8) for the Debug tab. (§B.3 of r1.)

## 6. Open items resolved by round 2

- The "should the SPA also validate `send`?" question from r1 §4 is now resolved: yes, at runtime, via `WsInboundSchema.parse`.
- The "should outbound be strict?" question is resolved: yes, with explicit provenance keys; non-strict was the wrong answer.
- The "where do web tests live?" question is resolved: under `web/src/**/*.test.ts` with the root `vitest.config.ts` include extended.

## 7. Items still deferred

Same as r1 §4 open items: AsyncAPI/OpenAPI publication (G40 territory), Telegram event-stream replacement (sibling work), Debug-tab redesign migration (G46/G47 territory).
