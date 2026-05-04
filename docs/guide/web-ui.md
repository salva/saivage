# Web Dashboard

The web UI is served by the Saivage daemon when run via `saivage serve`. It
is a Vite-built static bundle (under `web/`) plus a Fastify HTTP +
WebSocket server (`src/server/server.ts`).

## Accessing it

```
http://<host>:8080
```

The host and port are configured in `saivage.json` under `server`. By
default the server binds `0.0.0.0:8080`.

## Layout

The dashboard is divided into panels:

- **Plan**: the active plan (current stage highlighted), with completed
  stages folded into a history view.
- **Stage**: per-stage task list, status, dependencies, and reports.
- **Agents**: list of currently-active agent conversations with live status
  (running, suspended, compacting).
- **Conversation**: full message history for the selected agent
  (with tool calls and tool results).
- **Events**: streaming event bus output (system events, severity-tagged).
- **Notes**: user-note inbox; create / acknowledge / delete.
- **Inspections**: list of inspection reports + on-demand "inspect" action.
- **Files**: read-only browser of the project tree.
- **Providers**: provider/model health and rate-limit status.

State updates push over a WebSocket at `/ws`; the page also issues
classic REST polls for snapshots.

## REST endpoints

The web UI's API surface is also useful for scripting. All paths are
under `/api/`.

| Method | Path | Purpose |
|--------|------|---------|
| `GET`  | `/health` | Liveness check. |
| `GET`  | `/api/config` | Effective merged runtime + project config. |
| `GET`  | `/api/state` | Runtime snapshot — agents, plan, current stage. |
| `GET`  | `/api/plan` | Active plan JSON. |
| `GET`  | `/api/plan/stages/:id` | Stage detail (tasks, summary). |
| `GET`  | `/api/agents/:agentId/conversation` | Full LLM conversation log. |
| `GET`  | `/api/providers` | Provider health, rate limits, registered models. |
| `GET`  | `/api/inspections` | Inspection reports. |
| `GET`  | `/api/notes` | List user notes. |
| `POST` | `/api/notes/:id/acknowledge` | Mark a note acknowledged. |
| `DELETE` | `/api/notes/:id` | Delete a note. |
| `DELETE` | `/api/notes` | Delete all notes. |
| `GET`  | `/api/chats` | List chat sessions. |
| `GET`  | `/api/chats/:sessionId` | Chat session log. |
| `GET`  | `/api/files` | List project files (no `.saivage/tmp/`). |
| `GET`  | `/api/files/content?path=…` | Read a file. |
| `GET`  | `/api/debug/state` | Internal runtime debug snapshot. |
| `GET`  | `/api/debug/errors` | Recent error log. |
| `GET`  | `/api/debug/timeline` | Recent runtime timeline events. |
| `GET`  | `/ws` | WebSocket for live updates and chat. |

## WebSocket protocol

The WebSocket carries a JSON envelope:

```jsonc
// server → client
{ "type": "event",  "payload": { … SystemEvent … } }
{ "type": "state",  "payload": { … RuntimeState … } }
{ "type": "chat",   "payload": { sessionId, message } }

// client → server
{ "type": "chat",   "payload": { sessionId, message } }
{ "type": "note",   "payload": { content, permanent?, urgent? } }
```

See [Channels](/internals/channels) for the implementation.

## CORS / Auth

The daemon does **not** implement authentication. It is expected to live
inside a trusted network or behind a reverse proxy. Inside the LXC
deployment the dashboard is reachable only from the host (NAT bridge); see
[LXC](./install-lxc) for forwarding.
