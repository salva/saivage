# G48 — Design (Round 2)

- **Analysis**: [01-analysis-r2.md](01-analysis-r2.md)
- **Round 1**: [02-design-r1.md](02-design-r1.md), [04-review-r1.md](04-review-r1.md)

## 0. What changed since r1

| r1 design | r2 design |
|---|---|
| Helper lives in [src/server/cli.ts](../../../../src/server/cli.ts) with a `__withRuntime` test re-export. | Helper and the two actions move to a new side-effect-free module [src/server/cli-actions.ts](../../../../src/server/cli-actions.ts). [src/server/cli.ts](../../../../src/server/cli.ts) imports them and stays the executable entrypoint. |
| `start`'s `Fatal:` prefix preserved. | `start` is intentionally normalized to `Error:` to match `inspect`. |
| `bootstrap()` throw partially covered. | Out of scope; documented contract that bootstrap-rejection paths are forwarded as-is and do **not** receive a `runtime.shutdown()` call. Partial-bootstrap teardown is G51 (separate finding). |
| Test seam via `__` re-export. | Direct named exports from the side-effect-free sibling — no leading-underscore "test-only" convention needed. |
| Manual grep invariant in plan §3.4. | Automated AST-based invariant test (TypeScript compiler API). |
| T7 used a set-difference of resource *kinds*. | T7 uses per-kind count deltas plus a Linux `/proc/self/fd` directory-length delta. |
| No shutdown-only-failure test. | T8 added. |

Proposal B (the shared helper for `start` and `inspect`, leaving `serve` untouched) is unchanged and remains the selection.

## 1. Module layout

### 1.1 New module: [src/server/cli-actions.ts](../../../../src/server/cli-actions.ts)

Side-effect-free. Exports three named symbols and one type re-export.

```ts
/**
 * Saivage — CLI action layer
 *
 * Side-effect-free home for the `start` and `inspect` command actions and
 * the `withRuntime` lifecycle helper they share. This module is safe to
 * import from vitest (no commander parse, no top-level I/O).
 *
 * `cli.ts` is the executable entrypoint; it imports these symbols and wires
 * them into commander, then calls `program.parse()`.
 */

import { resolve } from "node:path";
import { bootstrap, runPlanner, type SaivageRuntime } from "./bootstrap.js";

export type { SaivageRuntime } from "./bootstrap.js";

/**
 * Run `fn(runtime)` against a freshly-bootstrapped Saivage runtime, then
 * guarantee `runtime.shutdown()` runs exactly once and the process exits.
 *
 * Contract:
 *   - If `bootstrap()` rejects, the error is logged and the process exits 1.
 *     No shutdown is attempted (no runtime exists). Partial-bootstrap state
 *     is G51's responsibility, not this helper's.
 *   - If `fn(runtime)` throws, `runtime.shutdown()` is awaited exactly once;
 *     the original failure is logged with `Error:` prefix; `process.exitCode`
 *     becomes 1; the process exits.
 *   - If `runtime.shutdown()` itself rejects, the rejection is logged with
 *     `Shutdown error:` prefix. A teardown-only failure does NOT override
 *     `process.exitCode` set by a successful `fn`. (Rationale: the action's
 *     outcome is what operators care about; a noisy shutdown should not
 *     turn green into red.)
 *   - `fn` may set `process.exitCode` directly to signal a soft failure;
 *     the helper preserves it.
 *
 * Used by short-lived CLI commands (`start`, `inspect`). NOT used by
 * `serve`, which keeps the runtime alive and owns its own signal-driven
 * teardown.
 */
export async function withRuntime(
  projectPath: string | undefined,
  fn: (runtime: SaivageRuntime) => Promise<void>,
): Promise<void> {
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
      try {
        await runtime.shutdown();
      } catch (err) {
        console.error(
          `Shutdown error: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    process.exit(process.exitCode ?? 0);
  }
}

/** `saivage start [project-path]` action. */
export async function startAction(projectPath?: string): Promise<void> {
  await withRuntime(projectPath, async (runtime) => {
    console.log(`Starting Saivage on ${runtime.project.projectRoot}...`);
    const result = await runPlanner(runtime);
    switch (result.kind) {
      case "success":
        console.log("Plan completed successfully.");
        break;
      case "failure":
        console.error(`Plan failed: ${result.reason}`);
        process.exitCode = 1;
        break;
      case "abort":
        console.log(`Plan aborted: ${result.reason}`);
        break;
      case "escalation":
        console.error("Plan escalated — manual intervention required.");
        process.exitCode = 1;
        break;
    }
  });
}

export interface InspectOptions {
  question?: string[];
}

/** `saivage inspect <project-path> <scope>` action. */
export async function inspectAction(
  projectPath: string,
  scope: string,
  opts: InspectOptions,
): Promise<void> {
  await withRuntime(projectPath, async (runtime) => {
    const { InspectorAgent } = await import("../agents/inspector.js");
    const { agentId, inspectionId } = await import("../ids.js");

    const reqId = inspectionId();
    const request = {
      id: reqId,
      scope,
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
  });
}
```

Notes on imports:

- `bootstrap` and `runPlanner` are imported at module top — fine, because [src/server/bootstrap.ts](../../../../src/server/bootstrap.ts) is itself side-effect-free at import time (declares classes/functions; no top-level I/O). vitest can mock the module without parsing argv.
- `InspectorAgent` and `ids` are still imported dynamically inside `inspectAction` to preserve the lazy-load shape (commander does not pay the inspector cost when running `start`). This is unchanged from r1.

### 1.2 [src/server/cli.ts](../../../../src/server/cli.ts) — minimal changes

```ts
// near the top, alongside `import { Command } from "commander";`
import { startAction, inspectAction } from "./cli-actions.js";

// start
program
  .command("start [project-path]")
  .description("Start the autonomous execution loop")
  .action(startAction);

// inspect
program
  .command("inspect <project-path> <scope>")
  .description("Dispatch the Inspector from CLI")
  .option("-q, --question <questions...>", "Questions to investigate")
  .action(inspectAction);
```

The dynamic `bootstrap` / `InspectorAgent` / `ids` imports formerly inside the inline action bodies are gone from `cli.ts`. `cli.ts` no longer references `runtime` or `shutdown` anywhere except inside `serve`'s SIGINT handler ([src/server/cli.ts L380](../../../../src/server/cli.ts#L380)).

### 1.3 Modules not changed

- [src/server/bootstrap.ts](../../../../src/server/bootstrap.ts) — untouched. (Partial-bootstrap transactionality is G51.)
- [src/server/server.ts](../../../../src/server/server.ts), [src/agents/inspector.ts](../../../../src/agents/inspector.ts), [src/runtime/recovery.ts](../../../../src/runtime/recovery.ts) — untouched.
- `serve` ([src/server/cli.ts L307-L390](../../../../src/server/cli.ts#L307-L390)) — untouched. `installRecoverableSocketErrorGuard` ([src/server/cli.ts L18-L31](../../../../src/server/cli.ts#L18-L31)) — untouched.

## 2. Exact contract of `withRuntime`

| Scenario | `bootstrap()` | `fn(runtime)` | `runtime.shutdown()` | stderr | exit code |
|---|---|---|---|---|---|
| Happy path | resolves | resolves; no `process.exitCode` | called, resolves | (none from helper) | 0 |
| Soft failure inside `fn` | resolves | resolves; sets `process.exitCode = 1` | called, resolves | (whatever `fn` printed) | 1 |
| Hard failure inside `fn` | resolves | throws `boom` | called, resolves | `Error: boom` | 1 |
| `bootstrap` throws | rejects `bf` | not called | not called | `Error: bf` | 1 |
| Shutdown-only failure on success | resolves | resolves; no `process.exitCode` | called, rejects `sd` | `Shutdown error: sd` | **0** (the action succeeded) |
| Shutdown failure during hard failure | resolves | throws `boom` | called, rejects `sd` | `Error: boom` then `Shutdown error: sd` | 1 |
| `fn` throws and sets exitCode | resolves | throws after setting `process.exitCode = 1` | called, resolves | `Error: <msg>` | 1 |

The "shutdown-only failure on success" row is the contract pinned by T8. The choice (exit 0, not 1) follows the principle that a noisy teardown should not invert a successful action's status — this matches `serve`'s existing pattern at [src/server/cli.ts L378-L382](../../../../src/server/cli.ts#L378-L382), which logs `Shutdown error:` without forcing `process.exitCode = 1`.

## 3. Operator-facing behaviour changes

| Surface | Before | After | Notes |
|---|---|---|---|
| `saivage start` thrown-error prefix | `Fatal: <msg>` ([src/server/cli.ts L92](../../../../src/server/cli.ts#L92)) | `Error: <msg>` | Intentional normalization per workspace "architecture-first, no backward compatibility" policy. `grep -rn 'Fatal:' src/ docs/` returns no other matches that depend on this string. |
| `saivage start` exit code on throw | 1 | 1 | Unchanged. |
| `saivage start` happy-path stdout | `Starting Saivage on …`, `Plan completed successfully.` | identical | Unchanged. |
| `saivage inspect` happy-path stdout | `Inspection complete.` + JSON | identical | Unchanged. |
| `saivage inspect` failure (`result.kind !== "success"`) stderr | `Inspection failed: <kind>` | identical | Unchanged. |
| `saivage inspect` thrown-error prefix | `Error: <msg>` | `Error: <msg>` | Unchanged. |
| `saivage inspect` hangs after throw | yes (the bug) | no — `runtime.shutdown()` runs and `process.exit(1)` follows | Fixed. |
| Process exit on `start`/`inspect` | no explicit `process.exit` | explicit `process.exit(process.exitCode ?? 0)` at end of `withRuntime` | Defends against half-closed MCP child handles holding the loop open past teardown. |

Documented in the rollout note in [03-plan-r2.md §5](03-plan-r2.md).

## 4. Automated invariant test (replaces r1's manual grep)

The invariant — "every `await bootstrap(...)` in [src/server/cli-actions.ts](../../../../src/server/cli-actions.ts) is followed by a `runtime.shutdown()` in the same function, and there are zero `await bootstrap(...)` calls in [src/server/cli.ts](../../../../src/server/cli.ts) except inside `serve`" — is enforced by [src/server/cli-actions.invariants.test.ts](../../../../src/server/cli-actions.invariants.test.ts) using the TypeScript compiler API (the `typescript` package is already a dev dependency; confirm in [package.json](../../../../package.json) during implementation).

The test does:

1. `ts.createSourceFile("cli-actions.ts", readFileSync(...), ts.ScriptTarget.Latest, true)`.
2. Walks the AST collecting every `CallExpression` whose `expression` is an `Identifier` named `bootstrap`. For each call, walks up to find the enclosing `FunctionDeclaration` / `ArrowFunction` / `FunctionExpression`.
3. Within that same enclosing function, walks again collecting every `CallExpression` whose `expression` is a `PropertyAccessExpression` with `.name.text === "shutdown"`. The receiver does **not** have to be named `runtime` — a future rename to `rt` cannot bypass the check.
4. Asserts: for every `bootstrap` call in `cli-actions.ts`, the enclosing function also contains at least one `.shutdown()` call. (Exactly one `bootstrap` call exists today, inside `withRuntime`. The test will fail if a second appears without its paired shutdown.)
5. Walks [src/server/cli.ts](../../../../src/server/cli.ts) and asserts every `await bootstrap(...)` is inside the `serve` command's action. (Identified by walking up to the nearest `CallExpression` whose `expression` matches `program.command("serve...").description(...).action(...)`.)

The test self-validates by also asserting *exactly one* `bootstrap` call exists in each of the two files (one in `withRuntime`, one in `serve`). If the call count drifts, the test fails with a clear message.

Cost: ~60 lines of test code, no new runtime dependencies. The check is robust to variable renames, dynamic-import re-shapes (`(await import(...)).bootstrap()` is detected by matching the property-access form too), and any future addition of a third short-lived runtime command (it must either route through `withRuntime` or fail the test).

## 5. Strengthened T7 (active-resource leak detection)

The r1 implementation used `new Set(process.getActiveResourcesInfo())` and compared as a set, so a baseline that already contained `PipeWrap` would hide any number of additional leaked `PipeWrap` instances. r2 fixes this with two independent assertions, both run after `withRuntime` resolves through the throw path and after one `setImmediate` tick:

1. **Per-kind count delta**. Build a histogram `Map<string, number>` of resource kinds from `process.getActiveResourcesInfo()` *before* `bootstrap()` and *after* shutdown. For each leak-sensitive kind (`ChildProcess`, `Pipe`, `PipeWrap`, `Process`, `Timeout`, `FSReqCallback`, `FileHandle`, `HandleWrap`), the after-count must be `<=` the before-count. Allow-listing kinds is replaced by an explicit deny-list of kinds we know are leak-relevant; any net positive in those kinds fails the test.
2. **FD-count delta on Linux**. On the dev OS the workspace runs on, `/proc/self/fd` is the cheapest definitive FD-handle count. Before bootstrap, capture `readdirSync("/proc/self/fd").length`; after shutdown + `setImmediate`, re-read and assert `after <= before + ALLOWED_FD_SLACK` where `ALLOWED_FD_SLACK = 2` (vitest's own log file handle may legitimately be added between snapshots). If `/proc/self/fd` does not exist (non-Linux CI), skip with `it.skipIf`.

Both assertions together close the hole reviewer 2 flagged: per-kind histogram catches "leaked an MCP child pipe" even when the baseline already had one of that kind; the FD delta catches anything the kind histogram cannot name (lockfile FD, log-rotation FD).

Rejected alternative: `node:async_hooks` with `createHook({ init, destroy })`. It catches every async resource by id, but the volume of init/destroy events during a real `bootstrap()` (hundreds per provider warm-up) and the cost of distinguishing "test harness" from "runtime" resources outweighs the benefit. The per-kind histogram is the more deterministic signal for this specific leak class.

## 6. Test architecture

| File | Purpose | Top-level mocks? |
|---|---|---|
| [src/server/cli-actions.test.ts](../../../../src/server/cli-actions.test.ts) (new) | T1-T8 — `withRuntime` unit semantics with `bootstrap` mocked. | Yes: `vi.mock("./bootstrap.js")` at top of file. |
| [src/server/cli-actions.e2e.test.ts](../../../../src/server/cli-actions.e2e.test.ts) (new) | T7 — real `bootstrap`, real `shutdown`, real MCP children, force `fn` to throw, assert kind-histogram + FD-count deltas. | **No** — uses the real bootstrap. Kept in a separate file precisely so the unit-test file's top-level `vi.mock("./bootstrap.js")` does not contaminate it. |
| [src/server/cli-actions.invariants.test.ts](../../../../src/server/cli-actions.invariants.test.ts) (new) | AST-based invariant — every `bootstrap()` paired with a `shutdown()` in the same enclosing function; exactly one `bootstrap` call in each of `cli.ts` (inside `serve`) and `cli-actions.ts` (inside `withRuntime`). | No mocks; reads source files. |

Detailed cases are in [03-plan-r2.md §3](03-plan-r2.md).

## 7. Risks (updated)

| Risk | Mitigation |
|---|---|
| `cli-actions.ts` becomes a dumping ground for other CLI helpers. | Module-level docstring restricts scope to "short-lived runtime command actions + their lifecycle helper". Add a new sibling (e.g. `cli-noruntime-actions.ts`) before mixing concerns. |
| The AST invariant test grows stale if `typescript` package APIs shift. | The compiler API surface used (`createSourceFile`, `forEachChild`, `isCallExpression`, `isIdentifier`, `isPropertyAccessExpression`) has been stable since TS 3.x. We pin nothing extra. |
| `/proc/self/fd` assertion is Linux-only. | `it.skipIf(process.platform !== "linux")`. Both vitest CI and the workspace dev box are Linux. macOS contributors lose T7's FD check but still get the kind-histogram check. |
| `process.exit(0)` in tests still kills the worker. | Unchanged from r1: `vi.spyOn(process, "exit").mockImplementation(((code) => { throw new Error(\`__exit:${code ?? 0}\`); }) as never)` in every spec that exercises `withRuntime`. |
| `start` operators have shell scripts grepping for `Fatal:`. | None known (`grep -rn 'Fatal:' src/ docs/ tests/` returns nothing else); change is documented in the rollout note. If a complaint surfaces, revert to a `Fatal:` prefix inside `startAction`'s wrapped callback before re-throwing — but that is back-pressure, not a baseline. |
| `runtime.shutdown()` hangs (MCP child ignoring SIGTERM). | Same r1 contingency: add `MCP_SHUTDOWN_TIMEOUT_MS` constant in [src/server/cli-actions.ts](../../../../src/server/cli-actions.ts) and `Promise.race` inside the finally. Tracked as a follow-up if T7 surfaces a real hang. |
