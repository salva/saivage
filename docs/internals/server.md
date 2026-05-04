# HTTP / WebSocket Server

[`src/server/server.ts`](https://github.com/salva/saivage/blob/main/src/server/server.ts) ·
[`src/server/bootstrap.ts`](https://github.com/salva/saivage/blob/main/src/server/bootstrap.ts)

The HTTP / WebSocket server exposes the daemon for the web UI, the
Telegram bot, and external automation. It is a Fastify app with the
`@fastify/static` and `@fastify/websocket` plugins.

## Bootstrap

`bootstrap(projectPath?)` is the canonical entry point used by `serve`,
`start`, and tests. It:

1. Resolves the project root (explicit arg or `discoverProject(cwd)`).
2. Loads project config (`loadProject`) and runtime config (`loadConfig`).
3. Constructs:
   - `EventBus`
   - `ModelRouter` (registers providers).
   - `McpRuntime` (registers in-process services + spawns external).
   - `NoteManager`, `Recovery`, `Supervisor`.
   - `ChildSpawner` — the closure used by the Dispatcher to instantiate
     child agents.
4. Returns a `SaivageRuntime` with everything wired up.

```ts
interface SaivageRuntime {
  project: ProjectContext;
  config: SaivageConfig;
  bus: EventBus;
  router: ModelRouter;
  mcp: McpRuntime;
  spawn: ChildSpawner;
  abort(reason: string): Promise<void>;
  shutdown(): Promise<void>;
}
```

The CLI commands `start` and `serve` differ only in whether they call
`runPlanner(runtime)` (one-shot) or `startServer(runtime)` (long-running).

## startServer

```ts
function startServer(
  runtime: SaivageRuntime,
  options?: ServerOptions,
): Promise<{ stop(): Promise<void> }>;
```

Registers routes, opens the WebSocket endpoint, optionally spawns the
Telegram bot, then begins listening. Inside the server lifecycle the
Planner is spawned in the background and the supervisor loop starts.

## Routes

See [Web Dashboard](/guide/web-ui) for the full REST/WS surface. All
routes live in `server.ts` for simplicity; cross-cutting concerns (CORS,
auth) are deferred to the deployment.

## Static assets

The web UI's built artifacts (`web/dist/`) are served from `/`. In
development you can run the Vite dev server separately and proxy `/api`
to the Fastify server.

## Graceful shutdown

`runtime.shutdown()` calls, in order:

1. Stop the supervisor loop.
2. Close the Fastify server (drain in-flight HTTP and WS).
3. Stop the Telegram bot if running.
4. Stop the MCP runtime (kills external services).
5. Persist the runtime state file as `status: "stopped"`.

`SIGINT` / `SIGTERM` triggers shutdown; the `request-shutdown` flow
[hands off](./supervisor#shutdown-handoff) a structured reason for the
next session.
