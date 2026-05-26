# G45 — Analysis r2

Round: 2 (writer: Claude Opus 4.7).
Inputs: [SPEC/v2/review-2026-05-round2/G45-internals-server-runtime-shape-drift.md](../G45-internals-server-runtime-shape-drift.md), [SPEC/v2/review-2026-05-round2/00-SUBSYSTEM-MAP.md](../00-SUBSYSTEM-MAP.md), [docs/internals/server.md](../../../../docs/internals/server.md), [src/server/bootstrap.ts](../../../../src/server/bootstrap.ts), [src/server/server.ts](../../../../src/server/server.ts), [src/server/cli.ts](../../../../src/server/cli.ts).
Prior round: [01-analysis-r1.md](./01-analysis-r1.md), [04-review-r1.md](./04-review-r1.md).

## Round-2 deltas vs r1

- Fixed the "silent no-op" misstatement (finding 2 of review r1). Against the real return shape, copy-pasted teardown code paths produce either a TypeError (`await server.stop()` against `{ close }`) or, with optional chaining, an unconditional no-op. Either way the Fastify socket stays open; the difference is whether the daemon crashes loudly or hangs silently. Both are wrong, but the precise mechanism is undefined-method dispatch, not a defined-but-empty `stop`.
- Refreshed source anchors against the current checkout (finding 3 of review r1): `SaivageRuntime` at [src/server/bootstrap.ts](../../../../src/server/bootstrap.ts#L47-L66); `runtime.shutdown` closure at [src/server/bootstrap.ts](../../../../src/server/bootstrap.ts#L229-L245); `createChildSpawner` at [src/server/bootstrap.ts](../../../../src/server/bootstrap.ts#L281-L287); `startServer` return at [src/server/server.ts](../../../../src/server/server.ts#L723-L727); `ServerOptions` at [src/server/server.ts](../../../../src/server/server.ts#L47-L50); `startServer` signature at [src/server/server.ts](../../../../src/server/server.ts#L52-L55).
- All other ground-truth claims from r1 remain correct after re-verification; review r1 did not dispute them.

## 1. Restating the issue

[docs/internals/server.md](../../../../docs/internals/server.md) is the entry point an engineer reads before touching the bootstrap / Fastify server / CLI shutdown plumbing. Three TS/prose blocks in that file describe code that does not exist:

1. A fenced `interface SaivageRuntime { … }` block at [docs/internals/server.md](../../../../docs/internals/server.md#L26-L36) that lists fields `project`, `config`, `bus`, `router`, `mcp`, `spawn`, `abort()`, `shutdown()`.
2. A `startServer` signature at [docs/internals/server.md](../../../../docs/internals/server.md#L42-L50) that returns `{ stop(): Promise<void> }`.
3. A "Graceful shutdown" five-step ordered list at [docs/internals/server.md](../../../../docs/internals/server.md#L72-L79) attributed to `runtime.shutdown()`.

## 2. Verified ground truth

### 2.1 The actual `SaivageRuntime`

Declared at [src/server/bootstrap.ts](../../../../src/server/bootstrap.ts#L47-L66):

- `config: SaivageConfig`
- `router: ModelRouter`
- `routing: ModelRoutingResolver`
- `mcpRuntime: McpRuntime`
- `eventBus: EventBus`
- `planService: PlanService`
- `project: ProjectContext`
- `tracker: RuntimeTracker`
- `plannerControl: PlannerControl`
- `plannerStartupDirectives: string[]`
- `agentRegistry: Map<string, BaseAgent>`
- `supervisor: RuntimeSupervisor | null`
- `shutdown: () => Promise<void>`

Field-by-field delta against the doc block:

| Doc claims | Reality | Status |
|---|---|---|
| `project` | `project` | matches |
| `config` | `config` | matches |
| `bus` | `eventBus` | renamed |
| `router` | `router` | matches |
| `mcp` | `mcpRuntime` | renamed |
| `spawn: ChildSpawner` | not a field; `createChildSpawner(runtime)` is a free function at [src/server/bootstrap.ts](../../../../src/server/bootstrap.ts#L281-L287) | removed |
| `abort(reason)` | does not exist on the runtime | fiction |
| `shutdown()` | `shutdown` | matches |
| — | `routing`, `planService`, `tracker`, `plannerControl`, `plannerStartupDirectives`, `agentRegistry`, `supervisor` | undocumented |

The doc therefore mislabels three fields, invents one method (`abort`), invents one closure field (`spawn`), and omits seven fields that exist.

### 2.2 The actual `startServer` return type

[src/server/server.ts](../../../../src/server/server.ts#L52-L55) declares:

```
export async function startServer(
  runtime: SaivageRuntime,
  options: ServerOptions = { port: 8080, host: "0.0.0.0" },
): Promise<{ close: () => Promise<void> }>
```

The returned object is built at [src/server/server.ts](../../../../src/server/server.ts#L723-L727):

```
return {
  close: async () => {
    await app.close();
    log.info("[server] Server closed");
  },
};
```

The doc's `stop()` method does not exist on this object. Failure modes for code copied from the doc:

- `await server.stop()` against the real return — TypeError: `server.stop is not a function`. The daemon crashes during teardown; the Fastify socket is left open until the process exits.
- `await server.stop?.()` (optional-chained, the common defensive pattern) — silent no-op. Fastify is never drained; in-flight HTTP / WS requests are dropped abruptly and the listening socket leaks until the process exits.

The r1 analysis described only the second mode as "silently does nothing"; the first mode is the more likely real-world outcome and is louder, not quieter. Both are wrong.

`ServerOptions` is `{ port: number; host: string }` ([src/server/server.ts](../../../../src/server/server.ts#L47-L50)). The parameter on `startServer` has a default value, so callers may omit it — TypeDoc renders it as optional. The corrected doc must therefore show `options?: ServerOptions` (with the default annotated), not `options: ServerOptions`.

### 2.3 The actual shutdown lifecycle

`runtime.shutdown` (the closure built inside `bootstrap`) does, in order, at [src/server/bootstrap.ts](../../../../src/server/bootstrap.ts#L229-L245):

1. `tracker.freeze("shutdown")`.
2. `writeShutdownSummary(project)` (best-effort; failures logged).
3. `supervisor?.stop()`.
4. `mcpRuntime.shutdown()`.
5. `eventBus.clear()`.
6. `writeRuntimeState(paths.runtimeState, { … status: "idle" })`.
7. `runtimeLock.release()`.

The final on-disk status is `"idle"`, not `"stopped"` as the doc claims (the `RuntimeStateSchema` does not currently use a `stopped` literal). The Fastify server is not closed here; the Telegram bot is not stopped here.

The five-step list the doc attributes to `runtime.shutdown()` is actually orchestrated by the `serve` command's `shutdown` closure starting around [src/server/cli.ts](../../../../src/server/cli.ts#L351-L386). The CLI sequence is:

1. `telegramBot?.stop()` ([src/server/cli.ts](../../../../src/server/cli.ts#L365)).
2. `runtime.plannerControl.requestRestart("shutdown", "system")` to signal the planner ([src/server/cli.ts](../../../../src/server/cli.ts#L371)).
3. Wait up to `PLANNER_SHUTDOWN_TIMEOUT_MS` (30 s, [src/server/cli.ts](../../../../src/server/cli.ts#L7)) for the planner promise to settle ([src/server/cli.ts](../../../../src/server/cli.ts#L375)).
4. `server.close()` (Fastify drain via `{ close }` returned by `startServer`) ([src/server/cli.ts](../../../../src/server/cli.ts#L377)).
5. `runtime.shutdown()` ([src/server/cli.ts](../../../../src/server/cli.ts#L380)).

The `start` subcommand has its own much narrower teardown — a single `await runtime?.shutdown()` in a `finally` block, with no Fastify server and no Telegram bot in that path. The `inspect` subcommand at [src/server/cli.ts](../../../../src/server/cli.ts#L262) also calls `runtime.shutdown()` directly.

### 2.4 Ownership of the five steps the doc lists

| Doc step | Real owner | Real file |
|---|---|---|
| Stop the supervisor loop | runtime closure | [src/server/bootstrap.ts](../../../../src/server/bootstrap.ts#L237) |
| Close the Fastify server | CLI (`serve` only) | [src/server/cli.ts](../../../../src/server/cli.ts#L377) |
| Stop the Telegram bot | CLI (`serve` only) | [src/server/cli.ts](../../../../src/server/cli.ts#L365) |
| Stop the MCP runtime | runtime closure | [src/server/bootstrap.ts](../../../../src/server/bootstrap.ts#L238) |
| Persist runtime state | runtime closure (writes `idle`, not `stopped`) | [src/server/bootstrap.ts](../../../../src/server/bootstrap.ts#L241-L243) |

The doc gets every layer-assignment wrong except (accidentally) supervisor stop and MCP shutdown — and even those are buried inside the bigger lie that the *runtime* drives the whole sequence.

## 3. Why it matters

`docs/internals/server.md` is the first hit for any operator searching the docs for `SaivageRuntime`, `startServer`, or "graceful shutdown". The harms are:

- Reading the interface block sends maintainers to grep for `runtime.bus` / `runtime.mcp` / `runtime.spawn`, finding nothing, and second-guessing the source.
- A copy-pasted `server.stop()` against the real return value either throws a TypeError or, when defensively optional-chained, silently no-ops; in both cases the Fastify socket leaks.
- The shutdown checklist points at the wrong layer for every "who owns this step?" question — the exact question someone reads this doc to answer.

## 4. Recurrence pattern

This is the third documentation-drift finding this round (G40 [docs/guide/web-ui.md](../../../../docs/guide/web-ui.md), G44 [docs/internals/channels.md](../../../../docs/internals/channels.md), G45 here). All three follow the same pattern: a fenced TS interface block hand-copied into markdown, then drifted from `src/`. Whatever fix lands for G45 should explicitly choose whether (a) the duplication itself is the bug — the structural diagnosis — or (b) only the current contents are wrong, and the duplication should be tolerated under a tighter lint discipline. The design round picks between those two framings.

## 5. Out of scope for this finding

- The cross-link `[hands off](./supervisor#shutdown-handoff)` at [docs/internals/server.md](../../../../docs/internals/server.md#L77-L78) resolves to a real anchor in [docs/internals/supervisor.md](../../../../docs/internals/supervisor.md); no fix needed.
- The "Static assets" and "Routes" sections at [docs/internals/server.md](../../../../docs/internals/server.md#L55-L68) are still factually correct; no edit needed.
- The CLI flag table / login flows are owned by [docs/guide/config-runtime.md](../../../../docs/guide/config-runtime.md) and are not part of G45.

## 6. Cross-links

- G40 — [docs/guide/web-ui.md](../../../../docs/guide/web-ui.md) user-facing drift.
- G44 — [docs/internals/channels.md](../../../../docs/internals/channels.md) regression of F35.
- G42 (if open) — "level-up" tooling proposal for auto-rendering TS interfaces into markdown; the recurrence pattern above is the strongest argument for it landing in this round.
