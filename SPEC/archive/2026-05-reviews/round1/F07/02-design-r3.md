# F07 — Design (r3)

## Changes from r2

Accepted reviewer items (all four required changes):

1. **Stale call-site references corrected.** `CONTEXT_OVERFLOW_RE` is at [src/agents/base.ts](src/agents/base.ts#L872-L878). The preventive compaction guard is the block at [src/agents/base.ts](src/agents/base.ts#L224-L236) with `shouldCompact` at [src/agents/base.ts](src/agents/base.ts#L225). The router has no `resolveActive` helper; resolution mirrors `getMaxContextTokens` and uses the existing `tryParseModelId` → `buildCandidateChain` → `parseModelId` → `getProviderForRequest` chain at [src/providers/router.ts](src/providers/router.ts#L245-L258). The design and plan now spell that out concretely rather than naming a helper that does not exist.
2. **OpenAI-compatible subclass encoding behaviour is now exact.** Proposal B's `OpenAIProvider.countTokens` no longer falls back to `o200k_base` for unknown model names. The fallback is `cl100k_base`, and `OllamaProvider`/`LlamaCppProvider` carry explicit overrides that pin `cl100k_base` regardless of model string. `OpenRouterProvider` keeps the inherited logic — its model strings are prefixed (`openai/...`, `anthropic/...`, `meta-llama/...`) and almost never match `gpt-5*`/`o1*`/`o3*`/`o4*`, so they land on the safe `cl100k_base` fallback by design. Per-class behaviour is enumerated below and codified by tests in the plan.
3. **Calibration is now monotonically tightening.** The optional `response.usage.inputTokens` calibration only adjusts when the reported number is **greater than** the maintained estimate. It never decreases the maintained count. This preserves the trigger's "earlier compaction, never later" invariant unambiguously. (If a future change wants authoritative-down-correction, that is a separate decision and would be in its own issue.)
4. **`runningCountedMsgIdx` is removed from the design.** The plan already does not use it; the design now matches.

Rejected reviewer items: none.

---

## Proposal A — Replace `chars/4` with a per-provider local tokenizer behind a small helper

(Unchanged in shape from r2; restated here for completeness.)

**Scope (files touched):**

- New: `src/runtime/token-counting.ts` (~80–120 lines). Single entry point `countMessageTokens(messages, modelSpec)` plus `countTextTokens(text, modelSpec)`.
- Edited:
  - [src/runtime/compaction.ts](src/runtime/compaction.ts#L12-L26) — delete `estimateTokens`. `shouldCompact` and the `compactConversation` log line call `countMessageTokens` instead. `shouldCompact` and `compactConversation` gain `modelSpec` and `tools` parameters.
  - [src/agents/base.ts](src/agents/base.ts#L225), [src/agents/base.ts](src/agents/base.ts#L666-L675) — `shouldCompact` call site is rewritten with the new parameters; `maybeStash` recomputes its threshold against `contextWindow * 0.05` tokens (not `contextWindow * 4 * 0.05` chars).
- New dep: `js-tiktoken` (pure JS, no native deps, ~600 KB BPE tables, works under tsup ESM).

**What gets added:**

- A switch keyed on `parseModelId(modelSpec).provider` selecting an encoding: `cl100k_base` for Anthropic, ollama, llamacpp, openrouter, pi-ai; per-model selection for openai/openai-codex/copilot (`gpt-5*`/`o1*`/`o3*`/`o4*` → `o200k_base`; otherwise `cl100k_base`).
- Thinking-block content is read from `block.thinking` and encoded.
- Image blocks contribute a fixed 1568-token surcharge.
- Tool-call `input` is JSON-stringified the same way the OpenAI adapter serialises it at [src/providers/openai.ts](src/providers/openai.ts#L102-L107).

**What gets removed:**

- `function estimateTokens` and the `~4 chars per token` comment ([src/runtime/compaction.ts](src/runtime/compaction.ts#L11-L26)).
- The implicit assumption at [src/agents/base.ts](src/agents/base.ts#L666) that `contextWindow * 4` is a char budget.

**Risk:**

- Bundle size: ~600 KB acceptable.
- Tokeniser accuracy for non-OpenAI families routed through OpenRouter is ±10%, absorbed by the 80% threshold.
- Anthropic's `cl100k_base` proxy is ~5% off the real Claude tokeniser; absorbed by the threshold.

**What it enables:** F20 numerator becomes correct independent of denominator fix; F18 prompt-size dashboard becomes measurable.

**What it forbids:** Re-introducing `chars/4` shortcuts anywhere; per-consumer estimation.

**Recommendation note:** Cheapest fix, but token counting bleeds out of the provider abstraction into `src/runtime/`. Workable, but Proposal B is structurally cleaner for the same line-count.

---

## Proposal B (RECOMMENDED) — Token counting is a provider capability; consumers stop estimating

**Scope (files touched):**

- New: `src/runtime/token-counting.ts` (~80–120 lines). Pure shared helper `countWithTiktoken(messages, system, tools, encoding)` and `countTextWithTiktoken(text, encoding)`. Not a public consumer API.
- Edited:
  - [src/providers/types.ts](src/providers/types.ts#L80-L98) — `ModelProvider` gains:

    ```ts
    /** Count tokens for a request-shaped slice. Synchronous, local-only.
     *  Implementations must not perform network calls.
     *  Must handle thinking-blocks, image-blocks, and tool-use input.
     */
    countTokens(
      model: string,
      messages: Message[],
      system?: string,
      tools?: ToolSchema[],
    ): number;
    ```

  - [src/providers/base.ts](src/providers/base.ts#L19) — default delegates to `countWithTiktoken(messages, system, tools, "cl100k_base")`. This is the only path `pi-ai` exercises. The default is `cl100k_base`, not `o200k_base`: pi-ai's tokenizer is undocumented but most non-OpenAI BPEs sit closer to `cl100k_base` than to `o200k_base`, and the 80% threshold absorbs the drift.
  - [src/providers/openai.ts](src/providers/openai.ts) — overrides; selects encoding by **model name**:
    - `gpt-5*`, `o1*`, `o3*`, `o4*` → `o200k_base`.
    - Everything else (including `gpt-3.5*`, `gpt-4*`, `gpt-4o*`, and any non-GPT model string an OpenAI-compatible subclass would pass through) → `cl100k_base`.
    The fallback is deliberately `cl100k_base`, not `o200k_base`, so that subclasses inheriting this method without override do not silently pick a GPT-5-era encoding for non-OpenAI model names.
  - [src/providers/openrouter.ts](src/providers/openrouter.ts) — **no override**. Inherits `OpenAIProvider.countTokens`. OpenRouter model strings are vendor-prefixed (`openai/gpt-4o`, `anthropic/claude-3.5-sonnet`, `meta-llama/llama-3.1-70b`) and do not match `gpt-5*`/`o1-4*`, so they land on `cl100k_base` — the closer-of-two encodings for Claude, LLaMA, Mistral, Qwen, etc. The 80% threshold absorbs the residual drift. (Note: a model string like `openrouter` passing through `openai/gpt-5-foo` would still take the `o200k_base` branch via the inherited model-name match — the intended behaviour.)
  - [src/providers/ollama.ts](src/providers/ollama.ts) — **explicit override** that pins `cl100k_base` regardless of model name. Ollama serves local LLaMA/Mistral/Qwen derivatives; their actual BPEs differ from OpenAI's but `cl100k_base` is the closer of the two public encodings, and we never want a `gpt-5*` model-name false positive to flip the encoding.
  - [src/providers/llamacpp.ts](src/providers/llamacpp.ts) — **explicit override**, same body as `OllamaProvider.countTokens`. Same reasoning.
  - [src/providers/openai-codex.ts](src/providers/openai-codex.ts) — `OpenAICodexProvider` extends `BaseProvider` directly ([src/providers/openai-codex.ts](src/providers/openai-codex.ts#L79)); overrides explicitly with the same model-family selection as `OpenAIProvider`.
  - [src/providers/copilot.ts](src/providers/copilot.ts) — `CopilotProvider` extends `BaseProvider` directly ([src/providers/copilot.ts](src/providers/copilot.ts#L121)); overrides explicitly with the same model-family selection as `OpenAIProvider`. Copilot rides the same tokenisers.
  - [src/providers/anthropic.ts](src/providers/anthropic.ts) — overrides with a counting-only flattening:
    - `block.text` → encoded text.
    - `block.thinking` (when `block.type === "thinking"`) → encoded text.
    - `block.input` (when `block.type === "tool_use"`) → `JSON.stringify(block.input)` encoded.
    - `block.content` (when `block.type === "tool_result"`) → encoded text.
    - `block.type === "image"` → adds 1568 tokens flat (no BPE), regardless of `image.source.type`. This is **deliberately distinct** from `convertMessages` ([src/providers/anthropic.ts](src/providers/anthropic.ts#L74-L97)) — the wire-conversion drops thinking and images; the counting flattening preserves them. The two functions are independent on purpose: counting must reflect what the runtime *thinks* is in the context window, not what gets sent on a single retry.
    - Tools and system prompt are tokenised with `cl100k_base` and added.
    - Encoding: `cl100k_base` for all Claude models. Drift vs. the real Claude BPE is ~5%, absorbed by the 80% threshold. The native `messages.countTokens` HTTP endpoint is explicitly **not** invoked.
  - [src/providers/pi-ai.ts](src/providers/pi-ai.ts) — no override; inherits `BaseProvider`'s `cl100k_base` default.
  - [src/providers/router.ts](src/providers/router.ts#L245-L258) — adds `countTokens(modelSpec, messages, system?, tools?): number` mirroring `getMaxContextTokens`'s candidate-chain resolution: same `tryParseModelId` / `buildCandidateChain` / `parseModelId` / `getProviderForRequest` calls, no new helper introduced. Synchronous because all provider implementations are synchronous.
  - [src/runtime/compaction.ts](src/runtime/compaction.ts#L12-L94) — `estimateTokens` deleted. `shouldCompact` signature: `shouldCompact(runningTokens: number, config: CompactionConfig): boolean` — the runtime no longer counts inside `compaction.ts`; the caller passes a number maintained incrementally on `BaseAgent`. `compactConversation` signature gains `modelSpec` and `tools`, used for the `log.info` line via `router.countTokens(modelSpec, messages, systemPrompt, tools)`. (Compaction itself is rare, so a one-off full re-count there is fine.)
  - [src/agents/base.ts](src/agents/base.ts):
    - New fields: `private runningInputTokens = 0;` and `private staticInputTokens = 0;`. (No `runningCountedMsgIdx`: `pushMessage` does the per-message delta inline and `replaceMessages` resets-and-recounts in a single call, so a separate "index of last counted message" slot is unnecessary.)
    - `pushMessage` ([src/agents/base.ts](src/agents/base.ts#L718-L734)) gains a single line: `this.runningInputTokens += this.ctx.router.countTokens(this.ctx.modelSpec, [message]);` (per-message delta count; no system or tools because those don't change on push).
    - The first call per agent — initialised in the constructor or lazily on first `runLoop` entry — performs a one-time full count of `system + tools` and stores it as `private staticInputTokens = router.countTokens(modelSpec, [], systemPrompt, getToolSchemas())`. The compaction check then compares `runningInputTokens + staticInputTokens > threshold`.
    - `replaceMessages` ([src/agents/base.ts](src/agents/base.ts#L734)) resets `runningInputTokens = 0` then re-counts the replacement set in a single call.
    - **Optional calibration (monotonically tightening only).** After a successful `router.chat(...)` at [src/agents/base.ts](src/agents/base.ts#L496), if `response.usage.inputTokens` is reported **and** the reported value **exceeds** `runningInputTokens + staticInputTokens` by more than 10%, set `runningInputTokens = response.usage.inputTokens - staticInputTokens`. If the reported value is lower than the maintained estimate, leave the maintained estimate untouched. This guarantees calibration can only tighten the trigger, never weaken it. (Provider over-counts dominated by hidden control tokens are the case we care about; an apparent provider under-count is treated as noise and ignored.)
    - Compaction check at [src/agents/base.ts](src/agents/base.ts#L225): `if (shouldCompact(this.runningInputTokens + this.staticInputTokens, this.compactionConfig)) { ... }`.
    - Overflow-retry branch at [src/agents/base.ts](src/agents/base.ts#L515-L538) is unchanged in shape; `compactWithReinjection` flows through the same counter reset because it calls `replaceMessages` at [src/agents/base.ts](src/agents/base.ts#L850).
    - `maybeStash` at [src/agents/base.ts](src/agents/base.ts#L666-L675): rewritten to `const tokenBudget = Math.floor(this.compactionConfig.contextWindow * 0.05); const tokens = this.ctx.router.countTokens(this.ctx.modelSpec, [{ role: "user", content: [{ type: "tool_result", tool_use_id: toolUseId, content }] }]); if (tokens <= tokenBudget) return content;`. Counted as a synthetic single-message conversation under the active model.
    - **Tool-schema hoisting**: `getToolSchemas()` ([src/agents/base.ts](src/agents/base.ts#L474), defined at [src/agents/base.ts](src/agents/base.ts#L597)) returns a list whose value is stable per agent instance. `staticInputTokens` caches the count once. Re-invoked inside `callLLM` for the actual `router.chat(...)` call — no behavioural change, just one extra call per loop iteration to a synchronous function returning a fixed list. Not a hot path.

**What gets added:**

- `ModelProvider.countTokens(...)` (required, sync, returns `number`).
- Six concrete implementations: `BaseProvider` default, `OpenAIProvider` (inherited by `OpenRouterProvider` deliberately), `OllamaProvider` override, `LlamaCppProvider` override, `OpenAICodexProvider` override, `CopilotProvider` override, `AnthropicProvider` override. `pi-ai` uses the default.
- `BaseAgent.runningInputTokens` and `staticInputTokens` (two fields, no third index slot).
- `ModelRouter.countTokens(...)`.
- Optional monotonically-tightening `response.usage.inputTokens` calibration.

**What gets removed:**

- `function estimateTokens` ([src/runtime/compaction.ts](src/runtime/compaction.ts#L12-L26)) and the surrounding doc comment.
- The `* 4` factor at [src/agents/base.ts](src/agents/base.ts#L666). `maybeStash`'s threshold becomes a real token threshold.
- Any future temptation to add a `chars / N` rule of thumb anywhere — the interface requires a real `countTokens`.

**Risk:**

- *Per-message delta counting introduces 1× `tiktoken.encode` call per `pushMessage`*. Empirically <2 ms for tool-result blocks; <5 ms for large user messages. Acceptable.
- *Tool-schema cache invalidation*: tool schemas can change mid-conversation when a worker spawns and the parent's allowed-tool set narrows. The cached `staticInputTokens` is recomputed on every `replaceMessages` (compaction) and on agent start; it does **not** auto-recompute on tool-set change because the current code does not mutate tool sets after agent construction. If F09 or another change introduces dynamic tool sets, that work owns adding a `recomputeStaticInputTokens()` call — flagged here, not added speculatively.
- *Local BPE drift vs. provider reality*: ±5% for OpenAI under correct encoding, ±5–10% for Anthropic via `cl100k_base` proxy, ±10–15% for OpenRouter pass-through to non-OpenAI families. The 80% threshold yields 5 percentage points of headroom before context overflow. Within tolerance; the optional usage calibration tightens it further.
- *Interface ripple*: eight provider files **see** the new method, but two don't need overrides (`pi-ai` inherits `BaseProvider`; `openrouter` inherits `OpenAIProvider`). Compile-time guarantee that no provider can be added without it.
- *Vector for double-counting*: if a future contributor adds a code path that mutates `this.messages` directly (bypassing `pushMessage`/`replaceMessages`), the running counter drifts. Mitigated by making `this.messages` access patterns audit-friendly; today only `pushMessage` and `replaceMessages` mutate it (verified by `grep -n "this\.messages\." src/agents/base.ts`).

**What it enables (cross-issue):**

- **F20** (per-model `maxContextTokens`): denominator becomes per-model; F07's numerator already is, so the threshold finally means 80% of the actual window.
- **F18** (prompt extraction): `router.countTokens(modelSpec, [], systemPrompt)` becomes the standard "how big is this prompt?" call.
- **F09** (worker base): worker agents inherit `runningInputTokens` discipline by extending `BaseAgent`; no duplication.
- **F11** (magic constants): does not block; F07 doesn't move `compaction_threshold_pct` or `max_compactions`.
- Cost reporting and compaction policy converge on the same definition of "size".

**What it forbids:**

- Re-introducing `chars / N` shortcuts anywhere in the codebase.
- Per-consumer token estimation. `BaseAgent`, `maybeStash`, and any future skill matcher must go through `router.countTokens(...)` or, inside `BaseAgent`, the maintained `runningInputTokens` field.
- Adding a new provider without implementing or inheriting `countTokens`.

**Recommendation note:** As in r2 — this is the right architecture. The interface change is one synchronous method; the consumer change is a counter maintained on `pushMessage`/`replaceMessages`. The running-token shortcut is mandatory and structural, not an optional acceleration: `shouldCompact` reads a maintained number, never re-counts the prefix. The OpenAI-family fallback is now `cl100k_base`, with explicit `cl100k_base` overrides on ollama and llamacpp, so the OpenAI-compatible subclasses are guaranteed not to mis-count local LLaMA/Mistral models. Calibration is monotonically tightening; it cannot lower the maintained count.

---

## Proposal C (rejected) — Purely reactive: never pre-count, react to provider `usage` only

(Unchanged from r2.) Reject reason: triggers compaction one round too late; doesn't fix `maybeStash`. The monotonically-tightening calibration in Proposal B captures the value of `response.usage` without inheriting C's blind spot.

---

## Recommendation

**Proposal B.** Same architectural conclusion as r2, refined to:

- pin `OpenAIProvider`'s fallback encoding to `cl100k_base` (the safer default for OpenAI-compatible subclass pass-through),
- add explicit `cl100k_base` overrides on `OllamaProvider` and `LlamaCppProvider`,
- make `response.usage.inputTokens` calibration monotonically tightening, and
- drop the unused `runningCountedMsgIdx` field.

These changes preserve r2's architectural shape and resolve every reviewer-flagged ambiguity without adding new abstractions.
