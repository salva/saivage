# F07 — Analysis (r3)

## Changes from r2

- Corrected the stale source references the r2 reviewer flagged. `CONTEXT_OVERFLOW_RE` lives at [src/agents/base.ts](src/agents/base.ts#L872-L878) (r2 still cited the pre-refactor `L773-L778`). The preventive-compaction guard block is at [src/agents/base.ts](src/agents/base.ts#L224-L236) with the `shouldCompact` call at [src/agents/base.ts](src/agents/base.ts#L225) (r2 cited `L222`). All other line numbers re-verified against the current file.
- Cross-check of the overflow-retry path: `isContextOverflowError` is invoked at [src/agents/base.ts](src/agents/base.ts#L515-L516) and `compactWithReinjection` from that branch at [src/agents/base.ts](src/agents/base.ts#L533); preventive `compactWithReinjection` is at [src/agents/base.ts](src/agents/base.ts#L236). These are the references the design and plan attach to.
- No other findings from r2 affect analysis-level claims (provider hierarchy and `response.usage` availability were already correct in r2).

## Problem restated

The runtime decides when to summarise an agent's conversation by comparing one number — a `chars / 4` rule-of-thumb — against `thresholdPct * contextWindow`. The estimator lives at [src/runtime/compaction.ts](src/runtime/compaction.ts#L12-L26) and feeds exactly two consumers:

1. `shouldCompact` ([src/runtime/compaction.ts](src/runtime/compaction.ts#L55-L62)), called once per loop iteration at [src/agents/base.ts](src/agents/base.ts#L225).
2. The "tokens: ~N" log line inside `compactConversation` ([src/runtime/compaction.ts](src/runtime/compaction.ts#L91-L94)).

It does **not** feed `isMaxCompactionsReached` ([src/runtime/compaction.ts](src/runtime/compaction.ts#L67-L72)), which compares `state.compactionCount` to `config.maxCompactions` and never looks at message size. The relationship is indirect: when `estimateTokens` under-counts, `shouldCompact` returns `false`, the agent keeps growing past the real context window, the provider call eventually fails with a context-overflow error, and the retry path at [src/agents/base.ts](src/agents/base.ts#L515-L538) invokes `compactWithReinjection` and bumps `compactionCount`. After three such consumptions of the compaction budget the agent is terminated with `max_compactions`, surfaced as a hard failure by planner/manager ([src/agents/planner.ts](src/agents/planner.ts#L210), [src/agents/manager.ts](src/agents/manager.ts#L313)).

The estimator is wrong in three concrete ways:

1. **Reasoning is invisible.** `BaseAgent` assembles assistant messages that contain `{ type: "thinking", thinking, thinking_signature }` blocks ([src/agents/base.ts](src/agents/base.ts#L263-L269), [src/agents/base.ts](src/agents/base.ts#L293-L300)). The estimator only sums `block.text`, `block.content` and `JSON.stringify(block.input)` ([src/runtime/compaction.ts](src/runtime/compaction.ts#L18-L22)) — it never reads `block.thinking`. A 6k-token Claude 4 / GPT-5 reasoning chain contributes **zero** to the estimate.
2. **Image content is invisible.** `ContentBlock` allows `type: "image"` ([src/providers/types.ts](src/providers/types.ts#L8-L19)). Images cost real tokens at the provider but contribute zero chars to the estimator.
3. **The 4 chars/token ratio is provider-agnostic.** Anthropic's BPE averages closer to ~3.5 ch/tok for English prose and lower for code/JSON; GPT-4o averages ~4 ch/tok for English but ~2.5 for dense JSON; tool-call `input` is dense JSON. The estimator JSON-stringifies `block.input` before dividing by 4, which under-counts tool-heavy turns by 30–60%.

### Which overflow errors actually trigger compaction

The agent's compact-and-retry branch tests `isContextOverflowError(msg) || isOrphanedToolResultError(msg)` ([src/agents/base.ts](src/agents/base.ts#L515)) using `CONTEXT_OVERFLOW_RE = /context.{0,20}(window|length)|exceeds?.{0,20}(context|token|limit)|max.{0,10}tokens?.{0,10}exceed|too many tokens/i` ([src/agents/base.ts](src/agents/base.ts#L872-L878)). That regex matches:

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

`contextWindow` itself is sourced from `router.getMaxContextTokens(modelSpec)` ([src/providers/router.ts](src/providers/router.ts#L245-L258)), which delegates to each provider's `maxContextTokens(model)` via the same `tryParseModelId` → `buildCandidateChain` → `parseModelId` → `getProviderForRequest` resolution chain. F20 documents that those numbers are hardcoded per provider. F07 and F20 are independent: even if F20 fixed the denominator, F07 would still mis-count the numerator.

## Call sites & dependencies

- `shouldCompact` — called once per loop iteration at [src/agents/base.ts](src/agents/base.ts#L225).
- `compactConversation` — called from inside `compactWithReinjection` at [src/agents/base.ts](src/agents/base.ts#L820-L850); `compactWithReinjection` itself is reached from the preventive path at [src/agents/base.ts](src/agents/base.ts#L236) and from the overflow-retry path at [src/agents/base.ts](src/agents/base.ts#L533).
- `isMaxCompactionsReached` — called at [src/agents/base.ts](src/agents/base.ts#L226) and [src/agents/base.ts](src/agents/base.ts#L519); reads `state.compactionCount` only.
- `estimateTokens` — only ever called from inside `compaction.ts` (private to the module via lack of export).
- `maybeStash` — defined at [src/agents/base.ts](src/agents/base.ts#L666-L675); its threshold is `contextWindow * 4 * 0.05` (chars, treating `contextWindow` as tokens × 4). Called at [src/agents/base.ts](src/agents/base.ts#L325) when building each tool-result block.
- No test currently asserts the value of `estimateTokens` directly; the only related test is the runtime-state mirroring suite in `src/runtime/runtime.test.ts`, which does not touch token counting.
- Provider `usage` field is consumed only by `recordLlmCall` ([src/providers/router.ts](src/providers/router.ts#L391-L393)) for telemetry. No downstream consumer feeds it back into `BaseAgent` or `compaction`.

### Provider class hierarchy (verified)

- `BaseProvider` (abstract) ([src/providers/base.ts](src/providers/base.ts#L3))
- Direct subclasses: `AnthropicProvider` ([src/providers/anthropic.ts](src/providers/anthropic.ts#L12)), `OpenAIProvider` ([src/providers/openai.ts](src/providers/openai.ts#L12)), `OpenAICodexProvider` ([src/providers/openai-codex.ts](src/providers/openai-codex.ts#L79)), `CopilotProvider` ([src/providers/copilot.ts](src/providers/copilot.ts#L121)), `PiAiProvider` ([src/providers/pi-ai.ts](src/providers/pi-ai.ts#L43)).
- Subclasses of `OpenAIProvider`: `OpenRouterProvider` ([src/providers/openrouter.ts](src/providers/openrouter.ts#L6)), `OllamaProvider` ([src/providers/ollama.ts](src/providers/ollama.ts#L7)), `LlamaCppProvider` ([src/providers/llamacpp.ts](src/providers/llamacpp.ts#L7)).

Any method added to `OpenAIProvider` is inherited by `openrouter/ollama/llamacpp` unless they override it. Any method added only to `BaseProvider` reaches `pi-ai` but is shadowed for the three OpenAI-API-compatible subclasses by whatever `OpenAIProvider` defines.

The three OpenAI-compatible subclasses serve different model families:

- `OpenRouterProvider`: routes to many vendors; model strings look like `openai/gpt-4o`, `anthropic/claude-3.5-sonnet`, `meta-llama/llama-3.1-70b`. No single tokenizer is correct; `cl100k_base` is the safest broad default (closer to Claude/LLaMA BPEs than `o200k_base`, and within 5% of GPT-3.5/GPT-4 OpenAI families).
- `OllamaProvider`: local models, predominantly LLaMA / Mistral / Qwen derivatives. Their actual BPEs differ from OpenAI's but `cl100k_base` is the closer of the two public encodings.
- `LlamaCppProvider`: same situation as ollama — local LLaMA-family derivatives.

These three subclasses must therefore **not** inherit a `gpt-5*`-style fallback that selects `o200k_base` for unknown model strings.

### Provider-side authoritative counting that already exists

- **OpenAI / Codex / Copilot / OpenRouter** — `response.usage.{input_tokens|prompt_tokens, output_tokens|completion_tokens}` ([src/providers/openai.ts](src/providers/openai.ts#L73-L78), [src/providers/openai-codex.ts](src/providers/openai-codex.ts#L237-L278), [src/providers/copilot.ts](src/providers/copilot.ts#L256-L259), [src/providers/copilot.ts](src/providers/copilot.ts#L301-L304), [src/providers/copilot.ts](src/providers/copilot.ts#L439-L442)).
- **Anthropic** — `response.usage.{input_tokens, output_tokens}` ([src/providers/anthropic.ts](src/providers/anthropic.ts#L65-L69)). The SDK also exposes `client.messages.countTokens(...)` for pre-flight counting; not currently used. F07 deliberately does not invoke it (no per-loop HTTP).
- **pi-ai** — `result.usage.{input, output}` ([src/providers/pi-ai.ts](src/providers/pi-ai.ts#L263-L266)).
- **ollama / llamacpp** — no usage field is wired up; they return placeholder zeros via the OpenAI-shaped path inherited from `OpenAIProvider`.

## Constraints any solution must respect

1. **No backward-compat shims.** The `chars / 4` path must be deleted in the same change that replaces it — no transitional `useAccurateTokens` flag, no `if (legacyEstimator)` branch, no `@deprecated` alias (per `_LOOP-CONVENTIONS.md` §"Mandatory project guidelines"). The two callers (`shouldCompact`, the log line in `compactConversation`) and `maybeStash`'s implicit char budget must all switch in lockstep.
2. **Synchronous `shouldCompact` is currently called on every loop tick.** Any solution that needs async (e.g. Anthropic's `messages.countTokens` HTTP call) must either:
   - cache the count and recompute it only when the message list grows (additive token cost of the newly-appended messages), or
   - make `shouldCompact` async and adjust the call sites at [src/agents/base.ts](src/agents/base.ts#L225) and [src/agents/base.ts](src/agents/base.ts#L515-L538).
3. **No new provider RPC per loop iteration.** Calling `messages.countTokens` on every tick would double the request load against Anthropic and add ~150–400 ms of latency per agent step. A running-token shortcut driven by message-delta counting plus optional `response.usage` calibration is mandatory; it is not an acceleration that can be deferred.
4. **Out-of-scope boundary.** `src/skills/`, `SPEC/v2/skills-memory/`, `SPEC/v2/skills/` are owned by another agent. Token counting in the *skill matcher's* prompt budget (`skills.max_per_agent` at [src/agents/base.ts](src/agents/base.ts#L168-L177)) is not touched.
5. **Provider interface change must extend, not re-shape.** `ModelProvider` ([src/providers/types.ts](src/providers/types.ts#L80-L98)) is implemented by `BaseProvider` and inherited by all eight providers. Adding a required method with a default in `BaseProvider` is safe; renaming/removing existing methods is not.
6. **F20 may land independently.** The fix must work whether `maxContextTokens` returns one number per provider (today) or one per model (F20). The compaction config interface stays keyed on `contextWindow: number`; F20 only changes the **value**.
7. **Compaction count semantics must not change.** `max_compactions = 3` is the user-visible safety net. A more accurate counter that triggers compaction earlier and more often must keep the cap; an off-by-one improvement that silently turns 3 compactions into 5 is a regression.
8. **OpenAI-compatible subclasses must not inherit a GPT-only fallback.** Any `countTokens` added to `OpenAIProvider` whose default branch picks an OpenAI-specific encoding for unknown model strings would mis-count local LLaMA/Mistral models on ollama and llamacpp and mis-count Anthropic/Meta passthroughs on OpenRouter. The fallback encoding for unknown-family model names must be the same encoding the three subclasses would themselves pick (`cl100k_base`).

## Out-of-band observations (informational, not part of the fix)

- The COMPACTION_PROMPT template feeds `serializeForSummary` ([src/runtime/compaction.ts](src/runtime/compaction.ts#L143-L165)) which currently drops `thinking`-block content. After F07 lands and thinking tokens start counting toward the threshold, the summariser will start dropping the most-expensive content from post-compaction history. F18-adjacent; needs a follow-up.
- The Anthropic-side `prompt is too long` mismatch with `CONTEXT_OVERFLOW_RE` (above) is a separate bug; if F07's accurate pre-flight counting works, this mismatch becomes mostly unreachable in practice.
- F11 lists `compaction_threshold_pct = 80` and `max_compactions = 3` as magic constants; F07 does not contest those values — only the *signal* they are compared against.
