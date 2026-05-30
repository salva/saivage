# F07 — Review (r1)

## Reviewer

GPT-5.5 (copilot)

## Documents reviewed

- [SPEC/v2/review-2026-05/F07-token-estimation-chars-over-4.md](SPEC/v2/review-2026-05/F07-token-estimation-chars-over-4.md)
- [SPEC/v2/review-2026-05/F07/01-analysis-r1.md](SPEC/v2/review-2026-05/F07/01-analysis-r1.md)
- [SPEC/v2/review-2026-05/F07/02-design-r1.md](SPEC/v2/review-2026-05/F07/02-design-r1.md)
- [SPEC/v2/review-2026-05/F07/03-plan-r1.md](SPEC/v2/review-2026-05/F07/03-plan-r1.md)

## Findings

### Analysis

- The core bug is correctly identified: [src/runtime/compaction.ts](src/runtime/compaction.ts#L12) uses a private `chars / 4` estimator, [src/runtime/compaction.ts](src/runtime/compaction.ts#L57) gates preventive compaction on it, and [src/agents/base.ts](src/agents/base.ts#L265) plus [src/agents/base.ts](src/agents/base.ts#L296-L298) can store `thinking` blocks that the estimator does not count.
- One factual statement needs correction before approval: the estimator does not feed `isMaxCompactionsReached` directly. That safety check only compares `state.compactionCount` to `config.maxCompactions` at [src/runtime/compaction.ts](src/runtime/compaction.ts#L69-L73). The accurate claim is that an under-count can defer preventive compaction until the overflow-retry path invokes [src/runtime/compaction.ts](src/runtime/compaction.ts#L84), thereby consuming the same compaction budget indirectly.
- The analysis should also avoid implying that every provider overflow string is recognized equally. The agent-level regex is broad at [src/agents/base.ts](src/agents/base.ts#L774-L778), but router non-retryable classification currently recognizes only `exceeds the context window` and `context_length_exceeded` at [src/providers/router.ts](src/providers/router.ts#L415-L418). If the document keeps examples such as `prompt is too long`, it should say whether they are examples of real provider errors or errors the current retry path actually compacts on.

### Design

- Proposal B is the right architecture: token counting belongs behind the provider/router boundary, and `shouldCompact` can become async because its call sites already live in async flows at [src/agents/base.ts](src/agents/base.ts#L221-L233) and [src/agents/base.ts](src/agents/base.ts#L536).
- The provider inheritance story is factually inconsistent. Proposal B says the `BaseProvider` default covers `ollama`, `llamacpp`, `openrouter`, and `pi-ai`, but only `pi-ai` extends `BaseProvider` directly at [src/providers/pi-ai.ts](src/providers/pi-ai.ts#L43). `openrouter`, `ollama`, and `llamacpp` extend `OpenAIProvider` at [src/providers/openrouter.ts](src/providers/openrouter.ts#L6), [src/providers/ollama.ts](src/providers/ollama.ts#L7), and [src/providers/llamacpp.ts](src/providers/llamacpp.ts#L7). If `OpenAIProvider` overrides `countTokens`, those subclasses inherit the OpenAI-family behavior, not the proposed generic base fallback. The design needs to specify that deliberately, or require overrides for those subclasses.
- The Anthropic native-count path is under-specified for the original symptom. The current Anthropic conversion maps `tool_use` and `tool_result`, then turns all remaining blocks into text from `b.text` at [src/providers/anthropic.ts](src/providers/anthropic.ts#L82-L93). That drops `thinking` and `image` content from request-shaped messages. If the plan says Anthropic calls `messages.countTokens` with converted messages, it must also define a conversion that preserves/counts the relevant blocks or the recommended fix can still miss the cost that triggered F07.

### Plan

- Step 9 cannot remain optional if Anthropic `messages.countTokens` is part of the recommended implementation. The analysis correctly states that there must be no new provider RPC per loop iteration, but step 7 first implements `shouldCompact` as a full `await router.countTokens(...)` call and step 9 calls the `lastReportedInputTokens` shortcut optional. Because `shouldCompact` runs before every LLM call at [src/agents/base.ts](src/agents/base.ts#L221-L222), the running-token/cache strategy is part of the minimum executable plan, not an acceleration.
- The plan needs to make the `compactConversation` counting signature explicit. `compactConversation` currently receives `systemPrompt`, `messages`, `router`, `config`, and `state` at [src/runtime/compaction.ts](src/runtime/compaction.ts#L84-L90), but not the active `modelSpec` or tool schemas. Step 7 says its log line should call `router.countTokens(...)`; the plan must say whether it counts under the active agent model, the summary model, and with or without tools.
- Several line/call-site claims should be corrected so an implementer does not patch the wrong place. The `tools` array is currently created inside `callLLM` at [src/agents/base.ts](src/agents/base.ts#L477), not a few lines below the preventive compaction check in `runLoop`; it can be hoisted or recomputed, but the plan should say that plainly. The successful `router.chat(...)` call is at [src/agents/base.ts](src/agents/base.ts#L496), not at the r1 plan's cited `L246-L249` location.

## Required changes

1. Revise the analysis to state the compaction-count relationship accurately: `estimateTokens` directly gates `shouldCompact` and compaction logging, while `isMaxCompactionsReached` uses only the already-consumed compaction count.
2. Revise Proposal B and the plan so the no-extra-Anthropic-RPC constraint is satisfied by the minimum implementation, not by an optional acceleration. Either make the running-token shortcut mandatory before landing or choose a counting strategy that does not add a provider HTTP call on every loop.
3. Specify provider inheritance/counting behavior exactly: decide whether OpenAI-compatible subclasses inherit OpenAI tokenization or override it, and define how Anthropic counting preserves or otherwise accounts for `thinking` and image blocks.
4. Fix the stale or misleading call-site references in the plan, especially the location of `getToolSchemas()`, the `router.chat(...)` call, and the missing active-model/tool information needed by `compactConversation` logging.

## Strengths

- The documents correctly reject a purely reactive usage-only approach; it would compact one round too late and would not address `maybeStash`.
- The recommended provider/router boundary is clean, testable, and aligned with F20 and F18 without adding backward-compatibility shims.
- The test plan covers the important regression cases: thinking blocks, image blocks, router delegation, and provider-specific counting.

VERDICT: CHANGES_REQUESTED