# G25 - Review (round 4, GPT-5.5)

## Findings

None.

## Required Change Coverage

Round 4 addresses the only round-3 blocker. The prior blocker was the exact `configPath` equality in validator-boundary Task 6, called out at [SPEC/v2/review-2026-05-round2/G25/04-review-r3.md](04-review-r3.md#L7-L13). Round 4 analysis now states the correct source of truth: resolver-created errors keep the resolver-stamped `configPath()` value, while the validator's `configPathStr` argument is only used for its own aggregate `MissingModelForRoleError` at [SPEC/v2/review-2026-05-round2/G25/01-analysis-r4.md](01-analysis-r4.md#L18-L25). The design repeats that same boundary: verbatim rethrow preserves the original error instance and payload at [SPEC/v2/review-2026-05-round2/G25/02-design-r4.md](02-design-r4.md#L56), the payload table defines `configPath` as a non-empty string at [SPEC/v2/review-2026-05-round2/G25/02-design-r4.md](02-design-r4.md#L146-L154), and the validator-boundary inventory row uses the same non-empty-string contract at [SPEC/v2/review-2026-05-round2/G25/02-design-r4.md](02-design-r4.md#L170-L174).

Task 6 in the plan now matches that contract. It still calls `validateModelCoverage` with `"/proj/.saivage/saivage.json"` at [SPEC/v2/review-2026-05-round2/G25/03-plan-r4.md](03-plan-r4.md#L291), still asserts the typed payload fields at [SPEC/v2/review-2026-05-round2/G25/03-plan-r4.md](03-plan-r4.md#L294-L300), and now checks `configPath` only as a non-empty string at [SPEC/v2/review-2026-05-round2/G25/03-plan-r4.md](03-plan-r4.md#L301-L302). This is consistent with the live code boundary: `validateModelCoverage` receives `configPathStr` at [src/config-validation.ts](../../../../src/config-validation.ts#L41-L44) and uses it only when creating `MissingModelForRoleError` at [src/config-validation.ts](../../../../src/config-validation.ts#L69), while resolver-side errors already use the global helper at [src/routing/resolver.ts](../../../../src/routing/resolver.ts#L111) and [src/routing/resolver.ts](../../../../src/routing/resolver.ts#L261). The proposed `NoAllowedRouteMatchError` throw sites preserve that pattern with `configPath()` at [SPEC/v2/review-2026-05-round2/G25/02-design-r4.md](02-design-r4.md#L81) and [SPEC/v2/review-2026-05-round2/G25/02-design-r4.md](02-design-r4.md#L138), and `configPath()` itself derives from the project-local Saivage root rather than the validator argument at [src/config.ts](../../../../src/config.ts#L217-L225).

No other exact-path coverage is silently weakened. Round 4 explicitly leaves the existing `MissingModelForRoleError` path coverage unchanged at [SPEC/v2/review-2026-05-round2/G25/03-plan-r4.md](03-plan-r4.md#L309), and the live validator test still asserts the fixed validator path appears in the error message at [src/config-validation.test.ts](../../../../src/config-validation.test.ts#L116-L119). The resolver-level failure tests already used the non-empty `configPath` contract and remain aligned with the inventory at [SPEC/v2/review-2026-05-round2/G25/03-plan-r4.md](03-plan-r4.md#L89-L90), [SPEC/v2/review-2026-05-round2/G25/03-plan-r4.md](03-plan-r4.md#L122-L123), [SPEC/v2/review-2026-05-round2/G25/03-plan-r4.md](03-plan-r4.md#L177-L178), and [SPEC/v2/review-2026-05-round2/G25/03-plan-r4.md](03-plan-r4.md#L210-L211).

## Open Questions

None.

VERDICT: APPROVED