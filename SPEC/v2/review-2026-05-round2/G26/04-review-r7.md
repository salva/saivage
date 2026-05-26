# G26 - Review (round 7, GPT-5.5)

## Findings

No blocking findings.

The round-6 blocker is addressed. Round 6 required the legacy-key rejection test to assert the full operator-facing message with `toBe`, preferably in both the populated and empty-stub fixtures ([SPEC/v2/review-2026-05-round2/G26/04-review-r6.md](04-review-r6.md#L5)). Round 7 now defines `EXACT_MESSAGE` from the same runtime-built legacy key and message template used by the schema ([SPEC/v2/review-2026-05-round2/G26/02-design-r7.md](02-design-r7.md#L157-L166), [SPEC/v2/review-2026-05-round2/G26/03-plan-r7.md](03-plan-r7.md#L127-L136)), and both rejection fixtures assert the exact message with `issue.message.toBe(EXACT_MESSAGE)` after pinning the single issue, code, and path ([SPEC/v2/review-2026-05-round2/G26/02-design-r7.md](02-design-r7.md#L180-L192), [SPEC/v2/review-2026-05-round2/G26/02-design-r7.md](02-design-r7.md#L200-L207), [SPEC/v2/review-2026-05-round2/G26/03-plan-r7.md](03-plan-r7.md#L151-L162), [SPEC/v2/review-2026-05-round2/G26/03-plan-r7.md](03-plan-r7.md#L171-L177)). That closes the substantive assertion gap without reintroducing the literal legacy bareword into the planned test source.

The documentation cleanup requested in round 6 is also materially addressed. The revised non-fatal-path note no longer claims an extra root `invalid_type` issue; it states the observed surface as the custom preprocess issue plus the three required-field issues from the inner object schema ([SPEC/v2/review-2026-05-round2/G26/02-design-r7.md](02-design-r7.md#L110-L117)). That is the behavior the fatal preprocess issue is meant to prevent, and the plan keeps the validation focused on one custom issue plus the exact message ([SPEC/v2/review-2026-05-round2/G26/03-plan-r7.md](03-plan-r7.md#L230-L240)).

## Residual Risk

One non-blocking wording nit remains: the design still says `z.NEVER` is `undefined` at runtime ([SPEC/v2/review-2026-05-round2/G26/02-design-r7.md](02-design-r7.md#L110-L112)), while installed Zod exports `NEVER` as the `INVALID` sentinel object ([node_modules/zod/v3/types.js](../../../../node_modules/zod/v3/types.js#L3693), [node_modules/zod/v3/helpers/parseUtil.js](../../../../node_modules/zod/v3/helpers/parseUtil.js#L101-L103)). I am not treating this as a blocker because the corrected issue-surface claim, fatal-abort mechanism, and test assertions are the load-bearing parts of G26, and all three are now in the right shape.

## Anchor Check

The live schema still contains the legacy `model_overrides` field at the expected replacement target ([src/types.ts](../../../../src/types.ts#L12-L30)), so the planned source edit remains anchored. The strengthened test plan preserves the grep gate by building both `LEGACY_KEY` and `EXACT_MESSAGE` at runtime ([SPEC/v2/review-2026-05-round2/G26/03-plan-r7.md](03-plan-r7.md#L62-L65), [SPEC/v2/review-2026-05-round2/G26/03-plan-r7.md](03-plan-r7.md#L208-L213)), while still making the operator-facing message a strict contract.

## Verdict

Approve. Round 7 resolves the prior blocker and the only remaining concern is doc wording precision, not implementation correctness or test coverage.

VERDICT: APPROVED