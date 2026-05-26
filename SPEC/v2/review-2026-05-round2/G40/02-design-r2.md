# G40 — Design (r2)

## Changes from r1

Reviewer-required changes (see [04-review-r1.md](./04-review-r1.md#L37-L70)):

1. Design A's Layout skeleton now correctly says the Dashboard combines
   the chat surface and status panel and that the other four tabs are
   full-view panels with no chat panel. Added the side rail + workspace
   header chrome sentence; explicitly notes the SPA has no footer.
2. Removed the implication that Debug consumes `/api/inspections`,
   `/api/providers`, or `/api/mcp/tools`. The Debug bullet matches the
   three `/api/debug/*` endpoints actually fetched by `DebugView`. The
   REST table keeps `/api/providers`, `/api/inspections`, and
   `/api/mcp/tools` as scriptable surface, not as panel data sources.
   Notes are listed as part of the Files tab (where the UI lives),
   not the Dashboard.
3. Test impact rewritten: `npm run docs:build` is **not** a link
   checker today (`ignoreDeadLinks: true` at
   [docs/.vitepress/config.ts L8-L12](docs/.vitepress/config.ts#L8-L12);
   `docs:build` is `npm run docs:api && vitepress build docs` at
   [package.json L20-L25](package.json#L20-L25)). The validation step
   is now an explicit manual path check plus a strengthened grep
   self-check that targets the **actual** legacy bullet markup
   (`- **Stage**`, `- **Conversation**`, ...) rather than the
   phrases "Stage tab" / "Conversation tab".
4. Design B is now explicitly recorded as a cross-finding follow-on
   for the metaplan (G40 + G44 + G45 land first, then a single
   generator pass). G40 does not add generator scripts, docs build
   plugins, or CI gates.

## Design A — Rewrite the guide in-place

**Idea.** Treat `docs/guide/web-ui.md` as a hand-maintained operator
doc and rewrite it once to match the current code. Five sections:
Accessing, Layout (five tabs + chrome), REST endpoints, WebSocket
protocol, Authentication. Keep it short — every paragraph cites the
source file it documents so future readers can verify.

**Replacement content (skeleton).**

1. **Accessing it** — unchanged. `0.0.0.0:8080` default; `saivage.json`
   override. Cite [src/server/server.ts L54-L57](src/server/server.ts#L54-L57).
2. **Layout** — one chrome paragraph plus five tab bullets:
   - Chrome paragraph: "The dashboard is a fixed two-pane shell — a
     left side rail with the brand, tab navigation, a Docs link, and a
     Shortcuts button ([web/src/App.vue L168-L220](web/src/App.vue#L168-L220)),
     next to a workspace pane whose header shows the active tab's
     description, label, the project path, and a `live` pill
     ([web/src/App.vue L222-L232](web/src/App.vue#L222-L232)). There
     is no footer."
   - **Dashboard** ([web/src/components/StatusPanel.vue](web/src/components/StatusPanel.vue)) —
     two-column grid combining the chat surface
     ([web/src/components/ChatWindow.vue](web/src/components/ChatWindow.vue),
     the only WebSocket consumer) with the live status panel; rendered
     at [web/src/App.vue L234-L240](web/src/App.vue#L234-L240).
   - **Plan** ([web/src/components/PlanView.vue](web/src/components/PlanView.vue)) —
     full-view: stages and evidence; per-stage detail nested.
   - **Agents** ([web/src/components/AgentsView.vue](web/src/components/AgentsView.vue)) —
     full-view: running agent conversations.
   - **Files** ([web/src/components/FilesView.vue](web/src/components/FilesView.vue)) —
     full-view: read-only browser of `.saivage/` and the project root;
     also the home of the notes inbox (list, acknowledge, delete) at
     [web/src/components/FilesView.vue L89-L173](web/src/components/FilesView.vue#L89-L173).
   - **Debug** ([web/src/components/DebugView.vue](web/src/components/DebugView.vue)) —
     full-view: `/api/debug/state`, `/api/debug/errors`, and
     `/api/debug/timeline` snapshots at
     [web/src/components/DebugView.vue L23-L60](web/src/components/DebugView.vue#L23-L60).
   - One closing sentence: "The chat panel lives only on the Dashboard
     tab; switching away from Dashboard hides it (but the WebSocket
     stays connected)."
3. **REST endpoints** — table rewritten from
   [src/server/server.ts L127-L666](src/server/server.ts#L127-L666)
   registrations. Add the missing `GET /api/mcp/tools` row; rename
   `:id` → `:noteId`; document the `?root=saivage|project` and `?path=`
   query parameters on `/api/files` and `/api/files/content`; note the
   1 MiB truncation cap on `/api/files/content`. Routes without a
   current SPA consumer (`/api/providers`, `/api/inspections`,
   `/api/mcp/tools`) are listed as registered scriptable surface, not
   as panel data sources.
4. **WebSocket protocol** — rewritten from the frame catalog
   enumerated in
   [01-analysis-r2.md](./01-analysis-r2.md#d3--websocket-frame-catalog).
   Two tables: server→client (`session`, `message`, `thinking`,
   `system`, `event`) and client→server (`{type:"message", content}`
   JSON envelope; raw text fallback). Cite
   [src/channels/websocket.ts L17-L37](src/channels/websocket.ts#L17-L37),
   [src/agents/chat.ts L209-L393](src/agents/chat.ts#L209-L393),
   [src/server/server.ts L693](src/server/server.ts#L693). Cross-link
   to [docs/internals/channels.md](docs/internals/channels.md) only as
   "further reading", not as the canonical reference.
5. **Authentication** — new dedicated section. Documents:
   - `SAIVAGE_API_TOKEN` env var
     ([server.ts L70-L78](src/server/server.ts#L70-L78)) enables the
     gate.
   - Three transport options accepted by `extractRequestToken()`
     ([server.ts L759-L766](src/server/server.ts#L759-L766)):
     `Authorization: Bearer <token>`, `x-saivage-token: <token>`, or
     `?token=<token>`.
   - SPA flow: token entered in the unauthorized banner is persisted
     to `localStorage["saivage.apiToken"]`
     ([web/src/utils/api.ts L16-L70](web/src/utils/api.ts#L16-L70))
     and injected automatically into REST + WS calls.
   - WebSocket close codes 1008, 4401, 4403 stop the SPA reconnect
     loop and surface the unauthorized banner
     ([web/src/composables/useWebSocket.ts L71-L84](web/src/composables/useWebSocket.ts#L71-L84)).
   - REST `/api/*` returns HTTP 401 with `{ "error": "unauthorized" }`
     when the token is missing or wrong
     ([server.ts L75-L78](src/server/server.ts#L75-L78)).
   - Public paths that bypass the gate: `/`, `/index.html`,
     `/assets/*`, `/health`, `/docs/*`.
   - "No token set" = no auth; this is the correct posture for an LXC
     deployment on a private bridge. Reverse proxy advice from the old
     paragraph moves into a one-sentence "exposed deployments" caveat.

**Files touched.**

- [docs/guide/web-ui.md](docs/guide/web-ui.md) — full rewrite, ~150 lines.

**Deletion list (architecture-first).**

- The "CORS / Auth" section at
  [docs/guide/web-ui.md L82-L86](docs/guide/web-ui.md#L82-L86) is
  deleted; replaced by the new "Authentication" section. The
  misleading paragraph cannot remain in any form.
- The fabricated WebSocket envelope examples at
  [docs/guide/web-ui.md L66-L80](docs/guide/web-ui.md#L66-L80) are
  deleted; replaced by the real frame tables. Do not keep them as
  "deprecated" — there was never a release in which they were correct.
- The "Stage / Conversation / Events / Notes / Inspections / Providers"
  bullets at [docs/guide/web-ui.md L19-L31](docs/guide/web-ui.md#L19-L31)
  are deleted; the five-tab list replaces them. No migration shim — the
  doc describes the SPA today, not a historical SPA.

**Public API impact.** None. Documentation-only change.

**Test impact.**

- `npm run docs:build` (VitePress) must still succeed after the
  rewrite. It is **not** a dead-link checker:
  [docs/.vitepress/config.ts L8-L12](docs/.vitepress/config.ts#L8-L12)
  sets `ignoreDeadLinks: true`, and the script at
  [package.json L20-L25](package.json#L20-L25) is just
  `npm run docs:api && vitepress build docs`. Treat `docs:build` as a
  smoke test that the Markdown still parses and the typedoc pre-step
  still runs, not as link validation.
- A **manual path-existence check** for every internal markdown link
  introduced in the rewrite, done from the project root, e.g.
  `for p in docs/guide/install-lxc.md docs/internals/channels.md \
   src/server/server.ts src/channels/websocket.ts src/agents/chat.ts \
   web/src/App.vue web/src/components/ChatWindow.vue \
   web/src/components/StatusPanel.vue web/src/components/PlanView.vue \
   web/src/components/AgentsView.vue web/src/components/FilesView.vue \
   web/src/components/DebugView.vue web/src/utils/api.ts \
   web/src/composables/useWebSocket.ts; do test -f "$p" || echo "MISSING $p"; done`.
  The doc lands only when this loop prints nothing.
- A **grep self-check** for stale tab markup. The legacy bullet text
  in [docs/guide/web-ui.md L20-L31](docs/guide/web-ui.md#L20-L31)
  uses the `- **Name**` form, not "Name tab", so the grep must match
  the markup: `grep -nE '^- \*\*(Stage|Conversation|Events|Notes|Inspections|Providers)\*\*' docs/guide/web-ui.md`
  must return zero hits after the rewrite, and a separate
  `grep -nE '"payload":' docs/guide/web-ui.md` must also return zero.
- A one-time eyeball check: bring up the daemon with and without
  `SAIVAGE_API_TOKEN`, walk the five tabs, copy each documented `curl`
  example, and confirm the WS frames table against
  `wscat -c ws://localhost:8080/ws?token=…`. Recorded in the plan as
  the validation step.

**Strengths.**

- Smallest possible diff — one file, no code changes.
- Operator-facing prose stays at the right reading level (no generated
  noise).
- Lands today; unblocks the auth-paragraph regression immediately.

**Weaknesses.**

- The doc rots the moment a new route or WS frame is added — exactly
  how the current state was reached. Round 1's review-2026-05 already
  shows this pattern across `docs/internals/server.md` (G45) and
  `docs/internals/channels.md` (G44).
- Five separate hand-maintained tables (REST, WS-out, WS-in, query
  params, close codes) is more surface than the operator audience
  needs. A new feature like `/api/mcp/tools` will be documented in the
  PR that adds the route, then forgotten by the next PR.

## Design B — Auto-generate the protocol sections from code (recorded as a cross-finding follow-on, NOT part of G40)

**Status.** Not implemented as part of G40. Recorded here so the
round-2 metaplan can pick it up as a separate new finding (working
title: "Auto-generate operator/internal REST + WS reference") **after**
G40, G44, and G45 have all landed as Design-A hand rewrites. At that
point the three rewritten docs become the input fixtures for the
generator and the regression class is closed for good.

**Idea.** Split `docs/guide/web-ui.md` into two layers:

- **Hand-written narrative** — Accessing, Layout, Authentication,
  cross-links. These are operator-prose sections that a generator
  cannot write well.
- **Auto-generated reference** — REST surface and WS frame catalog,
  emitted at `npm run docs:build` time from the actual Fastify route
  registrations in [src/server/server.ts](src/server/server.ts) and
  the `sendEvent` call sites in
  [src/agents/chat.ts](src/agents/chat.ts) /
  [src/channels/websocket.ts](src/channels/websocket.ts).

**New files (when the follow-on finding is implemented, not now).**

- `scripts/docs/extract-rest-routes.ts` — loads
  [src/server/server.ts](src/server/server.ts) under a Fastify stub
  that records `app.get/post/delete/.../websocket` registrations and
  emits a Markdown table to `docs/guide/.generated/rest-routes.md`.
- `scripts/docs/extract-ws-frames.ts` — AST-walks
  [src/agents/chat.ts](src/agents/chat.ts),
  [src/channels/websocket.ts](src/channels/websocket.ts),
  [src/server/server.ts](src/server/server.ts) for
  `sendEvent({ type: "<literal>", ... })` call sites, plus the inbound
  branch in `WebSocketChannel`'s message handler. Emits
  `docs/guide/.generated/ws-frames.md`.
- `docs/guide/.generated/` — generated output checked in so the doc
  builds in fresh checkouts without an extra build step.

**Strengths.**

- Closes the structural regression at the root: every new
  `app.get(...)` or `sendEvent({type:"..."})` is auto-documented or
  the build fails. The same generators are reusable by G44 / G45 if
  those findings want auto-generated internal docs.
- Operator narrative stays hand-written, where prose matters.

**Weaknesses.**

- Two new long-lived scripts and a new CI gate — non-trivial
  maintenance surface.
- AST-based extraction of `sendEvent` literals is brittle to
  refactors that hide the discriminator behind a variable.
- Bigger initial diff and review surface for what is, today, a docs
  fix.

## Recommendation — Design A only for G40

The G40 finding is "the doc lies about auth and lists tabs that do not
exist." That is a one-file regression and a one-file fix. Design A
delivers it now, before the next operator deploys behind a misconfigured
reverse proxy on the strength of the "no authentication" paragraph.

Design B is the right second step for the **family** of doc-drift
findings (G40, G44, G45) but is too much surface area to gate the auth
correction on. The round-2 metaplan should record it as a separate
new cross-finding follow-on (working title: "Auto-generate
operator/internal REST + WS reference") and schedule it after the three
Design-A rewrites complete. G40's plan does not add any generator
script, docs build plugin, or CI gate.

The plan in [03-plan-r2.md](./03-plan-r2.md) implements Design A.
