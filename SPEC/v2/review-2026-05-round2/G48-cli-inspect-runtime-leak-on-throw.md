# G48 — `saivage inspect` leaks the runtime on `inspector.run()` failure

- **Subsystem**: server / CLI (`src/server/cli.ts`)
- **Category**: bug, resource leak
- **Severity**: low

## Summary

The `inspect` CLI command boots a full runtime (MCP children, providers,
event bus, plan service, …), runs the Inspector, then calls
`runtime.shutdown()`. The `shutdown()` call sits on the happy path *after*
the success branch, not in a `finally`, so any exception inside
`inspector.run()`, `InspectorAgent.create()`, or the success branch's
`JSON.stringify` lands in the outer `catch` and the runtime is never torn
down. The process sets `process.exitCode = 1` but Node's event loop keeps
running because the MCP child processes, the file watchers, and the timers
are still alive — the CLI hangs until something else (operator Ctrl-C, OS
SIGKILL) forces the exit.

## Evidence

```ts
try {
  const runtime = await bootstrap(resolve(projectPath));
  …
  const inspector = await InspectorAgent.create(ctx, { request });
  const result = await inspector.run();

  if (result.kind === "success") {
    console.log("Inspection complete.");
    console.log(JSON.stringify(result.data, null, 2));
  } else {
    console.error(`Inspection failed: ${result.kind}`);
    process.exitCode = 1;
  }

  await runtime.shutdown();
} catch (err) {
  console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
}
```

[src/server/cli.ts](src/server/cli.ts#L228-L270)

If `inspector.run()` throws (LLM provider error, tool-call validation
failure, abort), control jumps to `catch` *without* the `runtime.shutdown()`
call.

## Why this matters

`saivage inspect` is typically run interactively (one operator question, one
answer). When it fails, the operator hits Ctrl-C and assumes the process
died — but the next `saivage inspect` invocation will race the still-running
MCP child processes and the still-locked `.saivage/runtime/runtime.json`
file. The visible symptom is intermittent "EBUSY" or "file in use" errors
on the next attempt. It also leaks an orphan PID in the runtime tracker
that may confuse the recovery logic.

This is mild (low impact) because the operator usually notices the hang and
sends SIGTERM, but it is the *only* code path in the codebase that boots a
runtime without a `finally` shutdown, so the asymmetry by itself is worth
fixing for readability.

## Rough remediation direction

Restructure the action to a `try`/`catch`/`finally`:

```ts
let runtime: SaivageRuntime | undefined;
try {
  runtime = await bootstrap(resolve(projectPath));
  …
  const result = await inspector.run();
  …
} catch (err) {
  console.error(`Error: …`);
  process.exitCode = 1;
} finally {
  if (runtime) {
    try { await runtime.shutdown(); } catch (err) {
      console.error(`Shutdown error: …`);
    }
  }
}
```

Then `process.exit(0)` (or `process.exit(process.exitCode ?? 0)`) at the
very end so the event loop terminates deterministically.

**Level up**: every short-lived CLI command that boots a runtime
(`start`, `note`, `inspect`, `request-shutdown`) shares the same setup +
teardown shape. Extract a `withRuntime(projectPath, fn)` helper that owns
the bootstrap/shutdown pairing, so future commands cannot reintroduce this
asymmetry by copy-pasting half the lifecycle. (`serve` is special because it
keeps the runtime alive — leave that one alone.)

## Cross-links

- G45 — internals doc claims `runtime.shutdown` does five things, when in
  fact the CLI owns most of them; centralising the lifecycle in
  `withRuntime` would also force the doc to track reality.
