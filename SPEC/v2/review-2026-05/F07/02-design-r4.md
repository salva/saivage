# F07 — Design (r4)

## Changes from r3

Accepted reviewer items (both required changes):

1. **`PiAiProvider.countTokens` is now the load-bearing override.** The r3 design relied on overrides in `AnthropicProvider`, `OpenAIProvider`, and `OpenAICodexProvider`, but `ModelRouter.createProvider` at [src/providers/router.ts](src/providers/router.ts#L720-L760) does not instantiate those classes for the live runtime path; it constructs `PiAiProvider` for `anthropic`, `openai`, `openai-codex`, `opencode`, and `opencode-go`. r4 introduces a provider/model-aware `PiAiProvider.countTokens` override that inspects `this.piProvider` (captured at construction, [src/providers/pi-ai.ts](src/providers/pi-ai.ts#L46-L50)) and the model name to pick the correct encoding. The runtime correctness surface now actually moves under change.
2. **Tests pin live-router behaviour.** The test plan now exercises `router.countTokens(modelSpec, ...)` for each of the five `PiAiProvider`-backed provider names, not just the unregistered direct classes. The new tests would fail today if the encoding were inherited from `BaseProvider` default.

The unregistered direct classes (`AnthropicProvider`, `OpenAICodexProvider`, `OpenRouterProvider`) still receive `countTokens` overrides — the new method is required by the `ModelProvider` interface, so every concrete class must implement it. Those overrides are explicitly labelled as not-on-live-path; full deletion of those dead classes is out of scope for F07 (it is its own clean-up issue under "Remove dead code").

`OpenAIProvider`'s override remains — it is the parent of `OllamaProvider` and `LlamaCppProvider`, which both add their own explicit overrides anyway, but keeping the parent method defined preserves the class's usability as a base.

Other r3 corrections (compaction call-site refs, monotonic calibration, removal of `runningCountedMsgIdx`, the `cl100k_base` fallback choice for OpenAI-compatible subclasses) all stand.

---

## Proposal A — Replace `chars/4` with a per-provider local tokenizer behind a small helper

(Unchanged in shape from r3; restated for completeness.)

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
- Tokeniser accuracy for non-OpenAI families is ±10%, absorbed by the 80% threshold.
- The proposal moves token counting out of the provider layer entirely — `BaseProvider` and subclasses never learn about encoding, but `compaction.ts` accumulates a provider-name switch that duplicates the routing logic in `ModelRouter`.

**What it enables:** F20 numerator becomes correct independent of denominator fix; F18 prompt-size dashboard becomes measurable.

**What it forbids:** Re-introducing `chars/4` shortcuts anywhere; per-consumer estimation.

**Recommendation note:** Cheapest fix, but token counting bleeds out of the provider abstraction into `src/runtime/`. Workable, but Proposal B is structurally cleaner for the same line-count and avoids encoding the provider-routing table twice.

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

  - [src/providers/base.ts](src/providers/base.ts#L3) — default delegates to `countWithTiktoken(messages, system, tools, "cl100k_base")`. The default is `cl100k_base` because it is the safer baseline for any non-OpenAI BPE. **This default is now reachable only through `CopilotProvider` if it forgets to override, and through any future provider that subclasses `BaseProvider` without overriding.** It is NOT reachable through `PiAiProvider` after this change (PiAiProvider overrides).
  - [src/providers/pi-ai.ts](src/providers/pi-ai.ts#L43) — **new mandatory override**. This is the live runtime entry point for `anthropic`, `openai`, `openai-codex`, `opencode`, and `opencode-go`:

    ```ts
    override countTokens(
      model: string,
      messages: Message[],
      system?: string,
      tools?: ToolSchema[],
    ): number {
      const encoding = this.encodingFor(model);
      return countWithTiktoken(messages, system, tools, encoding);
    }

    private encodingFor(model: string): "cl100k_base" | "o200k_base" {
      switch (this.piProvider) {
        case "openai":
        case "openai-codex":
          return /^(gpt-5|o1|o3|o4)/.test(model) ? "o200k_base" : "cl100k_base";
        case "anthropic":
          // cl100k_base is a documented ±5% proxy for Claude's BPE; the
          // native Anthropic countTokens HTTP is intentionally not called
          // (no per-loop RPC; see constraints §3).
          return "cl100k_base";
        case "opencode":
        case "opencode-go":
          // Non-OpenAI families (Kimi, GLM, DeepSeek). cl100k_base is the
          // closer of the two public encodings.
          return "cl100k_base";
        default:
          return "cl100k_base";
      }
    }
    ```

    Rationale for the per-`piProvider` switch (not per-model only):
    - `PiAiProvider` is constructed once per pi-ai provider name ([src/providers/router.ts](src/providers/router.ts#L729-L750)); `this.piProvider` is a stable enum-like string set by the router and is the only way to disambiguate `openai` vs `anthropic` vs `opencode` traffic going through the same class.
    - Model strings inside one piProvider (e.g. `openai`) include both `gpt-5*` (o200k_base) and `gpt-4o*` (cl100k_base), so a per-model regex is also necessary for the OpenAI family. Anthropic and OpenCode model strings do not need model-level branching (Claude all uses one BPE; Kimi/GLM/DeepSeek are non-OpenAI in any version).
  - [src/providers/copilot.ts](src/providers/copilot.ts#L121) — override using the same model-family regex as OpenAI (Copilot rides OpenAI BPEs):

    ```ts
    override countTokens(
      model: string,
      messages: Message[],
      system?: string,
      tools?: ToolSchema[],
    ): number {
      const encoding = /^(gpt-5|o1|o3|o4)/.test(model) ? "o200k_base" : "cl100k_base";
      return countWithTiktoken(messages, system, tools, encoding);
    }
    ```

  - [src/providers/openai.ts](src/providers/openai.ts#L12) — `OpenAIProvider` (a base class for `OllamaProvider`/`LlamaCppProvider`/`OpenRouterProvider`, never directly instantiated by the router today) overrides:

    ```ts
    override countTokens(
      model: string,
      messages: Message[],
      system?: string,
      tools?: ToolSchema[],
    ): number {
      const encoding = /^(gpt-5|o1|o3|o4)/.test(model) ? "o200k_base" : "cl100k_base";
      return countWithTiktoken(messages, system, tools, encoding);
    }
    ```

    Fallback for unknown / non-GPT model names is `cl100k_base` — the safer default for any OpenAI-compatible subclass passing through a non-OpenAI model name. `OpenRouterProvider` would inherit this (no override needed).
  - [src/providers/ollama.ts](src/providers/ollama.ts#L7) — **explicit override** that pins `cl100k_base` regardless of model name. Local LLaMA/Mistral/Qwen derivatives. Belt-and-suspenders: also blocks a user-installed model tag that accidentally matches `gpt-5*` from flipping the encoding.
  - [src/providers/llamacpp.ts](src/providers/llamacpp.ts#L7) — **explicit override**, same body as ollama.
  - [src/providers/openrouter.ts](src/providers/openrouter.ts#L6) — **no override** (class is unregistered in the router today). Inherits `OpenAIProvider.countTokens`. Vendor-prefixed model strings (`openai/gpt-4o`, `anthropic/claude-3.5-sonnet`, `meta-llama/llama-3.1-70b`) do not match `gpt-5|o1|o3|o4`, so they land on `cl100k_base`. Not on the live runtime path; provided so the class compiles and could be wired up by future registration.
  - [src/providers/anthropic.ts](src/providers/anthropic.ts#L12) — `AnthropicProvider` (unregistered in router; dead code at runtime, kept until a separate cleanup) overrides:

    ```ts
    override countTokens(
      _model: string,
      messages: Message[],
      system?: string,
      tools?: ToolSchema[],
    ): number {
      return countWithTiktoken(messages, system, tools, "cl100k_base");
    }
    ```

    Not on the live runtime path. The block flattening in `countWithTiktoken` already handles `thinking` and `image`.
  - [src/providers/openai-codex.ts](src/providers/openai-codex.ts#L79) — `OpenAICodexProvider` (unregistered in router; dead code at runtime) overrides with the same body as `OpenAIProvider`.
  - [src/providers/router.ts](src/providers/router.ts#L245-L258) — adds `countTokens(modelSpec, messages, system?, tools?): number` mirroring `getMaxContextTokens`'s candidate-chain resolution: same `tryParseModelId` / `buildCandidateChain` / `parseModelId` / `getProviderForRequest` calls, no new helper introduced. Synchronous because all provider implementations are synchronous.
  - [src/runtime/compaction.ts](src/runtime/compaction.ts#L12-L94) — `estimateTokens` deleted. `shouldCompact` signature: `shouldCompact(runningTokens: number, config: CompactionConfig): boolean` — the runtime no longer counts inside `compaction.ts`; the caller passes a number maintained incrementally on `BaseAgent`. `compactConversation` signature gains `modelSpec` and `tools`, used for the `log.info` line via `router.countTokens(modelSpec, messages, systemPrompt, tools)`.
  - [src/agents/base.ts](src/agents/base.ts):
    - New fields: `private runningInputTokens = 0;` and `private staticInputTokens = 0;`.
    - `pushMessage` ([src/agents/base.ts](src/agents/base.ts#L718-L734)) gains: `this.runningInputTokens += this.ctx.router.countTokens(this.ctx.modelSpec, [message]);` after `this.messages.push(message);`.
    - `replaceMessages` ([src/agents/base.ts](src/agents/base.ts#L734)) resets and recounts in one call: `this.messages = messages; this.runningInputTokens = this.ctx.router.countTokens(this.ctx.modelSpec, messages);`.
    - One-time initialisation in the constructor (after `getToolSchemas` is callable): `this.staticInputTokens = this.ctx.router.countTokens(this.ctx.modelSpec, [], this.systemPrompt, this.getToolSchemas());`.
    - Compaction check at [src/agents/base.ts](src/agents/base.ts#L225): `if (shouldCompact(this.runningInputTokens + this.staticInputTokens, this.compactionConfig)) { ... }`.
    - Overflow-retry branch at [src/agents/base.ts](src/agents/base.ts#L515-L538) is unchanged; `compactWithReinjection` resets the counter via the `replaceMessages` reset above.
    - **Optional monotonically-tightening calibration.** After a successful `router.chat(...)` at [src/agents/base.ts](src/agents/base.ts#L496): if `response.usage.inputTokens > (runningInputTokens + staticInputTokens) * 1.1`, set `runningInputTokens = max(0, response.usage.inputTokens - staticInputTokens)`. Never lowers the maintained count.
    - `maybeStash` at [src/agents/base.ts](src/agents/base.ts#L666-L675): threshold becomes `Math.floor(this.compactionConfig.contextWindow * 0.05)` tokens; size measured via `router.countTokens(modelSpec, [{ role: "user", content: [{ type: "tool_result", tool_use_id, content }] }])`. The `4 *` factor at [src/agents/base.ts](src/agents/base.ts#L667) is deleted.

**What gets added:**

- `ModelProvider.countTokens(...)` (required, sync, returns `number`).
- Eight concrete implementations: `BaseProvider` default, `PiAiProvider` override (**load-bearing**, covers 5 live registrations), `CopilotProvider` override, `OpenAIProvider` override (base for Ollama/LlamaCpp), `OllamaProvider` override, `LlamaCppProvider` override, `AnthropicProvider` override (interface only — class not registered), `OpenAICodexProvider` override (interface only — class not registered). `OpenRouterProvider` inherits.
- `BaseAgent.runningInputTokens` and `staticInputTokens`.
- `ModelRouter.countTokens(...)`.
- Optional monotonically-tightening `response.usage.inputTokens` calibration.

**What gets removed:**

- `function estimateTokens` ([src/runtime/compaction.ts](src/runtime/compaction.ts#L12-L26)) and the surrounding doc comment.
- The `* 4` factor at [src/agents/base.ts](src/agents/base.ts#L666). `maybeStash`'s threshold becomes a real token threshold.

**Risk:**

- *Per-message delta counting introduces 1× `tiktoken.encode` call per `pushMessage`*. Empirically <2 ms for tool-result blocks; <5 ms for large user messages.
- *`PiAiProvider` is a shared class for five distinct provider families*. The encoding switch sits inside `PiAiProvider.encodingFor`, gated by `this.piProvider`. A future contributor adding a new pi-ai registration in `createProvider` must also extend `encodingFor` — caught at test time by adding one test per registered piProvider (step 9 below).
- *Local BPE drift vs. provider reality*: ±5% for OpenAI under correct encoding; ±5–10% for Anthropic via `cl100k_base` proxy; ±10–15% for OpenCode pass-through to Kimi/GLM/DeepSeek. The 80% threshold yields 5 percentage points of headroom.
- *Interface ripple*: eight provider files **see** the new method; `PiAiProvider`'s override is the one that matters for production; the other overrides on direct classes are minimum-compliance.
- *Dead-code surface*: `AnthropicProvider`, `OpenAICodexProvider`, `OpenRouterProvider` continue to exist; the F07 design does not delete them. They will be deleted by a separate cleanup issue.
- *Vector for double-counting*: if a future contributor adds a code path that mutates `this.messages` directly (bypassing `pushMessage`/`replaceMessages`), the running counter drifts. Today only `pushMessage` and `replaceMessages` mutate `this.messages` (verified by `grep -n "this\.messages\." src/agents/base.ts`).

**What it enables (cross-issue):**

- **F20** (per-model `maxContextTokens`): denominator becomes per-model; F07's numerator already is, so the threshold finally means 80% of the actual window.
- **F18** (prompt extraction): `router.countTokens(modelSpec, [], systemPrompt)` becomes the standard "how big is this prompt?" call.
- **F09** (worker base): worker agents inherit `runningInputTokens` discipline by extending `BaseAgent`.
- **F11** (magic constants): does not block; F07 doesn't move `compaction_threshold_pct` or `max_compactions`.
- **F-cleanup-providers** (proposed): F07 makes the dead-code observation explicit, paving the way for deleting `AnthropicProvider`, `OpenAICodexProvider`, `OpenRouterProvider` and their tests.

**What it forbids:**

- Re-introducing `chars / N` shortcuts anywhere in the codebase.
- Per-consumer token estimation. `BaseAgent`, `maybeStash`, and any future skill matcher must go through `router.countTokens(...)` or, inside `BaseAgent`, the maintained `runningInputTokens` field.
- Adding a new provider without implementing or inheriting `countTokens`.
- Adding a new `PiAiProvider` registration without extending `PiAiProvider.encodingFor` (enforced by test coverage, step 9 below).

**Recommendation note:** This is the right architecture. The interface change is one synchronous method; the live runtime fix lives on `PiAiProvider.countTokens` where the production traffic actually goes. The OpenAI-family encoding logic is reused by `CopilotProvider` and `OpenAIProvider` (with its subclass overrides); the unregistered direct classes get minimum-compliance overrides that document themselves as dead-code-pending-cleanup.

---

## Proposal C (rejected) — Purely reactive: never pre-count, react to provider `usage` only

(Unchanged from r3.) Reject reason: triggers compaction one round too late; doesn't fix `maybeStash`. The monotonically-tightening calibration in Proposal B captures the value of `response.usage` without inheriting C's blind spot.

---

## Recommendation

**Proposal B.** Same architectural conclusion as r3, with the load-bearing override moved from the unregistered direct classes to `PiAiProvider` where production traffic actually flows. Direct-class overrides remain for interface compliance and are documented as not-on-live-path. Tests now pin behaviour through `router.countTokens(modelSpec, ...)` for every registered `PiAiProvider` family.
