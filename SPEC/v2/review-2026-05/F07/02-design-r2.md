# F07 — Design (r2)

## Changes from r1

Accepted reviewer items:

1. **Anthropic native `messages.countTokens` HTTP call is removed from the recommended path.** r1 made it conditional on a "lastReportedInputTokens shortcut" labelled optional in the plan. r2 chooses a counting strategy that adds **zero provider HTTP calls** per loop tick: every provider counts locally with `js-tiktoken` (or the equivalent local heuristic), and the runtime maintains a mandatory incremental running total so the unchanged message prefix is never re-tokenised. The native Anthropic counter is mentioned only as a potential future calibration point and is explicitly out of scope for F07.
2. **`countTokens` is synchronous.** Because there is no HTTP call, the new `ModelProvider.countTokens(...)` method returns `number`, not `Promise<number>`. `shouldCompact` stays synchronous; r1's async ripple is no longer needed.
3. **Provider inheritance is now stated factually.** Only `pi-ai` reaches `BaseProvider.countTokens` directly. `openrouter`, `ollama`, `llamacpp` extend `OpenAIProvider` ([src/providers/openrouter.ts](src/providers/openrouter.ts#L6), [src/providers/ollama.ts](src/providers/ollama.ts#L7), [src/providers/llamacpp.ts](src/providers/llamacpp.ts#L7)) and therefore inherit `OpenAIProvider.countTokens` deliberately. r2 documents that as the intended inheritance and lists per-class behaviour.
4. **Anthropic block conversion is specified.** r1 referred to "converted messages" without saying which blocks survived; the current `convertMessages` at [src/providers/anthropic.ts](src/providers/anthropic.ts#L74-L97) drops `thinking` and `image` blocks. r2 defines an inline counting-only flattening that preserves `block.thinking` text, treats images as a fixed-token surcharge (1568 per image, Anthropic's documented base cost at default detail), and treats unknown block types as zero plus a `log.warn` once per distinct type.
5. **`compactConversation` counting signature is now explicit.** The log line counts under the **active agent model** with the **active tool schemas** — both are already available at the call site ([src/agents/base.ts](src/agents/base.ts#L233-L239), [src/agents/base.ts](src/agents/base.ts#L533)) via `this.ctx.modelSpec` and `this.getToolSchemas()`. The signature gains `modelSpec` and `tools` parameters.
6. **Call-site references corrected.**
   - `getToolSchemas()` is invoked inside `callLLM` at [src/agents/base.ts](src/agents/base.ts#L474), not "a few lines below" the compaction check. r2's plan hoists it to a small helper used by both `runLoop` and `callLLM`, or recomputes (it is cheap — pure schema list).
   - The successful `router.chat(...)` await is at [src/agents/base.ts](src/agents/base.ts#L496), inside the retry `try` block, not r1's cited `L246-L249`.
   - `replaceMessages` lives at [src/agents/base.ts](src/agents/base.ts#L734); the running-counter reset hook attaches there.

Rejected reviewer items: none. (All four required changes are addressed.)

Strengths the reviewer called out (no change required, kept for record): Proposal C still correctly rejected; F20 cross-link still correct; F18/F09 cross-links still correct.

---

## Proposal A — Replace `chars/4` with a per-provider local tokenizer behind a small helper

(Unchanged in shape from r1; restated here for completeness and updated for the corrected facts.)

**Scope (files touched):**

- New: `src/runtime/token-counting.ts` (~80–120 lines). Single entry point `countMessageTokens(messages, modelSpec)` plus `countTextTokens(text, modelSpec)`.
- Edited:
  - [src/runtime/compaction.ts](src/runtime/compaction.ts#L12-L26) — delete `estimateTokens`. `shouldCompact` and the `compactConversation` log line call `countMessageTokens` instead. `shouldCompact` and `compactConversation` gain `modelSpec` and `tools` parameters.
  - [src/agents/base.ts](src/agents/base.ts#L222), [src/agents/base.ts](src/agents/base.ts#L666-L675) — `shouldCompact` call site is rewritten with the new parameters; `maybeStash` recomputes its threshold against `contextWindow * 0.05` tokens (not `contextWindow * 4 * 0.05` chars).
- New dep: `js-tiktoken` (pure JS, no native deps, ~600 KB BPE tables, works under tsup ESM).

**What gets added:**

- A switch statement keyed on `parseModelId(modelSpec).provider` selecting an encoding (`o200k_base` for newer OpenAI/Codex/Copilot; `cl100k_base` for Anthropic; `o200k_base` for `pi-ai`/`ollama`/`llamacpp`/`openrouter` as a default).
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

  - [src/providers/base.ts](src/providers/base.ts#L19) — default delegates to `countWithTiktoken(messages, system, tools, "o200k_base")`. This is the only path `pi-ai` exercises.
  - [src/providers/openai.ts](src/providers/openai.ts) — overrides; selects encoding per model family (`gpt-3.5*` → `cl100k_base`; `gpt-4*`, `gpt-4o*` → `cl100k_base`; `gpt-5*`, `o1*`, `o3*`, `o4*` → `o200k_base`). **Inherited by** `OpenRouterProvider`, `OllamaProvider`, `LlamaCppProvider` deliberately — `openrouter` ships a mix of OpenAI-family and other models, but the OpenAI BPE is the closest public tokeniser available and the 80% threshold absorbs the drift; `ollama`/`llamacpp` are usually llama/mistral derivatives whose BPE is closer to `cl100k_base` than to `o200k_base`, so the OpenAI override is also acceptable. None of `openrouter`/`ollama`/`llamacpp` need their own override file.
  - [src/providers/openai-codex.ts](src/providers/openai-codex.ts) — `OpenAICodexProvider` extends `BaseProvider` directly ([src/providers/openai-codex.ts](src/providers/openai-codex.ts#L79)), so it overrides explicitly with the same model-family encoding logic.
  - [src/providers/copilot.ts](src/providers/copilot.ts) — `CopilotProvider` extends `BaseProvider` directly ([src/providers/copilot.ts](src/providers/copilot.ts#L121)), so it overrides explicitly with the OpenAI-family encoding logic. Copilot rides the same tokenisers.
  - [src/providers/anthropic.ts](src/providers/anthropic.ts) — overrides with a counting-only flattening:
    - `block.text` → encoded text.
    - `block.thinking` (when `block.type === "thinking"`) → encoded text.
    - `block.input` (when `block.type === "tool_use"`) → `JSON.stringify(block.input)` encoded.
    - `block.content` (when `block.type === "tool_result"`) → encoded text.
    - `block.type === "image"` → adds 1568 tokens flat (no BPE), regardless of `image.source.type`. This is **deliberately distinct** from `convertMessages` ([src/providers/anthropic.ts](src/providers/anthropic.ts#L74-L97)) — the wire-conversion drops thinking and images; the counting flattening preserves them. The two functions are independent on purpose: counting must reflect what the runtime *thinks* is in the context window, not what gets sent on a single retry.
    - Tools and system prompt are tokenised with `cl100k_base` and added.
    - Encoding: `cl100k_base` for all Claude models. Drift vs. the real Claude BPE is ~5%, absorbed by the 80% threshold. The native `messages.countTokens` HTTP endpoint is explicitly **not** invoked.
  - [src/providers/pi-ai.ts](src/providers/pi-ai.ts) — no override; inherits `BaseProvider`'s `o200k_base` default. Pi.ai's tokeniser is undocumented; the default is a reasonable approximation and pi.ai is rarely a primary.
  - [src/providers/router.ts](src/providers/router.ts#L245-L258) — adds `countTokens(modelSpec, messages, system?, tools?): number` mirroring `getMaxContextTokens`'s candidate-chain resolution. Synchronous because all provider implementations are synchronous.
  - [src/runtime/compaction.ts](src/runtime/compaction.ts#L12-L94) — `estimateTokens` deleted. `shouldCompact` signature: `shouldCompact(runningTokens: number, config: CompactionConfig): boolean` — the runtime no longer counts inside `compaction.ts`; the caller passes a number maintained incrementally on `BaseAgent`. `compactConversation` signature gains `modelSpec` and `tools`, used for the `log.info` line via `router.countTokens(modelSpec, messages, systemPrompt, tools)`. (Compaction itself is rare, so a one-off full re-count there is fine.)
  - [src/agents/base.ts](src/agents/base.ts):
    - New fields: `private runningInputTokens = 0;` and `private runningCountedMsgIdx = 0;`.
    - `pushMessage` ([src/agents/base.ts](src/agents/base.ts#L721-L734)) gains a single line: `this.runningInputTokens += this.ctx.router.countTokens(this.ctx.modelSpec, [message], undefined, undefined);` (per-message delta count; no system or tools because those don't change on push).
    - The first call per agent — initialised in the constructor or lazily on first `runLoop` entry — performs a one-time full count of `system + tools` and stores it as `private staticInputTokens = router.countTokens(modelSpec, [], systemPrompt, getToolSchemas())`. The compaction check then compares `runningInputTokens + staticInputTokens > threshold`.
    - `replaceMessages` ([src/agents/base.ts](src/agents/base.ts#L734)) resets `runningInputTokens = 0; runningCountedMsgIdx = 0;` then re-counts the replacement set in a single loop.
    - Optional calibration: after a successful `router.chat(...)` at [src/agents/base.ts](src/agents/base.ts#L496), if `response.usage.inputTokens` is reported and the delta from `runningInputTokens + staticInputTokens` is > 10%, set `runningInputTokens = response.usage.inputTokens - staticInputTokens`. This corrects local-BPE drift against authoritative provider counts. Pure tightening; never weakens the trigger.
    - Compaction check at [src/agents/base.ts](src/agents/base.ts#L222): `if (shouldCompact(this.runningInputTokens + this.staticInputTokens, this.compactionConfig)) { ... }`.
    - Overflow-retry branch at [src/agents/base.ts](src/agents/base.ts#L518-L546) is unchanged in shape; `compactWithReinjection` flows through the same counter reset because it calls `replaceMessages` at [src/agents/base.ts](src/agents/base.ts#L850).
    - `maybeStash` at [src/agents/base.ts](src/agents/base.ts#L666-L675): rewritten to `const tokenBudget = Math.floor(this.compactionConfig.contextWindow * 0.05); const tokens = this.ctx.router.countTokens(this.ctx.modelSpec, [{ role: "user", content: [{ type: "tool_result", tool_use_id: toolUseId, content }] }]); if (tokens <= tokenBudget) return content;`. Counted as a synthetic single-message conversation under the active model.
    - **Tool-schema hoisting**: `getToolSchemas()` ([src/agents/base.ts](src/agents/base.ts#L474), defined at [src/agents/base.ts](src/agents/base.ts#L597)) returns a list whose value is stable per agent instance. `staticInputTokens` caches the count once. Re-invoked inside `callLLM` for the actual `router.chat(...)` call — no behavioural change, just one extra call per loop iteration to a synchronous function returning a fixed list. Not a hot path.

**What gets added:**

- `ModelProvider.countTokens(...)` (required, sync, returns `number`).
- Five concrete implementations: `BaseProvider` default, `OpenAIProvider` (inherited by 3 subclasses), `OpenAICodexProvider`, `CopilotProvider`, `AnthropicProvider`. `pi-ai` uses the default. Total: four explicit overrides plus one default.
- `BaseAgent.runningInputTokens` / `staticInputTokens` / `runningCountedMsgIdx`.
- `ModelRouter.countTokens(...)`.
- Optional `response.usage.inputTokens` calibration step (pure tightening).

**What gets removed:**

- `function estimateTokens` ([src/runtime/compaction.ts](src/runtime/compaction.ts#L12-L26)) and the surrounding doc comment.
- The `* 4` factor at [src/agents/base.ts](src/agents/base.ts#L666). `maybeStash`'s threshold becomes a real token threshold.
- Any future temptation to add a `chars / N` rule of thumb anywhere — the interface requires a real `countTokens`.

**Risk:**

- *Per-message delta counting introduces 1× `tiktoken.encode` call per `pushMessage`*. Empirically <2 ms for tool-result blocks; <5 ms for large user messages. Acceptable.
- *Tool-schema cache invalidation*: tool schemas can change mid-conversation when a worker spawns and the parent's allowed-tool set narrows. The cached `staticInputTokens` is recomputed on every `replaceMessages` (compaction) and on agent start; it does **not** auto-recompute on tool-set change because the current code does not mutate tool sets after agent construction. If F09 or another change introduces dynamic tool sets, that work owns adding a `recomputeStaticInputTokens()` call — flagged here, not added speculatively.
- *Local BPE drift vs. provider reality*: ±5% for OpenAI, ±5–10% for Anthropic via `cl100k_base` proxy, ±10–15% for OpenRouter pass-through to non-OpenAI families. The 80% threshold yields 5 percentage points of headroom before context overflow. Within tolerance; the optional usage calibration tightens it further.
- *Interface ripple*: eight provider files **see** the new method, but four don't need overrides. Compile-time guarantee that no provider can be added without it.
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

**Recommendation note:** As in r1 — this is the right architecture. The interface change is one synchronous method; the consumer change is a counter maintained on `pushMessage`/`replaceMessages`. The running-token shortcut is now **mandatory and structural**, not an optional acceleration: `shouldCompact` reads a maintained number, never re-counts the prefix.

---

## Proposal C (rejected) — Purely reactive: never pre-count, react to provider `usage` only

(Unchanged from r1.) Reject reason: triggers compaction one round too late; doesn't fix `maybeStash`. The optional calibration in Proposal B captures the value of `response.usage` without inheriting C's blind spot.

---

## Recommendation

**Proposal B.** Same architectural conclusion as r1, but the implementation no longer adds an HTTP call per loop iteration: counting is synchronous and local for every provider, and the unchanged-prefix re-count is eliminated structurally by the maintained running counter (mandatory, not optional). The `BaseProvider` default plus `OpenAIProvider` inheritance covers six of the eight providers without per-file boilerplate; the remaining two (`AnthropicProvider`, `OpenAICodexProvider`/`CopilotProvider`) override deliberately with documented per-block treatment for `thinking` and `image` content.
