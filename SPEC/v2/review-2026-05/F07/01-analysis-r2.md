# F07 — Analysis (r2)

## Changes from r1

- Corrected the relationship between `estimateTokens` and `isMaxCompactionsReached`. They are independent: the estimator gates only `shouldCompact` and the compaction log line. `isMaxCompactionsReached` looks at `state.compactionCount` alone. The under-count therefore burns the compaction budget **indirectly**, by letting preventive compaction skip until the overflow-retry path forces a compaction.
- Clarified which "context overflow" strings actually drive the compact-and-retry path. The agent-side regex is broad ([src/agents/base.ts](src/agents/base.ts#L773-L778)) but the router's `nonRetryable` classification is narrow — only `exceeds the context window` and `context_length_exceeded` ([src/providers/router.ts](src/providers/router.ts#L412-L416)). Calls out which examples are real provider strings vs. examples the current router would route through generic retry.
- Tightened call-site line numbers against the current file.

## Problem restated

The runtime decides when to summarise an agent's conversation by comparing one number — a `chars / 4` rule-of-thumb — against `thresholdPct * contextWindow`. The estimator lives at [src/runtime/compaction.ts](src/runtime/compaction.ts#L12-L26) and feeds exactly two consumers:

1. `shouldCompact` ([src/runtime/compaction.ts](src/runtime/compaction.ts#L55-L62)), called once per loop iteration at [src/agents/base.ts](src/agents/base.ts#L222).
2. The "tokens: ~N" log line inside `compactConversation` ([src/runtime/compaction.ts](src/runtime/compaction.ts#L91-L94)).

It does **not** feed `isMaxCompactionsReached` ([src/runtime/compaction.ts](src/runtime/compaction.ts#L67-L72)), which compares `state.compactionCount` to `config.maxCompactions` and never looks at message size. The relationship is indirect: when `estimateTokens` under-counts, `shouldCompact` returns `false`, the agent keeps growing past the real context window, the provider call eventually fails with a context-overflow error, and the retry path at [src/agents/base.ts](src/agents/base.ts#L518-L546) invokes `compactConversation` and bumps `compactionCount`. After three such consumptions of the compaction budget the agent is terminated with `max_compactions`, surfaced as a hard failure by planner/manager ([src/agents/planner.ts](src/agents/planner.ts#L210), [src/agents/manager.ts](src/agents/manager.ts#L313)).

The estimator is wrong in three concrete ways:

1. **Reasoning is invisible.** `BaseAgent` assembles assistant messages that contain `{ type: "thinking", thinking, thinking_signature }` blocks ([src/agents/base.ts](src/agents/base.ts#L263-L269), [src/agents/base.ts](src/agents/base.ts#L293-L300)). The estimator only sums `block.text`, `block.content` and `JSON.stringify(block.input)` ([src/runtime/compaction.ts](src/runtime/compaction.ts#L18-L22)) — it never reads `block.thinking`. A 6k-token Claude 4 / GPT-5 reasoning chain contributes **zero** to the estimate.
2. **Image content is invisible.** `ContentBlock` allows `type: "image"` ([src/providers/types.ts](src/providers/types.ts#L8-L19)). Images cost real tokens at the provider but contribute zero chars to the estimator.
3. **The 4 chars/token ratio is provider-agnostic.** Anthropic's BPE averages closer to ~3.5 ch/tok for English prose and lower for code/JSON; GPT-4o averages ~4 ch/tok for English but ~2.5 for dense JSON; tool-call `input` is dense JSON. The estimator JSON-stringifies `block.input` before dividing by 4, which under-counts tool-heavy turns by 30–60%.

### Which overflow errors actually trigger compaction

The agent's compact-and-retry branch tests `isContextOverflowError(msg) || isOrphanedToolResultError(msg)` ([src/agents/base.ts](src/agents/base.ts#L518)) using `CONTEXT_OVERFLOW_RE = /context.{0,20}(window|length)|exceeds?.{0,20}(context|token|limit)|max.{0,10}tokens?.{0,10}exceed|too many tokens/i` ([src/agents/base.ts](src/agents/base.ts#L773-L778)). That regex matches:

- Anthropic: `prompt is too long` — **does NOT match** the regex (no "context", no "exceeds", no "too many tokens"). This means real Anthropic overflow surfaces today as a generic transient error and falls through to the exponential-backoff path, where it retries indefinitely until `transientCap` fires. That is a latent secondary bug; F07 does not fix it but its existence makes accurate pre-flight counting even more important.
- OpenAI: `This model's maximum context length is 128000 tokens` — matches via `max.{0,10}tokens?.{0,10}exceed` only if the message contains "exceeded", which the OpenAI SDK does emit (`...exceeds the context window of...`). Matches.
- Router-level `nonRetryable` ([src/providers/router.ts](src/providers/router.ts#L412-L416)) only recognises the exact substrings `exceeds the context window` and `context_length_exceeded`. So even when the agent-side regex would match, only those two substrings prevent the router from marking the failure as a candidate-chain retry first.

Net: the compact-and-retry path is only reliably reached for OpenAI-style providers. For Anthropic the under-counted estimator does not even get a safety-net compaction; it just keeps retrying and eventually fails the call.

Authoritative usage is already available but unused: every provider returns `response.usage.{inputTokens, outputTokens}` and the router records them at [src/providers/router.ts](src/providers/router.ts#L391-L393). The compaction logic does not consume them.

## Contract

`estimateTokens(messages: Message[]) -> number`. Pure function over the in-memory message array. Today:

- Input: `messages` from [src/providers/types.ts](src/providers/types.ts#L3-L19) (string content OR `ContentBlock[]`).
- Output: integer ≥ 0.
- Error modes: none thrown; silently returns a low-biased number for thinking blocks, images, and non-text content.
- Lifecycle: called synchronously before each LLM round and inside the compaction log line. Not memoised. O(N) over all blocks in all messages.

`shouldCompact(messages, config) -> boolean`. Wraps the estimator. The threshold is `thresholdPct * contextWindow` — both numbers come from `BaseAgentConfig` and ultimately from `SaivageConfig.agents[role]` at [src/agents/base.ts](src/agents/base.ts#L185-L193).

`contextWindow` itself is sourced from `router.getMaxContextTokens(modelSpec)` ([src/providers/router.ts](src/providers/router.ts#L244-L258)), which delegates to each provider's `maxContextTokens(model)`. F20 documents that those numbers are hardcoded per provider. F07 and F20 are independent: even if F20 fixed the denominator, F07 would still mis-count the numerator.

## Call sites & dependencies

- `shouldCompact` — called once per loop iteration at [src/agents/base.ts](src/agents/base.ts#L222).
- `compactConversation` — called by the same loop ([src/agents/base.ts](src/agents/base.ts#L233-L239)) and by the overflow-retry path ([src/agents/base.ts](src/agents/base.ts#L536-L542)).
- `isMaxCompactionsReached` — called at [src/agents/base.ts](src/agents/base.ts#L223) and [src/agents/base.ts](src/agents/base.ts#L522); reads `state.compactionCount` only.
- `estimateTokens` — only ever called from inside `compaction.ts` (private to the module via lack of export).
- `maybeStash` — defined at [src/agents/base.ts](src/agents/base.ts#L675-L685); its threshold is `contextWindow * 4 * 0.05` (chars, treating `contextWindow` as tokens × 4). Called at [src/agents/base.ts](src/agents/base.ts#L328) when building each tool-result block.
- No test currently asserts the value of `estimateTokens` directly; the only related test is the runtime-state mirroring suite in `src/runtime/runtime.test.ts`, which does not touch token counting.
- Provider `usage` field is consumed only by `recordLlmCall` ([src/providers/router.ts](src/providers/router.ts#L391-L393)) for telemetry. No downstream consumer feeds it back into `BaseAgent` or `compaction`.

### Provider class hierarchy (verified)

- `BaseProvider` (abstract) ([src/providers/base.ts](src/providers/base.ts#L3))
- Direct subclasses: `AnthropicProvider` ([src/providers/anthropic.ts](src/providers/anthropic.ts#L12)), `OpenAIProvider` ([src/providers/openai.ts](src/providers/openai.ts#L12)), `OpenAICodexProvider` ([src/providers/openai-codex.ts](src/providers/openai-codex.ts#L79)), `CopilotProvider` ([src/providers/copilot.ts](src/providers/copilot.ts#L121)), `PiAiProvider` ([src/providers/pi-ai.ts](src/providers/pi-ai.ts#L43)).
- Subclasses of `OpenAIProvider`: `OpenRouterProvider` ([src/providers/openrouter.ts](src/providers/openrouter.ts#L6)), `OllamaProvider` ([src/providers/ollama.ts](src/providers/ollama.ts#L7)), `LlamaCppProvider` ([src/providers/llamacpp.ts](src/providers/llamacpp.ts#L7)).

Any method added to `OpenAIProvider` is inherited by `openrouter/ollama/llamacpp` unless they override it. Any method added only to `BaseProvider` reaches `pi-ai` but is shadowed for the three OpenAI-API-compatible subclasses by whatever `OpenAIProvider` defines.

### Provider-side authoritative counting that already exists

- **OpenAI / Codex / Copilot / OpenRouter** — `response.usage.{input_tokens|prompt_tokens, output_tokens|completion_tokens}` ([src/providers/openai.ts](src/providers/openai.ts#L73-L78), [src/providers/openai-codex.ts](src/providers/openai-codex.ts#L237-L278), [src/providers/copilot.ts](src/providers/copilot.ts#L256-L259), [src/providers/copilot.ts](src/providers/copilot.ts#L301-L304), [src/providers/copilot.ts](src/providers/copilot.ts#L439-L442)).
- **Anthropic** — `response.usage.{input_tokens, output_tokens}` ([src/providers/anthropic.ts](src/providers/anthropic.ts#L65-L69)). The SDK also exposes `client.messages.countTokens(...)` for pre-flight counting; not currently used. The native counter accepts the same `messages`/`system`/`tools` shape as `messages.create`, so it natively understands `thinking` and `image` blocks if they are converted/preserved.
- **pi-ai** — `result.usage.{input, output}` ([src/providers/pi-ai.ts](src/providers/pi-ai.ts#L263-L266)).
- **ollama / llamacpp** — no usage field is wired up; they return placeholder zeros via the OpenAI-shaped path inherited from `OpenAIProvider`.

A pre-flight provider-side count is available only for Anthropic today; OpenAI's tokenizer is deterministic locally via the `tiktoken` (or `js-tiktoken`) WASM/JS library; Copilot rides OpenAI tokenizers; OpenRouter rides per-model tokenizers; ollama/llamacpp report context length via `/api/tokenize` (not currently called).

## Constraints any solution must respect

1. **No backward-compat shims.** The `chars / 4` path must be deleted in the same change that replaces it — no transitional `useAccurateTokens` flag, no `if (legacyEstimator)` branch, no `@deprecated` alias (per `_LOOP-CONVENTIONS.md` §"Mandatory project guidelines"). The two callers (`shouldCompact`, the log line in `compactConversation`) and `maybeStash`'s implicit char budget must all switch in lockstep.
2. **Synchronous `shouldCompact` is currently called on every loop tick.** Any solution that needs async (e.g. Anthropic's `messages.countTokens` HTTP call) must either:
   - cache the count and recompute it only when the message list grows (additive token cost of the newly-appended messages), or
   - make `shouldCompact` async and adjust the call sites at [src/agents/base.ts](src/agents/base.ts#L222) and [src/agents/base.ts](src/agents/base.ts#L518-L542).
3. **No new provider RPC per loop iteration.** Calling `messages.countTokens` on every tick would double the request load against Anthropic and add ~150–400 ms of latency per agent step. A running-token shortcut driven by `response.usage` is mandatory; it is not an acceleration that can be deferred.
4. **Out-of-scope boundary.** `src/skills/`, `SPEC/v2/skills-memory/`, `SPEC/v2/skills/` are owned by another agent. Token counting in the *skill matcher's* prompt budget (`skills.max_per_agent` at [src/agents/base.ts](src/agents/base.ts#L168-L177)) is not touched.
5. **Provider interface change must extend, not re-shape.** `ModelProvider` ([src/providers/types.ts](src/providers/types.ts#L80-L98)) is implemented by `BaseProvider` and inherited by all eight providers. Adding a required method with a default in `BaseProvider` is safe; renaming/removing existing methods is not.
6. **F20 may land independently.** The fix must work whether `maxContextTokens` returns one number per provider (today) or one per model (F20). The compaction config interface stays keyed on `contextWindow: number`; F20 only changes the **value**.
7. **Compaction count semantics must not change.** `max_compactions = 3` is the user-visible safety net. A more accurate counter that triggers compaction earlier and more often must keep the cap; an off-by-one improvement that silently turns 3 compactions into 5 is a regression.

## Out-of-band observations (informational, not part of the fix)

- The COMPACTION_PROMPT template feeds `serializeForSummary` ([src/runtime/compaction.ts](src/runtime/compaction.ts#L143-L165)) which currently drops `thinking`-block content. After F07 lands and thinking tokens start counting toward the threshold, the summariser will start dropping the most-expensive content from post-compaction history. F18-adjacent; needs a follow-up.
- The Anthropic-side `prompt is too long` mismatch with `CONTEXT_OVERFLOW_RE` (above) is a separate bug; if F07's accurate pre-flight counting works, this mismatch becomes mostly unreachable in practice.
- F11 lists `compaction_threshold_pct = 80` and `max_compactions = 3` as magic constants; F07 does not contest those values — only the *signal* they are compared against.
