# G45 — `docs/internals/server.md` `SaivageRuntime` interface and shutdown flow are fictional

- **Subsystem**: docs (`docs/internals/server.md`)
- **Category**: documentation drift
- **Severity**: medium

## Summary

The internals doc for the HTTP/WS server publishes an interface block claiming
`SaivageRuntime` exposes `{ project, config, bus, router, mcp, spawn, abort(),
shutdown() }`, and that `startServer(runtime)` returns `{ stop(): Promise<void> }`.
Neither is true. The real `SaivageRuntime` shape uses different field names
(`eventBus`, `mcpRuntime`, `agentRegistry`, `plannerControl`, `routing`,
`tracker`, `planService`, …), there is no `spawn` closure, and `startServer`
returns an object whose teardown method is `close()`. The "Graceful shutdown"
section then attributes a five-step teardown to `runtime.shutdown()` that is
actually orchestrated *by the CLI*, not by the runtime, and in a different
order.

## Evidence

Doc — `SaivageRuntime` interface block:

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

[docs/internals/server.md](docs/internals/server.md#L26-L36)

Doc — `startServer` signature:

```ts
function startServer(
  runtime: SaivageRuntime,
  options?: ServerOptions,
): Promise<{ stop(): Promise<void> }>;
```

[docs/internals/server.md](docs/internals/server.md#L42-L50)

Doc — "Graceful shutdown" lifecycle attributed to `runtime.shutdown()`:

```
`runtime.shutdown()` calls, in order:

1. Stop the supervisor loop.
2. Close the Fastify server (drain in-flight HTTP and WS).
3. Stop the Telegram bot if running.
4. Stop the MCP runtime (kills external services).
5. Persist the runtime state file as `status: "stopped"`.
```

[docs/internals/server.md](docs/internals/server.md#L72-L79)

Reality (`bootstrap` and `startServer`):

- `SaivageRuntime` fields: see the construction site in
  [src/server/bootstrap.ts](src/server/bootstrap.ts) — `eventBus`, `mcpRuntime`,
  `agentRegistry`, `plannerControl`, `routing`, `tracker`, `planService`,
  `noteManager`, plus the `shutdown` callable.
- `startServer` returns `{ close(): Promise<void> }`, not `{ stop(): … }` — see
  [src/server/server.ts](src/server/server.ts#L730-L766).
- The five teardown steps the doc attributes to `runtime.shutdown()` are
  performed by the `serve` and `start` CLI commands; see
  [src/server/cli.ts](src/server/cli.ts#L210-L320). The real
  `runtime.shutdown()` is much narrower and the *ordering* (telegram bot stop
  before HTTP close, planner restart request between, supervisor loop is not
  a separate stop step) differs.

## Why this matters

`docs/internals/server.md` is the entry point any maintainer reads before
touching `bootstrap.ts`, `server.ts`, or the CLI shutdown plumbing. The
fictional interface block sends them grepping for `runtime.bus`,
`runtime.mcp`, `runtime.spawn` (all of which are `undefined`); the
`startServer` return-type lie means a copy-pasted teardown will call
`.stop()` on an object that only has `.close()` and silently no-op; and the
"in this order" shutdown checklist is wrong about which layer owns each step,
which is exactly the kind of question someone reads this doc to answer.

## Rough remediation direction

Replace both fenced TS blocks with the real interface (copy from
`bootstrap.ts`) and the real `startServer` signature. Rewrite the "Graceful
shutdown" section to describe the *actual* CLI-driven teardown (telegram bot
stop → planner restart request → HTTP server close → runtime shutdown which
in turn stops MCP and persists `status: "stopped"`), and explicitly note that
the runtime owns MCP + state persistence while the CLI owns everything above
it.

**Level up**: same as G40, G44 — auto-render the `SaivageRuntime` interface
into the doc from `bootstrap.ts` at docs build time, and lint
`docs/internals/*.md` against TS symbols. Manual sync of TS interface blocks
in markdown has now failed three times in the same review.

## Cross-links

- G40 — `docs/guide/web-ui.md` user-facing drift.
- G44 — `docs/internals/channels.md` regression of F35.
