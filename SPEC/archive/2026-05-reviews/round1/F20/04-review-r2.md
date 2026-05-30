# F20 Review r2

## Reviewer

GPT-5.5 (copilot)

## Documents reviewed

- [SPEC/v2/review-2026-05/_LOOP-CONVENTIONS.md](SPEC/v2/review-2026-05/_LOOP-CONVENTIONS.md)
- [SPEC/v2/review-2026-05/F20-max-context-tokens-hardcoded.md](SPEC/v2/review-2026-05/F20-max-context-tokens-hardcoded.md)
- Prior critique: [SPEC/v2/review-2026-05/F20/04-review-r1.md](SPEC/v2/review-2026-05/F20/04-review-r1.md)
- [SPEC/v2/review-2026-05/F20/01-analysis-r2.md](SPEC/v2/review-2026-05/F20/01-analysis-r2.md)
- [SPEC/v2/review-2026-05/F20/02-design-r2.md](SPEC/v2/review-2026-05/F20/02-design-r2.md)
- [SPEC/v2/review-2026-05/F20/03-plan-r2.md](SPEC/v2/review-2026-05/F20/03-plan-r2.md)
- Dependency check: [SPEC/v2/review-2026-05/F07/APPROVED.md](SPEC/v2/review-2026-05/F07/APPROVED.md), [SPEC/v2/review-2026-05/F07/03-plan-r4.md](SPEC/v2/review-2026-05/F07/03-plan-r4.md)
- Spot-checks: [src/providers/types.ts](src/providers/types.ts#L83-L98), [src/providers/base.ts](src/providers/base.ts#L1-L30), [src/providers/router.ts](src/providers/router.ts#L245-L258), [src/providers/router.ts](src/providers/router.ts#L720-L760), [src/routing/resolver.ts](src/routing/resolver.ts#L38-L73), [src/config.ts](src/config.ts#L1-L55), [src/providers/pi-ai.ts](src/providers/pi-ai.ts#L43-L110), [src/providers/pi-ai.ts](src/providers/pi-ai.ts#L270-L273), [src/providers/openai.ts](src/providers/openai.ts#L148-L153), [src/providers/openai-codex.ts](src/providers/openai-codex.ts#L374-L379), [src/providers/copilot.ts](src/providers/copilot.ts#L473-L483), [src/providers/ollama.ts](src/providers/ollama.ts#L7-L19), [src/providers/llamacpp.ts](src/providers/llamacpp.ts#L7-L23)

## Findings

### Analysis

No blocking findings. The r2 analysis correctly keeps F07's approved `countTokens` surface instead of trying to replace it. That matches [SPEC/v2/review-2026-05/F07/03-plan-r4.md](SPEC/v2/review-2026-05/F07/03-plan-r4.md), which adds `ModelProvider.countTokens`, router pass-through counting, and `BaseAgent` running-token accounting. F20 now scopes itself to replacing `maxContextTokens` with a capability record and making the post-F07 `BaseProvider.countTokens` derive its encoding from that record.

The source spot-check supports the baseline problem statement. [src/providers/types.ts](src/providers/types.ts#L91) still exposes `maxContextTokens`, [src/providers/base.ts](src/providers/base.ts#L19-L21) still returns a silent `200_000`, and [src/providers/router.ts](src/providers/router.ts#L245-L258) still substitutes `200_000` when resolution misses. The provider-specific examples are also accurate: Anthropic has dead same-value branches, OpenAI/OpenAI Codex use coarse heuristics, Copilot consults cached metadata before falling back, and Pi AI reads the registry with a `128_000` fallback.

### Design

No blocking findings. Proposal B is now internally executable: `ModelProvider.countTokens` and `ModelRouter.countTokens` stay as F07 defines them, while `maxContextTokens` is removed and replaced by `modelCapabilities(model)`. The revised design no longer has the r1 contradiction where `countTokens` was both removed and retained.

The Pi AI live-path concern is addressed. The router constructs `PiAiProvider` for `anthropic`, `openai`, `openai-codex`, `opencode`, and `opencode-go` in [src/providers/router.ts](src/providers/router.ts#L728-L750), and the r2 design moves the F07 encoding switch into `PiAiProvider.modelCapabilities` using `this.piProvider` plus the model id. That preserves the runtime distinction that r1 would have lost.

The local-provider config seam is also corrected. [src/config.ts](src/config.ts#L51) delegates the provider shape to `runtimeProviderConfigSchema`, and [src/routing/resolver.ts](src/routing/resolver.ts#L54-L57) is the right schema/type location for `defaultContextWindow`. Passing that parsed value from [src/providers/router.ts](src/providers/router.ts#L720-L760) into the Ollama and llama.cpp constructors is the right execution path.

### Plan

No blocking findings. The edit order is concrete and follows the recommended design: add `ModelCapabilities`, rewrite `BaseProvider`, convert every provider from `maxContextTokens` to `modelCapabilities`, remove the router's silent fallback, extend the runtime provider schema, and update the affected tests.

The test plan now covers the prior failure modes: direct provider capability tables, live-router Pi AI cases, router loud failure for unknown context windows, graceful `countTokens` fallback through `BaseProvider`, OpenRouter vendor-prefixed model strings, and `defaultContextWindow` injection for Ollama/llama.cpp. The validation commands use this repo's Vitest/typecheck/build conventions.

## Required changes

## Strengths

The r2 revision resolves the three r1 blockers without adding compatibility shims. The selected design consolidates context-window and tokenizer decisions into one provider-owned capability record, keeps F07's public counting surface intact, and removes the silent `200_000` context-window defaults that made this issue dangerous in the first place.

VERDICT: APPROVED