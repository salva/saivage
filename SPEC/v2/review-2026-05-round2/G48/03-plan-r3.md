# G48 — Plan (Round 3)

- **Analysis**: [01-analysis-r3.md](01-analysis-r3.md)
- **Design**: [02-design-r3.md](02-design-r3.md)
- **Round 2**: [03-plan-r2.md](03-plan-r2.md), [04-review-r2.md](04-review-r2.md)

## 0. r3 deltas (vs. r2 plan)

Two corrections from [04-review-r2.md](04-review-r2.md). No sequencing or test-case content changes.

1. **G51 link target updated.** All references to `G51-bootstrap-partial-failure-leaks-runtime-resources.md` are replaced with the actual filed path [../G51-partial-bootstrap-teardown.md](../G51-partial-bootstrap-teardown.md). The G51 stub is filed at [SPEC/v2/review-2026-05-round2/G51-partial-bootstrap-teardown.md](../G51-partial-bootstrap-teardown.md) and describes the deferred follow-up.
2. **T8 prefix verbiage normalized.** The plan body and the regression-test matrix consistently use `Shutdown error:` for the shutdown-only failure (T8) and `Error:` for action failures (T2, T3, T5). The r2 plan already did so in the code listings and the matrix; r3 keeps the same wording and removes the residual `Error: ...` slip that lived in the r2 analysis (fixed in [01-analysis-r3.md §7](01-analysis-r3.md)).

Everything else — sequenced steps, file paths, test bodies, validation commands — stays identical to r2. The r2 plan is the authoritative reference for any field not restated here.

## 1. Sequenced steps (unchanged from r2)

See [03-plan-r2.md §1](03-plan-r2.md) for the seven steps:

1. Create [src/server/cli-actions.ts](../../../../src/server/cli-actions.ts) per [02-design-r3.md §1.1](02-design-r3.md).
2. Edit [src/server/cli.ts](../../../../src/server/cli.ts) — add `import { startAction, inspectAction } from "./cli-actions.js";` and replace inline action bodies at [src/server/cli.ts L60-L98](../../../../src/server/cli.ts#L60-L98) and [src/server/cli.ts L218-L269](../../../../src/server/cli.ts#L218-L269) with `.action(startAction)` / `.action(inspectAction)`.
3. `npm run build` + `npm test` baseline.
4. Create [src/server/cli-actions.test.ts](../../../../src/server/cli-actions.test.ts) — T1-T6 + T8 with `vi.mock("./bootstrap.js")` at the top.
5. Create [src/server/cli-actions.e2e.test.ts](../../../../src/server/cli-actions.e2e.test.ts) — T7 with real bootstrap, kind-histogram + FD-count deltas.
6. Create [src/server/cli-actions.invariants.test.ts](../../../../src/server/cli-actions.invariants.test.ts) — AST-based bootstrap/shutdown pairing check.
7. Final validation: `npm run build`, `npm test`, then the three new files specifically.

The full code listings for each step are in [03-plan-r2.md](03-plan-r2.md) §1 Step 1-7. They apply verbatim to r3.

## 2. Order of file edits (unchanged from r2)

See [03-plan-r2.md §2](03-plan-r2.md).

## 3. Regression-test matrix (prefix contract normalized)

The matrix is identical to r2's. Stating it inline here so the prefix contract is unambiguous and matches [01-analysis-r3.md §7](01-analysis-r3.md):

| # | File | Scenario | Assertion |
|---|---|---|---|
| T1 | cli-actions.test.ts | Happy path | shutdown × 1, exit 0, no `Error:` and no `Shutdown error:` on stderr |
| T2 | cli-actions.test.ts | Callback throws | shutdown × 1, exit 1, `Error: <callback-msg>` on stderr |
| T3 | cli-actions.test.ts | `bootstrap()` rejects | shutdown × 0, exit 1, `Error: <bootstrap-msg>` on stderr |
| T4 | cli-actions.test.ts | Callback sets `process.exitCode = 1` | shutdown × 1, exit 1, no `Error:` log |
| T5 | cli-actions.test.ts | Callback throws AND shutdown rejects | shutdown × 1, exit 1, both `Error: <callback-msg>` and `Shutdown error: <shutdown-msg>` on stderr |
| T6 | cli-actions.test.ts | Callback throws AND sets exitCode | shutdown × 1 (exactly once), exit 1 |
| T7 | cli-actions.e2e.test.ts | Real bootstrap + forced throw | per-kind histogram delta ≤ 0 for all leak-sensitive kinds; FD delta ≤ 2 on Linux |
| T8 | cli-actions.test.ts | Shutdown-only failure on success path | shutdown × 1, exit **0**, `Shutdown error: <shutdown-msg>` on stderr, **no `Error:`** log |

The T8 assertion is exactly what [03-plan-r2.md §1 Step 4 T8](03-plan-r2.md) already encodes:

```ts
expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("Shutdown error: teardown failed"));
expect(errSpy).not.toHaveBeenCalledWith(expect.stringContaining("Error: teardown failed"));
expect(exitSpy).toHaveBeenCalledWith(0);
```

`Error:` is reserved for action failures (callback throw, bootstrap reject). `Shutdown error:` is reserved for shutdown-only failures. On a mixed callback-throw + shutdown-reject case (T5) both prefixes appear, but each tagged to its own failure source — no prefix is reused.

## 4. Risks & contingencies (unchanged from r2)

See [03-plan-r2.md §4](03-plan-r2.md). Vitest per-file `vi.mock` scope; `MCP_SHUTDOWN_TIMEOUT_MS` as a contingency, not a baseline; `Fatal:`→`Error:` rename has no other call sites; AST invariant test reads source files (not compiled output); T7 FD-slack of 2.

## 5. Rollout note (unchanged from r2)

See [03-plan-r2.md §5](03-plan-r2.md). Operator-visible: `saivage start` prefix changes `Fatal:` → `Error:` (exit code unchanged at 1); `saivage inspect` no longer hangs after a thrown failure; orphan-lockfile false-positives on consecutive runs disappear.

## 6. Done criteria

- All eight new tests (T1-T8) pass with the prefix contract in §3 above.
- `npm run build` and `npm test` pass cleanly on the full suite.
- The AST invariant test detects exactly one `bootstrap()` call in [src/server/cli.ts](../../../../src/server/cli.ts) (inside `serve`) and exactly one in [src/server/cli-actions.ts](../../../../src/server/cli-actions.ts) (inside `withRuntime`); both are paired with a `.shutdown()` call in the same function.
- [src/server/cli.ts](../../../../src/server/cli.ts) contains no references to `bootstrap`, `runPlanner`, `InspectorAgent`, `agentId`, `inspectionId`, or `SaivageRuntime` outside the `serve` action body.
- No new configuration keys; no new regex for parsing user intent; no new agent-tool-call heuristics; no new operator-tuned hardcoded values.
- [G51 — partial-bootstrap teardown](../G51-partial-bootstrap-teardown.md) is filed at [SPEC/v2/review-2026-05-round2/G51-partial-bootstrap-teardown.md](../G51-partial-bootstrap-teardown.md) as a separate, deferred finding; G48 does not block on it.
