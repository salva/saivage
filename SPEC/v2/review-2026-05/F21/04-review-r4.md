# F21 r4 Review

## Reviewer

GPT-5.5 (copilot)

## Documents reviewed

- [SPEC/v2/review-2026-05/_LOOP-CONVENTIONS.md](SPEC/v2/review-2026-05/_LOOP-CONVENTIONS.md)
- [SPEC/v2/review-2026-05/F21-copilot-hardcoded-headers.md](SPEC/v2/review-2026-05/F21-copilot-hardcoded-headers.md)
- Prior critique: [SPEC/v2/review-2026-05/F21/04-review-r3.md](SPEC/v2/review-2026-05/F21/04-review-r3.md)
- [SPEC/v2/review-2026-05/F21/01-analysis-r1.md](SPEC/v2/review-2026-05/F21/01-analysis-r1.md)
- [SPEC/v2/review-2026-05/F21/02-design-r2.md](SPEC/v2/review-2026-05/F21/02-design-r2.md)
- [SPEC/v2/review-2026-05/F21/03-plan-r4.md](SPEC/v2/review-2026-05/F21/03-plan-r4.md)
- Spot-checks: [src/auth/github-copilot.ts](src/auth/github-copilot.ts#L47-L48), [src/providers/router.ts](src/providers/router.ts#L272), [src/providers/router.ts](src/providers/router.ts#L298-L299), [src/providers/router.ts](src/providers/router.ts#L727-L728), [src/providers/copilot.ts](src/providers/copilot.ts#L33-L39), [src/providers/copilot.ts](src/providers/copilot.ts#L142-L150), [src/providers/types.ts](src/providers/types.ts#L27-L38)

## Findings

### Analysis

No blocking findings. The r1 analysis remains accurate against the spot-checked source: the Copilot header literal is still duplicated in the auth and provider surfaces, the provider still wires the literal into SDK defaults and fetch wrapping, and `ANTHROPIC_API_MODELS` remains the dead allow-list targeted by the same cleanup.

### Design

No blocking findings. Proposal A from r2 remains the right implementation shape for F21: one shared default-header module, shallow config overrides, stored header state on `CopilotProvider`, and explicit OAuth-refresh propagation. It satisfies the architecture-first guideline without introducing compatibility shims or a broader client-identity subsystem.

### Plan

No blocking findings. The r3 blocker is fixed in r4. The revised router-level test now acknowledges that `getBaseUrlFromToken` rewrites `proxy.` to `api.` and filters captured requests with `s.startsWith("https://api.example.test/") && s.includes("/v1/messages")` in [SPEC/v2/review-2026-05/F21/03-plan-r4.md](SPEC/v2/review-2026-05/F21/03-plan-r4.md#L85-L86). That matches the production normalization in [src/auth/github-copilot.ts](src/auth/github-copilot.ts#L47-L48) and the existing Copilot test's expected URL in [src/providers/copilot.test.ts](src/providers/copilot.test.ts#L35).

The strict-mode fixture issue is also fixed: r4 adds `system: "system"` in [SPEC/v2/review-2026-05/F21/03-plan-r4.md](SPEC/v2/review-2026-05/F21/03-plan-r4.md#L80), matching `ModelRouter.chat`'s `ChatRequest & { modelSpec: string }` input and the required `ChatRequest.system` field in [src/providers/types.ts](src/providers/types.ts#L27-L38). The inherited r3 steps still cover provider construction, lazy `setApiKey`, OAuth refresh, schema, CLI login, bootstrap token injection, regression tests, and the required validation commands.

## Required changes

None.

## Strengths

The r4 delta is narrow and directly responsive to the prior blocker. The plan now has an executable router regression test that exercises the production-normalized Anthropic messages URL while preserving the key lazy-refresh coverage the review loop asked for.

VERDICT: APPROVED