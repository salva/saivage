# F07 — Analysis (r1)

## Problem restated

The runtime decides when to summarise an agent's conversation by comparing one number — a `chars / 4` rule-of-thumb — against `thresholdPct * contextWindow`. The estimator lives at [src/runtime/compaction.ts](src/runtime/compaction.ts#L12-L26) and is the **only** signal feeding both `shouldCompact` ([src/runtime/compaction.ts](src/runtime/compaction.ts#L57-L64)) and the safety check `isMaxCompactionsReached` (via the log line at [src/runtime/compaction.ts](src/runtime/compaction.ts#L91-L94) and the retry path at [src/agents/base.ts](src/agents/base.ts#L517-L546)).

The estimator is wrong in three concrete ways:

1. **Reasoning is invisible.** `BaseAgent` assembles assistant messages that contain `{ type: "thinking", thinking, thinking_signature }` blocks ([src/agents/base.ts](src/agents/base.ts#L263-L269), [src/agents/base.ts](src/agents/base.ts#L293-L300)). The estimator only sums `block.text`, `block.content` and `JSON.stringify(block.input)` ([src/runtime/compaction.ts](src/runtime/compaction.ts#L18-L22)) — it never reads `block.thinking`. A 6k-token Claude 4 / GPT-5 reasoning chain contributes **zero** to the estimate.
2. **Image content is invisible.** `ContentBlock` allows `type: "image"` ([src/providers/types.ts](src/providers/types.ts#L8-L19)). Images cost real tokens at the provider but contribute zero chars to the estimator.
3. **The 4 chars/token ratio is provider-agnostic.** Anthropic's BPE averages closer to ~3.5 ch/tok for English prose and much lower for code/JSON; GPT-4o averages ~4 ch/tok for English but ~2.5 for dense JSON; tool-call `input` is dense JSON. The estimator JSON-stringifies `block.input` before dividing by 4, which under-counts tool-heavy turns by 30–60%.

The estimator runs on every iteration of `BaseAgent.runLoop` ([src/agents/base.ts](src/agents/base.ts#L221-L240)) **and** on every context-overflow retry inside `callLLM` ([src/agents/base.ts](src/agents/base.ts#L515-L546)). When it under-counts, the agent keeps growing past the real context window, the provider call fails with a `context_length_exceeded` / `prompt is too long` error, and the retry logic at [src/agents/base.ts](src/agents/base.ts#L517-L546) compacts and retries — burning one of the three permitted compactions on a problem that should have been caught preventively. After three such compactions the agent is terminated (`max_compactions`), which the planner and manager surface as a hard failure ([src/agents/planner.ts](src/agents/planner.ts#L210), [src/agents/manager.ts](src/agents/manager.ts#L313)).

Authoritative usage is already available but unused: every provider returns `response.usage.{inputTokens, outputTokens}` and the router records them at [src/providers/router.ts](src/providers/router.ts#L391-L393). The compaction logic does not consume them.

## Contract

`estimateTokens(messages: Message[]) -> number`. Pure function over the in-memory message array. Today:

- Input: `messages` from [src/providers/types.ts](src/providers/types.ts#L3-L19) (string content OR `ContentBlock[]`).
- Output: integer ≥ 0.
- Error modes: none thrown; silently returns a low-biased number for thinking blocks, images, and non-text content.
- Lifecycle: called synchronously before each LLM round and inside the overflow-retry branch. Not memoised. O(N) over all blocks in all messages.

`shouldCompact(messages, config) -> boolean`. Wraps the estimator. The threshold is `thresholdPct * contextWindow` — both numbers come from `BaseAgentConfig` and ultimately from `SaivageConfig.agents[role]` at [src/agents/base.ts](src/agents/base.ts#L185-L193).

`contextWindow` itself is sourced from `router.getMaxContextTokens(modelSpec)` ([src/providers/router.ts](src/providers/router.ts#L244-L258)), which delegates to each provider's `maxContextTokens(model)`. F20 documents that those numbers are hardcoded per provider (200 000 for Anthropic, 128 000 for OpenAI, regardless of model). F07 and F20 are independent: even if F20 fixed the denominator, F07 would still mis-count the numerator.

## Call sites & dependencies

- `shouldCompact` — called once per loop iteration at [src/agents/base.ts](src/agents/base.ts#L221-L240).
- `compactConversation` — called by the same loop ([src/agents/base.ts](src/agents/base.ts#L233-L240)) and by the overflow-retry path ([src/agents/base.ts](src/agents/base.ts#L536-L546)).
- `estimateTokens` — only ever called from inside `compaction.ts` (private to the module via lack of export).
- No test currently asserts the value of `estimateTokens` directly; the only related test is the runtime-state mirroring suite in `src/runtime/runtime.test.ts`, which does not touch token counting.
- Provider `usage` field is consumed only by:
  - `recordLlmCall` ([src/providers/router.ts](src/providers/router.ts#L391-L393)) for telemetry.
  - Router tests asserting `usage.inputTokens` round-trips.
  - No downstream consumer feeds it back into `BaseAgent` or `compaction`.

Provider-side authoritative counting that already exists:

- **OpenAI / Codex / Copilot / OpenRouter** — `response.usage.{input_tokens|prompt_tokens, output_tokens|completion_tokens}` ([src/providers/openai.ts](src/providers/openai.ts#L73-L78), [src/providers/openai-codex.ts](src/providers/openai-codex.ts#L237-L278), [src/providers/copilot.ts](src/providers/copilot.ts#L256-L259), [src/providers/copilot.ts](src/providers/copilot.ts#L301-L304), [src/providers/copilot.ts](src/providers/copilot.ts#L439-L442)).
- **Anthropic** — `response.usage.{input_tokens, output_tokens}` ([src/providers/anthropic.ts](src/providers/anthropic.ts#L65-L69)). The SDK also exposes a stand-alone `client.messages.countTokens(...)` endpoint for *pre-flight* counting; it is not used.
- **pi-ai** — `result.usage.{input, output}` ([src/providers/pi-ai.ts](src/providers/pi-ai.ts#L263-L266)).
- **ollama / llamacpp** — no usage field is wired up; they return placeholder zeros via `BaseProvider`.

A pre-flight (i.e. *before* `chat()`) provider-side count is available only for Anthropic today; OpenAI's tokenizer is deterministic locally via the `tiktoken` (or `@dqbd/tiktoken`/`js-tiktoken`) WASM library; Copilot rides OpenAI tokenizers; OpenRouter rides per-model tokenizers; ollama/llamacpp report context length via their `/api/tokenize` endpoints (not currently called).

## Constraints any solution must respect

1. **No backward-compat shims.** The `chars / 4` path must be deleted in the same change that replaces it — no transitional `useAccurateTokens` flag, no `if (legacyEstimator)` branch, no `@deprecated` alias kept for callers (per `_LOOP-CONVENTIONS.md` §"Mandatory project guidelines"). The two callers (`shouldCompact`, the log line in `compactConversation`) and the overflow-retry log line must all switch in lockstep.
2. **Synchronous `shouldCompact` is currently called on every loop tick.** Any solution that needs async (e.g. Anthropic's `messages.countTokens` HTTP call) must either:
   - cache the count and recompute it only when the message list grows (additive token cost of the newly-appended messages), or
   - make `shouldCompact` async and adjust the call sites at [src/agents/base.ts](src/agents/base.ts#L221-L240) and [src/agents/base.ts](src/agents/base.ts#L517-L546).
3. **No new provider RPC per loop iteration.** Calling `messages.countTokens` per tick would double the request load against Anthropic and add ~150–400 ms of latency to every agent step. The cache strategy above is mandatory if a server-side counter is used.
4. **Out-of-scope boundary.** `src/skills/`, `SPEC/v2/skills-memory/`, `SPEC/v2/skills/` are owned by another agent. Token counting in the *skill matcher's* prompt budget (`skills.max_per_agent` at [src/agents/base.ts](src/agents/base.ts#L168-L177)) is not touched.
5. **Provider interface change must extend, not re-shape.** `ModelProvider` ([src/providers/types.ts](src/providers/types.ts#L80-L98)) is implemented by eight providers; adding an optional method is safe, replacing or renaming an existing one is not (changes ripple through every provider plus router + tests).
6. **F20 may land independently.** The fix must work whether `maxContextTokens` returns one number per provider (today) or one number per model (F20-proposed). The compaction config interface is keyed on `contextWindow: number` and must remain so; F20 only changes the **value**.
7. **Compaction count semantics must not change.** `max_compactions = 3` is the user-visible safety net (planner/manager react to `max_compactions`). A more accurate counter that triggers compaction earlier and more often must keep the *cap*; an off-by-one improvement that turns 3 valid compactions into 5 silent ones is a regression.

## Out-of-band observations (informational, not part of the fix)

- The COMPACTION_PROMPT itself uses a generic "summarize this conversation" template that loses thinking-block content (it is invisible to the serialiser in `serializeForSummary` at [src/runtime/compaction.ts](src/runtime/compaction.ts#L143-L165)). After F07 lands and thinking blocks start showing up as real cost, the *summariser* will also start dropping the most-expensive content from the post-compaction history. This is an F18-adjacent concern (prompt content) and will need a follow-up.
- F11 lists `compaction_threshold_pct = 80` and `max_compactions = 3` as magic constants; F07 does not contest those values — only the *signal* they are compared against.
