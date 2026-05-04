# Saivage Reliability & System-Design Review (2026-05-04)

This pass focuses on what happens when things go wrong: how the runtime handles crashes, signals, partial writes, races between agents and the operator, and how cleanly the system shuts down and resumes. Findings are tied to specific code paths and ordered by impact.

## High-Impact Findings

### R1. Single-instance guard is unsafe against PID reuse, and the check-then-write is a TOCTOU race

- File: [src/runtime/recovery.ts](saivage/src/runtime/recovery.ts) `isAnotherInstanceRunning`, [src/server/bootstrap.ts](saivage/src/server/bootstrap.ts) (immediately calls `writeRuntimeState` after the check).
- The guard reads `runtime.json`, takes the recorded PID, and runs `process.kill(pid, 0)`. On Linux PIDs cycle, so after a hard crash the same PID can belong to an unrelated process (often `tsx` or `node` again). The guard then refuses to start with "Another Saivage instance is already running" even though no instance is. Conversely, if the recorded PID happens to be alive but `started_at` was three weeks ago, that's clearly stale data.
- Even when the check passes correctly, two concurrent bootstraps can both pass it: the file is read, both decide "no instance", both call `writeRuntimeState`, both keep running. There is no `O_CREAT|O_EXCL` lock acquisition.
- Impact: false positives (operator can't restart after some crashes), false negatives (rare but real concurrent operator-mistake), corrupted recovery if both instances run `recoverFromCrash` against the same `.saivage/`.

### R2. Shutdown on `serve` doesn't wait for the Planner

- File: [src/server/cli.ts](saivage/src/server/cli.ts) `serve` action.
- `runPlannerWithRecovery(runtime)` is a fire-and-forget Promise. The signal handler calls `await server.close()`, `await runtime.shutdown()`, `process.exit(0)` — but the planner promise is never awaited. If the planner is mid-LLM-call or mid-agent-dispatch, it gets cut off when `process.exit(0)` runs:
  - any pending `plan_complete_stage()` writes that hadn't reached `writeDoc` are lost
  - the agent's `agentStopped(...)` flush may not run, so `runtime.json` reads "running" forever after the next bootstrap (forcing the operator into the recovery path even though shutdown was clean)
  - the shutdown summary captures state at the moment of `runtime.shutdown()`, missing whatever the planner produces in its last few seconds

### R3. Multiple SIGINT handlers stacked, no re-entrancy guard

- Files: [src/server/cli.ts](saivage/src/server/cli.ts) `serve`, [src/server/bootstrap.ts](saivage/src/server/bootstrap.ts) `runPlanner`/`runPlannerWithRecovery`.
- A single SIGINT triggers handlers in three different scopes. That's by design (each layer cancels its own piece) but they are not coordinated:
  - The CLI handler awaits server.close + runtime.shutdown then `process.exit(0)`.
  - `runPlanner` registers a handler that calls `planner.cancel()`.
  - `runPlannerWithRecovery` registers a handler that flips `cancelled = true`.
- A second SIGINT (impatient operator hitting Ctrl+C twice) re-enters the CLI shutdown with no guard, so `server.close()` and `runtime.shutdown()` are called twice in parallel. Fastify's `close()` rejects on the second invocation; `runtime.shutdown()` re-runs MCP shutdown which races with the in-flight one. The visible symptom is "shutdown" hanging or throwing.
- `runPlannerWithRecovery` calls `process.setMaxListeners(30)` to silence Node's "possible memory leak" warning; this is a workaround, not a fix — the real defect is that handlers are registered in nested loops and never deduplicated.

### R4. No `uncaughtException` / `unhandledRejection` handlers

- A bug in any agent, MCP client, EventBus subscriber, or chat handler that throws asynchronously brings the process down without:
  - writing a shutdown summary
  - flushing `runtime.json` to "idle" / "error"
  - releasing any lockfile
- On the next start, recovery treats the previous run as crashed (correct), but the operator has no breadcrumb beyond stdout. For a multi-agent runtime that can run for hours unattended this is a real gap.

### R5. Atomic write isn't durable against power loss

- File: [src/store/documents.ts](saivage/src/store/documents.ts) `writeDoc`.
- The current code does `writeFileSync(tmp, …)` then `renameSync(tmp, path)`. POSIX rename is atomic against process crashes — fine for `kill -9` mid-write — but it is **not** durable against power loss: the rename can be ordered before the data hits disk, leaving an empty/zero-length `path` after reboot. The next `readDoc(path, schema)` then throws a parse error and recovery refuses to start.
- Mitigation is cheap: `fsync(fd)` before rename, `fsync(parentDir)` after rename. Standard "atomic-durable" recipe.

### R6. Stale `.tmp` files accumulate forever

- Same file. If `writeFileSync(tmp, …)` succeeds but the process is killed before `renameSync`, the `path.tmp` file stays around. Multiply by one entry per crashed write; over months `.saivage/` accumulates orphaned `runtime.json.tmp`, `tasks.json.tmp`, etc. They never confuse readers (only `path` is loaded), but they're dead weight and confuse operators reading the directory.
- Recovery already runs at startup and is the natural place to sweep them.

### R7. Notes "pending acknowledgment" is overwritten on each call

- File: [src/runtime/notes.ts](saivage/src/runtime/notes.ts) `getUnacknowledgedNotes`.
- `pendingAcknowledgment = notes.map(n => n.id)` — assignment, not union. If the planner injects notes (call A), then before `acknowledgeNotes()` runs the runtime does another inject (call B), the IDs from call A are dropped. Their notes will never be acknowledged through this code path; they linger as unacked and get re-injected on every subsequent cycle. They show up forever in the dashboard's "Notes" panel.
- This isn't hypothetical: any planner restart between inject and ack (e.g. after a stuck-agent verdict, or an explicit `/restart-planner`) leaves notes in this stuck state.

### R8. EventBus delivers events serially per `publish` call

- File: [src/events/bus.ts](saivage/src/events/bus.ts) `publish`.
- A single `await sub.handler(event)` serialized over all subscriptions. When the chat handler is doing a Telegram API call (network, 1–3 s), every other subscriber waits. There is no per-handler timeout, so a hung handler stalls the publisher (which is the runtime publishing `stage_completed`, `task_failed`, etc.).
- Errors are caught (good), but a handler that returns a never-resolving Promise hangs the publisher indefinitely.

## Medium-Impact Findings

### R9. `RuntimeTracker.flush()` can race shutdown's "idle" write

- File: [src/runtime/recovery.ts](saivage/src/runtime/recovery.ts), [src/server/bootstrap.ts](saivage/src/server/bootstrap.ts) shutdown.
- `runtime.shutdown()` writes `idle` state at the end. But if a child agent's `onActivity` callback fires on the way out (worker finishing a tool call after MCP shutdown rejected its in-flight request), `tracker.agentActivity()` runs `flush()` which writes `status: "running"` — overwriting the idle write. On next start the recovery path is taken even though shutdown was clean.

### R10. MCP service crash-restart loop has no global cool-down

- File: [src/mcp/runtime.ts](saivage/src/mcp/runtime.ts) `restartService`.
- Per-service `crashCount` resets when a fresh `ManagedService` is created. If a service crashes immediately on connect (config bug, wrong path), each `callTool` triggers a fresh start attempt, which crashes, which gives up after 3 retries… and then the next `callTool` starts the cycle over. There is no "we've failed N times in M minutes, stop trying for a while" gate, so the runtime hot-loops on a broken service.

### R11. Plan service is read-modify-write without inter-process protection

- File: [src/mcp/plan-server.ts](saivage/src/mcp/plan-server.ts).
- All methods are synchronous JS (no await between read and write), so they're effectively atomic *within one Node process*. That's a fragile guarantee: if anyone refactors `plan_complete_stage` to await the git callback before the history write, two concurrent `plan_*` calls will lose updates. There is no test asserting "two concurrent plan operations don't lose data". Adding a tiny in-memory mutex around plan/history writes would document and enforce the constraint.

### R12. Chat agent message queue grows without bound

- File: [src/agents/chat.ts](saivage/src/agents/chat.ts) `messageQueue`.
- Each user message chains `messageQueue = messageQueue.then(handle)`. There's no length cap and no per-message timeout. A user spamming "?" while the LLM is slow queues N LLM round-trips — each costs tokens, all of them serialize. If the LLM hangs, every subsequent message is permanently queued.

### R13. Stash cleanup runs only at bootstrap

- File: [src/runtime/stash.ts](saivage/src/runtime/stash.ts).
- `cleanStash()` is called once at startup. A long-running runtime (days) accumulates stash files until next restart. Trivial to schedule.

### R14. WebSocket chat agents not torn down on global shutdown

- Files: [src/server/server.ts](saivage/src/server/server.ts) `/ws`, [src/server/cli.ts](saivage/src/server/cli.ts) `serve`.
- `serve` shutdown calls `server.close()` (fine) before `runtime.shutdown()` (which calls `eventBus.clear()`). When the WebSocket connections close, each chat agent's `cleanup()` runs `unsubscribe()`. If close is slow (e.g. socket buffered traffic), `cleanup()` may run after `eventBus.clear()` has already wiped the subscription map — `unsubscribe()` becomes a no-op, harmless. But the chat agent's `messageQueue` may still be flushing an LLM response to a closed channel, swallowing the error. The chat log is saved but the user never sees the final assistant message.

## Lower-Impact / Latent

- `chatSessionId()` is reused as message ID in [chat.ts](saivage/src/agents/chat.ts) `recordMessage`. Two messages within the same nanosecond would collide. The current implementation almost certainly avoids this in practice but the type is misleading.
- `appendDoc` is unused in this codebase but still exported. If someone uses it for a hot path (e.g. an event log), the read-modify-write under contention will lose entries.
- `/api/files/content` reads up to 1 MB synchronously inside the request handler, blocking the event loop. Fine in a controlled deployment, real if many parallel clients hit it.
- Telegram bot `stop()` is called synchronously in shutdown but `bot.stop()` is async in grammy; the returned Promise is dropped.

## Confirmed Defects vs Risks

| ID | Confirmed defect / High-confidence risk |
|---|---|
| R1 | Defect: PID-reuse false positive blocks restart |
| R2 | Defect: planner not awaited at shutdown |
| R3 | Defect: re-entrant shutdown on second SIGINT |
| R4 | Defect: process can die without writing idle state |
| R5 | Risk: not durable against power loss |
| R6 | Defect: orphan `.tmp` files accumulate |
| R7 | Defect: notes lost from pending-ack list |
| R8 | Risk: a hung event handler stalls publishes |
| R9 | Risk: tracker race overwrites idle status |
| R10 | Risk: hot crash-loop on broken MCP service |
| R11 | Latent: plan-server relies on JS-synchrony |
| R12 | Risk: unbounded chat queue |
| R13 | Latent: stash grows during long sessions |
| R14 | Latent: closing chat may drop final reply |

## Remediation Plan

This pass implements the high-impact items (R1, R2, R3, R4, R5, R6, R7, R8) plus the cheap medium item R9. Lower-impact and latent items are deferred with reasons below.

### A1. Atomic write hardening + tmp sweep (R5, R6)

- `writeDoc` opens the tmp file, writes, `fsync(fd)`, closes, `renameSync`, then `fsync(parentDir)`. Cost: one extra syscall per write, well worth it for `runtime.json`/`plan.json`.
- New exported `sweepStaleTempFiles(dir, maxAgeMs)` helper that removes orphan `*.tmp` files older than 5 minutes.

### A2. Lockfile-based single-instance guard (R1)

- New `acquireRuntimeLock(saivageDir)` opens `tmp/state/runtime.lock` with `wx` (atomic create-or-fail). On success, returns a release function that unlinks the file. On failure, reads the PID inside; if `process.kill(pid, 0)` says the PID is dead, unlinks the stale lock and retries once. If the PID is alive, throws "Another instance is running".
- Bootstrap calls this *before* any state mutation. Shutdown calls the release.

### A3. Idempotent shutdown + planner await (R2, R3)

- `serve` keeps a single `shuttingDown` flag; subsequent SIGINT/SIGTERM are ignored (logged "Force exit on next signal" and second-level handler that does `process.exit(1)` after the third).
- The planner promise is captured and awaited (with a 30 s cap) before `runtime.shutdown()`.
- The nested `runPlanner` and `runPlannerWithRecovery` handlers de-duplicate via a `installSignalCancel` helper that returns an unregister function and re-uses the existing handler if already installed.

### A4. Process-fatal handlers (R4)

- `bootstrap.ts` installs `uncaughtException` and `unhandledRejection` handlers that log the error, attempt `writeRuntimeState(idle)` and lock release, then `process.exit(1)`. Best-effort.

### A5. Notes pending-ack merge (R7)

- `pendingAcknowledgment` becomes a `Set<string>`. `getUnacknowledgedNotes` adds to the set instead of overwriting. `acknowledgeNotes` still empties the set after the iteration.

### A6. EventBus parallel + per-handler timeout (R8)

- `publish` dispatches to all matching handlers via `Promise.allSettled`, each wrapped in a 5 s timeout. Handlers that exceed the timeout are logged and the publisher continues.

### A7. RuntimeTracker idle-aware flush (R9)

- `RuntimeTracker` exposes `freeze(reason)` that flips an internal flag; subsequent flushes are no-ops. Shutdown calls `tracker.freeze("shutdown")` before `writeRuntimeState(idle)`.

### Deferred

| ID | Reason |
|---|---|
| R10 MCP cool-down | Needs a sliding-window crash counter design that doesn't break healthy restarts. Worth doing but not in this pass. |
| R11 plan-server mutex | Not currently observable; the latent guarantee is fine for now. Add a regression test in a follow-up. |
| R12 chat queue cap | Real but bounded by socket lifetime; needs UX call (drop oldest? reject?). Defer. |
| R13 periodic stash cleanup | Trivial follow-up. |
| R14 WS final-reply | Needs server-side flush coordination; defer. |
| Misc lower-impact | As above. |
