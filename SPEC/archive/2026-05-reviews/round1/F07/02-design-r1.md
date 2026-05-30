# F07 — Design (r1)

Two proposals plus one rejected. Both delete `chars / 4` outright; they differ in *where* the authoritative count lives.

---

## Proposal A — Replace `chars/4` with a per-provider tokenizer behind a small helper

**Scope (files touched):**

- New: `src/runtime/token-counting.ts` (~80–120 lines). Single entry point `countMessageTokens(messages, modelSpec, router)`.
- Edited:
  - [src/runtime/compaction.ts](src/runtime/compaction.ts#L12-L26) — delete `estimateTokens`. `shouldCompact` and the `compactConversation` log line call `countMessageTokens` instead.
  - [src/agents/base.ts](src/agents/base.ts#L221-L240), [src/agents/base.ts](src/agents/base.ts#L676) — `shouldCompact` call site signature changes (one new argument: `modelSpec`, already in `this.ctx.modelSpec`); the `maybeStash` threshold at L676 (`contextWindow * 4 * 0.05`) is rewritten to `contextWindow * 0.05` of *tokens*, with content converted via `countTextTokens(content, modelSpec, router)`.
- New dep: `js-tiktoken` (pure-JS BPE; ~600 KB unpacked, no native deps, works under tsup ESM). Alternative `@dqbd/tiktoken` (WASM, faster but adds WASM-loading concerns under tsup) — rejected on operational simplicity.

**What gets added:**

- Module-level dispatch keyed on the provider name parsed out of `modelSpec`:

  ```ts
  // src/runtime/token-counting.ts (illustrative shape)
  export function countMessageTokens(
    messages: Message[],
    modelSpec: string,
    router: ModelRouter,
  ): number {
    const { provider } = parseModelId(modelSpec);
    switch (provider) {
      case "openai":
      case "openai-codex":
      case "copilot":            // Copilot rides OpenAI tokenizers
      case "openrouter":         // approximated via OpenAI tokenizer; see note
        return countWithTiktoken(messages, modelSpec);
      case "anthropic":
        return countWithAnthropicRatio(messages); // 3.5 ch/tok + thinking + image fudge
      case "pi-ai":
      case "ollama":
      case "llamacpp":
        return countWithGenericRatio(messages, 3.8);
    }
  }
  ```

- `countWithTiktoken` flattens every `ContentBlock` (including `thinking`, `image` placeholder), assembles a single string per message in the same way the OpenAI adapter does at [src/providers/openai.ts](src/providers/openai.ts#L80-L131), and passes it to `encoder.encode(...).length`. Tool calls are serialised the same way the OpenAI adapter serialises them (`JSON.stringify(input)` in a function-call envelope) so the count matches the wire format.
- `countWithAnthropicRatio` is a deliberate, named heuristic: `Math.ceil(allChars / 3.5)` for text + `block.thinking` + `block.content`, **plus** an image surcharge of `1568` per image block (Anthropic's documented base cost for a single image at default detail). The heuristic is honest about being an approximation; it replaces today's silent miscount, not the ideal `messages.countTokens` HTTP call (which is reserved for Proposal B).
- A single `countTextTokens(text, modelSpec, router)` overload used by `maybeStash`.

**What gets removed:**

- `function estimateTokens` and the `~4 chars per token` comment ([src/runtime/compaction.ts](src/runtime/compaction.ts#L11-L26)).
- The implicit assumption at [src/agents/base.ts](src/agents/base.ts#L676) that `contextWindow * 4` is a char budget — replaced by a real token budget.

**Risk:**

- *Bundle size.* `js-tiktoken` ships the cl100k_base + o200k_base BPE tables (~600 KB). Acceptable for a server runtime; not a constraint here.
- *Tokenizer accuracy for non-OpenAI models routed through OpenRouter.* OpenRouter exposes many model families; counting them with `o200k_base` will be ±10% for Claude/Gemini. Acceptable because compaction's threshold is 80%, leaving a comfortable margin — and OpenRouter is rarely used as primary.
- *Anthropic thinking blocks.* The 3.5 ch/tok ratio is conservative for prose but optimistic for code-heavy thinking. The 80% threshold still leaves headroom; if real-world traces show overflow, the fallback is to call Anthropic's `messages.countTokens` (Proposal B).
- *Cold-start cost.* `js-tiktoken` lazy-loads its tables on first `get_encoding(...)`; ~30 ms. Triggered by the planner's first loop iteration. Acceptable.

**What it enables (cross-issue):**

- F20 (per-model `maxContextTokens`): once F20 lands, the threshold denominator is also accurate, and the system is end-to-end correct for context budgeting.
- F18 (prompt bloat): once thinking-block tokens count, the prompt-size dashboard (potentially a F18 follow-up) can show *real* per-role costs.
- F09 (worker base): F09's planned `WorkerAgent` base would inherit the same accurate counter from `BaseAgent`; no extra work.

**What it forbids:**

- Re-introducing chars-per-token shortcuts anywhere in the codebase: there is one helper and the `chars/4` literal no longer exists.
- Provider-shaped drift: `countMessageTokens` is the only token counter; the switch is exhaustive on the eight registered providers.

**Recommendation note:** smallest meaningful fix; closes the under-count for the two providers that account for ~95% of real runtime calls (Anthropic via direct, OpenAI/GPT-5 via Copilot). Does not require touching the `ModelProvider` interface.

---

## Proposal B — Token counting becomes a provider capability; consumers stop estimating

Everything in Proposal A is replaced by a structural change: token accounting is the provider's job, and the runtime tracks an authoritative **running total** sourced from `response.usage` plus a provider-supplied incremental counter for newly-appended messages.

**Scope (files touched):**

- Edited:
  - [src/providers/types.ts](src/providers/types.ts#L80-L98) — `ModelProvider` gains:

    ```ts
    /** Count tokens for an arbitrary message slice (request-shaped).
     *  Implementations MAY call a provider HTTP endpoint or use a local BPE.
     *  MUST be cheap enough to call once per loop iteration; implementations
     *  should cache.
     */
    countTokens(model: string, messages: Message[], system?: string, tools?: ToolSchema[]): Promise<number>;
    ```

  - [src/providers/base.ts](src/providers/base.ts) — default implementation calls a shared `countWithTiktoken(messages, "o200k_base")` so providers without a native counter (ollama, llamacpp, openrouter, pi-ai) get a sensible default without per-file boilerplate.
  - [src/providers/anthropic.ts](src/providers/anthropic.ts) — implements `countTokens` via `this.client.messages.countTokens({ model, messages, system })`. Cached behind a `Map<messagesHash, number>` keyed on the last 4 message ids + system prompt SHA so repeated calls for the same message list don't hit the network. Single network call per loop iteration on cache miss; usually cache-hit after the first call in a round.
  - [src/providers/openai.ts](src/providers/openai.ts), [src/providers/openai-codex.ts](src/providers/openai-codex.ts), [src/providers/copilot.ts](src/providers/copilot.ts) — implement via `js-tiktoken` directly (no HTTP).
  - [src/providers/router.ts](src/providers/router.ts#L244-L258) — adds `async countTokens(modelSpec, messages, system, tools)` that mirrors `getMaxContextTokens` (resolves the provider via the same candidate-chain logic).
  - [src/runtime/compaction.ts](src/runtime/compaction.ts#L12-L64) — `estimateTokens` deleted. `shouldCompact` becomes `async shouldCompact(messages, systemPrompt, tools, config, router)`.
  - [src/agents/base.ts](src/agents/base.ts#L221-L240), [src/agents/base.ts](src/agents/base.ts#L517-L546) — call sites become `await shouldCompact(...)`. Both already live inside `async` functions; no signature ripple beyond these two sites.
  - [src/agents/base.ts](src/agents/base.ts#L676) — `maybeStash`'s threshold is rewritten in terms of tokens via `router.countTokens` on the single tool-result string (cached against the tool_use id to avoid double-counting on retry).
  - **Tracking the authoritative running cost.** `BaseAgent` keeps a `private lastReportedInputTokens: number | null`. After every successful `router.chat(...)` it stores `response.usage.inputTokens`. `shouldCompact` short-circuits: if `lastReportedInputTokens != null` AND the message list has only grown by N additive entries since the last call, it returns `(lastReportedInputTokens + countTokens(newSlice)) > threshold` — avoiding a full re-count of the unchanged prefix on every tick.
- Telemetry side-effect:
  - `recordLlmCall` at [src/providers/router.ts](src/providers/router.ts#L391-L393) is unchanged; the authoritative `usage` numbers now also drive compaction, not just dashboards.

**What gets added:**

- `ModelProvider.countTokens` as a real method (not optional). Eight implementations, mostly one-liners that delegate to a shared `countWithTiktoken` helper module.
- A `MessageHash` keying scheme (`sha1` of stringified message ids + last-message length) for the Anthropic-side cache.
- `lastReportedInputTokens` field on `BaseAgent` and an `additiveCount(newMessages)` shortcut on the provider.

**What gets removed:**

- `function estimateTokens` ([src/runtime/compaction.ts](src/runtime/compaction.ts#L11-L26)).
- The implicit "we'll over-estimate to be safe" mindset baked into the constant `0.80` threshold. With authoritative numbers, the threshold can stay at `0.80` and actually *mean* 80%, not "80% of an under-count that ends up being ~110% of real".
- The synchronous `shouldCompact` signature — replaced by `async`. The two callers are both already async; the change is local.

**Risk:**

- *Interface ripple.* Eight provider files gain a new method. Mitigated by the `BaseProvider` default implementation: ollama/llamacpp/openrouter/pi-ai don't need to override.
- *Anthropic HTTP cost.* `messages.countTokens` is a real RPC (~150 ms, ~no token cost from Anthropic). With the `lastReportedInputTokens` shortcut, it's called at most once per compaction event, not per loop tick. Network failures fall back to the local Anthropic ratio counter (the same one Proposal A uses) and log a warning.
- *Counter drift between local BPE and the provider's actual count.* For OpenAI-family the drift is < 1% (tiktoken is the reference); for Anthropic with the local fallback ratio, drift is ±15%, the same as Proposal A. The 80% threshold absorbs it.
- *The `lastReportedInputTokens` shortcut depends on additive message growth.* The two paths that don't grow additively are compaction itself (replaces history) and the orphaned-tool-result repair (also replaces history). Both already reset `compactionState`; both can reset `lastReportedInputTokens = null` in the same line.
- *Test surface.* Provider tests gain `countTokens` mocks. Router tests gain one new method to stub. The compaction unit test (if added) needs to drive an async path.

**What it enables (cross-issue):**

- F20 (per-model context windows) becomes a one-line change per provider once F07/B has landed: providers already know per-model BPE/tokenizer mappings, so `maxContextTokens(model)` can finally differentiate.
- F09 (worker base): the shared `WorkerAgent` inherits the running-token-count discipline, no duplication risk.
- F18 (prompt bloat): the per-role prompt budget is now measurable in real tokens via `router.countTokens(modelSpec, [], systemPrompt)`. A dashboard surface for "how big is each agent's prompt?" becomes trivially correct.
- Cost reporting: every `response.usage` already lives on `recordLlmCall`; with the same numbers driving compaction, dashboards and compaction policy converge on the same definition of "size".
- A future "soft compaction" (stash old turns to disk instead of summarising) becomes possible because we'd actually know which turns weigh how much.

**What it forbids:**

- Re-introducing a chars-per-token estimator anywhere in the codebase.
- Per-consumer token estimation — `BaseAgent`, `maybeStash`, any future skill matcher, the supervisor, the shutdown handoff serialiser, all go through `router.countTokens`.
- Adding a new provider without implementing (or inheriting via `BaseProvider`) `countTokens`; the method is required by the interface.

**Recommendation note:** the right architecture. The interface change is one method, the consumer change is two call sites becoming `async`, and it makes F20 a one-liner per provider afterwards. The only reason to pick A over B is if `async shouldCompact` would ripple unexpectedly — and it does not (both call sites verified above are already inside `async` functions).

---

## Proposal C (rejected) — Purely reactive: never pre-count, react to provider `usage` only

"Stop estimating altogether. After each LLM call, read `response.usage.inputTokens`; if it crossed the threshold, compact *before* the next call."

- **Pro:** zero implementation complexity beyond reading `response.usage`.
- **Con (fatal):** the first time the agent crosses the budget, the *current* call has already succeeded with usage > threshold but the *next* call may already be > the hard `maxContextTokens` limit because of the user/tool-result additions appended between calls. The proposal would force compaction one round too late, and the failure mode is exactly today's: a `context_length_exceeded` error from the provider, then the retry/compact path at [src/agents/base.ts](src/agents/base.ts#L517-L546). It addresses the wrong half of the loop (reactive instead of preventive).
- **Con:** doesn't fix `maybeStash`, which needs a *forward-looking* token count for tool results before they are added to history.

Rejected.

---

## Recommendation

**Proposal B.**

- The `ModelProvider` interface is the right place for "how big is this conversation?" because each provider already owns "how big is the *response*?" (`response.usage`). Splitting authoritative usage off-provider into a side library was the original mistake; B puts it back where it belongs.
- The two callers (`shouldCompact`, `maybeStash`) are both already async, so the synchronous-to-async shift costs nothing.
- It makes F20 the trivial change it should always have been, and gives F18 a measurable surface.
- The compatibility-shim risk is zero: `BaseProvider` gives a default `countTokens` so the eight providers don't all need to change in lockstep; the eight `chars/4` callers collapse to zero in the same commit.
- It does not require a transitional period (per `_LOOP-CONVENTIONS.md` §"Mandatory project guidelines").

If, during implementation, the `lastReportedInputTokens` shortcut proves insufficient (e.g. for some provider where `usage.inputTokens` is structurally undercounted relative to its own `countTokens`), the shortcut is dropped and `shouldCompact` calls `router.countTokens(...)` unconditionally — adding ~50 ms per tick for the local-BPE providers and one cached HTTP call per round for Anthropic. Acceptable.
