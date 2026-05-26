# F21 r2 Review

## Reviewer

GPT-5.5 (copilot)

## Documents reviewed

- [SPEC/v2/review-2026-05/_LOOP-CONVENTIONS.md](SPEC/v2/review-2026-05/_LOOP-CONVENTIONS.md)
- Prior critique: [SPEC/v2/review-2026-05/F21/04-review-r1.md](SPEC/v2/review-2026-05/F21/04-review-r1.md)
- [SPEC/v2/review-2026-05/F21/01-analysis-r1.md](SPEC/v2/review-2026-05/F21/01-analysis-r1.md)
- [SPEC/v2/review-2026-05/F21/02-design-r2.md](SPEC/v2/review-2026-05/F21/02-design-r2.md)
- [SPEC/v2/review-2026-05/F21/03-plan-r2.md](SPEC/v2/review-2026-05/F21/03-plan-r2.md)
- Spot-checks: [src/providers/copilot.ts](src/providers/copilot.ts#L33-L39), [src/providers/copilot.ts](src/providers/copilot.ts#L63-L73), [src/providers/copilot.ts](src/providers/copilot.ts#L134-L150), [src/auth/github-copilot.ts](src/auth/github-copilot.ts#L17-L22), [src/auth/github-copilot.ts](src/auth/github-copilot.ts#L75-L88), [src/auth/github-copilot.ts](src/auth/github-copilot.ts#L127-L139), [src/auth/github-copilot.ts](src/auth/github-copilot.ts#L169-L181), [src/auth/index.ts](src/auth/index.ts#L1-L5), [src/providers/router.ts](src/providers/router.ts#L174-L199), [src/providers/router.ts](src/providers/router.ts#L237-L238), [src/providers/router.ts](src/providers/router.ts#L298-L299), [src/providers/router.ts](src/providers/router.ts#L720-L728), [src/auth/types.ts](src/auth/types.ts#L30-L34), [src/auth/store.ts](src/auth/store.ts#L92-L122), [src/routing/resolver.ts](src/routing/resolver.ts#L38-L57), [src/server/cli.ts](src/server/cli.ts#L451-L470), [src/server/bootstrap.ts](src/server/bootstrap.ts#L741-L760)

## Findings

### Analysis

No blocking findings. The r1 analysis remains accurate against the current code. The duplicated Copilot header literals are still present in [src/providers/copilot.ts](src/providers/copilot.ts#L33-L39) and [src/auth/github-copilot.ts](src/auth/github-copilot.ts#L17-L22), the device-flow User-Agent copies are still inline in [src/auth/github-copilot.ts](src/auth/github-copilot.ts#L75-L88) and [src/auth/github-copilot.ts](src/auth/github-copilot.ts#L127-L139), and the redundant `ANTHROPIC_API_MODELS` Set still feeds an already-prefix-based branch in [src/providers/copilot.ts](src/providers/copilot.ts#L63-L73). The problem statement and constraints are sufficient for implementation.

### Design

No blocking findings. Proposal A now addresses the r1 architectural gaps: header state lives on `CopilotProvider` rather than in an optional second `setApiKey` argument, so later refreshes from [src/providers/router.ts](src/providers/router.ts#L237-L238), [src/providers/router.ts](src/providers/router.ts#L298-L299), [src/security/prompt-injection-cop.ts](src/security/prompt-injection-cop.ts#L112-L113), and [src/server/bootstrap.ts](src/server/bootstrap.ts#L741-L760) cannot erase the override. The design also correctly widens the OAuth provider boundary instead of relying on a module-level registry closure: the current interface in [src/auth/types.ts](src/auth/types.ts#L30-L34) and store call at [src/auth/store.ts](src/auth/store.ts#L92-L122) need that typed pathway for Copilot refresh headers to reach `refreshGitHubCopilotToken`.

The selected precedence rule is also the right one: shallow merge defaults, provider headers, then account headers. That matches the existing provider/account config model around [src/providers/router.ts](src/providers/router.ts#L720-L728) and avoids forcing account overrides to repeat every provider-level header.

### Plan

The plan resolves most r1 issues but still has two executable gaps.

First, Step 5 contradicts the design's required merge rule for OAuth refresh. The provider construction snippet correctly uses `{ ...(providerConfig?.headers ?? {}), ...(accountConfig?.headers ?? {}) }`, but the `resolveApiKey` instruction says to compute headers from `accountConfig?.headers` if present, otherwise `providerConfig?.headers`. A literal implementation would drop provider-level header overrides whenever an account supplies a partial header override, so the chat provider and OAuth token-exchange paths could send different impersonation triples. This is the same production-wiring class of issue called out in r1, not a style concern.

Second, the proposed router-level test is not currently executable as written. `Parameters<typeof ModelRouter>[0]` is not a valid way to type a class constructor argument; use the existing router test fixture style or `ConstructorParameters<typeof ModelRouter>[0]` / `SaivageConfig` instead. More importantly, the test routes `claude-sonnet-4.6`, which takes the Anthropic messages path in [src/providers/copilot.ts](src/providers/copilot.ts#L407-L444), but the stubbed response body is an OpenAI Chat Completions payload with `choices`. That test can fail on response parsing even if the header wiring is correct, so it does not cleanly satisfy the r1 requirement for a focused production-wiring regression test.

## Required changes

1. Update the plan's `resolveApiKey` instructions so every `getOAuthApiKey` call receives the same shallow merge used for provider construction: provider headers first, account headers second, with `undefined` only when both are empty. Apply that to the explicit profile, account-profile, and provider fallback paths in [src/providers/router.ts](src/providers/router.ts#L174-L199).
2. Fix the router-level test plan so the proposed test compiles and fails only on the intended wiring regression. Either use a non-Claude OpenAI-compatible model with the current Chat Completions-shaped response, or keep `claude-sonnet-4.6` and return an Anthropic messages-shaped response like the existing test in [src/providers/copilot.test.ts](src/providers/copilot.test.ts#L8-L42). Also replace the invalid `Parameters<typeof ModelRouter>[0]` cast with a valid config fixture or constructor type.

## Strengths

The r2 revision materially improves the proposal. Stored Copilot header state is the right lifecycle boundary, the OAuth interface widening is a clean typed solution, and the design now includes the current router, auth-store, CLI-login, and bootstrap surfaces instead of deferring them to F15. Once the two remaining plan details are corrected, Proposal A should be ready to implement.

VERDICT: CHANGES_REQUESTED