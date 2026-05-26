# G45 — Implementation plan r1

Round: 1 (writer: Claude Opus 4.7).
Approach: Proposal A from [02-design-r1.md](./02-design-r1.md) (manual rewrite, no shims).

## Scope

Single file edit: [docs/internals/server.md](../../../../docs/internals/server.md). No source code changes. No new files. No tests added — this is a documentation finding.

## Pre-work

1. Re-read the real source one last time so the rewrite quotes it verbatim:
   - `SaivageRuntime` declaration at [src/server/bootstrap.ts](../../../../src/server/bootstrap.ts#L48-L67).
   - `bootstrap` body for the "constructs" bullet list at [src/server/bootstrap.ts](../../../../src/server/bootstrap.ts#L107-L256).
   - `startServer` signature and return shape at [src/server/server.ts](../../../../src/server/server.ts#L47-L55) and [src/server/server.ts](../../../../src/server/server.ts#L760-L765).
   - `runtime.shutdown` closure body at [src/server/bootstrap.ts](../../../../src/server/bootstrap.ts#L218-L237).
   - `serve` shutdown closure at [src/server/cli.ts](../../../../src/server/cli.ts#L353-L386) and `PLANNER_SHUTDOWN_TIMEOUT_MS` at [src/server/cli.ts](../../../../src/server/cli.ts#L7).
   - `start` finally-block teardown at [src/server/cli.ts](../../../../src/server/cli.ts#L96-L98).
   - `RuntimeState.status` values in [src/types.ts](../../../../src/types.ts) — confirm `"stopped"` is *not* a legal value before writing that sentence into the doc.
2. Grep for cross-references that must stay consistent:
   - `rg -n "runtime\\.shutdown|startServer|SaivageRuntime|\\\"stopped\\\"" docs/`
   - Reconcile any other doc that still says `runtime.bus`, `runtime.mcp`, or `runtime.spawn`.

## Step-by-step edit

All steps target [docs/internals/server.md](../../../../docs/internals/server.md).

### Step 1 — "Bootstrap" bullet list

Replace the existing `bootstrap(projectPath?)` ordered list ([docs/internals/server.md](../../../../docs/internals/server.md#L13-L24)) with the actual construction order from [src/server/bootstrap.ts](../../../../src/server/bootstrap.ts#L107-L256). New bullets in source order:

1. Resolve project root (`discoverProject(cwd)`).
2. Load project config (`loadProject`) and runtime config (`loadConfig`).
3. Build `ModelRoutingResolver` and run `validateModelCoverage`.
4. Construct `ModelRouter`, run `inspectUsageAtStartup`.
5. Construct `McpRuntime`, register built-in services, start configured MCP servers, begin monitoring.
6. Construct `PlanService`, register the `plan` in-process MCP service.
7. Single-instance guard (`isAnotherInstanceRunning` + `acquireRuntimeLock`).
8. `recoverFromCrash`.
9. Clean stale notes (one-shot `NoteManager.cleanupStaleNotes`).
10. Construct `EventBus`; clean stash.
11. Write initial `runtime.json`; build `RuntimeTracker`, `agentRegistry`, `PlannerControl`.
12. Construct `SaivageRuntime`, then `NoteService` + `RuntimeSupervisor`; start supervisor; consume any pending shutdown handoff.

Drop the `ChildSpawner` bullet — it is built on demand by `createChildSpawner(runtime)` at [src/server/bootstrap.ts](../../../../src/server/bootstrap.ts#L256-L262), not stored on the runtime.

### Step 2 — Replace the `SaivageRuntime` interface block

Delete the block at [docs/internals/server.md](../../../../docs/internals/server.md#L26-L36) and replace with a fenced `ts` block copied from [src/server/bootstrap.ts](../../../../src/server/bootstrap.ts#L48-L67), preserving:

- `config`, `router`, `routing`, `mcpRuntime`, `eventBus`, `planService`, `project`, `tracker`, `plannerControl`, `plannerStartupDirectives`, `agentRegistry`, `supervisor`, `shutdown` (in source order).
- The two JSDoc comments on `plannerStartupDirectives`, `agentRegistry`, `supervisor`, and `shutdown` may be summarised down to one short line each, but field names must match exactly.

Append a sentence: "Authoritative source: [src/server/bootstrap.ts](../../../../src/server/bootstrap.ts#L48-L67) — open the file rather than rely on this block if they ever diverge."

### Step 3 — Replace the `startServer` signature block

Delete the block at [docs/internals/server.md](../../../../docs/internals/server.md#L42-L50) and replace with:

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

One-line prose under it: "The only method on the returned object is `close`; there is no `stop`."

### Step 4 — Add the entry-point distinction

Add a short paragraph between the `startServer` section and "Routes" naming the two CLI commands and what each calls:

- `serve` ([src/server/cli.ts](../../../../src/server/cli.ts#L304-L309)) — long-running; calls `startServer(runtime)` and `runPlannerWithRecovery(runtime)`.
- `start` ([src/server/cli.ts](../../../../src/server/cli.ts#L60-L98)) — one-shot; calls `runPlanner(runtime)`. No HTTP, no Telegram.

This removes the doc’s current conflation of the two paths.

### Step 5 — Rewrite "Graceful shutdown" into two subsections

Delete the existing five-step list at [docs/internals/server.md](../../../../docs/internals/server.md#L70-L80) and replace with the two subsections below.

#### 5.1 "CLI-driven teardown (`serve`)"

Ordered list, sourced from [src/server/cli.ts](../../../../src/server/cli.ts#L353-L386):

1. `telegramBot?.stop()` (if Telegram is configured).
2. `runtime.plannerControl.requestRestart("shutdown", "system")` — tells the planner to wind down cooperatively.
3. Wait up to `PLANNER_SHUTDOWN_TIMEOUT_MS` (30 s, [src/server/cli.ts](../../../../src/server/cli.ts#L7)) for the planner promise.
4. `server.close()` — the `close` returned by `startServer`; drains in-flight HTTP and WS via Fastify.
5. `runtime.shutdown()`.

One line of prose noting re-entrant SIGINT handling (`shuttingDown` flag, second Ctrl+C forces exit) at [src/server/cli.ts](../../../../src/server/cli.ts#L350-L365).

#### 5.2 "`runtime.shutdown()`"

Ordered list, sourced from [src/server/bootstrap.ts](../../../../src/server/bootstrap.ts#L218-L237):

1. `tracker.freeze("shutdown")` — stops late agent-activity callbacks racing the final state write.
2. `writeShutdownSummary(project)` — best-effort.
3. `supervisor?.stop()`.
4. `mcpRuntime.shutdown()` — stops external MCP services.
5. `eventBus.clear()`.
6. `writeRuntimeState(..., { status: "idle" })` — note the value: `"idle"`, not `"stopped"`.
7. `runtimeLock.release()`.

Append a one-line callout: "`start` and `inspect` invoke `runtime.shutdown()` directly with no Fastify / Telegram steps — that wrapping is owned only by `serve`."

### Step 6 — Fix the trailing prose

The current closing paragraph at [docs/internals/server.md](../../../../docs/internals/server.md#L77-L80) is fine as-is (the `request-shutdown` flow exists at [src/runtime/shutdown-handoff.ts](../../../../src/runtime/shutdown-handoff.ts) and the anchor `./supervisor#shutdown-handoff` resolves). Leave it.

### Step 7 — Final grep

Run:

```
rg -n "runtime\\.bus|runtime\\.mcp|runtime\\.spawn|runtime\\.abort|\\{\\s*stop\\(\\)|status: \\\"stopped\\\"" docs/internals/server.md
```

Must return zero matches before the PR is opened.

## Validation

1. `npm run docs:build` from `saivage/` — must pass.
2. Open the built page in `docs/.vitepress/dist/internals/server.html`; eyeball the three rewritten sections in a browser.
3. Cross-check linked anchors: the anchors `./supervisor#shutdown-handoff`, `/guide/web-ui`, and any new in-file anchors render and resolve.
4. Confirm no other internals doc still claims `{ stop(): … }` or `runtime.bus` — fix in the same PR if found; otherwise nothing else changes.
5. Spot-check `docs/guide/`: there is no mirror of the runtime interface there, but if grep finds one, file a follow-up (do not silently expand the G45 PR).

## Out of scope but worth recording

- Auto-rendering the TS interface (Proposal B in the design): track as a level-up under the metaplan, not inside this PR.
- Adding a CI step that diffs `SaivageRuntime` against the doc: contingent on Proposal B; do not add it here.
- Renaming any of `eventBus` / `mcpRuntime` / `routing` to match the original "doc-friendly" short names. Source is the source of truth; the doc must match the code, not the other way around.

## Risks

- A reviewer may reasonably push back that landing Proposal A leaves G40 / G44 / G45 all looking near-identical, and that they should be solved together by Proposal B. The plan for that contingency: collapse the three findings into a single batched implementation plan under the round-2 metaplan and execute Proposal B once for all three. The text edits enumerated above remain the required content delta regardless of which mechanism delivers them.
- Step 5.2 lists `tracker.freeze("shutdown")` as step 1, which is correct against the current `bootstrap.ts`. If a future PR reorders these calls, the doc drifts again. The only structural mitigation is Proposal B; until then, the closing "Authoritative source" line is the best we have.

## Estimated diff size

Net change in [docs/internals/server.md](../../../../docs/internals/server.md): roughly +40 / −30 lines. No other files touched.
