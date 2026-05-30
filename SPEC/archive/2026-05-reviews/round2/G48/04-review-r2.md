# G48 — Review (Round 2)

- Reviewed: [01-analysis-r2.md](01-analysis-r2.md), [02-design-r2.md](02-design-r2.md), [03-plan-r2.md](03-plan-r2.md)
- Prior review: [04-review-r1.md](04-review-r1.md)
- Issue: [../G48-cli-inspect-runtime-leak-on-throw.md](../G48-cli-inspect-runtime-leak-on-throw.md)
- Live anchor: [../../../../src/server/cli.ts](../../../../src/server/cli.ts)

## Required Changes

1. G51 is still not filed, but round 2 now depends on it as the partial-bootstrap follow-up.

   The scope correction itself is right: [01-analysis-r2.md](01-analysis-r2.md#L39-L43) narrows G48 to failures after `bootstrap()` resolves, and [02-design-r2.md](02-design-r2.md#L48-L50) documents that `withRuntime` cannot shut down a runtime that never returned. The problem is that the same docs claim the excluded bug is covered by G51: [01-analysis-r2.md](01-analysis-r2.md#L71), [02-design-r2.md](02-design-r2.md#L12), and [03-plan-r2.md](03-plan-r2.md#L401) all say it is filed or assigned to G51, while [01-analysis-r2.md](01-analysis-r2.md#L43) still says "to be filed". The linked file, `SPEC/v2/review-2026-05-round2/G51-bootstrap-partial-failure-leaks-runtime-resources.md`, is absent; `rg --files saivage/SPEC/v2/review-2026-05-round2 | rg 'G51'` returns no matches. Since the requested verification explicitly includes "partial-bootstrap scoped out (G51 filed)", this must be fixed before approval.

   Required fix: create the G51 finding at the linked path, or remove the "filed" claim and keep this round blocked until the follow-up exists.

2. The T8 summary in the analysis uses the wrong error prefix.

   The design and plan correctly pin the shutdown-only failure case as `Shutdown error:` with exit code 0: [02-design-r2.md](02-design-r2.md#L205-L209), [03-plan-r2.md](03-plan-r2.md#L158-L170), and [03-plan-r2.md](03-plan-r2.md#L370). However, the analysis resolution table says T8 should "log `Error: ...` (the shutdown failure)" in [01-analysis-r2.md](01-analysis-r2.md#L73). That contradicts the helper contract and the test body. This is a small edit, but it is directly on one of the requested verification points and should be corrected to `Shutdown error:`.

## Verified Improvements

- The `cli-actions.ts` extraction resolves the r1 import-side-effect objection. [src/server/cli.ts](../../../../src/server/cli.ts#L583) still has top-level `program.parse()`, so moving `withRuntime`, `startAction`, and `inspectAction` to a side-effect-free sibling is the right test seam. The plan wires `start` and `inspect` through imported actions while leaving `serve` as the long-lived runtime owner.
- T7 is materially stronger than r1: [02-design-r2.md](02-design-r2.md#L244-L250) and [03-plan-r2.md](03-plan-r2.md#L174-L241) use per-kind resource histograms plus a Linux `/proc/self/fd` count, with the e2e test isolated from the mocked-bootstrap unit file.
- The r1 bootstrap-failure overclaim is mostly fixed. The docs now clearly state that `bootstrap()` rejection and partial-bootstrap rollback are out of G48's implementation scope; only the missing G51 artifact blocks approval.
- The AST invariant is now automated with the TypeScript compiler API in [03-plan-r2.md](03-plan-r2.md#L246-L336), and it avoids the r1 variable-name fragility by checking for `.shutdown()` calls rather than only `runtime.shutdown()`.
- Fatal-to-Error normalization is documented consistently in the design and rollout note. This matches the live source: `start` currently logs `Fatal:` at [src/server/cli.ts](../../../../src/server/cli.ts#L93), while `inspect` logs `Error:` after failures, so the behavior change is intentional rather than accidental.

## Summary

Round 2 fixes the core architecture and test-design objections from r1: the helper moves out of the side-effectful CLI entrypoint, T7 can detect same-kind leaks, T8 exists, the invariant is automated, and `Fatal:` to `Error:` is documented. Approval is blocked only by follow-through on the scoped-out partial-bootstrap bug and the small T8 prefix inconsistency in the analysis.

VERDICT: CHANGES_REQUESTED