# F07 — Review (r3)

## Reviewer

GPT-5.5 (copilot)

## Documents reviewed

- [SPEC/v2/review-2026-05/F07/04-review-r2.md](SPEC/v2/review-2026-05/F07/04-review-r2.md)
- [SPEC/v2/review-2026-05/F07/01-analysis-r3.md](SPEC/v2/review-2026-05/F07/01-analysis-r3.md)
- [SPEC/v2/review-2026-05/F07/02-design-r3.md](SPEC/v2/review-2026-05/F07/02-design-r3.md)
- [SPEC/v2/review-2026-05/F07/03-plan-r3.md](SPEC/v2/review-2026-05/F07/03-plan-r3.md)

## Findings

### Analysis

- The r2 corrections are materially addressed. The analysis now links the context-overflow regex and preventive compaction guard to the current `BaseAgent` locations, and it correctly preserves the distinction between `shouldCompact` and `isMaxCompactionsReached`.
- There is one new blocking factual gap in the provider analysis: it verifies the provider class hierarchy, but not the provider classes that the router actually registers. The live router constructs `anthropic`, `openai`, `openai-codex`, `opencode`, and `opencode-go` as `PiAiProvider` instances at [src/providers/router.ts](src/providers/router.ts#L729-L750), while `PiAiProvider` itself is the active wrapper class at [src/providers/pi-ai.ts](src/providers/pi-ai.ts#L43). The direct `AnthropicProvider`, `OpenAIProvider`, and `OpenAICodexProvider` classes do exist at [src/providers/anthropic.ts](src/providers/anthropic.ts#L12), [src/providers/openai.ts](src/providers/openai.ts#L12), and [src/providers/openai-codex.ts](src/providers/openai-codex.ts#L79), but they are not what `ModelRouter.createProvider` uses for those provider names today. That changes the correctness surface for F07.

### Design

- Proposal B remains the right architectural direction: a synchronous provider capability plus a maintained `BaseAgent` running count resolves the core `chars / 4` bug without adding per-loop provider RPCs.
- The OpenAI-compatible subclass ambiguity from r2 is fixed for `OpenAIProvider` inheritance (`openrouter`, `ollama`, `llamacpp`) and the monotonic calibration semantics are now exact.
- However, the design's active-provider coverage is incomplete. It says the `BaseProvider` default is the only path `pi-ai` exercises and then places provider-specific behavior in `OpenAIProvider`, `OpenAICodexProvider`, and `AnthropicProvider`. In the current router, the active `openai/*`, `anthropic/*`, `openai-codex/*`, `opencode/*`, and `opencode-go/*` paths would instead inherit the generic `BaseProvider.countTokens` through `PiAiProvider` unless `PiAiProvider` gets its own provider/model-aware override or the router registration is deliberately changed. That would leave GPT-5-family `openai`/`openai-codex` routes on `cl100k_base` and would make the direct-provider overrides largely irrelevant to the live runtime path.

### Plan

- The `resolveActive` executability gap from r2 is fixed: Step 6 now mirrors the existing candidate-chain resolution directly.
- The `BaseAgent` running-counter steps are executable against the current mutation points. `this.messages` is pushed at [src/agents/base.ts](src/agents/base.ts#L719) and replaced at [src/agents/base.ts](src/agents/base.ts#L735), so the proposed hooks cover the observed write paths.
- The plan is not yet executable as a complete fix because it does not specify any `PiAiProvider.countTokens` implementation or tests for the active router-backed provider names. Updating `OpenAIProvider`, `AnthropicProvider`, and `OpenAICodexProvider` is not enough when `ModelRouter.createProvider` currently maps those names to `PiAiProvider`. The test plan also pins direct provider behavior but does not prove that `router.countTokens("openai/gpt-5...", ...)`, `router.countTokens("anthropic/claude...", ...)`, or `router.countTokens("openai-codex/gpt-5...", ...)` use the intended counting path.

## Required changes

1. Revise the analysis/design/plan to account for the active `PiAiProvider` registrations in `ModelRouter.createProvider`. The revised proposal must either add a provider/model-aware `PiAiProvider.countTokens` path covering `openai`, `anthropic`, `openai-codex`, `opencode`, and `opencode-go`, or explicitly change router registration to use the direct provider classes and justify that broader architectural move. Also correct the claim that the `BaseProvider` default is only a `pi-ai` path.
2. Add tests that pin the active runtime behavior through `ModelRouter.countTokens` and/or `PiAiProvider.countTokens`, not just the direct legacy provider classes. At minimum, cover an active OpenAI-family model that should select `o200k_base`, an Anthropic-family model that should use the intended Claude proxy, and the generic PiAi/OpenCode fallback behavior.

## Strengths

- r3 cleanly resolves the stale references, nonexistent router helper, inherited encoding fallback, calibration monotonicity, and unused-state-slot objections from r2.
- The proposed running-token counter is focused and testable, and it keeps `shouldCompact` synchronous.
- The cross-issue ordering note is improved and correctly explains why F07 should precede F20.

VERDICT: CHANGES_REQUESTED