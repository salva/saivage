# G49 — Design (Round 1)

- **Analysis**: [01-analysis-r1.md](01-analysis-r1.md)

## 1. Proposals

### Proposal A — Narrow the `send` signature, leave inbound alone

Change [useWebSocket.ts L93-L97](../../../../web/src/composables/useWebSocket.ts#L93-L97) to a TypeScript-only discriminated union and ask `ChatWindow.vue` to call `send({ type: "message", content })`. Leave the inbound side, the server channel, and the events-array memory leak unchanged.

```ts
export type WsOut = { type: "message"; content: string };
function send(msg: WsOut) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}
```

**Pros**
- Smallest diff (one file, ~10 lines).
- Removes the immediate footgun: a new caller cannot pass a bare string.

**Cons**
- Compile-time only. A bad client (browser console, malicious actor, drift in a future caller that uses `as any`) can still post any payload; the server still silently treats unknown shapes as user prose.
- The inbound side keeps fabricating `{type:"message", content:rawBytes}` on parse failure, which the issue identifies as a confusing failure mode for SPA developers.
- Two `WsEvent` declarations remain, free to drift.
- Violates the architecture-first principle: the structural problem (no single source of truth, no runtime validation, fail-quiet on unknowns) is left in place.
- The `events.value` array leak the issue flags as a "level up" concern is untouched.

### Proposal B — Schema-driven envelope, shared module, fail-loud both ends, emitter API (RECOMMENDED)

One Zod schema file is the single source of truth for both the inbound (server→SPA) and outbound (SPA→server) discriminated unions. Both the server and the web bundle import it. Both sides validate at the boundary; any frame that does not match the schema is rejected loudly:

- Server reads an invalid frame → log + close the socket with code `1003`. The chat agent never sees the bytes.
- Client reads an invalid frame → emit a structured error to the SPA's diagnostic surface and close the socket. The composable does not synthesise a fake frame.
- Either side tries to *send* an invalid frame → throw synchronously (the schema's `.parse` is the only encoder; we deliberately have no escape hatch).

The composable's `events: Ref<WsEvent[]>` is replaced with an emitter, `onEvent(handler) → unsubscribe`. The unbounded array goes away with it.

#### B.1 Files touched

| File | Change | Live anchor for the edit |
|---|---|---|
| [src/channels/ws-schema.ts](../../../../src/channels/ws-schema.ts) | NEW. Zod schemas + inferred TS types for `WsInbound` (SPA→server) and `WsOutbound` (server→SPA). Exported helpers `parseInbound(raw: string)` and `parseOutbound(raw: string)` returning a discriminated `Result` (no exceptions for parse paths). | New file. |
| [web/tsconfig.json](../../../../web/tsconfig.json#L13-L15) | Add a path alias so `@channels/ws-schema` resolves to `../src/channels/ws-schema.ts`. Add `../src/channels/ws-schema.ts` to `include`. | L13-L15 (paths) and L17 (include). |
| [web/vite.config.ts](../../../../web/vite.config.ts#L4) | Add a matching `resolve.alias` entry so the dev server and the production build resolve the schema module the same way. | L4-L20. |
| [web/package.json](../../../../web/package.json#L11-L13) | Add `"zod": "^3.25.76"` to `dependencies` (matches the root pin at [package.json L39](../../../../package.json#L39)). | L11-L13. |
| [web/src/composables/useWebSocket.ts](../../../../web/src/composables/useWebSocket.ts) | Delete the loose `WsEvent` interface (L5-L8); delete the unbounded `events` ref (L33); replace `onmessage` (L62-L70) with `parseOutbound` + emitter dispatch; replace `send(content:string)` (L93-L97) with `send(msg: WsInbound)`. Return `onEvent` in place of `events`. | L5-L8, L33, L62-L70, L93-L97, return value at L138. |
| [src/channels/websocket.ts](../../../../src/channels/websocket.ts) | Delete the redeclared `WsEvent` interface (L4-L7); rewrite the inbound parser (L17-L27) to call `parseInbound` and close the socket with `1003` on failure; rewrite `sendEvent` (L40-L43) to `parseOutbound`-validate the bag before `ws.send`. Update `send(message:string)` (L34-L37) to call `sendEvent` of an explicit `{type:"message", content}` envelope (unchanged semantics, now schema-validated). | L4-L7, L17-L27, L34-L37, L40-L43. |
| [src/agents/chat.ts](../../../../src/agents/chat.ts) | Remove the two `ChatChannel & { sendEvent?: … }` escape hatches at L209 and L390. Add `sendEvent(event: WsOutbound): void` to `ChatChannel` (see next row). Replace the call-site casts with direct `this.channel.sendEvent?.(...)`. | L209-L210, L388-L393. |
| [src/channels/types.ts](../../../../src/channels/types.ts) | Add `sendEvent?(event: WsOutbound): void` to `ChatChannel`. The optional marker stays because Telegram does not implement it meaningfully (see Section 5). | Single new method, no anchor available yet (file is small). |
| [src/server/server.ts](../../../../src/server/server.ts#L693) | `channel.sendEvent({ type: "session", sessionId })` becomes a schema-validated call; no syntactic change at the call site, but the type now flows from `WsOutbound` and the build fails if `sessionId` is mistyped. | L693. |
| [src/channels/telegram.ts](../../../../src/channels/telegram.ts#L375) | Re-type `sendEvent` to `(event: WsOutbound) => void`. Body remains a no-op (Telegram has no event stream); we keep the method so the optional in `ChatChannel` stays a coherent "channel-level capability" rather than "schema-level capability". | L375. |
| [web/src/components/ChatWindow.vue](../../../../web/src/components/ChatWindow.vue) | Replace `events, send` destructure (L39) with `onEvent, send`. Replace `watch(() => events.value.length, …)` (L71) with `onEvent((ev) => { … })`. Update the body to discriminate on `ev.type` against the literal union (TypeScript will surface any non-exhaustive case). Replace `send(JSON.stringify({ type: "message", content: text }))` (L157) with `send({ type: "message", content: text })`. Drop the `as string` / `as string \| undefined` casts at L82-L110; they are now redundant because `WsOutbound` types each branch precisely. | L39, L71-L121, L157. |

#### B.2 Schema shape

`src/channels/ws-schema.ts`:

```ts
import { z } from "zod";

// SPA → server (only currently legal frame).
export const WsInboundSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("message"), content: z.string().min(1) }),
]).strict();
export type WsInbound = z.infer<typeof WsInboundSchema>;

// server → SPA. Every emitter today is captured here.
const ProvenanceFields = {
  provider: z.string().optional(),
  model: z.string().optional(),
  modelSpec: z.string().optional(),
  requestedModelSpec: z.string().optional(),
};
export const WsOutboundSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("session"), sessionId: z.string().min(1) }),
  z.object({ type: z.literal("thinking") }),
  z.object({ type: z.literal("message"), content: z.string(), ...ProvenanceFields }),
]);
export type WsOutbound = z.infer<typeof WsOutboundSchema>;

export type ParseResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string; raw: string };

export function parseInbound(raw: string): ParseResult<WsInbound> { /* JSON.parse + safeParse */ }
export function parseOutbound(raw: string): ParseResult<WsOutbound> { /* … */ }
```

Notes on the schema choices:

- `.strict()` on the inbound union rejects any extra keys — the SPA cannot smuggle fields the server has not agreed to.
- The outbound union is **not** strict because chat-side `sendEvent({ type:"message", content, ...source })` ([src/agents/chat.ts L392](../../../../src/agents/chat.ts#L392)) spreads provenance metadata; we list every legal provenance key explicitly in `ProvenanceFields` so the SPA can drop the `as string` casts at [ChatWindow.vue L107-L110](../../../../web/src/components/ChatWindow.vue#L107-L110). New provenance fields require a schema edit — that is the intended outcome.
- The two `WsEvent` interfaces in [useWebSocket.ts L5-L8](../../../../web/src/composables/useWebSocket.ts#L5-L8) and [src/channels/websocket.ts L4-L7](../../../../src/channels/websocket.ts#L4-L7) are deleted; consumers import `WsOutbound` / `WsInbound` from the schema module.
- The `"system"` and `"event"` discriminator branches in [ChatWindow.vue L112-L121](../../../../web/src/components/ChatWindow.vue#L112-L121) have **no emitter** in the current codebase (verified by grep across `src/`). The design removes those branches from the SPA and from the schema. If a future emitter wants to push system-level notifications it adds the discriminator to the schema first.

#### B.3 SPA composable shape

```ts
import { WsInbound, WsOutbound, parseOutbound } from "@channels/ws-schema";

export function useWebSocket(url?: string) {
  const connected = ref(false);
  const status = ref<WsStatus>("connecting");
  const handlers = new Set<(ev: WsOutbound) => void>();
  const errors = ref<{ raw: string; reason: string }[]>([]);
  // …connection bookkeeping unchanged…

  ws.onmessage = (event) => {
    const r = parseOutbound(typeof event.data === "string" ? event.data : "");
    if (!r.ok) {
      errors.value.push({ raw: r.raw, reason: r.error });
      ws?.close(1003, "schema-violation");
      return;
    }
    for (const h of handlers) h(r.value);
  };

  function send(msg: WsInbound) {
    if (ws?.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify(msg)); // schema-checked at the type level via WsInbound
  }
  function onEvent(h: (ev: WsOutbound) => void): () => void {
    handlers.add(h);
    return () => handlers.delete(h);
  }

  return { connected, status, errors, onEvent, send, disconnect, reconnect };
}
```

The replacement deliberately deletes:

- the unbounded `events: Ref<WsOutbound[]>` (the issue's "Level up");
- the silent `events.value.push({type:"message", content:event.data})` fallback;
- the `WsEvent` interface and its loose `[key: string]: unknown` index signature.

`errors` is a small, capped (last 8 frames) array kept for the Debug tab; this is a deliberate, bounded surface, not a regression of the original leak.

#### B.4 Server channel shape

```ts
import { parseInbound, WsOutbound, WsOutboundSchema } from "./ws-schema.js";

ws.on("message", (data) => {
  const raw = data.toString().trim();
  if (!raw) return;
  const r = parseInbound(raw);
  if (!r.ok) {
    log.warn(`[ws] dropping malformed frame: ${r.error}`);
    this.ws.close(1003, "schema-violation");
    return;
  }
  // r.value.type === "message"  (only inbound variant today)
  this.messageHandler?.(r.value.content);
});

sendEvent(event: WsOutbound): void {
  WsOutboundSchema.parse(event); // throws if a server emitter drifts
  if (this.ws.readyState === this.ws.OPEN) this.ws.send(JSON.stringify(event));
}
```

`send(message:string)` ([src/channels/websocket.ts L34-L37](../../../../src/channels/websocket.ts#L34-L37)) becomes a thin wrapper that constructs the validated `{type:"message", content:message}` envelope and delegates to `sendEvent`.

**Pros**
- One source of truth, both ends. Drift is a compile-time error on the schema-importing side and a runtime error at the boundary on the wire side.
- Fail-loud at every seam: malformed wire → close `1003`; out-of-schema emitter → synchronous throw on the server (caught by the server's existing chat-agent error path); out-of-schema receiver → SPA surfaces the raw frame.
- The unbounded `events` array is removed in the same edit, addressing the issue's "Level up".
- The two `ChatChannel & { sendEvent?: … }` escape hatches in [chat.ts L209,L390](../../../../src/agents/chat.ts#L209-L393) are removed; `sendEvent` becomes part of the channel interface.
- Resolves the precondition for G40 (web-protocol doc drift): once the schema exists, the doc can be generated from it or simply reference it as canonical.

**Cons**
- Larger diff (~10 files, 1 new module, 1 new dep on web).
- Adds Zod to the web bundle. Zod tree-shakes to ~12 KB gzipped with this schema; acceptable for an admin SPA (acceptance criterion in the plan).
- Requires a path-alias / Vite alias edit so the web bundle can import a server-tree module. This is a one-time configuration change.
- Telegram's `sendEvent` becomes a slightly more constrained no-op (`WsOutbound` instead of `Record<string, unknown>`). No observable behaviour change.

### Recommendation: Proposal B

Proposal A fixes only the most visible footgun and leaves the structural failure (no shared schema, silent fallbacks, redeclared `WsEvent`, unbounded array, escape-hatch casts) in place. The issue is filed as "low severity" precisely because no current caller demonstrates the problem; the cheap fix would calcify the design. Proposal B is the architecture-first answer and is the work the issue's own "Rough remediation direction" and "Cross-links" point at.

## 2. Failure modes and how the design rejects them

| Failure | Today | Under Proposal B |
|---|---|---|
| Bare string `send("hi")` from a new SPA caller. | Server treats `"hi"` as user prose ([websocket.ts L17-L27](../../../../src/channels/websocket.ts#L17-L27)). | TS compile error at the call site (`send` requires `WsInbound`). If circumvented at runtime, server `parseInbound` returns `ok:false`; socket closes `1003`. |
| Server emitter publishes `{type:"toolCall",…}`. | SPA renders nothing silently. | `WsOutboundSchema.parse` throws on the server side, surfacing the drift in the chat agent's existing error path. The frame never reaches the client. |
| Field rename `provider` → `providerId` on the server. | SPA reads `ev.provider as string \| undefined` → `undefined`, silent break. | Schema lists `provider`; the rename forces an edit to the schema, which then forces an edit to the SPA's branch. Both ends move atomically. |
| Malformed wire bytes. | SPA fabricates `{type:"message", content:rawBytes}` and renders garbage as if the agent said it. | `parseOutbound` returns `ok:false`; SPA pushes to bounded `errors` ring, closes socket; reconnect/backoff fires normally. |
| Slow memory leak from long sessions. | `events.value` grows unbounded ([useWebSocket.ts L33,L66](../../../../web/src/composables/useWebSocket.ts#L33-L66)). | Array is gone; handlers own their own retention. |

## 3. Migration order

The change can land in one PR; the file-level order inside the PR matters for review:

1. New `src/channels/ws-schema.ts` (schema + parse helpers + types). No imports yet.
2. `web/package.json` (+ `zod`), `web/tsconfig.json` (path alias + `include`), `web/vite.config.ts` (resolve alias). Lockfile update.
3. `src/channels/types.ts` — add `sendEvent` to `ChatChannel`.
4. `src/channels/websocket.ts` — schema-validated parser + sender; drop `WsEvent`.
5. `src/channels/telegram.ts` — retype no-op `sendEvent` to `WsOutbound`.
6. `src/agents/chat.ts` — drop the two escape-hatch casts.
7. `src/server/server.ts` — call site is now schema-typed (no behavioural change).
8. `web/src/composables/useWebSocket.ts` — drop `WsEvent`, drop `events`, add `onEvent`, retype `send`, schema-validated `onmessage`.
9. `web/src/components/ChatWindow.vue` — migrate to `onEvent`, schema-typed branches, structured `send`.
10. Tests (Section 4 of the plan).

The PR is atomic: there is no intermediate state in which two `WsEvent` shapes coexist or one end validates while the other does not.

## 4. Open items deferred to round 2

- Whether to also retype Telegram's `sendEvent` into a *real* event stream (e.g. Telegram Bot API "inline notifications"). Out of scope; sibling improvement.
- Whether to publish the schema as a typed OpenAPI / AsyncAPI artefact for the docs in [docs/web/](../../../../docs/web). G40's territory; the schema module is the precondition.
- Whether to enforce `parseOutbound` at the SPA boundary even in production builds (vs strip in `import.meta.env.PROD`). Going with: validate in all builds. The frame rate is human-paced; validation cost is negligible and the value (no silent drift in production) is high.
