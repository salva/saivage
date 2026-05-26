# G48 — Analysis (Round 3)

- **Issue**: [../G48-cli-inspect-runtime-leak-on-throw.md](../G48-cli-inspect-runtime-leak-on-throw.md)
- **Round 2**: [01-analysis-r2.md](01-analysis-r2.md), [02-design-r2.md](02-design-r2.md), [03-plan-r2.md](03-plan-r2.md), [04-review-r2.md](04-review-r2.md)
- **Subsystem**: server / CLI ([src/server/cli.ts](../../../../src/server/cli.ts))
- **Severity**: low (operator-visible hang; secondary: orphan MCP children racing the next bootstrap)

## 0. Round 3 deltas (vs. r2)

This round addresses the two blockers in [04-review-r2.md](04-review-r2.md). No design or test-architecture decision from r2 is revisited; the analysis, design, and plan stand otherwise.

1. **G51 stub now exists.** r2 claimed the partial-bootstrap follow-up was filed as G51 but the linked file was absent. r3 ships [../G51-partial-bootstrap-teardown.md](../G51-partial-bootstrap-teardown.md) — a brief stub describing the partial-bootstrap-failure scope, its motivating example from G48, and the deferred-to fix shape. The link path in r2's docs (`G51-bootstrap-partial-failure-leaks-runtime-resources.md`) is replaced workspace-wide with the actual filename, [../G51-partial-bootstrap-teardown.md](../G51-partial-bootstrap-teardown.md).

2. **T8 prefix in §7 corrected.** r2's resolution table said T8 should "log `Error: ...` (the shutdown failure)". That contradicted the design and plan, both of which correctly pin the shutdown-only-failure path to `Shutdown error:`. r3 normalizes the analysis to match: action failures log `Error:`; shutdown-only failures log `Shutdown error:`. See §7 below.

Nothing else changes. The full r2 analysis stands as written.

## 1. Restated finding (unchanged from r2)

See [01-analysis-r2.md §1](01-analysis-r2.md). The `saivage inspect` subcommand boots a full Saivage runtime ([src/server/cli.ts L228](../../../../src/server/cli.ts#L228)) and calls `runtime.shutdown()` ([src/server/cli.ts L262](../../../../src/server/cli.ts#L262)) only on the happy path; any throw skips shutdown and leaks runtime resources. The `start` action already encodes the correct `finally { runtime?.shutdown() }` pattern at [src/server/cli.ts L60-L98](../../../../src/server/cli.ts#L60-L98).

## 2. Evidence (unchanged from r2)

See [01-analysis-r2.md §2](01-analysis-r2.md). Live line numbers in [src/server/cli.ts](../../../../src/server/cli.ts) and [src/server/bootstrap.ts](../../../../src/server/bootstrap.ts) are accurate as of r3 verification (no source drift since r2).

## 3. Partial-bootstrap-failure: scope and follow-up (G51 link updated)

G48 explicitly narrows scope to **failures after `bootstrap()` resolves**:

- Anything thrown by `fn(runtime)` inside the helper, by `JSON.stringify(result.data, ...)`, by `InspectorAgent.create(...)`, by `inspector.run()`, or by `runPlanner(...)` after the runtime has been returned to the helper is **in scope** for G48. The helper guarantees exactly one `runtime.shutdown()` against the live runtime.
- Anything thrown by `bootstrap()` itself — including a throw between `acquireRuntimeLock(...)` ([src/server/bootstrap.ts L182](../../../../src/server/bootstrap.ts#L182)) and the final `return runtime;` — is **out of scope** for G48. `installFatalHandlers(runtime, runtimeLock)` is not yet installed at the point the throw happens ([src/server/bootstrap.ts L259](../../../../src/server/bootstrap.ts#L259)), so the partial state (open lockfile, spawned MCP children, started supervisor monitoring) is genuinely orphaned. This is a real bug, but it is **a different bug** with a different fix shape (making `bootstrap` transactional — accumulate rollback closures and run them on throw).
- Follow-up finding: [G51 — partial-bootstrap teardown](../G51-partial-bootstrap-teardown.md) is **filed** at [SPEC/v2/review-2026-05-round2/G51-partial-bootstrap-teardown.md](../G51-partial-bootstrap-teardown.md). G48 does not block on it. G48's helper contract states explicitly that `bootstrap`-rejection paths are the caller's responsibility (and `withRuntime` simply forwards the error to stderr with `Error:` and exits 1, matching today's `inspect` behaviour for that branch).

## 4. Test-architecture constraints (unchanged from r2)

See [01-analysis-r2.md §4](01-analysis-r2.md). r3 keeps Option B — split into [src/server/cli-actions.ts](../../../../src/server/cli-actions.ts) — for the same reasons.

## 5. Operator-facing behaviour: `Fatal:` → `Error:` (unchanged from r2)

See [01-analysis-r2.md §5](01-analysis-r2.md). `start`'s thrown-error prefix is intentionally normalized from `Fatal:` to `Error:` to match `inspect` and `init`. Per workspace policy ("Architecture-first, no backward compatibility") this is the correct move.

## 6. Scope boundaries (unchanged from r2, G51 link updated)

- **In scope**: `inspect` and `start` actions in [src/server/cli.ts](../../../../src/server/cli.ts), extracted to [src/server/cli-actions.ts](../../../../src/server/cli-actions.ts). New unit test file [src/server/cli-actions.test.ts](../../../../src/server/cli-actions.test.ts), new e2e leak test file [src/server/cli-actions.e2e.test.ts](../../../../src/server/cli-actions.e2e.test.ts), new invariant test file [src/server/cli-actions.invariants.test.ts](../../../../src/server/cli-actions.invariants.test.ts).
- **Out of scope**: `serve` (long-lived; owns its own signal-driven shutdown); `note`, `request-shutdown`, `status`, `models`, `login`, `logout`, `init`, `validate-stage-id` (do not call `bootstrap()`); partial-bootstrap teardown ([G51](../G51-partial-bootstrap-teardown.md), separate finding).
- **No new configuration keys**, **no new regex**, **no new agent-tool-call heuristics**, **no new operator-tuned hardcoded values**.

## 7. Open questions resolved in this round (T8 prefix corrected)

| Question | Resolution |
|---|---|
| Where does the helper live? | [src/server/cli-actions.ts](../../../../src/server/cli-actions.ts) — new side-effect-free sibling module. |
| What about partial-bootstrap leaks? | Out of scope for G48; filed as [G51](../G51-partial-bootstrap-teardown.md). |
| Strengthen T7 how? | Per-kind count delta on `process.getActiveResourcesInfo()`, plus `/proc/self/fd` directory-length delta on Linux. |
| What if `runtime.shutdown()` rejects on the **success** path? | T8 pins this: log `Shutdown error: <msg>` on stderr; keep `process.exitCode` as the action set it (0 for a successful run); exit 0. A noisy teardown does **not** invert a successful action's status. |
| What if `runtime.shutdown()` rejects on a **failure** path (callback already threw)? | Log `Error: <msg>` for the callback failure **and** `Shutdown error: <msg>` for the teardown; exit 1 (the callback's failure dominates). T5 pins this. |
| Keep `Fatal:` in `start`? | No; normalize to `Error:`. Documented. |
| Reuse G30's `scanForSyncFs`? | No; it is sync-fs-specific. G48 ships an AST-based invariant test ([src/server/cli-actions.invariants.test.ts](../../../../src/server/cli-actions.invariants.test.ts)) using the TypeScript compiler API already in dependencies. |

### Error-prefix contract (consolidated)

Single source of truth, matching [02-design-r3.md §2](02-design-r3.md) and [03-plan-r3.md §3](03-plan-r3.md):

| Failure surface | stderr prefix | exit code |
|---|---|---|
| Callback `fn(runtime)` throws | `Error: <msg>` | 1 |
| `bootstrap()` rejects | `Error: <msg>` | 1 |
| `runtime.shutdown()` rejects on success path | `Shutdown error: <msg>` | **0** |
| `runtime.shutdown()` rejects on failure path | `Error: <callback-msg>` then `Shutdown error: <shutdown-msg>` | 1 |

The prefix is `Error:` for any action failure (callback throw or bootstrap reject) and `Shutdown error:` for shutdown-only failures. Exit code follows the action's outcome, not the shutdown's.
