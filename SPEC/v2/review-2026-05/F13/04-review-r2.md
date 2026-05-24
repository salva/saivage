# F13 — Review (r2)

## Reviewer

GPT-5.5 (copilot)

## Documents reviewed

- [SPEC/v2/review-2026-05/_LOOP-CONVENTIONS.md](SPEC/v2/review-2026-05/_LOOP-CONVENTIONS.md)
- [SPEC/v2/review-2026-05/F13/04-review-r1.md](SPEC/v2/review-2026-05/F13/04-review-r1.md)
- [SPEC/v2/review-2026-05/F13/01-analysis-r2.md](SPEC/v2/review-2026-05/F13/01-analysis-r2.md)
- [SPEC/v2/review-2026-05/F13/02-design-r2.md](SPEC/v2/review-2026-05/F13/02-design-r2.md)
- [SPEC/v2/review-2026-05/F13/03-plan-r2.md](SPEC/v2/review-2026-05/F13/03-plan-r2.md)

Spot-checked:

- [src/agents/base.ts](src/agents/base.ts#L489-L580)
- [src/agents/base.ts](src/agents/base.ts#L866-L891)
- [src/providers/router.ts](src/providers/router.ts#L321-L360)
- [src/providers/router.ts](src/providers/router.ts#L369-L417)
- [src/providers/base.ts](src/providers/base.ts#L1-L20)

## Findings

### Analysis

The r2 analysis resolves the r1 factual issue around internal sentinels. `"Agent cancelled"` is thrown before entering the `router.chat` try block or from `sleepWithCancellation` after the catch has already begun, and `"consecutive invalid tool calls"` remains a dispatcher-path error rather than a provider/callLLM classifier case. Leaving both outside `ProviderError` is now the right scope boundary for F13.

The analysis also correctly preserves the important distinction between generic provider-side invalid requests and Saivage-side orphaned tool-result repair cases. That distinction is required because [src/agents/base.ts](src/agents/base.ts#L515-L535) currently treats context overflow and orphaned tool-result errors as compact-and-retry conditions, not fatal invalid requests.

### Design

Proposal B remains the right architecture: typed provider-boundary errors, no parallel legacy regex path, no router-local duplicate context predicate, and a single narrow exception for provider message inspection when the provider exposes no structured orphaned-tool field.

One design detail still needs correction before approval. The design says Anthropic classification uses `error.error.type` at [SPEC/v2/review-2026-05/F13/02-design-r2.md](SPEC/v2/review-2026-05/F13/02-design-r2.md#L99), and the plan repeats `err.error?.error?.type` throughout the Anthropic branch at [SPEC/v2/review-2026-05/F13/03-plan-r2.md](SPEC/v2/review-2026-05/F13/03-plan-r2.md#L32-L42). The installed Anthropic SDK exposes the response error type directly as `APIError.type` ([node_modules/@anthropic-ai/sdk/core/error.d.ts](node_modules/@anthropic-ai/sdk/core/error.d.ts#L12-L14)); `APIError.error` is typed only as the JSON body object ([node_modules/@anthropic-ai/sdk/core/error.d.ts](node_modules/@anthropic-ai/sdk/core/error.d.ts#L9-L10)). Implementing the plan literally either fails strict TypeScript or requires casts that violate the plan's own `unknown` / structural-narrowing constraint.

### Plan

The router cleanup still has a scope bug. The replacement catch block calls `classifyProviderError(error, providerName)` at [SPEC/v2/review-2026-05/F13/03-plan-r2.md](SPEC/v2/review-2026-05/F13/03-plan-r2.md#L69-L76), but in the current `callProvider` method `providerName` is declared only inside the success path at [src/providers/router.ts](src/providers/router.ts#L390-L405). It is not visible in the catch block at [src/providers/router.ts](src/providers/router.ts#L406-L417). The plan needs to parse the provider name before the try, pass the already-available `provider.name`, or otherwise make that binding explicit.

The retry-after extraction is also not executable as written. The plan reads `err.headers?.["retry-after"]` for Anthropic and OpenAI at [SPEC/v2/review-2026-05/F13/03-plan-r2.md](SPEC/v2/review-2026-05/F13/03-plan-r2.md#L42-L52), but both SDKs type `headers` as a `Headers` object ([node_modules/@anthropic-ai/sdk/core/error.d.ts](node_modules/@anthropic-ai/sdk/core/error.d.ts#L7-L8), [node_modules/openai/core/error.d.ts](node_modules/openai/core/error.d.ts#L7-L8)). Under this repo's strict TypeScript settings ([tsconfig.json](tsconfig.json#L9-L18)), the implementation should use `headers.get("retry-after")`, `headers.get("retry-after-ms")`, and the relevant Anthropic reset header names. Similarly, any `instanceof APIError` check must import a runtime value, not only an erased type, because `verbatimModuleSyntax` is enabled.

The rest of the plan is now coherent: `orphaned_tool_result` has a concrete producer, router failover short-circuits repair-class errors, the aggregate wrapper preserves kind and last-provider context, BaseAgent switches on typed kinds, and the test matrix covers provider classifier, router, and BaseAgent behavior.

## Required changes

1. Correct the Anthropic APIError design and plan to use the SDK's direct `type` field (or a strictly typed structural equivalent), not `err.error?.error?.type`. Also state the runtime import/narrowing approach used for `instanceof` checks under `verbatimModuleSyntax`.
2. Fix retry-after extraction in the plan so SDK headers are read through `Headers.get(...)`, including OpenAI's `retry-after-ms` and Anthropic reset headers where applicable.
3. Fix the router `callProvider` snippet so the catch block has a valid provider identity for `classifyProviderError` (`provider.name`, a top-level `parseModelId(spec)`, or another explicitly scoped binding).

## Strengths

The r2 revision cleanly addresses the r1 architectural blockers without adding backward-compatibility shims. The orphaned-tool repair path is preserved, the old BaseAgent regex classifier is deleted rather than shadowed, and the validation plan is broad enough to protect the behavioral contract across providers, router failover, and BaseAgent retry logic.

VERDICT: CHANGES_REQUESTED