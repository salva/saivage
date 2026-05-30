# Web Dashboard Internals

[`web/`](https://github.com/salva/saivage/tree/main/web)

The dashboard is a small Vue 3 + Vite single-page application. It is
served as static assets by the daemon; all runtime data flows through
the REST endpoints + WebSocket described in [Web Dashboard](/guide/web-ui).

## Stack

- Vue 3 (composition API, `<script setup>`).
- Vite for build & dev server.
- `lucide-vue-next` for icons.
- Plain CSS pipeline under `web/src/styles/` (entry: `index.css`, layers: `tokens`, `semantic`, `base`, `patterns`); no UI framework.

## Component map

| File | Purpose |
|------|---------|
| `App.vue` | Top-level layout, panel switcher. |
| `components/PlanView.vue` | Active plan + history visualization. |
| `components/agents/AgentsView.vue` | Live agent list and conversation viewer. |
| `components/ChatWindow.vue` | WebSocket chat against the Chat agent. |
| `components/StatusPanel.vue` | Daemon status header. |
| `components/FilesView.vue` | Read-only project file browser. |
| `components/DebugView.vue` | `/api/debug/*` outputs for diagnosis. |
| `components/JsonHighlight.vue` | Pretty JSON printer. |
| `components/FormattedContent.vue` | Markdown / code block renderer. |

## State management

The app holds shell state in `App.vue` and local feature state in Vue
composables. `composables/useWebSocket.ts` owns the WebSocket connection,
schema parser, auth-aware reconnect path, and bounded backoff. Additional
composables (`useAuthState`, `useAgentRoster`, `useAgentConversation`, and
`useChatSessions`) keep feature state local. There is no Pinia or Vuex — the
surface is still small enough.

## Build

```bash
npm run build:web        # one-shot
npm --prefix web run dev # dev server with HMR
```

In dev, configure Vite's `proxy` to forward `/api` and `/ws` to the
daemon (the Saivage repo's `web/vite.config.ts` already does this for
`localhost:8080`).

## Output

`vite build` writes to `web/dist/`. The Fastify server serves this
directory at `/`. Saivage's outer `npm run build` calls `npm run build:web`
before bundling the server with tsup.

## Customizing

- Branding: edit `App.vue` header and `index.html`.
- Theming: `web/src/styles/tokens.css` defines the raw design tokens; `web/src/styles/semantic.css` maps them to semantic roles.
- New panel: add a Vue component, register it in `App.vue`'s panel
  switcher, and wire any new REST/WS calls through `useWebSocket.ts`.

## Known constraints

- Optional token authentication is supported when the daemon sets
  `SAIVAGE_API_TOKEN`; `utils/api.ts` injects bearer tokens into REST calls and
  appends `?token=` for WebSocket connections.
- No SSR. The bundle is purely client-side; the HTML shell is static.
- WebSocket reconnect is bounded backoff (1 s → 30 s, factor 1.7, with jitter)
  without state resync. Auth-policy close codes stop reconnecting until a new
  token is supplied.
