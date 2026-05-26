# F21 r1 Review

## Reviewer

GPT-5.5 (copilot)

## Documents reviewed

- [SPEC/v2/review-2026-05/_LOOP-CONVENTIONS.md](SPEC/v2/review-2026-05/_LOOP-CONVENTIONS.md)
- [SPEC/v2/review-2026-05/F21-copilot-hardcoded-headers.md](SPEC/v2/review-2026-05/F21-copilot-hardcoded-headers.md)
- [SPEC/v2/review-2026-05/F21/01-analysis-r1.md](SPEC/v2/review-2026-05/F21/01-analysis-r1.md)
- [SPEC/v2/review-2026-05/F21/02-design-r1.md](SPEC/v2/review-2026-05/F21/02-design-r1.md)
- [SPEC/v2/review-2026-05/F21/03-plan-r1.md](SPEC/v2/review-2026-05/F21/03-plan-r1.md)
- Spot checks: [src/providers/copilot.ts](src/providers/copilot.ts), [src/auth/github-copilot.ts](src/auth/github-copilot.ts), [src/config.ts](src/config.ts), plus routing/auth call-path checks where needed.

## Findings

### Analysis

The analysis is factually sound. The duplicate header constants are present in [src/providers/copilot.ts](src/providers/copilot.ts#L33-L39) and [src/auth/github-copilot.ts](src/auth/github-copilot.ts#L17-L22), the two inline device-flow User-Agent strings are present in [src/auth/github-copilot.ts](src/auth/github-copilot.ts#L77-L82) and [src/auth/github-copilot.ts](src/auth/github-copilot.ts#L131-L136), and the `ANTHROPIC_API_MODELS` Set is currently redundant with `model.startsWith("claude-")` in [src/providers/copilot.ts](src/providers/copilot.ts#L60-L74). No required analysis change.

### Design

Proposal A is the right direction, but it leaves the production config path under-specified. The design says the route layer can pass `providers["github-copilot"].headers` into the provider and that the OAuth caller can wrap the provider definition, yet the actual registry and routing paths are not included as touched surfaces. Today `ModelRouter.createProvider` constructs Copilot with only `new CopilotProvider(apiKey)` at [src/providers/router.ts](src/providers/router.ts#L728), and runtime refresh paths call `provider.setApiKey(oauthKey)` with no config at [src/providers/router.ts](src/providers/router.ts#L238-L299). The shared provider interface also only allows `setApiKey?(apiKey: string): void` at [src/providers/types.ts](src/providers/types.ts#L99). Without an explicit route-layer design, the proposed config field is parseable but not reliably used.

The OAuth side has the same gap. `getOAuthApiKey` only accepts `profileKey` at [src/auth/store.ts](src/auth/store.ts#L92-L122), and the static provider registry at [src/auth/store.ts](src/auth/store.ts#L26-L30) has no access to runtime provider config. The design's closure/wrapper note is plausible, but it needs to name the real caller and storage boundary that will pass header overrides into `loginGitHubCopilot` and `refreshGitHubCopilotToken`.

### Plan

The plan is not yet executable to the stated F21 goal. Step 3 makes `CopilotProvider` accept overrides, but Step 3 also says `setApiKey(apiKey, headerOverride?)` resolves defaults when the override is omitted. That means later production calls such as [src/providers/router.ts](src/providers/router.ts#L238), [src/providers/router.ts](src/providers/router.ts#L299), [src/security/prompt-injection-cop.ts](src/security/prompt-injection-cop.ts#L113), and [src/server/bootstrap.ts](src/server/bootstrap.ts#L754) can erase a configured header override unless every relevant call path is changed or the provider preserves constructor/account overrides internally.

Step 4 explicitly leaves `githubCopilotOAuthProvider.login` / `refreshToken` on defaults and says production wiring can follow once F15 lands. That is a blocker for F21: the issue covers auth exchange headers too, and the stated constraint says an operator must be able to bump the impersonation triple from `.saivage/saivage.json` without rebuilding. Deferring the auth-token exchange path means an upstream rejection at `copilot_internal/v2/token` would still require a source edit or a separate future issue.

The tests also do not catch this. Adding direct `new CopilotProvider(..., overrides)` tests proves only the constructor path; it would pass even if `ModelRouter` and OAuth refresh never read `providers["github-copilot"].headers`.

## Required changes

1. Revise the design and plan to include concrete production wiring from `RuntimeProviderConfigLike` / `RuntimeProviderAccountLike` into Copilot provider construction and refresh. Specify precedence, likely account headers over provider headers over defaults, and update [src/providers/types.ts](src/providers/types.ts#L99) or an equivalent typed pathway so router call sites can pass overrides without type holes. The plan must cover [src/providers/router.ts](src/providers/router.ts#L238), [src/providers/router.ts](src/providers/router.ts#L299), and [src/providers/router.ts](src/providers/router.ts#L728), plus either update or explicitly justify the direct startup/security `setApiKey` call sites.
2. Revise the OAuth/auth plan so configured Copilot headers reach `startDeviceFlow`, `pollForAccessToken`, and `refreshGitHubCopilotToken` in the current executable code path, not a post-F15 follow-up. Name the concrete change to [src/auth/store.ts](src/auth/store.ts#L92-L122), the provider registry/caller, or another real call path that supplies the override.
3. Add tests that fail without the production wiring: at minimum a router-level Copilot test showing `providers["github-copilot"].headers` reaches the request headers after lazy OAuth/static API-key setup, and an auth-level test showing `refreshGitHubCopilotToken` applies a supplied override to the token-exchange request. Constructor-only `CopilotProvider` tests are not enough for this issue.
4. Update the validation section to include the new router/auth focused tests alongside `src/providers/copilot.test.ts` and `src/config.test.ts`.

## Strengths

The analysis is precise and the recommendation correctly rejects filesystem auto-detection as deployment-shape-dependent complexity. Proposal A's shared header module plus config override is the right conceptual fix once the missing production call paths are made explicit.

VERDICT: CHANGES_REQUESTED