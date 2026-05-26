# G40 — Plan (r1, Design A)

## Implementation steps

1. **Replace the layout section.** Open
   [docs/guide/web-ui.md](docs/guide/web-ui.md#L19-L31). Delete the
   nine-bullet tab list. Insert a five-bullet list, one entry per tab in
   the order rendered by [web/src/App.vue](web/src/App.vue#L29-L37):

   - **Dashboard** ([web/src/components/StatusPanel.vue](web/src/components/StatusPanel.vue)) — live runtime status, current stage, recent notes.
   - **Plan** ([web/src/components/PlanView.vue](web/src/components/PlanView.vue)) — active plan, per-stage detail, history.
   - **Agents** ([web/src/components/AgentsView.vue](web/src/components/AgentsView.vue)) — running agent roster with conversation drill-down via [src/server/server.ts](src/server/server.ts#L183).
   - **Files** ([web/src/components/FilesView.vue](web/src/components/FilesView.vue)) — read-only browser of `.saivage/` (default) and the project root, served from [src/server/server.ts](src/server/server.ts#L376-L476).
   - **Debug** ([web/src/components/DebugView.vue](web/src/components/DebugView.vue)) — `/api/debug/*` snapshots, MCP tool inventory, provider health.

   Add one closing sentence: "A persistent chat panel
   ([web/src/components/ChatWindow.vue](web/src/components/ChatWindow.vue))
   stays visible on every tab and is the only WebSocket consumer."

   Update the "Layout" heading paragraph at
   [docs/guide/web-ui.md](docs/guide/web-ui.md#L33-L34) to read: "Live
   updates are pushed over `/ws`; every tab also polls its REST endpoint
   on a short interval for snapshots."

2. **Rewrite the REST table.** Replace
   [docs/guide/web-ui.md](docs/guide/web-ui.md#L40-L62) wholesale with
   the table below. Every row's "Source" column points back to the
   registration line in [src/server/server.ts](src/server/server.ts).

   | Method | Path | Purpose | Source |
   |---|---|---|---|
   | `GET` | `/health` | Liveness + project name + runtime status. | [server.ts L127](src/server/server.ts#L127) |
   | `GET` | `/api/config` | Project metadata + resolved planner/chat routing. | [server.ts L201](src/server/server.ts#L201) |
   | `GET` | `/api/state` | `{ state, plan }` snapshot. | [server.ts L173](src/server/server.ts#L173) |
   | `GET` | `/api/plan` | `{ plan, history }`. | [server.ts L142](src/server/server.ts#L142) |
   | `GET` | `/api/plan/stages/:id` | Stage detail: tasks, summary, reports. | [server.ts L150](src/server/server.ts#L150) |
   | `GET` | `/api/agents/:agentId/conversation` | Full LLM conversation snapshot for a running agent (404 if exited). | [server.ts L183](src/server/server.ts#L183) |
   | `GET` | `/api/providers` | Per-provider model list + error if listing failed. | [server.ts L218](src/server/server.ts#L218) |
   | `GET` | `/api/mcp/tools` | Inspector listing of every MCP tool the runtime is aware of. | [server.ts L232](src/server/server.ts#L232) |
   | `GET` | `/api/inspections` | All `inspections/*.json` reports. | [server.ts L238](src/server/server.ts#L238) |
   | `GET` | `/api/notes` | Current user notes. | [server.ts L255](src/server/server.ts#L255) |
   | `POST` | `/api/notes/:noteId/acknowledge` | Mark a note acknowledged. | [server.ts L260](src/server/server.ts#L260) |
   | `DELETE` | `/api/notes/:noteId` | Delete one note. | [server.ts L270](src/server/server.ts#L270) |
   | `DELETE` | `/api/notes` | Delete all notes. | [server.ts L279](src/server/server.ts#L279) |
   | `GET` | `/api/chats` | List persisted chat sessions across channels. | [server.ts L286](src/server/server.ts#L286) |
   | `GET` | `/api/chats/:sessionId` | Full chat log for one session. | [server.ts L325](src/server/server.ts#L325) |
   | `GET` | `/api/files?root=saivage\|project&path=` | Directory listing; `root` defaults to `saivage`. Project root listing hides `node_modules`, `.git`, `.saivage-work`, `dist`, `build`. | [server.ts L376](src/server/server.ts#L376) |
   | `GET` | `/api/files/content?root=&path=` | File contents (UTF-8); truncated at 1 MiB with `truncated: true`. | [server.ts L428](src/server/server.ts#L428) |
   | `GET` | `/api/debug/state` | Raw runtime state, plan, history, project config, saivage.json. | [server.ts L477](src/server/server.ts#L477) |
   | `GET` | `/api/debug/errors` | Aggregated stage/task failures sorted by timestamp. | [server.ts L502](src/server/server.ts#L502) |
   | `GET` | `/api/debug/timeline` | Stage start/complete + task completion events. | [server.ts L598](src/server/server.ts#L598) |
   | `GET` | `/ws` | WebSocket — see next section. | [server.ts L662](src/server/server.ts#L662) |

   Add a one-line caveat under the table: "Static SPA assets are served
   from `/` and VitePress docs from `/docs/`; neither path is part of
   the API surface."

3. **Replace the WebSocket protocol section.** Delete the fabricated
   envelopes at [docs/guide/web-ui.md](docs/guide/web-ui.md#L66-L80) and
   insert two tables.

   Server → client frames (every `sendEvent` call site in `src/`):

   | `type` | Fields | Emitted by |
   |---|---|---|
   | `session` | `sessionId: string` | [src/server/server.ts L693](src/server/server.ts#L693), on socket open. |
   | `message` | `content: string` plus optional source metadata. | [src/agents/chat.ts L389-L393](src/agents/chat.ts#L389-L393); also wrapped by [src/channels/websocket.ts L35-L37](src/channels/websocket.ts#L35-L37) for plain text. |
   | `thinking` | (none) | [src/agents/chat.ts L209-L210](src/agents/chat.ts#L209-L210), at the start of each assistant turn. |
   | `system` / `event` | Pass-through `SystemEvent` payload filtered by the notification filter. | Bus subscription wired in [src/server/server.ts L729-L734](src/server/server.ts#L729-L734); both discriminators are rendered identically by [web/src/components/ChatWindow.vue L111](web/src/components/ChatWindow.vue#L111). |

   Client → server frames (handled by `WebSocketChannel`):

   | Input | Behaviour |
   |---|---|
   | `{ "type": "message", "content": "<text>" }` | `content` is unwrapped and forwarded to the chat agent. Used by [web/src/components/ChatWindow.vue L157](web/src/components/ChatWindow.vue#L157). |
   | Any other JSON | Stringified payload is treated as raw user text. |
   | Any non-JSON text | Treated as raw user text. |

   Handler reference: [src/channels/websocket.ts L17-L28](src/channels/websocket.ts#L17-L28).
   Note explicitly: "There is no `interrupt` frame, no `note` frame, and
   no envelope wrapper. Frames are flat JSON objects."

   Replace the "See [Channels](/internals/channels) for the
   implementation" link with: "Further reading:
   [docs/internals/channels.md](docs/internals/channels.md) (server-side
   implementation)." Do not block on G44 — the link still resolves;
   G44's rewrite will improve the target.

4. **Add the Authentication section (replaces "CORS / Auth").** Delete
   [docs/guide/web-ui.md](docs/guide/web-ui.md#L82-L86) and insert a
   dedicated `## Authentication` section:

   - Opening sentence: "When `SAIVAGE_API_TOKEN` is set in the daemon's
     environment, every `/api/*` request and the `/ws` upgrade must
     carry the same token; missing or wrong tokens return HTTP 401 or
     close the WebSocket with code 1008."
   - Token-transport bullets, sourced from
     [src/server/server.ts L759-L766](src/server/server.ts#L759-L766):
     - `Authorization: Bearer <token>` header (preferred, used by the SPA).
     - `x-saivage-token: <token>` header.
     - `?token=<token>` query parameter (used by the SPA for
       WebSocket connections, which cannot set headers).
   - SPA flow bullets, sourced from
     [web/src/utils/api.ts L16-L115](web/src/utils/api.ts#L16-L115) and
     [web/src/composables/useWebSocket.ts L44-L84](web/src/composables/useWebSocket.ts#L44-L84):
     - Tokens entered in the unauthorized banner are persisted to
       `localStorage["saivage.apiToken"]`.
     - Visiting `http://host:8080/?token=<t>` is the recommended
       first-time onboarding flow; the token is moved to
       `localStorage` and stripped from the URL on first load.
     - `?token=<t>` is automatically appended to the WebSocket URL.
   - Close-code bullets: 1008, 4401, 4403 from the SPA reconnect-loop
     guard at [web/src/composables/useWebSocket.ts L71-L84](web/src/composables/useWebSocket.ts#L71-L84).
   - Public-path bullets: `/`, `/index.html`, `/assets/*`, `/health`,
     `/docs/*` bypass the gate by design (the SPA must load before the
     user can enter a token, and `/health` must stay reachable for
     monitoring).
   - Closing paragraph: "When `SAIVAGE_API_TOKEN` is unset the daemon
     does not authenticate. This is the correct posture for an LXC
     deployment on a private bridge; for any other deployment set the
     env var or terminate TLS + auth at a reverse proxy."

5. **Verify the introductory paragraph** at
   [docs/guide/web-ui.md](docs/guide/web-ui.md#L1-L17). The only change
   is to replace the `(src/server/server.ts)` parenthetical with a
   markdown link: `([src/server/server.ts](src/server/server.ts))`.

6. **Self-check link integrity.** From the project root, run a
   workspace-wide grep for any remaining mention of the deleted tabs
   ("Stage tab", "Conversation tab", "Events tab", "Inspections tab",
   "Providers tab", "Notes tab") and confirm the only hits are now in
   `SPEC/v2/review-2026-05-round2/G40/` (analysis + design + plan
   reference them) and the original finding file. Also grep for
   `"payload":` patterns inside `docs/guide/web-ui.md` to confirm none
   of the fabricated envelopes survived.

## Validation

1. **Link check.** `npm run docs:build` (VitePress) — must succeed. The
   build verifies that every internal `[…](…)` link resolves. Pay
   attention to:
   - `./install-lxc` — exists at `docs/guide/install-lxc.md`. ✓
   - `docs/internals/channels.md` — exists today; subject of G44 but
     present. ✓
   - `src/server/server.ts#Lnnn` etc. — VitePress does not validate
     line anchors against source, but the file paths must resolve
     under the docs base.
2. **Eyeball check.** Start the daemon two ways and walk every claim
   in the rewritten doc:
   - `unset SAIVAGE_API_TOKEN && node dist/cli.js serve .` — confirm
     all five tabs render, REST table calls return 200 with the
     documented shapes, WebSocket frames match the new tables (use
     `wscat -c ws://localhost:8080/ws`).
   - `SAIVAGE_API_TOKEN=test123 node dist/cli.js serve .` — confirm
     `/api/state` returns 401 without the header,
     `/api/state` returns 200 with `Authorization: Bearer test123`,
     `/ws` closes with 1008 when the `?token=` is wrong, and the SPA
     surfaces the unauthorized banner.
3. **Markdown lint.** Run the existing `npm run lint` family; if no
   markdown lint is configured today, none needs to be added (Design A
   stays inside the existing tooling envelope).
4. **No code tests required.** Documentation-only change. The Vitest
   suite is unaffected.

## Rollback

`git checkout -- docs/guide/web-ui.md`. The change is isolated to a
single doc file; no schema, code, or build configuration is touched.
There is no on-disk format or persisted state to migrate back. Operators
on the old doc revision are no worse off than they are today (in fact
they were strictly worse off — the rollback target is the broken doc,
not a working one).

## Cross-finding coordination

- **G41 (App.vue ↔ `/api/state` drift).** No ordering dependency. G40
  documents the actual `/api/state` shape (`{state, plan}` at
  [src/server/server.ts L173-L180](src/server/server.ts#L173-L180));
  G41's fix preserves that shape. Land either order. If G41 changes the
  response shape (e.g. flattens it), G40's REST table row for
  `/api/state` must be re-verified — flag this in the G41 plan, not
  here.
- **G44 (channels.md regression).** G40 lands first. The "Further
  reading" link to `docs/internals/channels.md` resolves today; G44's
  rewrite will keep the same path. G40 explicitly does not depend on
  G44 — the in-place WebSocket section in `web-ui.md` is self-contained
  so the operator does not have to follow the cross-link to understand
  the protocol.
- **G45 (server.md `SaivageRuntime` drift).** Fully independent — G40
  is operator-facing (`docs/guide/`), G45 is internals-facing
  (`docs/internals/`). No coordination needed.
- **Future "Auto-generate REST + WS catalogs" finding (Design B
  follow-on).** After G40, G44, G45 land, the three rewritten docs
  become the fixtures for a single generator pass. Recommend the
  round-2 meta-plan record this as a new finding (G-series, working
  title "Auto-generate operator/internal REST + WS reference") and
  schedule it after the three Design-A rewrites complete.
