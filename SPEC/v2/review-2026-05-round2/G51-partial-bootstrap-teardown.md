# G51 — Partial-bootstrap failure leaks runtime resources

- **Subsystem**: server / runtime bootstrap ([src/server/bootstrap.ts](../../../src/server/bootstrap.ts))
- **Severity**: low (latent; only surfaces when `bootstrap()` itself rejects after acquiring side-effectful resources)
- **Status**: filed; not scheduled. Documented as a deferred follow-up to [G48](G48-cli-inspect-runtime-leak-on-throw.md).

## Symptom

If `bootstrap()` rejects **after** acquiring side-effectful resources but **before** returning a `SaivageRuntime`, the partial state is orphaned:

- The runtime lockfile FD acquired at [src/server/bootstrap.ts L173-L182](../../../src/server/bootstrap.ts#L173-L182) stays held.
- Any MCP child processes spawned by `mcpRuntime` construction prior to the throw stay alive.
- The supervisor interval, if already started, keeps running.
- `installFatalHandlers(runtime, runtimeLock)` ([src/server/bootstrap.ts L259](../../../src/server/bootstrap.ts#L259)) has **not** yet been installed at the throw point, so the global `uncaughtException` / `unhandledRejection` net does not catch the partial state either.

The next `saivage` invocation in the same project then trips on "Another Saivage instance is already running" until the orphan FDs are reaped by process exit (or, in practice, until the operator runs `pkill -f saivage`).

## Scope and motivating example

[G48 r3](G48/01-analysis-r3.md#L39-L43) narrows its fix to "failures **after** `bootstrap()` resolves". The shared `withRuntime` helper introduced by G48 cannot shut down a runtime that never returned — there is no runtime object to call `.shutdown()` on, and the partial state lives inside `bootstrap()`'s closure where the helper has no handle.

Concretely, G48's helper contract ([02-design-r3.md §2](G48/02-design-r3.md#L2)) states:

> If `bootstrap()` rejects, the error is logged with `Error:` prefix and the process exits 1. **No shutdown is attempted (no runtime exists). Partial-bootstrap state is G51's responsibility, not this helper's.**

That row of G48's contract — the "`bootstrap` throws" row — is the motivating example for G51. G48 ships exit 1 + stderr line for this branch (matching today's `inspect` behaviour); the leak itself is what G51 owns.

## Deferred-to fix shape (not scheduled)

Making `bootstrap()` transactional:

- Accumulate "rollback" closures inside `bootstrap()` as side effects are taken (lock acquired → push `releaseLock`; MCP children spawned → push `terminateChildren`; supervisor started → push `stopSupervisor`).
- Wrap the body in a `try { ... return runtime; } catch (err) { await runRollbacks(); throw err; }` shape so a partial-bootstrap failure cleans up its own partial state before re-throwing.

This is a different bug with a different fix surface than G48 (which is a CLI-action-layer concern, not a bootstrap-layer concern). It deserves its own analysis/design/plan pass; it is not a single-line fix.

## Out of scope here

- G48's `withRuntime` / `cli-actions.ts` extraction — handled in [G48 r3](G48/03-plan-r3.md).
- `serve`'s long-lived runtime ownership — `serve` already owns its own teardown path and is not affected by this finding.

## Future work

Not scheduled. Re-open with a dedicated round when an operator hits the orphan-lockfile symptom on a bootstrap-throw path, or when bootstrap itself is touched for another reason and transactionality can be added in the same change.
