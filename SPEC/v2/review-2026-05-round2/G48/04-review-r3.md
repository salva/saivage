# G48 - Review r3

## Findings

No blocking findings.

## Verification

- The G51 follow-up is filed at [../G51-partial-bootstrap-teardown.md](../G51-partial-bootstrap-teardown.md) and has the required stub shape: severity, symptom, scope/motivating example, and deferred-to fix shape. It correctly owns bootstrap rejection after side-effectful partial setup, which is outside G48's helper layer.
- The first r2 blocker is resolved. Round 3 points G48 to the actual G51 filename in the analysis, design, and plan. The old absent filename now only remains in historical r1/r2/review material, not in the r3 contract.
- The T8 prefix contract is normalized across the round 3 docs: action and bootstrap failures use `Error:`, shutdown failures use `Shutdown error:`, and the mixed callback-failure plus shutdown-failure case logs each source with its own prefix.
- Exit status follows the action outcome, not teardown. T8 pins a successful action plus shutdown rejection to exit 0 with `Shutdown error:` and no `Error:`; T5 keeps callback failure plus shutdown rejection at exit 1; bootstrap rejection exits 1 without attempting shutdown.
- The rest of r2 is preserved by reference rather than redesigned: the side-effect-free `cli-actions.ts` split, `serve` exclusion, strengthened T7 resource checks, AST invariant test, intentional `Fatal:` to `Error:` normalization, and no-new-config/no-new-regex/no-new-heuristics constraints all remain intact.

## Residual Risk

No residual blocker. G51 is intentionally a deferred finding rather than a full implementation plan, and that is sufficient for G48's scoped-out partial-bootstrap concern.

VERDICT: APPROVED