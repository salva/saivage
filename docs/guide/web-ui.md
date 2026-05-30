# Web Dashboard

The web UI is served by the Saivage daemon when run via `saivage serve`. It
is a Vite-built static bundle (under `web/`) plus a Fastify HTTP +
WebSocket server ([src/server/server.ts](src/server/server.ts)).

## Accessing it

```
http://<host>:8080
```

The host and port are configured in `saivage.json` under `server`. By
default the server binds `0.0.0.0:8080`
([src/server/server.ts L54-L57](src/server/server.ts#L54-L57)).

## Layout

The dashboard is a fixed two-pane shell — a left side rail with the
brand, tab navigation, a Docs link, and a Shortcuts button
([web/src/App.vue L168-L220](web/src/App.vue#L168-L220)), next to a
workspace pane whose header shows the active tab's description, label,
the project path, and a `live` pill
([web/src/App.vue L222-L232](web/src/App.vue#L222-L232)). There is no
footer.

Tabs, in the order rendered by
[web/src/App.vue L29-L37](web/src/App.vue#L29-L37):

- **Dashboard** ([web/src/components/StatusPanel.vue](web/src/components/StatusPanel.vue)) —
  two-column grid combining the chat surface
  ([web/src/components/ChatWindow.vue](web/src/components/ChatWindow.vue),
  the only WebSocket consumer) with the live status panel; mounted at
  [web/src/App.vue L234-L240](web/src/App.vue#L234-L240).
- **Plan** ([web/src/components/PlanView.vue](web/src/components/PlanView.vue)) —
  active plan, per-stage detail, history.
- **Agents** ([web/src/components/AgentsView.vue](web/src/components/AgentsView.vue)) —
  running agent roster with conversation drill-down via
  [src/server/server.ts L183](src/server/server.ts#L183).
- **Files** ([web/src/components/FilesView.vue](web/src/components/FilesView.vue)) —
  read-only browser of `.saivage/` (default) and the project root,
  served from
  [src/server/server.ts L376-L476](src/server/server.ts#L376-L476).
  Also the home of the notes inbox (list, acknowledge, delete) at
  [web/src/components/FilesView.vue L89-L173](web/src/components/FilesView.vue#L89-L173).
- **Debug** ([web/src/components/DebugView.vue](web/src/components/DebugView.vue)) —
  `/api/debug/state`, `/api/debug/errors`, and `/api/debug/timeline`
  snapshots; the only three endpoints fetched by
  [web/src/components/DebugView.vue L23-L60](web/src/components/DebugView.vue#L23-L60).

The chat panel lives only on the Dashboard tab; switching away from
Dashboard hides it (the WebSocket stays connected so streamed events
continue to arrive).

Live updates are pushed over `/ws` and rendered into the Dashboard chat
panel; every tab also polls its REST endpoint on a short interval for
snapshots through `apiFetch()` (see Authentication below).

## REST endpoints

The web UI's API surface is also useful for scripting. All paths are
under `/api/` except `/health` and `/ws`.

| Method | Path | Purpose | Source |
|---|---|---|---|
| `GET` | `/health` | Liveness + project name + runtime status. | [server.ts L127](src/server/server.ts#L127) |
| `GET` | `/api/config` | Project metadata + resolved planner/chat routing. | [server.ts L201](src/server/server.ts#L201) |
| `GET` | `/api/state` | `{ state, plan }` snapshot. | [server.ts L173](src/server/server.ts#L173) |
| `GET` | `/api/plan` | `{ plan, history }`. | [server.ts L142](src/server/server.ts#L142) |
| `GET` | `/api/plan/stages/:id` | Stage detail: tasks, summary, reports. | [server.ts L150](src/server/server.ts#L150) |
| `GET` | `/api/agents/:agentId/conversation` | Full LLM conversation snapshot for a running agent (404 if exited). | [server.ts L183](src/server/server.ts#L183) |
| `GET` | `/api/providers` | Per-provider model list + error if listing failed. Registered scriptable endpoint; no current SPA panel. | [server.ts L218](src/server/server.ts#L218) |
| `GET` | `/api/mcp/tools` | Inspector listing of every MCP tool the runtime is aware of. Registered scriptable endpoint; no current SPA panel. | [server.ts L232](src/server/server.ts#L232) |
| `GET` | `/api/inspections` | All `inspections/*.json` reports. Registered scriptable endpoint; no current SPA panel. | [server.ts L238](src/server/server.ts#L238) |
| `GET` | `/api/notes` | Current user notes (consumed by the Files tab). | [server.ts L255](src/server/server.ts#L255) |
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

Static SPA assets are served from `/` and VitePress docs from `/docs/`;
neither path is part of the API surface.

## WebSocket protocol

Frames are flat JSON objects. There is no `interrupt` frame, no `note`
frame, and no envelope wrapper.

Server → client frames:

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

Handler reference:
[src/channels/websocket.ts L17-L28](src/channels/websocket.ts#L17-L28).

Further reading:
[docs/internals/server/channels.md](../internals/server/channels.md) (server-side
implementation).

## Authentication

When `SAIVAGE_API_TOKEN` is set in the daemon's environment, every
`/api/*` request and the `/ws` upgrade must carry the same token;
missing or wrong tokens return HTTP 401 or close the WebSocket with
code 1008.

Accepted token transports
([src/server/server.ts L759-L766](src/server/server.ts#L759-L766)):

- `Authorization: Bearer <token>` header (preferred, used by the SPA).
- `x-saivage-token: <token>` header.
- `?token=<token>` query parameter (used by the SPA for WebSocket
  connections, which cannot set headers).

SPA flow
([web/src/utils/api.ts L16-L115](web/src/utils/api.ts#L16-L115);
[web/src/composables/useWebSocket.ts L44-L84](web/src/composables/useWebSocket.ts#L44-L84)):

- Tokens entered in the unauthorized banner are persisted to
  `localStorage["saivage.apiToken"]`.
- Visiting `http://host:8080/?token=<t>` is the recommended first-time
  onboarding flow; the token is moved to `localStorage` and stripped
  from the URL on first load.
- `?token=<t>` is automatically appended to the WebSocket URL.

WebSocket close codes that stop the SPA reconnect loop
([web/src/composables/useWebSocket.ts L71-L84](web/src/composables/useWebSocket.ts#L71-L84)):

- `1008` — policy violation (token missing or wrong on `/ws` upgrade).
- `4401` — unauthorized.
- `4403` — forbidden.

Public paths that bypass the gate by design: `/`, `/index.html`,
`/assets/*`, `/health`, `/docs/*`. The SPA must load before the user
can enter a token, and `/health` must stay reachable for monitoring.

When `SAIVAGE_API_TOKEN` is unset the daemon does not authenticate.
This is the correct posture for an LXC deployment on a private bridge;
for any other deployment set the env var or terminate TLS + auth at a
reverse proxy. See [LXC](./install-lxc) for the bridge layout.
