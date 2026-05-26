# F13 - Review (r3)

## Reviewer

GPT-5.5 (copilot)

## Documents reviewed

- [SPEC/v2/review-2026-05/_LOOP-CONVENTIONS.md](SPEC/v2/review-2026-05/_LOOP-CONVENTIONS.md)
- [SPEC/v2/review-2026-05/F13/04-review-r2.md](SPEC/v2/review-2026-05/F13/04-review-r2.md)
- [SPEC/v2/review-2026-05/F13/01-analysis-r2.md](SPEC/v2/review-2026-05/F13/01-analysis-r2.md)
- [SPEC/v2/review-2026-05/F13/02-design-r3.md](SPEC/v2/review-2026-05/F13/02-design-r3.md)
- [SPEC/v2/review-2026-05/F13/03-plan-r3.md](SPEC/v2/review-2026-05/F13/03-plan-r3.md)

Spot-checked:

- [src/providers/anthropic.ts](src/providers/anthropic.ts#L1)
- [src/providers/anthropic.ts](src/providers/anthropic.ts#L31)
- [src/providers/openai.ts](src/providers/openai.ts#L13)
- [src/providers/openai.ts](src/providers/openai.ts#L38)
- [src/providers/router.ts](src/providers/router.ts#L290)
- [src/providers/router.ts](src/providers/router.ts#L358)
- [src/providers/router.ts](src/providers/router.ts#L395)
- [src/providers/router.ts](src/providers/router.ts#L413-L414)
- [src/agents/base.ts](src/agents/base.ts#L872-L890)
- [node_modules/@anthropic-ai/sdk/core/error.d.ts](node_modules/@anthropic-ai/sdk/core/error.d.ts#L7-L16)
- [node_modules/openai/core/error.d.ts](node_modules/openai/core/error.d.ts#L7-L17)

## Findings

### Analysis

The r2 analysis remains sufficient for implementation. The current code still has the brittle BaseAgent regex classifiers, including the over-broad throttling match on `capacity` / `overloaded` at [src/agents/base.ts](src/agents/base.ts#L872-L890), and the router still has its separate context-window substring check at [src/providers/router.ts](src/providers/router.ts#L413-L414). The analysis correctly keeps the Saivage-internal cancellation and dispatcher sentinels outside the new provider-error surface, because those paths do not flow through the router catch being redesigned.

### Design

The r3 design resolves the remaining r2 blockers. Anthropic classification now uses direct `APIError.type` rather than the invalid `err.error?.error?.type` walk ([SPEC/v2/review-2026-05/F13/02-design-r3.md](SPEC/v2/review-2026-05/F13/02-design-r3.md#L5), [SPEC/v2/review-2026-05/F13/02-design-r3.md](SPEC/v2/review-2026-05/F13/02-design-r3.md#L101-L108)), which matches the installed SDK declaration at [node_modules/@anthropic-ai/sdk/core/error.d.ts](node_modules/@anthropic-ai/sdk/core/error.d.ts#L7-L16). Retry metadata is now read through `Headers.get(...)`, including OpenAI `retry-after-ms` and Anthropic reset headers ([SPEC/v2/review-2026-05/F13/02-design-r3.md](SPEC/v2/review-2026-05/F13/02-design-r3.md#L6), [SPEC/v2/review-2026-05/F13/02-design-r3.md](SPEC/v2/review-2026-05/F13/02-design-r3.md#L110)). The runtime import strategy for `instanceof` is explicit and compatible with `verbatimModuleSyntax` ([SPEC/v2/review-2026-05/F13/02-design-r3.md](SPEC/v2/review-2026-05/F13/02-design-r3.md#L7)).

Proposal B remains the right architecture. It deletes the BaseAgent regex path and the router-local duplicate predicate in the same change, centralizes provider-boundary normalization in `ProviderError`, and keeps the only unavoidable message inspection limited to the orphaned-tool-result distinction inside `classifyProviderError` ([SPEC/v2/review-2026-05/F13/02-design-r3.md](SPEC/v2/review-2026-05/F13/02-design-r3.md#L59-L66), [SPEC/v2/review-2026-05/F13/02-design-r3.md](SPEC/v2/review-2026-05/F13/02-design-r3.md#L149)). That respects the no-backward-compatibility and no-parallel-shim rule.

### Plan

The r3 plan is executable. It fixes the `providerName` scope problem by hoisting `parseModelId(spec)` before the `try` in `callProvider`, then using the same binding in the catch classification path ([SPEC/v2/review-2026-05/F13/03-plan-r3.md](SPEC/v2/review-2026-05/F13/03-plan-r3.md#L8), [SPEC/v2/review-2026-05/F13/03-plan-r3.md](SPEC/v2/review-2026-05/F13/03-plan-r3.md#L97-L111)). It also preserves `ProviderError.kind` through the router aggregate wrap and records the last failing provider name ([SPEC/v2/review-2026-05/F13/03-plan-r3.md](SPEC/v2/review-2026-05/F13/03-plan-r3.md#L113-L123)), which addresses the current raw `new Error` aggregate at [src/providers/router.ts](src/providers/router.ts#L358).

The SDK handling is now strict-TypeScript friendly: Anthropic and OpenAI narrowing uses runtime value imports, direct typed fields, and `Headers.get(...)` ([SPEC/v2/review-2026-05/F13/03-plan-r3.md](SPEC/v2/review-2026-05/F13/03-plan-r3.md#L57-L73)). The test plan covers the r2 failure modes directly: header parsing, provider classifier fixtures, router short-circuit behavior for repair/non-retryable kinds, aggregate wrap preservation, BaseAgent retry semantics, and the `capacity` regression ([SPEC/v2/review-2026-05/F13/03-plan-r3.md](SPEC/v2/review-2026-05/F13/03-plan-r3.md#L183-L202)).

## Required changes

None.

## Strengths

The r3 revision is focused and complete: it fixes the factual SDK-shape issues, closes the router scoping hole, and keeps the broader architecture-first direction intact. The chosen proposal removes the old regex classifiers rather than layering a compatibility path beside them, and the validation plan is strong enough to hand directly to an implementer.

VERDICT: APPROVED