# G48 — Analysis (Round 2)

- **Issue**: [../G48-cli-inspect-runtime-leak-on-throw.md](../G48-cli-inspect-runtime-leak-on-throw.md)
- **Round 1**: [01-analysis-r1.md](01-analysis-r1.md), [02-design-r1.md](02-design-r1.md), [03-plan-r1.md](03-plan-r1.md), [04-review-r1.md](04-review-r1.md)
- **Subsystem**: server / CLI ([src/server/cli.ts](../../../../src/server/cli.ts))
- **Severity**: low (operator-visible hang; secondary: orphan MCP children racing the next bootstrap)

## 0. Round 2 deltas (vs. r1)

This round narrows scope, refines the test architecture, and lines up the live `start` behaviour with the proposed normalization. Six concerns from [04-review-r1.md](04-review-r1.md) drive the deltas:

1. r1 plan exported a test seam from [src/server/cli.ts](../../../../src/server/cli.ts), whose top-level `program.parse()` at [L583](../../../../src/server/cli.ts#L583) makes the module unimportable from vitest. **Fix**: extract the lifecycle helper and the two short-lived actions into a side-effect-free sibling module, [src/server/cli-actions.ts](../../../../src/server/cli-actions.ts) (new). [src/server/cli.ts](../../../../src/server/cli.ts) imports them and stays the executable entrypoint.
2. r1 T7 used `process.getActiveResourcesInfo()` as a set-difference, which silently masks "more `PipeWrap` than baseline". **Fix**: assert per-kind count deltas for the leak-sensitive kinds, and additionally compare `/proc/self/fd` directory length on Linux (the dev/CI OS) for an FD-count check the kind histogram cannot see.
3. r1 analysis claimed `bootstrap()` throwing mid-flight is in scope, but the recommended helper cannot clean up partial state. **Fix**: scope is narrowed to "failures after `bootstrap()` resolves." Partial-bootstrap teardown becomes a documented follow-up finding (§3, §6), and the design explicitly states the helper does not, and cannot, clean up resources held by a bootstrap that never returned a runtime.
4. r1 test matrix missed the shutdown-only failure path. **Fix**: add T8 — callback succeeds, `runtime.shutdown()` rejects — pinning the contract that shutdown rejections are logged and do **not** override a successful action's exit code.
5. r1 §3.4 listed manual grep checks. **Fix**: replace with an automated vitest spec ([src/server/cli-actions.invariants.test.ts](../../../../src/server/cli-actions.invariants.test.ts), new) that uses the TypeScript compiler API to walk [src/server/cli.ts](../../../../src/server/cli.ts) and [src/server/cli-actions.ts](../../../../src/server/cli-actions.ts) AST and asserts the bootstrap/shutdown pairing invariant independent of the variable name chosen (`runtime`, `rt`, etc.). G30's `scanForSyncFs` helper is sync-fs-specific and not reusable here; G48 ships its own AST walk in the test file, with no new production helper.
6. r1 design claimed the `Error:` prefix is preserved from `start`'s existing path, but [src/server/cli.ts L92](../../../../src/server/cli.ts#L92) currently logs `Fatal:`. **Fix**: `start` is intentionally normalized to `Error:` to match `inspect` and `init`. The behavioural change is documented in §5 below and re-stated in the design's rollout note.

No other claims from r1 change. Bug localization, Proposal B (shared `withRuntime` for `start` and `inspect`, leaving `serve` untouched), and the project-rule compliance check ([01-analysis-r1.md §5](01-analysis-r1.md)) stand.

## 1. Restated finding (unchanged from r1)

The `saivage inspect` subcommand boots a full Saivage runtime ([src/server/cli.ts L228](../../../../src/server/cli.ts#L228)) and calls `runtime.shutdown()` ([src/server/cli.ts L262](../../../../src/server/cli.ts#L262)) only on the happy path. Any throw inside `InspectorAgent.create(...)`, `inspector.run()`, or `JSON.stringify(...)` jumps into the outer `catch` ([src/server/cli.ts L263-L269](../../../../src/server/cli.ts#L263-L269)) and skips `runtime.shutdown()`, leaving MCP child stdio, the supervisor interval, RuntimeTracker writers, and the runtime lockfile FD holding the event loop open. The `start` action ([src/server/cli.ts L60-L98](../../../../src/server/cli.ts#L60-L98)) already encodes the correct pattern; the asymmetry is the structural root cause.

## 2. Evidence (live line numbers)

| # | Location | Live lines | Notes |
|---|---|---|---|
| 1 | [src/server/cli.ts](../../../../src/server/cli.ts#L217-L270) | L217-L270 | Whole `inspect` action. Shutdown only on success path. |
| 2 | [src/server/cli.ts](../../../../src/server/cli.ts#L60-L98) | L60-L98 | `start` action — uses `finally { await runtime?.shutdown(); }`. Logs `Fatal:` on error (L92). |
| 3 | [src/server/cli.ts](../../../../src/server/cli.ts#L583) | L583 | `program.parse();` — top-level side effect. Why r1's import-the-CLI test seam does not work. |
| 4 | [src/server/cli.ts](../../../../src/server/cli.ts#L307-L390) | L307-L390 | `serve` — long-lived runtime owner; deliberately excluded from the helper. |
| 5 | [src/server/bootstrap.ts](../../../../src/server/bootstrap.ts#L173-L182) | L173-L182 | Runtime lockfile acquired here. Skipping `shutdown()` keeps the lock FD open. |
| 6 | [src/server/bootstrap.ts](../../../../src/server/bootstrap.ts#L225-L249) | inside `runtime.shutdown` | Freezes tracker, writes shutdown summary, stops supervisor, terminates MCP children, clears event bus, writes idle state, releases lock. |
| 7 | [src/server/bootstrap.ts](../../../../src/server/bootstrap.ts#L259) | L259 | `installFatalHandlers(runtime, runtimeLock)` — global `uncaughtException`/`unhandledRejection` hooks. Outlive any leaked `inspect`. |

## 3. Partial-bootstrap-failure: scope and follow-up

[04-review-r1.md](04-review-r1.md#L34-L41) flagged that r1's analysis claimed coverage of "throws inside `bootstrap()` after lockfile acquisition", but the recommended `withRuntime` helper cannot call `runtime.shutdown()` when `bootstrap()` rejects (no runtime exists). This round explicitly narrows G48's scope to **failures after `bootstrap()` resolves**:

- Anything thrown by `fn(runtime)` inside the helper, by `JSON.stringify(result.data, ...)`, by `InspectorAgent.create(...)`, by `inspector.run()`, or by `runPlanner(...)` after the runtime has been returned to the helper is **in scope** for G48. The helper guarantees exactly one `runtime.shutdown()` against the live runtime.
- Anything thrown by `bootstrap()` itself — including a throw between `acquireRuntimeLock(...)` ([src/server/bootstrap.ts L182](../../../../src/server/bootstrap.ts#L182)) and the final `return runtime;` — is **out of scope** for G48. `installFatalHandlers(runtime, runtimeLock)` is not yet installed at the point the throw happens (it is installed after the runtime object is built — [src/server/bootstrap.ts L259](../../../../src/server/bootstrap.ts#L259)), so the partial state (open lockfile, spawned MCP children, started supervisor monitoring) is genuinely orphaned. This is a real bug, but it is **a different bug** with a different fix shape (making `bootstrap` transactional — accumulate "rollback" closures and run them on throw).
- Follow-up finding: open a new round-2 finding **G51 — bootstrap is not transactional** ([SPEC/v2/review-2026-05-round2/G51-bootstrap-partial-failure-leaks-runtime-resources.md](../G51-bootstrap-partial-failure-leaks-runtime-resources.md), to be filed). G48 does not block on it; G48's helper contract states explicitly that `bootstrap`-rejection paths are the caller's responsibility (and `withRuntime` simply forwards the error to stderr with `Error:` and exits 1, matching today's `inspect` behaviour for that branch).

## 4. Test-architecture constraints

The r1 plan's blocker was that `cli.ts` has a top-level `program.parse()` ([src/server/cli.ts L583](../../../../src/server/cli.ts#L583)) that runs at import time, parses vitest's argv, and either exits the worker (`--help` style) or invokes a real subcommand action. There are two viable resolutions:

- **Option A — guard the parse**: replace L583 with `if (import.meta.url === pathToFileURL(process.argv[1]).href) program.parse();` or `if (process.env.SAIVAGE_CLI_AS_ENTRYPOINT === "1") program.parse();`. **Rejected**: the guard logic is brittle (subtle `process.argv[1]` resolution on symlinks, ts-node, bundlers, dist build paths) and forces every test that imports `cli.ts` to know the guard convention. It also exports test-only behaviour from the executable entrypoint, which is what the review called out as the architecture violation.
- **Option B — split into a side-effect-free sibling**: move the helper and the two short-lived actions to [src/server/cli-actions.ts](../../../../src/server/cli-actions.ts) (new). [src/server/cli.ts](../../../../src/server/cli.ts) imports `withRuntime`, `startAction`, `inspectAction` and wires them into commander; nothing else in `cli.ts` changes. The new module has no `program`, no `parse`, no top-level side effects. **Selected**: matches the architecture-first principle (one module, one job), gives a clean import surface for vitest (`import { withRuntime, startAction, inspectAction } from "../../src/server/cli-actions.js"`), and does not need any "test-only" exports from `cli.ts`.

`installRecoverableSocketErrorGuard` ([src/server/cli.ts L18-L31](../../../../src/server/cli.ts#L18-L31)) stays in `cli.ts` — it is a process-global side effect rightly bound to the executable entrypoint, not the action layer.

## 5. Operator-facing behaviour: `Fatal:` → `Error:` (intentional)

Today, on a thrown error inside the `start` action, [src/server/cli.ts L92](../../../../src/server/cli.ts#L92) logs `Fatal: <message>`. Every other subcommand that boots a runtime (`inspect`) or seeds a project (`init`) logs `Error: <message>`. After the refactor, `start` will share the helper with `inspect`, and the helper writes `Error:` once on any thrown failure. The `Fatal:` prefix is intentionally retired.

Per workspace policy ("Architecture-first, no backward compatibility"), normalizing this is the correct move. No existing tests or runbooks grep for `Fatal:` in `start`'s output (confirmed: `grep -rn 'Fatal:' src/ docs/ tests/` returns no matches outside the cli.ts line itself). The change is called out in the design's rollout note.

## 6. Scope boundaries (unchanged from r1, plus the §3 clarification)

- **In scope**: `inspect` and `start` actions in [src/server/cli.ts](../../../../src/server/cli.ts), extracted to [src/server/cli-actions.ts](../../../../src/server/cli-actions.ts). New unit test file [src/server/cli-actions.test.ts](../../../../src/server/cli-actions.test.ts), new e2e leak test file [src/server/cli-actions.e2e.test.ts](../../../../src/server/cli-actions.e2e.test.ts), new invariant test file [src/server/cli-actions.invariants.test.ts](../../../../src/server/cli-actions.invariants.test.ts).
- **Out of scope**: `serve` (long-lived; owns its own signal-driven shutdown); `note`, `request-shutdown`, `status`, `models`, `login`, `logout`, `init`, `validate-stage-id` (do not call `bootstrap()`); partial-bootstrap teardown (G51, separate finding).
- **No new configuration keys**, **no new regex**, **no new agent-tool-call heuristics**, **no new operator-tuned hardcoded values**. The shutdown timeout contingency from [02-design-r1.md §3.4](02-design-r1.md) remains a contingency, not a baseline.

## 7. Open questions resolved in this round

| Question | Resolution |
|---|---|
| Where does the helper live? | [src/server/cli-actions.ts](../../../../src/server/cli-actions.ts) — new side-effect-free sibling module. |
| What about partial-bootstrap leaks? | Out of scope for G48; filed as G51. |
| Strengthen T7 how? | Per-kind count delta on `process.getActiveResourcesInfo()` (the API stable since Node 17.3 — [01-analysis-r1.md §7](01-analysis-r1.md#L51-L55)), plus `/proc/self/fd` directory length delta on Linux. |
| What if `runtime.shutdown()` rejects on the success path? | T8 pins this: log `Error: ...` (the shutdown failure), keep `process.exitCode` as the action set it (typically 0 for the success-path test), exit accordingly. |
| Keep `Fatal:` in `start`? | No; normalize to `Error:`. Documented. |
| Reuse G30's `scanForSyncFs`? | No; it is sync-fs-specific. G48 ships an AST-based invariant test ([src/server/cli-actions.invariants.test.ts](../../../../src/server/cli-actions.invariants.test.ts)) using the TypeScript compiler API already in dependencies. |
