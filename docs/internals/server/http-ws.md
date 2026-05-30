# HTTP / WebSocket Server

[`src/server/server.ts`](https://github.com/salva/saivage/blob/main/src/server/server.ts) ·
[`src/server/bootstrap.ts`](https://github.com/salva/saivage/blob/main/src/server/bootstrap.ts)

The HTTP / WebSocket server exposes the daemon for the web UI, the
Telegram bot, and external automation. It is a Fastify app with the
`@fastify/static` and `@fastify/websocket` plugins.

## Bootstrap

`bootstrap(projectPath?)` is the canonical entry point used by `serve`,
`start`, and tests. In source order it:

1. Resolves the project root (`discoverProject(cwd)`).
2. Loads project config (`loadProject`) and runtime config (`loadConfig`).
3. Builds the `ModelRoutingResolver` and runs `validateModelCoverage`.
4. Constructs the `ModelRouter` and runs `inspectUsageAtStartup`.
5. Constructs the `McpRuntime`, registers built-in services, starts the
   configured MCP servers, and begins monitoring.
6. Constructs the `PlanService` and registers the `plan` in-process MCP
   service.
7. Runs the single-instance guard (`isAnotherInstanceRunning` +
   `acquireRuntimeLock`).
8. Runs `recoverFromCrash`.
9. Cleans stale notes via a one-shot `NoteManager.cleanupStaleNotes`.
10. Constructs the `EventBus` and cleans the stash.
11. Writes the initial `runtime.json`, then builds `RuntimeTracker`,
    `agentRegistry`, and `PlannerControl`.
12. Constructs `SaivageRuntime`, then `NoteService` and
    `RuntimeSupervisor`; starts the supervisor; consumes any pending
    shutdown handoff.

`ChildSpawner` is **not** a field on the runtime: it is built on demand
by `createChildSpawner(runtime)` in
[`src/server/bootstrap.ts`](https://github.com/salva/saivage/blob/main/src/server/bootstrap.ts).

```ts
export interface SaivageRuntime {
  config: SaivageConfig;
  router: ModelRouter;
  routing: ModelRoutingResolver;
  mcpRuntime: McpRuntime;
  eventBus: EventBus;
  planService: PlanService;
  project: ProjectContext;
  tracker: RuntimeTracker;
  plannerControl: PlannerControl;
  /** Dedicated runtime directives injected into the next Planner startup. */
  plannerStartupDirectives: string[];
  /** Live agent instances for conversation inspection. */
  agentRegistry: Map<string, import("../agents/base.js").BaseAgent>;
  /** Background log-only supervisor for stuck-agent detection. */
  supervisor: RuntimeSupervisor | null;
  /** Stop the runtime gracefully. */
  shutdown: () => Promise<void>;
}
```

Authoritative source:
[`src/server/bootstrap.ts`](https://github.com/salva/saivage/blob/main/src/server/bootstrap.ts) —
open the file rather than rely on this block if they ever diverge.

## startServer

```ts
interface ServerOptions {
  port: number;
  host: string;
}

function startServer(
  runtime: SaivageRuntime,
  options?: ServerOptions, // defaults to { port: 8080, host: "0.0.0.0" }
): Promise<{ close: () => Promise<void> }>;
```

The only method on the returned object is `close`; there is no `stop`.
Code that calls `.stop()` will throw a TypeError; defensively
optional-chained `.stop?.()` silently leaks the Fastify socket.

Registers routes, opens the WebSocket endpoint, optionally spawns the
Telegram bot, then begins listening. Inside the server lifecycle the
Planner is spawned in the background and the supervisor loop starts.

## Entry points

Two CLI commands drive the runtime, and they do not share a teardown
path:

- `serve` ([`src/server/cli.ts`](https://github.com/salva/saivage/blob/main/src/server/cli.ts)) —
  long-running; calls `startServer(runtime)` and
  `runPlannerWithRecovery(runtime)`.
- `start` ([`src/server/cli.ts`](https://github.com/salva/saivage/blob/main/src/server/cli.ts)) —
  one-shot; calls `runPlanner(runtime)`. No HTTP, no Telegram.

## Routes

See [Web Dashboard](/guide/web-ui) for the full REST/WS surface. All
routes live in `server.ts` for simplicity; cross-cutting concerns (CORS,
auth) are deferred to the deployment.

## Static assets

The web UI's built artifacts (`web/dist/`) are served from `/`. In
development you can run the Vite dev server separately and proxy `/api`
to the Fastify server.

## Graceful shutdown

`serve` wraps `runtime.shutdown()` with Fastify and Telegram teardown;
`start` and `inspect` do not.

### CLI-driven teardown (`serve`)

Sourced from
[`src/server/cli.ts`](https://github.com/salva/saivage/blob/main/src/server/cli.ts):

1. `telegramBot?.stop()` — if Telegram is configured.
2. `runtime.plannerControl.requestRestart("shutdown", "system")` —
   tells the planner to wind down cooperatively.
3. Wait up to `PLANNER_SHUTDOWN_TIMEOUT_MS` (30 s) for the planner
   promise.
4. `server.close()` — the `close` returned by `startServer`; drains
   in-flight HTTP and WS via Fastify.
5. `runtime.shutdown()`.

Re-entrant SIGINT is handled by a `shuttingDown` flag; a second Ctrl+C
forces exit.

### `runtime.shutdown()`

Sourced from
[`src/server/bootstrap.ts`](https://github.com/salva/saivage/blob/main/src/server/bootstrap.ts):

1. `tracker.freeze("shutdown")` — stops late agent-activity callbacks
   racing the final state write.
2. `writeShutdownSummary(project)` — best-effort.
3. `supervisor?.stop()`.
4. `mcpRuntime.shutdown()` — stops external MCP services.
5. `eventBus.clear()`.
6. `writeRuntimeState(..., { status: "idle" })` — the persisted on-disk
   status. See [abort-recovery](./abort-recovery) for the full
   runtime-state schema.
7. `runtimeLock.release()`.

`start` and `inspect` invoke `runtime.shutdown()` directly with no
Fastify / Telegram steps — that wrapping is owned only by `serve`.

`SIGINT` / `SIGTERM` triggers shutdown; the `request-shutdown` flow
[hands off](./supervisor#shutdown-handoff) a structured reason for the
next session.
