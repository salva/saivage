# G48 — Analysis (Round 1)

- **Issue**: [../G48-cli-inspect-runtime-leak-on-throw.md](../G48-cli-inspect-runtime-leak-on-throw.md)
- **Subsystem**: server / CLI ([src/server/cli.ts](../../../../src/server/cli.ts))
- **Severity**: low (operator-visible hang; secondary: orphan MCP children racing the next bootstrap)

## 1. Restated finding

The `saivage inspect` subcommand boots a full Saivage runtime (MCP children, providers, plan service, supervisor, runtime lockfile, event bus) and then calls `runtime.shutdown()` only on the happy path. Any throw inside `bootstrap(...)` after the lockfile is acquired, inside `InspectorAgent.create(...)`, inside `inspector.run()`, or inside the success-branch `JSON.stringify` jumps into the outer `catch` and skips `runtime.shutdown()`. The Node event loop stays open (MCP child stdio, supervisor interval, RuntimeTracker writers, runtime lockfile FD) and the process hangs until the operator sends SIGINT/SIGTERM.

This is the only command in the file that boots a runtime without a `finally`-style teardown — `start` ([src/server/cli.ts L60-L98](../../../../src/server/cli.ts#L60-L98)) already uses `finally { await runtime?.shutdown(); }`, and `serve` ([src/server/cli.ts L307-L390](../../../../src/server/cli.ts#L307-L390)) owns its own SIGINT/SIGTERM shutdown path. The asymmetry is the root cause and the readability liability.

## 2. Evidence (current source, live line numbers)

| # | Location | Live lines | Notes |
|---|---|---|---|
| 1 | [src/server/cli.ts](../../../../src/server/cli.ts#L217-L270) | L217-L270 | Whole `inspect` action. |
| 2 | [src/server/cli.ts](../../../../src/server/cli.ts#L228) | L228 | `const runtime = await bootstrap(resolve(projectPath));` — declared inside `try`, not visible to the `catch`. |
| 3 | [src/server/cli.ts](../../../../src/server/cli.ts#L251-L252) | L251-L252 | `InspectorAgent.create(...)` and `inspector.run()` — the two await points most likely to throw (LLM provider error, abort, tool-call validation). |
| 4 | [src/server/cli.ts](../../../../src/server/cli.ts#L262) | L262 | `await runtime.shutdown();` — on the happy path only, *outside* a `finally`. |
| 5 | [src/server/cli.ts](../../../../src/server/cli.ts#L263-L269) | L263-L269 | `catch (err)` — does *not* call `runtime.shutdown()`. |
| 6 | [src/server/cli.ts](../../../../src/server/cli.ts#L60-L98) | L60-L98 | `start` command — correct pattern: `let runtime; try { … } catch { … } finally { await runtime?.shutdown(); }`. The shape `inspect` should match. |
| 7 | [src/server/bootstrap.ts](../../../../src/server/bootstrap.ts#L216-L240) | L216-L240 | `SaivageRuntime.shutdown` — freezes the tracker, writes shutdown summary, stops the supervisor, shuts down `mcpRuntime` (which terminates spawned MCP child processes), clears the event bus, writes the final `idle` runtime state, and releases the runtime lockfile. Skipping it leaks every one of these. |
| 8 | [src/server/bootstrap.ts](../../../../src/server/bootstrap.ts#L705-L737) | L705-L737 | `installFatalHandlers` — installs `uncaughtException` / `unhandledRejection` global hooks at bootstrap time. After a leaked `inspect`, these handlers remain registered on the still-alive process and may fire on subsequent code. |

## 3. Symptom → root-cause map

| Symptom | Root cause |
|---|---|
| `saivage inspect ... ` hangs after printing `Error: ...`. Operator hits Ctrl-C. | `inspector.run()` (or any earlier await) threw → `catch` ran → `runtime.shutdown()` never ran → MCP child stdio, supervisor interval, and the lockfile keep the event loop alive. |
| Next `saivage inspect` (or any bootstrap) on the same project fails with "Another Saivage instance is already running" or EBUSY on `.saivage/runtime/runtime.json`. | Orphan PID from the previous run is still alive when `isAnotherInstanceRunning` checks ([src/server/bootstrap.ts L169-L173](../../../../src/server/bootstrap.ts#L169-L173)), or the runtime lockfile FD from the first run still holds the lock. |
| Stray MCP child processes (shell/fs/git) outliving the CLI. | `mcpRuntime.shutdown()` never called. |

All three reduce to: *the inspect command treats `runtime.shutdown()` as success-path cleanup instead of as a teardown invariant.*

## 4. Why the issue's "low severity" still warrants a structural fix

The bug is operator-visible only intermittently, but the broader pattern matters:

- `inspect`, `start`, `serve` (and any future short-lived runtime command) all share the bootstrap + teardown contract. Today only `start` enforces it correctly; `inspect` copy-pasted half of it. Without a single owner of the lifecycle, the next added subcommand will copy-paste the same trap.
- The runtime lockfile + PID tracker explicitly exist to make crash recovery deterministic ([src/runtime/recovery.ts](../../../../src/runtime/recovery.ts), [src/server/bootstrap.ts L169-L174](../../../../src/server/bootstrap.ts#L169-L174)). Silent shutdown skips defeat them — the next bootstrap thinks the previous run is "still running" instead of "crashed", and recovery does not engage.
- This is the cheapest fix in the round 2 batch with the clearest invariant: "every code path that calls `bootstrap()` MUST guarantee `runtime.shutdown()` runs exactly once."

## 5. Project-rule compliance check

The new project-wide principles apply as follows to this fix:

1. **No regex for parsing user intent — slash commands only.** N/A. The inspect command parses no user prose. Subcommand routing is done by commander.
2. **Avoid hardcoded values; prefer config.** No new hardcoded literals are introduced. The shutdown timeout already used by `serve` (`PLANNER_SHUTDOWN_TIMEOUT_MS`) is local and not relevant — `inspect` runs no planner. We may want a small "post-shutdown grace window" before forcing `process.exit`; this can stay as a module-level constant in cli.ts (sibling to `PLANNER_SHUTDOWN_TIMEOUT_MS`) rather than a configuration knob, because (a) it gates only CLI quiescence, not behaviour, and (b) operators do not tune it.
3. **No fragile agent-tool-call heuristics.** N/A. The change is around runtime-lifecycle bookkeeping, not LLM or tool-call parsing. We deliberately *avoid* introducing heuristics to detect "is the runtime still alive?" — instead, the design relies on a single deterministic ownership boundary (`withRuntime`).

## 6. Scope boundaries

- **In scope**: the `inspect` action in [src/server/cli.ts L217-L270](../../../../src/server/cli.ts#L217-L270), and a refactor of `start` (L60-L98) to share the same lifecycle helper. A new unit/integration test file for the helper.
- **Out of scope**: `serve` — keeps the runtime alive for the lifetime of the HTTP server and owns its own signal-handler-driven teardown; leave its structure unchanged. `note`, `request-shutdown`, `status`, `models`, `login`, `logout`, `init`, `validate-stage-id` — none of these call `bootstrap()`, so the helper does not apply.
- **Backward-compat policy**: per project rule, no compatibility shim is required — the CLI surface (subcommand names, flags, stdout/stderr shape, exit codes) is preserved exactly. This is an internal refactor.

## 7. Resource-leak detection (test surface)

Node exposes `process.getActiveResourcesInfo()` (stable since Node 17.3) which returns a `string[]` listing every async resource keeping the event loop alive (timers, child IPC channels, file watchers, sockets, lockfile FDs). After `runtime.shutdown()` is awaited the snapshot should contain only test-harness resources (`TTYWrap`, vitest's own timers). This is the deterministic signal we will assert against in regression tests, in lieu of fragile "did the process hang?" timeouts.

The complementary surface — `process._getActiveHandles()` / `process._getActiveRequests()` — is undocumented and version-fragile; we will avoid it.

## 8. Open questions

- Should the helper accept a custom shutdown timeout, or fail fast if `runtime.shutdown()` itself rejects? Going with: log shutdown rejections as warnings and continue to `process.exit`, matching `serve`'s existing pattern at [src/server/cli.ts L380-L382](../../../../src/server/cli.ts#L380-L382). The fatal handlers installed by `installFatalHandlers` cover the catastrophic case.
- Should the helper call `process.exit(process.exitCode ?? 0)` itself, or leave that to the action? Going with: the helper exits the process on its way out, because that is the invariant operators rely on (`saivage inspect` is a one-shot — it should not return control to a shell hung on a half-open event loop). `serve` is exempt because it never calls the helper.
