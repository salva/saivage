# G26 - Review (round 6, GPT-5.5)

## Findings

1. The round-6 test still does not assert the exact operator-facing message. The runtime fix itself is in the right shape: the proposed schema emits the legacy-key issue with `fatal: true` before returning `z.NEVER` ([SPEC/v2/review-2026-05-round2/G26/02-design-r6.md](02-design-r6.md#L95-L101), [SPEC/v2/review-2026-05-round2/G26/03-plan-r6.md](03-plan-r6.md#L124-L130)), and the installed Zod runtime confirms that `arg.fatal` calls `status.abort()` before the preprocess branch can invoke the inner schema ([node_modules/zod/v3/types.js](../../../../node_modules/zod/v3/types.js#L3176-L3183), [node_modules/zod/v3/types.js](../../../../node_modules/zod/v3/types.js#L3210-L3215)). The strengthened assertion also catches inner required-field leakage by requiring exactly one issue ([SPEC/v2/review-2026-05-round2/G26/03-plan-r6.md](03-plan-r6.md#L246-L250)). However, the stated test contract is an exact `ZodError.issues` surface: length, code, path, and message. Round 6 only checks that the message contains the runtime-built key ([SPEC/v2/review-2026-05-round2/G26/02-design-r6.md](02-design-r6.md#L37-L42), [SPEC/v2/review-2026-05-round2/G26/03-plan-r6.md](03-plan-r6.md#L19-L23), [SPEC/v2/review-2026-05-round2/G26/03-plan-r6.md](03-plan-r6.md#L246-L250)). A future implementation could keep the key while weakening or garbling the remediation text and this test would still pass. Required change: make the first legacy-key rejection test assert the full expected message with `toBe`, using the same runtime-built `LEGACY_KEY` interpolation as the schema message. Prefer also applying the same exact code/path/message assertion to the empty-stub fixture so both legacy shapes prove the identical single-issue surface.

## Required Change Coverage

The round-5 blocker around non-fatal preprocess behavior is otherwise addressed. [package.json](../../../../package.json#L39) pins the review to Zod 3.25.x, and the installed implementation shows fatal issues abort the preprocess effect before `_parseSync` runs on the inner object schema ([node_modules/zod/v3/types.js](../../../../node_modules/zod/v3/types.js#L3176-L3215)). That is the correct mechanism for preventing the extra `project_name`, `objectives`, and `skills` required-field issues identified in [SPEC/v2/review-2026-05-round2/G26/04-review-r5.md](04-review-r5.md#L5).

The no-leakage part of the regression is now load-bearing: the otherwise-valid legacy fixture asserts `toHaveLength(1)` before checking the custom code and path ([SPEC/v2/review-2026-05-round2/G26/03-plan-r6.md](03-plan-r6.md#L236-L250)), and the empty-stub fixture also asserts one issue ([SPEC/v2/review-2026-05-round2/G26/03-plan-r6.md](03-plan-r6.md#L254-L263)). The remaining gap is only exact message pinning.

One small documentation cleanup should ride with that edit: the design explains the non-fatal path as if `z.NEVER` were `undefined` and would produce a root object invalid-type issue plus required-field issues ([SPEC/v2/review-2026-05-round2/G26/02-design-r6.md](02-design-r6.md#L142-L149)). The observed installed behavior is the custom issue plus the three required-field issues, which is enough to justify the fatal fix; the extra root-invalid wording is unnecessary and makes the evidence less crisp.

## Anchor Check

The live schema still contains the legacy field in the expected current range ([src/types.ts](../../../../src/types.ts#L12-L30)), so the planned replacement target remains valid. The Zod version and fatal-abort source anchors also match the round-6 analysis ([package.json](../../../../package.json#L39), [node_modules/zod/v3/types.js](../../../../node_modules/zod/v3/types.js#L3176-L3215)).

## What Holds

Proposal A remains the right design: reject only the legacy key with a fatal preprocess issue, keep the inner schema as a plain stripping `z.object`, remove the resolver legacy source tier, and keep Task 1 and Task 3 coupled. Once the schema test pins the exact message, the round-5 objection is fully resolved.

VERDICT: CHANGES_REQUESTED