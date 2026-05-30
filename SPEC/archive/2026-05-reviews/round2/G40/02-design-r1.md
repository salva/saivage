# G40 — Design (r1)

## Design A — Rewrite the guide in-place

**Idea.** Treat `docs/guide/web-ui.md` as a hand-maintained operator doc
and rewrite it once to match the current code. Five sections: Accessing,
Layout (five tabs), REST endpoints, WebSocket protocol, Authentication.
Keep it short — every paragraph cites the source file it documents so
future readers can verify.

**Replacement content (skeleton).**

1. **Accessing it** — unchanged. `0.0.0.0:8080` default; `saivage.json`
   override. Cite [src/server/server.ts](src/server/server.ts#L54-L57).
2. **Layout** — five bullets, one per tab, each pointing at the
   implementing component:
   - **Dashboard** ([web/src/components/StatusPanel.vue](web/src/components/StatusPanel.vue)) — live control room.
   - **Plan** ([web/src/components/PlanView.vue](web/src/components/PlanView.vue)) — stages and evidence; per-stage detail nested.
   - **Agents** ([web/src/components/AgentsView.vue](web/src/components/AgentsView.vue)) — running agent conversations.
   - **Files** ([web/src/components/FilesView.vue](web/src/components/FilesView.vue)) — `.saivage/` and project-root trees, read-only.
   - **Debug** ([web/src/components/DebugView.vue](web/src/components/DebugView.vue)) — `/api/debug/*` snapshots plus MCP tool inventory.
   Note the persistent chat panel ([web/src/components/ChatWindow.vue](web/src/components/ChatWindow.vue)).
3. **REST endpoints** — table rewritten from
   [src/server/server.ts](src/server/server.ts#L127-L666) registrations.
   Add the missing `GET /api/mcp/tools` row; rename `:id` → `:noteId`;
   document the `?root=saivage|project` and `?path=` query parameters
   on `/api/files` and `/api/files/content`; note the 1 MiB truncation
   cap on `/api/files/content`.
4. **WebSocket protocol** — rewritten from the frame catalog enumerated
   in [01-analysis-r1.md](./01-analysis-r1.md#d3--websocket-frame-catalog).
   Two tables: server→client (`session`, `message`, `thinking`,
   `system`, `event`) and client→server (`{type:"message", content}`
   JSON envelope; raw text fallback). Cite
   [src/channels/websocket.ts](src/channels/websocket.ts#L17-L37),
   [src/agents/chat.ts](src/agents/chat.ts#L209-L393),
   [src/server/server.ts](src/server/server.ts#L693). Cross-link to
   [docs/internals/channels.md](docs/internals/channels.md) only as
   "further reading", not as the canonical reference.
5. **Authentication** — new dedicated section. Documents:
   - `SAIVAGE_API_TOKEN` env var ([server.ts](src/server/server.ts#L70-L78))
     enables the gate.
   - Three transport options accepted by
     `extractRequestToken()` ([server.ts](src/server/server.ts#L759-L766)):
     `Authorization: Bearer <token>`, `x-saivage-token: <token>`, or
     `?token=<token>`.
   - SPA flow: token entered in the unauthorized banner is persisted
     to `localStorage["saivage.apiToken"]`
     ([web/src/utils/api.ts](web/src/utils/api.ts#L16-L70)) and injected
     automatically into REST + WS calls.
   - WebSocket close codes 1008, 4401, 4403 stop the SPA reconnect loop
     and surface the unauthorized banner
     ([web/src/composables/useWebSocket.ts](web/src/composables/useWebSocket.ts#L71-L84)).
   - REST `/api/*` returns HTTP 401 with `{ "error": "unauthorized" }`
     when the token is missing or wrong
     ([server.ts](src/server/server.ts#L75-L78)).
   - Public paths that bypass the gate: `/`, `/index.html`, `/assets/*`,
     `/health`, `/docs/*`.
   - "No token set" = no auth; this is the correct posture for an LXC
     deployment on a private bridge. Reverse proxy advice from the old
     paragraph moves into a one-sentence "exposed deployments" caveat.

**Files touched.**

- [docs/guide/web-ui.md](docs/guide/web-ui.md) — full rewrite, ~150 lines.

**Deletion list (architecture-first).**

- The "CORS / Auth" section at
  [docs/guide/web-ui.md](docs/guide/web-ui.md#L82-L86) is deleted; replaced
  by the new "Authentication" section. The misleading paragraph cannot
  remain in any form.
- The fabricated WebSocket envelope examples at
  [docs/guide/web-ui.md](docs/guide/web-ui.md#L66-L80) are deleted; replaced
  by the real frame tables. Do not keep them as "deprecated" — there was
  never a release in which they were correct.
- The "Stage / Conversation / Events / Notes / Inspections / Providers"
  bullets at [docs/guide/web-ui.md](docs/guide/web-ui.md#L19-L31) are
  deleted; the five-tab list replaces them. No migration shim — the doc
  describes the SPA today, not a historical SPA.

**Public API impact.** None. Documentation-only change.

**Test impact.**

- `npm run docs:build` (VitePress) must pass after the rewrite. The
  build catches dead internal links (`/internals/channels`,
  `./install-lxc`) — we re-validate those paths against the current
  `docs/` tree as part of the rewrite. No new test harness required.
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

## Design B — Auto-generate the protocol sections from code

**Idea.** Split `docs/guide/web-ui.md` into two layers:

- **Hand-written narrative** — Accessing, Layout, Authentication,
  cross-links. These are operator-prose sections that a generator
  cannot write well.
- **Auto-generated reference** — REST surface and WS frame catalog,
  emitted at `npm run docs:build` time from the actual Fastify route
  registrations in [src/server/server.ts](src/server/server.ts) and the
  `sendEvent` call sites in [src/agents/chat.ts](src/agents/chat.ts) /
  [src/channels/websocket.ts](src/channels/websocket.ts).

**New files.**

- `scripts/docs/extract-rest-routes.ts` — loads
  [src/server/server.ts](src/server/server.ts) under a Fastify stub that
  records `app.get/post/delete/.../websocket` registrations and emits a
  Markdown table to `docs/guide/.generated/rest-routes.md`. The stub is
  the smallest possible Fastify-compatible recorder (≈80 lines); it
  does not boot the runtime — it imports `startServer` and replaces
  `Fastify({...})` with a record-only proxy.
- `scripts/docs/extract-ws-frames.ts` — AST-walks
  [src/agents/chat.ts](src/agents/chat.ts),
  [src/channels/websocket.ts](src/channels/websocket.ts),
  [src/server/server.ts](src/server/server.ts) for
  `sendEvent({ type: "<literal>", ... })` call sites, plus the inbound
  branch in `WebSocketChannel`'s message handler. Emits
  `docs/guide/.generated/ws-frames.md` with one row per discriminator
  and a source link.
- `docs/guide/.generated/` — generated output checked in (so the doc
  builds in fresh checkouts without an extra build step) and excluded
  from manual edits via a header comment.

**Touched files.**

- [docs/guide/web-ui.md](docs/guide/web-ui.md) — full rewrite; the REST
  and WebSocket sections become VitePress `<!--@include: ./.generated/…-->`
  blocks.
- [package.json](package.json) — new `docs:gen` script and a
  `docs:build` predependency.
- [docs/.vitepress/config.ts](docs/.vitepress/config.ts) — if needed,
  enable the markdown-include plugin.
- New: `scripts/docs/extract-rest-routes.ts`,
  `scripts/docs/extract-ws-frames.ts`,
  `docs/guide/.generated/rest-routes.md`,
  `docs/guide/.generated/ws-frames.md`.

**Deletion list.**

- Same as Design A for [docs/guide/web-ui.md](docs/guide/web-ui.md):
  drop the old tab list, the fabricated WS envelopes, and the
  "no authentication" paragraph. None of the hand-maintained REST or
  WS prose survives — it is replaced by `<!--@include-->` directives.
- No code deleted from `src/`. Generators are read-only.

**Public API impact.** None.

**Test impact.**

- A new CI step: `npm run docs:gen` regenerates the
  `docs/guide/.generated/*.md` files and `git diff --exit-code
  docs/guide/.generated/` fails the build when they drift from the
  source. This is how a route added without a doc update is caught —
  the PR diff includes the regenerated table or the build fails.
- `npm run docs:build` consumes the same generated files; no separate
  step needed at deploy time.
- Vitest: one test per generator (round-trip a fixture `server.ts`
  through the recorder and assert the emitted markdown).

**Strengths.**

- Closes the structural regression at the root: every new
  `app.get(...)` or `sendEvent({type:"..."})` is auto-documented or
  the build fails. The same generators are reusable by G44 / G45 if
  those findings want auto-generated internal docs.
- Operator narrative stays hand-written, where prose matters.
- The auth section, the only piece that needs prose, is still
  hand-written.

**Weaknesses.**

- Two new long-lived scripts and a new CI gate — non-trivial
  maintenance surface. The Fastify route recorder is the riskiest
  bit: a future migration to a different HTTP framework breaks it.
- AST-based extraction of `sendEvent` literals is brittle to refactors
  that hide the discriminator behind a variable (e.g. `sendEvent({type: kind, ...})`).
  We would need to forbid that pattern via the generator (fail on
  non-literal discriminator), which adds a linting concern outside
  the originally cited code.
- Bigger initial diff and review surface for what is a docs fix.

## Recommendation — Design A

The G40 finding is "the doc lies about auth and lists tabs that do not
exist." That is a one-file regression and a one-file fix. Design A
delivers it now, before the next operator deploys behind a misconfigured
reverse proxy on the strength of the "no authentication" paragraph.

Design B is the right second step for the **family** of doc-drift
findings (G40, G44, G45) but is too much surface area to gate the auth
correction on. It is recorded here so the round-2 meta-plan can pick it
up as a follow-on finding (working title: "Auto-generate REST + WS
catalogs from server.ts") once G40, G44, G45 have all landed as Design-A
rewrites. At that point the three rewritten docs become the input
fixtures for the generator and the regression class is closed for good.

The plan in [03-plan-r1.md](./03-plan-r1.md) implements Design A.
