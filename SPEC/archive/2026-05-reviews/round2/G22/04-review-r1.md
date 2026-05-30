# G22 - Review (round 1)

**Reviewer**: GPT-5.5.
**Documents reviewed**: [SPEC/v2/review-2026-05-round2/G22/01-analysis-r1.md](SPEC/v2/review-2026-05-round2/G22/01-analysis-r1.md), [SPEC/v2/review-2026-05-round2/G22/02-design-r1.md](SPEC/v2/review-2026-05-round2/G22/02-design-r1.md), [SPEC/v2/review-2026-05-round2/G22/03-plan-r1.md](SPEC/v2/review-2026-05-round2/G22/03-plan-r1.md).
**Finding**: [SPEC/v2/review-2026-05-round2/G22-router-dead-copilot-oauth-mapping.md](SPEC/v2/review-2026-05-round2/G22-router-dead-copilot-oauth-mapping.md).

## Findings

No blocking issues.

The round-1 analysis correctly verifies the finding against the current router. `PROVIDER_TO_OAUTH` contains the dead alias row at [src/providers/router.ts](src/providers/router.ts#L64-L68), and its only direct consumer is `resolveApiKey` at [src/providers/router.ts](src/providers/router.ts#L170-L199). The canonical router/provider registration path uses `github-copilot`, not `copilot`, in the provider list at [src/providers/router.ts](src/providers/router.ts#L102-L114), registration gate at [src/providers/router.ts](src/providers/router.ts#L736-L737), and provider factory at [src/providers/router.ts](src/providers/router.ts#L773-L777). The OAuth backend is also keyed by `github-copilot` at [src/auth/github-copilot.ts](src/auth/github-copilot.ts#L227-L228). That makes the `copilot` map row a real orphan rather than an intentionally supported spelling.

The design's recommended Proposal A is the right architecture-first fix. Deleting only the `copilot` row would leave `PROVIDER_TO_OAUTH` as a three-row identity map, which would preserve a misleading abstraction after its only non-identity behavior is gone. Removing the table and passing `providerName` directly through `getProfileByKey` / `getOAuthApiKey` keeps the live behavior for canonical providers unchanged while eliminating the half-supported `copilot` alias footgun. This matches the project rules: no compatibility shim, no speculative seam, and aggressive dead-code removal.

The scope control is also sound. The documents correctly leave `CopilotProvider.name = "copilot"` at [src/providers/copilot.ts](src/providers/copilot.ts#L104) as a separate followup because it affects provider display/error text, not router OAuth keying. They also avoid pulling in G21's future provider-name union or descriptor-table work, while still noting the deconflict with G21 and G36. That is the right boundary for a local G22 cleanup.

The implementation plan is sufficiently complete and testable. Its edit list removes the constant and replaces the four `oauthId` references in [src/providers/router.ts](src/providers/router.ts#L174-L199), with explicit guardrails against touching the G21 provider-registration surface. The validation stack is proportional: typecheck, lint, focused router tests, full vitest, and build. Existing router tests already exercise surviving canonical OAuth/account resolution for `github-copilot` and `anthropic` at [src/providers/router.test.ts](src/providers/router.test.ts#L441-L442) and [src/providers/router.test.ts](src/providers/router.test.ts#L472), so the plan does not need to add a compatibility-preserving test for the removed alias.

## Non-blocking Notes

- The plan's precondition to refresh line anchors if G21 or G36 lands first is important, because all three findings touch [src/providers/router.ts](src/providers/router.ts#L64-L68) or nearby provider-registration logic.
- When writing the final APPROVED.md, mention that G36 must drop any step that moves `PROVIDER_TO_OAUTH`, because G22 deletes the symbol entirely.

VERDICT: APPROVED