# F15 — Review (r1)

## Reviewer

GPT-5.5 (copilot)

## Documents reviewed

- [SPEC/v2/review-2026-05/F15-oauth-token-resolution-overlap.md](SPEC/v2/review-2026-05/F15-oauth-token-resolution-overlap.md)
- [SPEC/v2/review-2026-05/F15/01-analysis-r1.md](SPEC/v2/review-2026-05/F15/01-analysis-r1.md)
- [SPEC/v2/review-2026-05/F15/02-design-r1.md](SPEC/v2/review-2026-05/F15/02-design-r1.md)
- [SPEC/v2/review-2026-05/F15/03-plan-r1.md](SPEC/v2/review-2026-05/F15/03-plan-r1.md)

## Findings

### Analysis

The core diagnosis is accurate. Bootstrap imports the OAuth helpers and eagerly calls `injectOAuthTokens` during provider initialization ([src/server/bootstrap.ts](src/server/bootstrap.ts#L13), [src/server/bootstrap.ts](src/server/bootstrap.ts#L135), [src/server/bootstrap.ts](src/server/bootstrap.ts#L740-L762)). The router already has the account-aware lazy resolution path in `resolveApiKey` ([src/providers/router.ts](src/providers/router.ts#L174-L200)), and the live provider-touching call sites re-apply the resolved key before model listing, chat, and startup usage inspection ([src/providers/router.ts](src/providers/router.ts#L236-L238), [src/providers/router.ts](src/providers/router.ts#L297-L299), [src/providers/router.ts](src/providers/router.ts#L638-L640)). The prompt-injection preflight also resolves and sets a key before delegating to `router.chat` ([src/security/prompt-injection-cop.ts](src/security/prompt-injection-cop.ts#L111-L113)). The auth-store profile selection and refresh behavior described in the analysis also matches the code ([src/auth/store.ts](src/auth/store.ts#L92-L131)).

There is one blocking factual error in the call-site inventory: the analysis lists `router.callProvider final retry path` at [src/providers/router.ts](src/providers/router.ts#L639). That line is inside `inspectUsageCandidate`, and `callProvider` itself does not call `resolveApiKey` or `setApiKey` ([src/providers/router.ts](src/providers/router.ts#L366-L413)). The actual startup usage caller is already listed separately, so this should be removed or corrected rather than kept as a second caller.

### Design

Proposal A is the right architecture for this finding: delete the eager writer, keep the existing lazy `resolveApiKey` path as the single token-resolution authority, and remove dead mapping/helper surface. That satisfies the no-backward-compatibility guideline because it removes the duplicate path instead of gating or preserving it.

The design has a small but real executability mismatch around `PROVIDER_TO_OAUTH`. Proposal A says [src/providers/router.ts](src/providers/router.ts) should keep `PROVIDER_TO_OAUTH` as the single mapping, "exported for any future caller," while the same proposal says nothing is added, and the plan says to keep the constant unchanged. The current constant is private ([src/providers/router.ts](src/providers/router.ts#L68-L73)). Pick one instruction. If no current caller needs it, the cleanest fix is to drop the export wording; if it must become exported, the plan should include that edit and explain why adding public API surface is worth it.

### Plan

The edit plan is otherwise executable. Removing `injectOAuthTokens`, the bootstrap OAuth import, `OAUTH_TO_PI`, and `oauthToProviderName` matches the current references: `OAUTH_TO_PI` is unused except its declaration ([src/providers/router.ts](src/providers/router.ts#L60-L63)), and `oauthToProviderName` is only defined and barrel-exported ([src/auth/store.ts](src/auth/store.ts#L149-L158), [src/auth/index.ts](src/auth/index.ts#L1)). The proposed validation commands use this repo's Vitest/typecheck/build conventions.

The plan must be aligned with the design's final decision on `PROVIDER_TO_OAUTH` export status. As written, an implementer could reasonably either leave it private or export it, and one of those choices would contradict part of the r1 design.

## Required changes

1. Correct the analysis call-site inventory by removing the `router.callProvider final retry path` entry or explicitly stating that [src/providers/router.ts](src/providers/router.ts#L639) is the `inspectUsageCandidate` lazy-resolution call. Do not claim `callProvider` resolves or sets API keys unless the live code is changed to do that.
2. Align the design and plan on `PROVIDER_TO_OAUTH`: either remove the "exported for any future caller" wording and keep the constant private, or make exporting it an explicit plan step with rationale and update "What gets added" accordingly.

## Strengths

- The recommended fix is properly scoped and deletes the duplicate eager path instead of preserving a compatibility shim.
- The plan's search steps and validation commands are concrete enough for an implementation pass once the two documentation mismatches are corrected.
- The design correctly keeps F15 independent of F27 and avoids expanding this finding into the larger per-request API-key threading redesign.

VERDICT: CHANGES_REQUESTED