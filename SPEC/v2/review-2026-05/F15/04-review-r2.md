# F15 - Review r2

## Reviewer

GPT-5.5 (copilot)

## Documents reviewed

- [SPEC/v2/review-2026-05/_LOOP-CONVENTIONS.md](SPEC/v2/review-2026-05/_LOOP-CONVENTIONS.md)
- [SPEC/v2/review-2026-05/F15/04-review-r1.md](SPEC/v2/review-2026-05/F15/04-review-r1.md)
- [SPEC/v2/review-2026-05/F15/01-analysis-r2.md](SPEC/v2/review-2026-05/F15/01-analysis-r2.md)
- [SPEC/v2/review-2026-05/F15/02-design-r2.md](SPEC/v2/review-2026-05/F15/02-design-r2.md)
- [SPEC/v2/review-2026-05/F15/03-plan-r1.md](SPEC/v2/review-2026-05/F15/03-plan-r1.md)

## Findings

### Analysis

The r1 factual blocker is corrected. The r2 analysis now states that `callProvider` does not call `resolveApiKey` or `setApiKey` ([SPEC/v2/review-2026-05/F15/01-analysis-r2.md](SPEC/v2/review-2026-05/F15/01-analysis-r2.md#L5), [SPEC/v2/review-2026-05/F15/01-analysis-r2.md](SPEC/v2/review-2026-05/F15/01-analysis-r2.md#L55)), which matches the current `callProvider` body ([src/providers/router.ts](src/providers/router.ts#L366-L413)). The corrected account-aware key resolution claim points to the actual `router.chat` candidate loop ([src/providers/router.ts](src/providers/router.ts#L297-L299)).

The rest of the analysis matches the source: the eager bootstrap path is still imported/called/defined at [src/server/bootstrap.ts](src/server/bootstrap.ts#L13), [src/server/bootstrap.ts](src/server/bootstrap.ts#L135), and [src/server/bootstrap.ts](src/server/bootstrap.ts#L740-L762), while the lazy path is centralised in `resolveApiKey` ([src/providers/router.ts](src/providers/router.ts#L174-L200)) and re-applied by the live provider-touching paths ([src/providers/router.ts](src/providers/router.ts#L236-L238), [src/providers/router.ts](src/providers/router.ts#L297-L299), [src/providers/router.ts](src/providers/router.ts#L638-L640), [src/security/prompt-injection-cop.ts](src/security/prompt-injection-cop.ts#L111-L113)).

### Design

The r1 `PROVIDER_TO_OAUTH` ambiguity is resolved. Proposal A now keeps the constant private and adds no public export ([SPEC/v2/review-2026-05/F15/02-design-r2.md](SPEC/v2/review-2026-05/F15/02-design-r2.md#L5), [SPEC/v2/review-2026-05/F15/02-design-r2.md](SPEC/v2/review-2026-05/F15/02-design-r2.md#L11-L14), [SPEC/v2/review-2026-05/F15/02-design-r2.md](SPEC/v2/review-2026-05/F15/02-design-r2.md#L75)), which matches the current private constant in [src/providers/router.ts](src/providers/router.ts#L68-L73) and the unchanged plan instruction ([SPEC/v2/review-2026-05/F15/03-plan-r1.md](SPEC/v2/review-2026-05/F15/03-plan-r1.md#L13)).

Proposal A satisfies the mandatory project guidelines: it deletes the duplicate eager writer, does not introduce a compatibility shim, and does not add unused public surface. Proposal B remains a valid level-up alternative but is correctly left outside this finding's recommended scope ([SPEC/v2/review-2026-05/F15/02-design-r2.md](SPEC/v2/review-2026-05/F15/02-design-r2.md#L40-L67), [SPEC/v2/review-2026-05/F15/02-design-r2.md](SPEC/v2/review-2026-05/F15/02-design-r2.md#L71-L75)).

### Plan

The plan is executable and still aligned with the r2 design. Its edit steps match the current references: bootstrap import/call/helper removal ([src/server/bootstrap.ts](src/server/bootstrap.ts#L13), [src/server/bootstrap.ts](src/server/bootstrap.ts#L135), [src/server/bootstrap.ts](src/server/bootstrap.ts#L740-L762)), `OAUTH_TO_PI` removal ([src/providers/router.ts](src/providers/router.ts#L60-L63)), and `oauthToProviderName` removal plus barrel cleanup ([src/auth/store.ts](src/auth/store.ts#L154-L158), [src/auth/index.ts](src/auth/index.ts#L1)). The search checks and validation commands are concrete, use this repo's Vitest/typecheck/build conventions, and include a focused lazy-resolution regression test ([SPEC/v2/review-2026-05/F15/03-plan-r1.md](SPEC/v2/review-2026-05/F15/03-plan-r1.md#L20-L23), [SPEC/v2/review-2026-05/F15/03-plan-r1.md](SPEC/v2/review-2026-05/F15/03-plan-r1.md#L32-L49)).

## Required changes

## Strengths

- r2 directly addresses both r1 required changes.
- The chosen fix is small and architecture-consistent: delete the duplicate eager writer and keep the existing lazy resolver as the single authority.
- The plan pins the intended lazy behaviour with a focused regression test and includes the broad validation gates needed for a safe implementation pass.

VERDICT: APPROVED