# G48 — Design (Round 3)

- **Analysis**: [01-analysis-r3.md](01-analysis-r3.md)
- **Round 2**: [02-design-r2.md](02-design-r2.md), [04-review-r2.md](04-review-r2.md)

## 0. What changed since r2

The r2 design is accepted in substance. r3 only changes the link target of the partial-bootstrap follow-up:

| r2 design | r3 design |
|---|---|
| References `G51-bootstrap-partial-failure-leaks-runtime-resources.md` (file did not exist). | References [../G51-partial-bootstrap-teardown.md](../G51-partial-bootstrap-teardown.md) (filed in r3). |

The error-prefix contract was already consistent in the r2 design and plan (`Error:` for action failures, `Shutdown error:` for shutdown-only failures); r3 inherits it unchanged. The only r3 fix on that axis is in the analysis (§7), not the design.

Proposal B (the shared helper for `start` and `inspect`, leaving `serve` untouched) is unchanged and remains the selection.

## 1. Module layout (unchanged from r2)

See [02-design-r2.md §1](02-design-r2.md) for the full code listing of [src/server/cli-actions.ts](../../../../src/server/cli-actions.ts), the two `program.command(...).action(...)` rewrites in [src/server/cli.ts](../../../../src/server/cli.ts), and the list of modules **not** touched ([src/server/bootstrap.ts](../../../../src/server/bootstrap.ts), [src/server/server.ts](../../../../src/server/server.ts), [src/agents/inspector.ts](../../../../src/agents/inspector.ts), [src/runtime/recovery.ts](../../../../src/runtime/recovery.ts), `serve`, `installRecoverableSocketErrorGuard`).

## 2. Exact contract of `withRuntime` (unchanged from r2)

| Scenario | `bootstrap()` | `fn(runtime)` | `runtime.shutdown()` | stderr | exit code |
|---|---|---|---|---|---|
| Happy path | resolves | resolves; no `process.exitCode` | called, resolves | (none from helper) | 0 |
| Soft failure inside `fn` | resolves | resolves; sets `process.exitCode = 1` | called, resolves | (whatever `fn` printed) | 1 |
| Hard failure inside `fn` | resolves | throws `boom` | called, resolves | `Error: boom` | 1 |
| `bootstrap` throws | rejects `bf` | not called | not called | `Error: bf` | 1 |
| Shutdown-only failure on success | resolves | resolves; no `process.exitCode` | called, rejects `sd` | `Shutdown error: sd` | **0** (the action succeeded) |
| Shutdown failure during hard failure | resolves | throws `boom` | called, rejects `sd` | `Error: boom` then `Shutdown error: sd` | 1 |
| `fn` throws and sets exitCode | resolves | throws after setting `process.exitCode = 1` | called, resolves | `Error: <msg>` | 1 |

The "shutdown-only failure on success" row (exit 0, prefix `Shutdown error:`) is the contract pinned by T8. A noisy teardown does not invert a successful action's status — matching `serve`'s existing pattern at [src/server/cli.ts L378-L382](../../../../src/server/cli.ts#L378-L382).

The "bootstrap throws" row is the point at which control hands off to [G51](../G51-partial-bootstrap-teardown.md): G48's helper logs `Error:` and exits 1, but does **not** attempt to clean up resources held by the partial bootstrap (no runtime object exists to call `.shutdown()` on). That leak is G51's responsibility.

## 3. Operator-facing behaviour changes (unchanged from r2)

See [02-design-r2.md §3](02-design-r2.md). Summary: `saivage start` thrown-error prefix changes from `Fatal:` to `Error:` (intentional normalization); `saivage inspect` no longer hangs after a thrown failure; explicit `process.exit(process.exitCode ?? 0)` at end of `withRuntime` defends against half-closed MCP child handles holding the loop open past teardown.

## 4. Automated invariant test (unchanged from r2)

See [02-design-r2.md §4](02-design-r2.md). [src/server/cli-actions.invariants.test.ts](../../../../src/server/cli-actions.invariants.test.ts) uses the TypeScript compiler API to walk [src/server/cli.ts](../../../../src/server/cli.ts) and [src/server/cli-actions.ts](../../../../src/server/cli-actions.ts) ASTs and assert the bootstrap/shutdown pairing invariant independent of the variable name.

## 5. Strengthened T7 (unchanged from r2)

See [02-design-r2.md §5](02-design-r2.md). Per-kind count delta on `process.getActiveResourcesInfo()` plus `/proc/self/fd` directory-length delta on Linux.

## 6. Test architecture (unchanged from r2)

| File | Purpose | Top-level mocks? |
|---|---|---|
| [src/server/cli-actions.test.ts](../../../../src/server/cli-actions.test.ts) (new) | T1-T8 — `withRuntime` unit semantics with `bootstrap` mocked. | Yes: `vi.mock("./bootstrap.js")` at top of file. |
| [src/server/cli-actions.e2e.test.ts](../../../../src/server/cli-actions.e2e.test.ts) (new) | T7 — real `bootstrap`, real `shutdown`, real MCP children, force `fn` to throw, assert kind-histogram + FD-count deltas. | **No** — uses the real bootstrap. |
| [src/server/cli-actions.invariants.test.ts](../../../../src/server/cli-actions.invariants.test.ts) (new) | AST-based invariant — every `bootstrap()` paired with a `shutdown()` in the same enclosing function; exactly one `bootstrap` call in each of `cli.ts` (inside `serve`) and `cli-actions.ts` (inside `withRuntime`). | No mocks; reads source files. |

Detailed cases are in [03-plan-r3.md §3](03-plan-r3.md).

## 7. Risks (unchanged from r2)

See [02-design-r2.md §7](02-design-r2.md). `cli-actions.ts` scope creep mitigated by the module-level docstring; AST invariant test uses stable TS compiler API surface; `/proc/self/fd` is Linux-only and `it.skipIf`-guarded for macOS; `process.exit(0)` in tests handled by `vi.spyOn` throwing on call; `Fatal:`→`Error:` rename has no other call sites; `runtime.shutdown()` hang stays a contingency (`MCP_SHUTDOWN_TIMEOUT_MS` + `Promise.race`), not a baseline.
