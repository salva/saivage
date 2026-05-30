# F21 r3 Review

## Reviewer

GPT-5.5 (copilot)

## Documents reviewed

- [SPEC/v2/review-2026-05/_LOOP-CONVENTIONS.md](SPEC/v2/review-2026-05/_LOOP-CONVENTIONS.md)
- Prior critique: [SPEC/v2/review-2026-05/F21/04-review-r2.md](SPEC/v2/review-2026-05/F21/04-review-r2.md)
- [SPEC/v2/review-2026-05/F21/01-analysis-r1.md](SPEC/v2/review-2026-05/F21/01-analysis-r1.md)
- [SPEC/v2/review-2026-05/F21/02-design-r2.md](SPEC/v2/review-2026-05/F21/02-design-r2.md)
- [SPEC/v2/review-2026-05/F21/03-plan-r3.md](SPEC/v2/review-2026-05/F21/03-plan-r3.md)
- Spot-checks: [src/providers/router.ts](src/providers/router.ts#L94-L104), [src/providers/router.ts](src/providers/router.ts#L174-L199), [src/providers/router.ts](src/providers/router.ts#L720-L728), [src/auth/github-copilot.ts](src/auth/github-copilot.ts#L44-L49), [src/providers/copilot.test.ts](src/providers/copilot.test.ts#L25-L35), [src/server/bootstrap.ts](src/server/bootstrap.ts#L740-L755), [src/server/cli.ts](src/server/cli.ts#L451-L469)

## Findings

### Analysis

No blocking findings. The r1 analysis remains accurate against the current code: the Copilot header literals and inline User-Agent copies still describe the same duplication problem, and the dead Anthropic allow-list is still part of the same redeploy-to-update anti-pattern. The contract and constraints remain sufficient for an implementer.

### Design

No blocking findings. Proposal A is still the right architecture for this issue: a shared default-header module, stored header state on `CopilotProvider`, config-supplied shallow overrides, and explicit OAuth-refresh propagation. The design avoids the two lifecycle mistakes rejected earlier: transient `setApiKey` header arguments and deferred token-exchange wiring.

### Plan

The r3 plan fixes the r2 production-wiring blocker. Step 5 now computes one provider-plus-account header override and passes it to every `getOAuthApiKey` branch in `resolveApiKey`, so explicit profile, account profile, and provider fallback paths all use the same impersonation triple as provider construction.

However, the critical router-level regression test is still not executable as written. The test fixture sets `proxy-ep=proxy.example.test` in [SPEC/v2/review-2026-05/F21/03-plan-r3.md](SPEC/v2/review-2026-05/F21/03-plan-r3.md#L299-L301), then filters captured calls for `proxy.example.test` in [SPEC/v2/review-2026-05/F21/03-plan-r3.md](SPEC/v2/review-2026-05/F21/03-plan-r3.md#L316-L318). Production code converts the token's `proxy-ep` host with `proxyHost.replace(/^proxy\./, "api.")` in [src/auth/github-copilot.ts](src/auth/github-copilot.ts#L44-L49), and the existing Copilot test confirms the resulting request URL is `https://api.example.test/v1/messages` in [src/providers/copilot.test.ts](src/providers/copilot.test.ts#L25-L35). With correct header wiring, the proposed filter returns no calls and the test fails for the wrong reason. This is the same class of executability gap as the r2 test concern, so it remains blocking.

## Required changes

1. Fix the router-level test plan in [SPEC/v2/review-2026-05/F21/03-plan-r3.md](SPEC/v2/review-2026-05/F21/03-plan-r3.md#L293-L322) so it selects the actual outgoing Copilot request URL after `proxy-ep` normalization. Filtering for `api.example.test`, `/v1/messages`, or the first captured Anthropic messages request would all be acceptable; filtering for `proxy.example.test` is not. While touching the snippet, include `system: "system"` in the `router.chat` request so the fixture matches the `ChatRequest` shape.

## Strengths

The substantive design and production steps are now strong. The shallow-merge precedence is correct, the OAuth interface widening is clean, the bootstrap accessor is a small justified surface addition, and the auth-level test gives useful coverage of the token-exchange path. After the router test selector is corrected, this should be ready to approve.

VERDICT: CHANGES_REQUESTED