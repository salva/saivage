# G40 — Analysis (r2)

## Changes from r1

Reviewer-required changes (see [04-review-r1.md](./04-review-r1.md#L37-L70)):

1. Corrected layout/chrome facts: `ChatWindow` is mounted **only** on
   the Dashboard tab at [web/src/App.vue](web/src/App.vue#L234-L252),
   not "alongside every tab". Added the side rail and workspace header
   to the chrome inventory (D1).
2. Removed the unsupported claims that the Dashboard surfaces notes
   inline and that Debug consumes `/api/inspections` and
   `/api/providers`. Notes UI lives in `FilesView` at
   [web/src/components/FilesView.vue](web/src/components/FilesView.vue#L89-L173);
   `DebugView` only fetches `/api/debug/state`, `/api/debug/errors`, and
   `/api/debug/timeline` at
   [web/src/components/DebugView.vue](web/src/components/DebugView.vue#L23-L60).
   Server-registered endpoints without a current SPA panel
   (`/api/providers`, `/api/inspections`, `/api/mcp/tools`) are kept in
   D2 but labelled as registered scriptable surface, not as SPA
   consumers (D1, D2).
3. The "REST polls for snapshots" subsection (D6) is unchanged but the
   per-tab "consumer" annotations now match the source.
4. Sibling-finding text (D7, D8) and the recommendation to keep
   Design B as a cross-finding follow-on rather than gating G40 are
   carried forward; see [02-design-r2.md](./02-design-r2.md) and
   [03-plan-r2.md](./03-plan-r2.md) for the actionable change.

## Functional analysis

The user-facing web UI guide at
[docs/guide/web-ui.md](docs/guide/web-ui.md#L1-L86) is the single entry
point an operator reads before opening the dashboard, scripting against
the HTTP surface, or writing a WebSocket client. Its contract is
"everything on this page must match the running daemon at
[src/server/server.ts](src/server/server.ts#L1) and the SPA at
[web/src/App.vue](web/src/App.vue#L1)". Today it fails that contract on
every section: tab list, REST table, WS frame catalog, and the
authentication paragraph are all wrong, and the auth claim is actively
dangerous (it tells operators no auth exists when `SAIVAGE_API_TOKEN`
is in fact enforced at
[src/server/server.ts](src/server/server.ts#L70-L78) for `/api/*` and at
[src/server/server.ts](src/server/server.ts#L662-L668) for `/ws`).

Below every drifted claim in the 86-line doc is enumerated against
ground truth in the source.

## Drift inventory

### D1 — Tab list and chrome (doc says nine tabs; SPA renders five tabs plus a fixed shell)

- Doc [docs/guide/web-ui.md](docs/guide/web-ui.md#L19-L31) lists
  **Plan, Stage, Agents, Conversation, Events, Notes, Inspections,
  Files, Providers**.
- SPA registers exactly five tabs in the `tabs: TabConfig[]` array at
  [web/src/App.vue](web/src/App.vue#L29-L37): **Dashboard, Plan, Agents,
  Files, Debug**. Active-tab type narrows the same way at
  [web/src/App.vue](web/src/App.vue#L23). Default landing tab is
  `agents` at [web/src/App.vue](web/src/App.vue#L40).
- The SPA chrome around the tab body is:
  - Side rail with brand, tab-nav buttons, Docs link, and Shortcuts
    button at [web/src/App.vue](web/src/App.vue#L168-L220).
  - Workspace header with the active tab's description as eyebrow, the
    tab label as `<h1>`, a project-path pill, and a "live" pill at
    [web/src/App.vue](web/src/App.vue#L222-L232).
  - No footer is rendered.
- Tab body composition:
  - **Dashboard** is a two-column grid that renders
    [web/src/components/ChatWindow.vue](web/src/components/ChatWindow.vue)
    next to [web/src/components/StatusPanel.vue](web/src/components/StatusPanel.vue)
    at [web/src/App.vue](web/src/App.vue#L234-L240). `ChatWindow` is
    only mounted inside this dashboard grid; it is **not** rendered on
    the other four tabs.
  - **Plan**, **Agents**, **Files**, **Debug** each render as a
    single full-view panel at [web/src/App.vue](web/src/App.vue#L241-L252).
- "Stage" is not a top-level tab; per-stage detail lives inside `PlanView`.
- "Conversation" is not a tab; the per-agent conversation panel is opened
  from `AgentsView` against `/api/agents/:agentId/conversation`.
- "Events" is not a tab; system/event frames stream into the chat
  surface that the Dashboard tab renders (see D3).
- "Notes" is not a tab; notes are read/acknowledged/deleted from inside
  the Files tab at
  [web/src/components/FilesView.vue](web/src/components/FilesView.vue#L89-L173).
- "Inspections" is not a tab. `/api/inspections` is registered at
  [src/server/server.ts](src/server/server.ts#L238) but no current SPA
  panel calls it.
- "Providers" is not a tab. `/api/providers` is registered at
  [src/server/server.ts](src/server/server.ts#L218) but no current SPA
  panel calls it.

### D2 — REST route table

Doc [docs/guide/web-ui.md](docs/guide/web-ui.md#L40-L62) tabulates one
set of routes; [src/server/server.ts](src/server/server.ts#L127-L666)
registers a different set. Diff:

| Documented | Reality |
|---|---|
| `GET /health` ✓ | `GET /health` at [server.ts L127](src/server/server.ts#L127) |
| `GET /api/config` ✓ | `GET /api/config` at [server.ts L201](src/server/server.ts#L201) |
| `GET /api/state` ✓ | `GET /api/state` at [server.ts L173](src/server/server.ts#L173) |
| `GET /api/plan` ✓ | `GET /api/plan` at [server.ts L142](src/server/server.ts#L142) |
| `GET /api/plan/stages/:id` ✓ | `GET /api/plan/stages/:id` at [server.ts L150](src/server/server.ts#L150) |
| `GET /api/agents/:agentId/conversation` ✓ | same at [server.ts L183](src/server/server.ts#L183) |
| `GET /api/providers` ✓ | `GET /api/providers` at [server.ts L218](src/server/server.ts#L218); registered, no current SPA consumer. |
| `GET /api/inspections` ✓ | `GET /api/inspections` at [server.ts L238](src/server/server.ts#L238); registered, no current SPA consumer. |
| `GET /api/notes` ✓ | `GET /api/notes` at [server.ts L255](src/server/server.ts#L255) |
| `POST /api/notes/:id/acknowledge` ✓ | at [server.ts L260](src/server/server.ts#L260) (path parameter named `:noteId`, not `:id`) |
| `DELETE /api/notes/:id` ✓ | at [server.ts L270](src/server/server.ts#L270) (same naming caveat) |
| `DELETE /api/notes` ✓ | at [server.ts L279](src/server/server.ts#L279) |
| `GET /api/chats` ✓ | at [server.ts L286](src/server/server.ts#L286) |
| `GET /api/chats/:sessionId` ✓ | at [server.ts L325](src/server/server.ts#L325) |
| `GET /api/files` ✓ | at [server.ts L376](src/server/server.ts#L376); accepts undocumented `?root=saivage\|project` and `?path=` query parameters at [server.ts L377-L398](src/server/server.ts#L377-L398). |
| `GET /api/files/content?path=…` ✓ | at [server.ts L428](src/server/server.ts#L428); same undocumented `?root=` parameter at [server.ts L429-L451](src/server/server.ts#L429-L451); 1 MiB truncation cap at [server.ts L466-L470](src/server/server.ts#L466-L470). |
| `GET /api/debug/state` ✓ | at [server.ts L477](src/server/server.ts#L477) |
| `GET /api/debug/errors` ✓ | at [server.ts L502](src/server/server.ts#L502) |
| `GET /api/debug/timeline` ✓ | at [server.ts L598](src/server/server.ts#L598) |
| `GET /ws` ✓ | at [server.ts L662](src/server/server.ts#L662) |
| — | **Undocumented**: `GET /api/mcp/tools` at [server.ts L232-L234](src/server/server.ts#L232-L234). Registered scriptable surface; no current SPA consumer. |
| — | **Undocumented**: `GET /docs/` placeholder at [server.ts L115-L124](src/server/server.ts#L115-L124) (only when VitePress is unbuilt). |
| — | **Undocumented**: static SPA mount on `/` and `/assets/*` at [server.ts L91-L96](src/server/server.ts#L91-L96), and VitePress mount on `/docs/` at [server.ts L102-L113](src/server/server.ts#L102-L113). |

The doc's column captions ("Method", "Path", "Purpose") and most rows
survive — the regressions are the missing `GET /api/mcp/tools` row and
the missing `?root` query-parameter documentation. The sibling-finding
linkage in [G40-web-ui-doc-massively-drifted.md](../G40-web-ui-doc-massively-drifted.md)
claims `/api/events`, `/api/chat`, `/api/inspections`, `/api/providers`
"do not exist"; in this codebase `/api/inspections` and `/api/providers`
**do** exist (lines cited above), and only `/api/events` and `/api/chat`
are absent. The principal table-level regressions are therefore the
missing `:noteId` path spelling, the missing `?root=` parameter, and the
missing `/api/mcp/tools` row — not the wholesale fabrication implied by
the original finding. The whole-doc regression is still high-severity
because of D1, D3, and D4 below.

### D3 — WebSocket frame catalog

Doc [docs/guide/web-ui.md](docs/guide/web-ui.md#L66-L80) claims the WS
carries envelopes with a `payload` field:

```
server → client: { type: "event"|"state"|"chat", payload: {...} }
client → server: { type: "chat",  payload: {sessionId, message} }
                 { type: "note",  payload: {content, permanent?, urgent?} }
```

Actual frames have no `payload` wrapper and the discriminator set is
different on both sides.

**Server → client frames** (every site that calls `WebSocketChannel.sendEvent`):

| `type` | Payload shape | Emitted at |
|---|---|---|
| `session` | `{ sessionId: string }` | [src/server/server.ts L693](src/server/server.ts#L693) on socket open. |
| `message` | `{ content: string, ...source }` where `source` is the spread of the chat agent's source metadata; also used for plain assistant text echo via `WebSocketChannel.send()` at [src/channels/websocket.ts L35-L37](src/channels/websocket.ts#L35-L37). | [src/agents/chat.ts L389-L393](src/agents/chat.ts#L389-L393), [src/channels/websocket.ts L35-L37](src/channels/websocket.ts#L35-L37). |
| `thinking` | `{}` (no extra fields) — sent at the start of each assistant turn. | [src/agents/chat.ts L209-L210](src/agents/chat.ts#L209-L210). |
| `system` / `event` | Pass-through of `SystemEvent` bus payloads, filtered by `getEventFilter()` at [src/server/server.ts L729-L734](src/server/server.ts#L729-L734). The client treats both discriminators identically at [web/src/components/ChatWindow.vue L111](web/src/components/ChatWindow.vue#L111). |

The shipped `WsEvent` type is a flat `{ type: string; [key: string]: unknown }`
at [src/channels/websocket.ts L3-L6](src/channels/websocket.ts#L3-L6) and
mirrored client-side at
[web/src/composables/useWebSocket.ts L5-L8](web/src/composables/useWebSocket.ts#L5-L8).
No `state` frame is ever sent — runtime state is REST-polled via
`/api/state`. No envelope wrapper is ever sent.

**Client → server frames** (only consumer is `WebSocketChannel`'s
`ws.on("message")` handler at
[src/channels/websocket.ts L17-L28](src/channels/websocket.ts#L17-L28)):

| Inbound | Behaviour |
|---|---|
| `{ type: "message", content: string }` JSON envelope | `content` is extracted and forwarded to the chat agent's `messageHandler`. |
| any other JSON | The full JSON string is treated as raw user text. |
| any non-JSON text | Treated as raw user text. |

The composer in
[web/src/components/ChatWindow.vue L157](web/src/components/ChatWindow.vue#L157)
sends `JSON.stringify({ type: "message", content: text })`. There is no
`interrupt` frame, no `note` frame, no `sessionId` field, and no
`chat`-discriminator frame. The doc's `{type:"chat", payload:...}` and
`{type:"note", payload:...}` are entirely fabricated.

The G40 finding text additionally lists `{type:"interrupt"}` as a parsed
inbound frame — that is also wrong. The implementation at
[src/channels/websocket.ts L17-L28](src/channels/websocket.ts#L17-L28)
only recognises the `message` discriminator.

### D4 — Authentication paragraph (security-relevant)

Doc [docs/guide/web-ui.md](docs/guide/web-ui.md#L82-L86) states verbatim:

> The daemon does **not** implement authentication. It is expected to live
> inside a trusted network or behind a reverse proxy.

The daemon **does** implement authentication. Evidence:

- The optional API token gate is registered when the
  `SAIVAGE_API_TOKEN` env var is set at
  [src/server/server.ts L70-L78](src/server/server.ts#L70-L78). The
  `onRequest` hook rejects any `/api/*` request whose extracted token
  does not match.
- The WebSocket upgrade handler repeats the check at
  [src/server/server.ts L662-L668](src/server/server.ts#L662-L668) and
  closes the socket with code 1008 ("unauthorized") when the token is
  missing or wrong.
- Tokens may be supplied via `Authorization: Bearer <token>`, the
  `x-saivage-token` header, or `?token=<token>` query parameter — see
  `extractRequestToken()` at
  [src/server/server.ts L759-L766](src/server/server.ts#L759-L766) and
  `bearer()` at
  [src/server/server.ts L751-L757](src/server/server.ts#L751-L757).
- The SPA reads the token from URL `?token=` or `localStorage` at
  [web/src/utils/api.ts L25-L70](web/src/utils/api.ts#L25-L70), threads
  it through every REST call as `Authorization: Bearer …` at
  [web/src/utils/api.ts L112-L115](web/src/utils/api.ts#L112-L115), and
  through every WS connection as `?token=` at
  [web/src/utils/api.ts L82-L88](web/src/utils/api.ts#L82-L88) (consumed
  by `useWebSocket().getUrl()` at
  [web/src/composables/useWebSocket.ts L44-L48](web/src/composables/useWebSocket.ts#L44-L48)).
- The composable converts auth-policy WebSocket close codes
  (1008, 4401, 4403) into a sticky `unauthorized` flag at
  [web/src/composables/useWebSocket.ts L71-L84](web/src/composables/useWebSocket.ts#L71-L84),
  shared via
  [web/src/composables/useAuthState.ts L12-L34](web/src/composables/useAuthState.ts#L12-L34).

A workspace-wide `grep -rn SAIVAGE_API_TOKEN docs/` returns nothing, so
the env var that gates the entire HTTP surface is not mentioned in any
operator-facing document. The "1008 / 4401 / 4403" close codes that the
SPA treats as terminal auth failures are also undocumented.

### D5 — Default-port claim

Doc [docs/guide/web-ui.md](docs/guide/web-ui.md#L11-L17) says the default
bind is `0.0.0.0:8080`. That matches the `startServer` signature default
at [src/server/server.ts L54-L57](src/server/server.ts#L54-L57). No drift.

### D6 — "REST polls for snapshots" claim

Doc [docs/guide/web-ui.md](docs/guide/web-ui.md#L33-L34) says the page
issues "classic REST polls for snapshots". This is correct in shape —
StatusPanel, PlanView, AgentsView, FilesView, DebugView all poll their
respective `/api/*` routes — but the doc omits the fact that
`apiFetch()` is the only entry point and that it transparently injects
the bearer token. Minor drift; subsumed by D4.

### D7 — Channels cross-link target

Doc [docs/guide/web-ui.md](docs/guide/web-ui.md#L80) links to
`/internals/channels` ("See [Channels] for the implementation"). That
document is itself the subject of G44 (regression: references files
deleted in F35). Re-pointing this link is part of the G40↔G44
coordination, not a separate G40 fix.

### D8 — LXC reverse-proxy advice

Doc [docs/guide/web-ui.md](docs/guide/web-ui.md#L85-L86) tells operators
to "see [LXC](./install-lxc) for forwarding". `docs/guide/install-lxc.md`
exists, but the advice is moot once auth is documented (D4) — the
deployment is no longer "unauthenticated". The hint should remain (NAT
is still a valid posture) but it cannot stay as the sole security
argument.

## Why this matters

D1 makes the doc unusable as a navigational reference — readers look for
four tabs that do not exist and miss the Debug tab entirely. D3 makes
the doc unusable as a protocol reference — any external automation
written against the documented frames will fail on the first message
because the server never emits `payload`-wrapped envelopes and never
accepts `note` or `chat` discriminators. D4 is the most damaging: it
tells the operator no authentication exists, so a reader who deploys the
daemon on a routable network will assume their only defence is the
reverse proxy mentioned in
[docs/guide/web-ui.md](docs/guide/web-ui.md#L85-L86), miss
`SAIVAGE_API_TOKEN` entirely, and either (a) over-provision a proxy they
do not need, or (b) — worse — see the silent 401s the daemon returns and
incorrectly conclude the service is broken rather than gated.

D2 is the smallest drift (table is mostly accurate) but is still
load-bearing because `/api/mcp/tools` is the only inspector entry-point
for the MCP runtime and currently has no public surface other than as a
registered route.

## Sibling-finding coordination

- **G41** — `App.vue` reads non-existent `/api/state` fields. Same root
  cause (doc and code disagree on schema). G40 owns the doc rewrite;
  G41 owns the SPA fix. The new D3 frame table for `system` / `event`
  is consistent with G41's `/api/state` shape (`{state, plan}`) at
  [src/server/server.ts L173-L180](src/server/server.ts#L173-L180); no
  contradiction. G40's rewritten layout/REST sections must not claim
  the Dashboard polls `/api/state` fields that G41 is about to remove
  or reshape — the rewrite uses the current `{state, plan}` shape from
  source and nothing more.
- **G44** — `docs/internals/channels.md` references files deleted in
  F35. The "See Channels" link at
  [docs/guide/web-ui.md](docs/guide/web-ui.md#L80) is the only inbound
  reference from the guide tree. Once G44 rewrites
  `docs/internals/channels.md` to describe only `websocket.ts` and
  `telegram.ts`, this link target stays valid. G40 does not need to
  delete it. Coordination: G40 lands first (rewrites the WS section
  inline so it stands alone), G44 lands second (the internal doc
  becomes a deeper reference rather than a load-bearing pointer).
- **G45** — `docs/internals/server.md` documents a `SaivageRuntime`
  shape that does not exist. Independent of G40 (different doc,
  different audience).

## Out of scope for G40

- Adding new REST routes or WS frames. The only goal is to make the
  doc describe what is already shipped.
- Touching the SPA. G41 owns the SPA-side bug.
- Rewriting `docs/internals/*`. Owned by G44 / G45.
- Documenting `/docs/` VitePress mount logic
  ([server.ts L102-L113](src/server/server.ts#L102-L113)) — belongs in
  a future docs-on-deployment finding, not the user-facing web-UI
  guide.
- Building a doc generator, adding a docs build plugin, or wiring a new
  CI gate. Recorded for the round-2 meta-plan as a cross-finding
  follow-on after G40/G44/G45 land (see
  [02-design-r2.md](./02-design-r2.md)).
