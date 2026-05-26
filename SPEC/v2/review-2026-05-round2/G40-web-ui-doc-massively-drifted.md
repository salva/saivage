# G40 — `docs/guide/web-ui.md` describes a different web UI than the one shipped

- **Subsystem**: docs (`docs/guide/web-ui.md`)
- **Category**: documentation drift, security-relevant (auth)
- **Severity**: high
- **Transversality**: cross-cuts web UI, server routes, WebSocket protocol, auth

## Summary

The user-facing Web UI guide describes a tab layout, REST surface, WebSocket
protocol, and security posture that bear almost no resemblance to the code that
runs today. An operator following the doc cannot navigate the SPA, cannot
write a WebSocket client, and is actively misinformed about the existence of
authentication.

## Evidence

Tab inventory:

- Doc lists **nine** tabs — Plan, Stage, Agents, Conversation, Events, Notes,
  Inspections, Files, Providers — at [docs/guide/web-ui.md](docs/guide/web-ui.md#L20).
- The SPA registers **five** — Dashboard, Plan, Agents, Files, Debug — in
  [web/src/App.vue](web/src/App.vue#L40-L60).

WebSocket protocol:

- Doc states messages use envelopes `{type:"event", payload}`, `{type:"state", payload}`,
  `{type:"chat", payload}`, `{type:"note", payload}` at
  [docs/guide/web-ui.md](docs/guide/web-ui.md#L92-L108).
- Actual server frames are `{type:"session"|"message"|"thinking"|"system"|"event", ...}`
  with a flat `content` field, not `payload` — see
  [src/server/server.ts](src/server/server.ts#L389-L520).
- Inbound client frames the doc never mentions: `{type:"message", content}` and
  `{type:"interrupt"}` are the only shapes parsed by the server in
  [src/channels/websocket.ts](src/channels/websocket.ts#L20-L50).

Authentication:

- Doc explicitly states: *"The daemon does not implement authentication; deploy
  behind a reverse proxy if you need it"* — [docs/guide/web-ui.md](docs/guide/web-ui.md#L160-L170).
- Server actually gates every `/api/*` route and the WS upgrade on the
  `SAIVAGE_API_TOKEN` environment variable in
  [src/server/server.ts](src/server/server.ts#L88-L160), and the SPA reads the
  token from `localStorage` and threads it through every fetch in
  [web/src/composables/useAuthState.ts](web/src/composables/useAuthState.ts#L1-L80).
- `SAIVAGE_API_TOKEN` appears nowhere under `docs/` — verified by a workspace-wide
  `grep` for the symbol.

REST routes:

- Doc tabulates `/api/state`, `/api/plan`, `/api/events`, `/api/chat`, `/api/notes`,
  `/api/inspections`, `/api/files`, `/api/providers` at [docs/guide/web-ui.md](docs/guide/web-ui.md#L40-L80).
- Actual routes: `/api/state`, `/api/plan`, `/api/notes`, `/api/files`,
  `/api/files/content`, `/api/agents`, `/api/conversation`, `/api/system-events`,
  `/api/sessions`, `/api/auth/test` — see
  [src/server/server.ts](src/server/server.ts#L160-L380). `/api/events`,
  `/api/chat`, `/api/inspections`, `/api/providers` do not exist.

## Why this matters

This is the single user-facing entry point for the web UI. A new operator
reading it will fail to log in (no auth mentioned), fail to find the
"Conversation" / "Events" / "Notes" tabs, and any external automation written
against the documented REST/WS surface will 404 or crash on the first message.
The auth lie is the worst symptom — a reader can reasonably conclude they need
to add a reverse proxy *before* exposing the daemon, when in fact the
`SAIVAGE_API_TOKEN` gate is already enforced and silently rejecting them.

## Rough remediation direction

Rewrite `docs/guide/web-ui.md` against the current code: enumerate the five
real tabs with one sentence each pointing at the implementing component; copy
the actual REST table from `server.ts` route registrations; document the real
WS protocol (`session` / `message` / `thinking` / `system` / `event` frames out,
`message` / `interrupt` in); and add a dedicated "Authentication" section that
explains the `SAIVAGE_API_TOKEN` env var, the `Authorization: Bearer` header,
the login UI flow, and the 401/1008/4401 close codes.

**Level up**: treat the docs/code drift symptomatically. Generate the REST
surface section from the Fastify route registrations at build time (a tiny
script that loads `server.ts` in a stub runtime and emits a markdown table),
and the WS frame catalog from the discriminated union in
[src/server/server-events.ts](src/server/server-events.ts). Make the docs build
fail when an undocumented route or frame type appears. This is how the
`docs/internals/*.md` files have rotted (see G44, G45) — manual sync does not
survive even a single feature.

## Cross-links

- G41 — `App.vue` reads non-existent `/api/state` fields (same root cause: doc
  and code disagree on schema).
- G44 — `docs/internals/channels.md` still references files deleted in F35.
- G45 — `docs/internals/server.md` documents a `SaivageRuntime` shape that
  does not exist.
- F26 — SPA auth-state duplication (the auth path the doc denies exists).
