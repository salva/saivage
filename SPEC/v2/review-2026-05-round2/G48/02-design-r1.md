# G48 — Design (Round 1)

- **Analysis**: [01-analysis-r1.md](01-analysis-r1.md)

## 1. Proposals

### Proposal A — Minimal local fix: try/catch/finally inside `inspect`

Restructure only the `inspect` action ([src/server/cli.ts L217-L270](../../../../src/server/cli.ts#L217-L270)):

```ts
.action(async (projectPath: string, scope: string, opts) => {
  const { resolve } = await import("node:path");
  const { bootstrap } = await import("./bootstrap.js");
  const { InspectorAgent } = await import("../agents/inspector.js");
  const { agentId, inspectionId } = await import("../ids.js");

  let runtime: import("./bootstrap.js").SaivageRuntime | undefined;
  try {
    runtime = await bootstrap(resolve(projectPath));

    const reqId = inspectionId();
    const request = { /* … unchanged … */ };
    const ctx = { /* … unchanged … */ };

    const inspector = await InspectorAgent.create(ctx, { request });
    const result = await inspector.run();

    if (result.kind === "success") {
      console.log("Inspection complete.");
      console.log(JSON.stringify(result.data, null, 2));
    } else {
      console.error(`Inspection failed: ${result.kind}`);
      process.exitCode = 1;
    }
  } catch (err) {
    console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  } finally {
    if (runtime) {
      try { await runtime.shutdown(); }
      catch (err) {
        console.error(`Shutdown error: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    process.exit(process.exitCode ?? 0);
  }
});
```

Pros: smallest diff; touches one action.

Cons:

- Leaves the structural asymmetry between `start` (uses `finally`) and `inspect` (now also uses `finally`) and any *future* short-lived runtime command (which will copy-paste whichever neighbour the author looks at). The issue itself flags this as the deeper problem.
- Duplicates the `process.exit(process.exitCode ?? 0)` boilerplate that `start` would also benefit from.
- No reusable test surface — to verify shutdown-on-throw we would have to invoke commander, which is awkward in vitest.

### Proposal B — Extract `withRuntime(projectPath, fn)` helper, used by `inspect` and `start` (RECOMMENDED)

Add a single co-located helper in [src/server/cli.ts](../../../../src/server/cli.ts) (just below `installRecoverableSocketErrorGuard` at [L18-L31](../../../../src/server/cli.ts#L18-L31)) that owns the bootstrap+teardown invariant:

```ts
/**
 * Run `fn(runtime)` against a freshly-bootstrapped Saivage runtime, then
 * guarantee `runtime.shutdown()` runs exactly once and the process exits.
 *
 * Used by short-lived CLI commands (`start`, `inspect`). NOT used by
 * `serve`, which keeps the runtime alive and owns its own signal-driven
 * teardown.
 */
async function withRuntime<T>(
  projectPath: string | undefined,
  fn: (runtime: SaivageRuntime) => Promise<T>,
): Promise<void> {
  const { resolve } = await import("node:path");
  const { bootstrap } = await import("./bootstrap.js");
  const absolutePath = projectPath ? resolve(projectPath) : undefined;

  let runtime: SaivageRuntime | undefined;
  try {
    runtime = await bootstrap(absolutePath);
    await fn(runtime);
  } catch (err) {
    console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  } finally {
    if (runtime) {
      try { await runtime.shutdown(); }
      catch (err) {
        console.error(`Shutdown error: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    process.exit(process.exitCode ?? 0);
  }
}
```

- The `SaivageRuntime` type comes from a top-of-file `import type { SaivageRuntime } from "./bootstrap.js";` (type-only, no eager module load).
- `bootstrap` is still imported dynamically inside the helper so the existing module-load-deferred shape (commander parses without paying the cost of bootstrap.ts) is preserved.
- The signature is intentionally `Promise<void>`: `withRuntime` never returns the action's value; the caller communicates failure via `process.exitCode` (or by throwing).
- The helper centralizes three rules:
  1. `bootstrap` and `shutdown` are paired.
  2. Shutdown rejections are logged, not thrown.
  3. The process exits deterministically with `process.exitCode ?? 0` after teardown — preventing the event-loop-stuck-on-MCP-child symptom described in the issue.

Then rewrite the two short-lived commands to call it:

```ts
// start
.action((projectPath?: string) =>
  withRuntime(projectPath, async (runtime) => {
    const { runPlanner } = await import("./bootstrap.js");
    console.log(`Starting Saivage on ${runtime.project.projectRoot}...`);
    const result = await runPlanner(runtime);
    switch (result.kind) {
      case "success":  console.log("Plan completed successfully."); break;
      case "failure":  console.error(`Plan failed: ${result.reason}`); process.exitCode = 1; break;
      case "abort":    console.log(`Plan aborted: ${result.reason}`); break;
      case "escalation": console.error(`Plan escalated — manual intervention required.`); process.exitCode = 1; break;
    }
  })
);

// inspect
.action((projectPath: string, scope: string, opts) =>
  withRuntime(projectPath, async (runtime) => {
    const { InspectorAgent } = await import("../agents/inspector.js");
    const { agentId, inspectionId } = await import("../ids.js");

    const reqId = inspectionId();
    const request = {
      id: reqId, scope,
      questions: opts.question ?? [scope],
      requested_at: new Date().toISOString(),
      requested_by: "chat" as const,
    };
    const ctx = {
      project: runtime.project,
      router: runtime.router,
      mcpRuntime: runtime.mcpRuntime,
      agentId: agentId(),
      role: "inspector" as const,
      modelSpec: runtime.routing.resolve("inspector").modelSpec,
      authProfileKey: runtime.routing.resolve("inspector").authProfile,
      accountRef: runtime.routing.resolve("inspector").accountRef,
    };
    const inspector = await InspectorAgent.create(ctx, { request });
    const result = await inspector.run();
    if (result.kind === "success") {
      console.log("Inspection complete.");
      console.log(JSON.stringify(result.data, null, 2));
    } else {
      console.error(`Inspection failed: ${result.kind}`);
      process.exitCode = 1;
    }
  })
);
```

Pros:

- One owner of the lifecycle. Future commands that need a runtime cannot reintroduce the asymmetry without explicitly opting out.
- `start`'s existing-but-correct pattern is no longer load-bearing copy-paste — the contract is encoded once.
- Direct unit-test surface: the helper takes a callback, so a vitest spec can drive both throw paths and assert `runtime.shutdown()` was called and `process.getActiveResourcesInfo()` collapsed.
- Aligns with the issue's "level up" recommendation.

Cons:

- Slightly larger diff (`start` is also rewritten).
- Couples `bootstrap` and `process.exit` policy. We accept this because the helper is *named* for CLI use (`withRuntime` is not exported; it lives in `cli.ts`), and `serve` deliberately does not use it.

### Why not also `request-shutdown` and `note`?

`request-shutdown` ([src/server/cli.ts L186-L213](../../../../src/server/cli.ts#L186-L213)) and `note` ([src/server/cli.ts L148-L184](../../../../src/server/cli.ts#L148-L184)) call `loadProject(...)` only — they never call `bootstrap()`, so they hold no MCP children, no lockfile, no supervisor. Wrapping them in `withRuntime` would be wrong (it would spin up a full runtime they do not need) and slow. Leave them untouched.

## 2. Recommendation

**Adopt Proposal B.** It is the cheapest version of the structural fix flagged by the issue, has a clean test surface, and removes the asymmetry permanently. The "minimum diff" advantage of Proposal A is illusory once the regression test plan is in scope — testing the lifecycle invariant is much easier against a helper than against a commander action.

## 3. Detailed design (Proposal B)

### 3.1 Module shape

[src/server/cli.ts](../../../../src/server/cli.ts) gains:

- A top-of-file `import type { SaivageRuntime } from "./bootstrap.js";` (next to the existing `import { Command } from "commander";` at [L5](../../../../src/server/cli.ts#L5)).
- The `withRuntime` function defined immediately after `installRecoverableSocketErrorGuard` ([L18-L31](../../../../src/server/cli.ts#L18-L31)).
- Two action bodies (`start` at [L60-L98](../../../../src/server/cli.ts#L60-L98), `inspect` at [L217-L270](../../../../src/server/cli.ts#L217-L270)) rewritten to delegate to `withRuntime`.

No new files in production code.

### 3.2 Exact contract of `withRuntime`

| Concern | Behaviour |
|---|---|
| Bootstrap throws | `console.error("Error: …")`; `process.exitCode = 1`; skip shutdown (no runtime exists); `process.exit(1)`. |
| `fn` throws | `console.error("Error: …")`; `process.exitCode = 1`; *always* call `runtime.shutdown()` before exiting. |
| `fn` returns normally with `process.exitCode === undefined` | Call `runtime.shutdown()`; `process.exit(0)`. |
| `fn` returns normally but set `process.exitCode = 1` itself | Call `runtime.shutdown()`; `process.exit(1)`. |
| `runtime.shutdown()` itself throws | `console.error("Shutdown error: …")`; do not raise the original `fn` exception over it; continue to `process.exit(process.exitCode ?? 0)`. |

Exit always goes through `process.exit(...)` so that any residual handles (FDs from a half-closed MCP child, supervisor timers that did not unref) cannot keep the loop alive past teardown. The `installFatalHandlers` global hooks ([src/server/bootstrap.ts L705-L737](../../../../src/server/bootstrap.ts#L705-L737)) remain installed but are no longer load-bearing for `inspect`/`start` because the explicit `finally` runs first.

### 3.3 No regex / no fragile heuristics

The helper does **not** introspect `runtime.mcpRuntime`'s internal child list, sniff `process._getActiveHandles()`, or run a "is the loop empty?" probe. Project principle 3 forbids fragile runtime heuristics, and shutdown ownership is already explicit on `runtime.shutdown()`. The only "is something keeping the loop open?" check we use is in tests (see plan §3) and uses the documented, stable `process.getActiveResourcesInfo()` API.

### 3.4 No new configuration

The helper introduces no new tunables. The project principle "prefer config over hardcoded" applies to behaviour operators tune; the bootstrap/teardown invariant is not operator-tunable.

If, during implementation, we discover that `mcpRuntime.shutdown()` itself can hang (e.g. an MCP child ignoring SIGTERM), we will add a `MCP_SHUTDOWN_TIMEOUT_MS` constant sibling to the existing `PLANNER_SHUTDOWN_TIMEOUT_MS` at [src/server/cli.ts L7](../../../../src/server/cli.ts#L7), wrapped around `runtime.shutdown()` in `withRuntime`'s `finally`. This is a contingency, not a baseline requirement, and is called out explicitly in the plan §4.

### 3.5 Logging convention

`Error:` (uppercase, prefix) preserved verbatim from the current `inspect` and `start` error paths so operator-facing stderr lines and any downstream log scrapers do not need updating. Shutdown failures use the prefix `Shutdown error:`, matching `serve`'s existing style at [src/server/cli.ts L380-L381](../../../../src/server/cli.ts#L380-L381).

## 4. Files touched (summary)

| File | Live anchor | Change |
|---|---|---|
| [src/server/cli.ts](../../../../src/server/cli.ts#L1-L17) | L1-L17 | Add `import type { SaivageRuntime } from "./bootstrap.js";`. |
| [src/server/cli.ts](../../../../src/server/cli.ts#L18-L31) | after L31 | Insert `withRuntime` helper. |
| [src/server/cli.ts](../../../../src/server/cli.ts#L60-L98) | L60-L98 | Rewrite `start` action body to delegate to `withRuntime`. |
| [src/server/cli.ts](../../../../src/server/cli.ts#L217-L270) | L217-L270 | Rewrite `inspect` action body to delegate to `withRuntime`. |
| [src/server/cli.test.ts](../../../../src/server/cli.test.ts) | (new) | New file. Unit tests for `withRuntime` — see plan §3. |

No changes: [src/server/bootstrap.ts](../../../../src/server/bootstrap.ts), [src/server/server.ts](../../../../src/server/server.ts), [src/agents/inspector.ts](../../../../src/agents/inspector.ts), [src/runtime/recovery.ts](../../../../src/runtime/recovery.ts). `serve` ([src/server/cli.ts L307-L390](../../../../src/server/cli.ts#L307-L390)) is intentionally untouched.

## 5. Risks

| Risk | Mitigation |
|---|---|
| `withRuntime` is `Promise<void>` but `start`'s action used to be passed a non-undefined `result` to switch on. | The switch moves *inside* the callback; the callback owns its own success/failure-branching and sets `process.exitCode` as needed. Verified in the snippet above. |
| `process.exit` truncates pending stdout/stderr. | `console.log/error` to TTY is synchronous on Linux; only async sinks (pipes to slow consumers) could truncate. The pre-existing `installRecoverableSocketErrorGuard` ([L18-L31](../../../../src/server/cli.ts#L18-L31)) already handles EPIPE. No regression. |
| Operator scripts depend on `inspect` not calling `process.exit` (e.g. relying on the absence of explicit exit to allow custom Node flags to finalise). | None known; the issue itself calls out that operators currently SIGINT the hang. Documented in the rollout note. |
| Vitest harness keeps file watchers or worker IPC alive, making `getActiveResourcesInfo()` assertions noisy. | Tests do not call `process.exit` (helper is invoked via a test seam — see plan §3.1); the assertion uses an allow-list of test-harness resource kinds. |
