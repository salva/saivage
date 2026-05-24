# F07 — Plan (r3)

For the recommended Proposal B (token counting as a synchronous provider capability, with a mandatory running-token counter on `BaseAgent`).

## Changes from r2

Accepted reviewer items (all four required changes):

1. **Stale source references corrected.** `CONTEXT_OVERFLOW_RE` is at [src/agents/base.ts](src/agents/base.ts#L872-L878). The preventive-compaction guard block is at [src/agents/base.ts](src/agents/base.ts#L224-L236) with the `shouldCompact` call at [src/agents/base.ts](src/agents/base.ts#L225). All other line numbers re-verified.
2. **Router pass-through no longer names a nonexistent `resolveActive` helper.** Step 6 now inlines the same `tryParseModelId` → `buildCandidateChain` → `parseModelId` → `getProviderForRequest` chain that `getMaxContextTokens` already uses at [src/providers/router.ts](src/providers/router.ts#L245-L258). No new router helper is introduced.
3. **OpenAI-compatible subclass encoding is now exact.** Step 5a pins `OpenAIProvider`'s fallback to `cl100k_base` instead of `o200k_base`. New steps 5e and 5f add explicit `cl100k_base` overrides for `OllamaProvider` and `LlamaCppProvider`. `OpenRouterProvider` deliberately inherits — its model strings (`openai/...`, `anthropic/...`, `meta-llama/...`) do not match the GPT-5-family regex and therefore land on `cl100k_base` via inheritance. The plan adds tests that prove this.
4. **Calibration is monotonically tightening.** Step 8's calibration snippet only runs when the reported `inputTokens` **exceeds** the maintained estimate; it never lowers the maintained count.

Rejected reviewer items: none.

Removed from r2: any mention of `runningCountedMsgIdx`. Two counter fields only (`runningInputTokens`, `staticInputTokens`).

---

## Ordered edit steps

1. **New module: [src/runtime/token-counting.ts](src/runtime/token-counting.ts).**
   Exports:
   ```ts
   export function countWithTiktoken(
     messages: Message[],
     system: string | undefined,
     tools: ToolSchema[] | undefined,
     encoding: "cl100k_base" | "o200k_base",
   ): number;

   export function countTextWithTiktoken(text: string, encoding: "cl100k_base" | "o200k_base"): number;
   ```
   `countWithTiktoken` flattens every `ContentBlock` and encodes:
   - `block.text` → text encoded.
   - `block.thinking` (when `block.type === "thinking"`) → text encoded.
   - `block.content` (when `block.type === "tool_result"`) → text encoded.
   - `block.input` (when `block.type === "tool_use"`) → `JSON.stringify(block.input)` encoded, plus a fixed 3-token envelope per call.
   - `block.type === "image"` → adds **1568 tokens** flat (no BPE).
   - Unknown block types → 0 plus one `log.warn` per distinct type (deduped via a module-level `Set`).
   - `system` → encoded text (if present).
   - `tools` → `JSON.stringify(tools)` encoded (single bundle; matches OpenAI's tool-list wire shape).
   Encoders are cached at module scope: `let cl100k: Tiktoken | null = null; let o200k: Tiktoken | null = null;` lazily initialised on first call.

2. **Install dependency.** `npm install --save js-tiktoken`. Pin to current stable; confirm bundles cleanly under `tsup` (validation step at the end).

3. **Extend `ModelProvider` interface.** Edit [src/providers/types.ts](src/providers/types.ts#L80-L98):
   ```ts
   countTokens(
     model: string,
     messages: Message[],
     system?: string,
     tools?: ToolSchema[],
   ): number;
   ```
   Required, synchronous, no HTTP.

4. **Add default in `BaseProvider`.** Edit [src/providers/base.ts](src/providers/base.ts#L19): add an instance method
   ```ts
   countTokens(_model: string, messages: Message[], system?: string, tools?: ToolSchema[]): number {
     return countWithTiktoken(messages, system, tools, "cl100k_base");
   }
   ```
   The default is `cl100k_base` (not `o200k_base`): pi-ai's tokenizer is undocumented and `cl100k_base` is the safer default for any non-OpenAI BPE. This is the only path reached by `pi-ai`.

5. **Override in providers that need per-model encoding selection or special-block handling:**

   5a. [src/providers/openai.ts](src/providers/openai.ts) — add `countTokens` that selects encoding by `model`:
       ```ts
       countTokens(model: string, messages: Message[], system?: string, tools?: ToolSchema[]): number {
         const isNewGen = /^(gpt-5|o1|o3|o4)/.test(model);
         const encoding = isNewGen ? "o200k_base" : "cl100k_base";
         return countWithTiktoken(messages, system, tools, encoding);
       }
       ```
       Fallback for unknown / non-GPT model names is `cl100k_base` — the safer default for any OpenAI-compatible subclass passing through a non-OpenAI model name. `OpenRouterProvider` deliberately inherits this method without override; its vendor-prefixed model strings (`openai/gpt-4o`, `anthropic/claude-3.5-sonnet`, `meta-llama/llama-3.1-70b`, etc.) do not match the `gpt-5|o1|o3|o4` regex and so land on `cl100k_base`.

   5b. [src/providers/openai-codex.ts](src/providers/openai-codex.ts) — `OpenAICodexProvider` extends `BaseProvider` directly at [src/providers/openai-codex.ts](src/providers/openai-codex.ts#L79). Add the **same body** as `OpenAIProvider.countTokens`.

   5c. [src/providers/copilot.ts](src/providers/copilot.ts) — `CopilotProvider` extends `BaseProvider` directly at [src/providers/copilot.ts](src/providers/copilot.ts#L121); Copilot rides OpenAI BPEs. Add the **same body** as `OpenAIProvider.countTokens`.

   5d. [src/providers/anthropic.ts](src/providers/anthropic.ts) — override:
       ```ts
       countTokens(_model: string, messages: Message[], system?: string, tools?: ToolSchema[]): number {
         return countWithTiktoken(messages, system, tools, "cl100k_base");
       }
       ```
       The flattening in `countWithTiktoken` already handles `thinking` (counts `block.thinking`) and `image` (1568 surcharge). No call to `client.messages.countTokens`. `convertMessages` at [src/providers/anthropic.ts](src/providers/anthropic.ts#L74-L97) is **not** modified — wire conversion still drops `thinking`/`image` (those blocks are not Anthropic-API-shaped on send today). Counting and wiring are intentionally separate concerns. (Fixing wire-side image/thinking handoff is out of scope for F07; F18 territory.)

   5e. [src/providers/ollama.ts](src/providers/ollama.ts) — **explicit override** that ignores the model name and pins `cl100k_base`:
       ```ts
       override countTokens(_model: string, messages: Message[], system?: string, tools?: ToolSchema[]): number {
         return countWithTiktoken(messages, system, tools, "cl100k_base");
       }
       ```
       Ollama serves local LLaMA/Mistral/Qwen derivatives whose BPEs are closer to `cl100k_base` than to `o200k_base`. The override also guarantees that a model name accidentally matching the `gpt-5|o1|o3|o4` regex (e.g. a user-installed model tag) cannot flip the encoding to `o200k_base`.

   5f. [src/providers/llamacpp.ts](src/providers/llamacpp.ts) — **explicit override**, same body as 5e. Same reasoning.

   5g. [src/providers/openrouter.ts](src/providers/openrouter.ts) — **no file change**. Deliberately inherits `OpenAIProvider.countTokens`; vendor-prefixed model strings naturally land on `cl100k_base`. The plan adds an OpenRouter test that pins this behaviour (step 9).

   5h. [src/providers/pi-ai.ts](src/providers/pi-ai.ts) — **no file change**. Inherits `BaseProvider.countTokens`.

6. **Router pass-through.** Edit [src/providers/router.ts](src/providers/router.ts#L245-L258) — add `countTokens` directly below `getMaxContextTokens`, mirroring its resolution chain literally (no new helper):
   ```ts
   countTokens(
     modelSpec: string,
     messages: Message[],
     system?: string,
     tools?: ToolSchema[],
   ): number {
     const parsed = tryParseModelId(modelSpec);
     if (!parsed) {
       const candidate = this.buildCandidateChain(modelSpec)[0];
       if (!candidate) return 0;
       const { provider: providerName, model } = parseModelId(candidate.spec);
       const provider = this.getProviderForRequest(providerName, { accountRef: candidate.accountRef });
       return provider?.countTokens(model, messages, system, tools) ?? 0;
     }
     const { provider: providerName, model } = parsed;
     const provider = this.getProviderForRequest(providerName);
     return provider?.countTokens(model, messages, system, tools) ?? 0;
   }
   ```
   The structure is copy-pasted from `getMaxContextTokens` ([src/providers/router.ts](src/providers/router.ts#L245-L258)) with the return expression swapped. No `resolveActive` helper, no parallel resolution path.

7. **Rewrite `compaction.ts`.**
   - Delete `function estimateTokens` ([src/runtime/compaction.ts](src/runtime/compaction.ts#L12-L26)) and its preceding `/** Rough token estimation: ~4 chars per token. */` comment.
   - Change `shouldCompact` signature to:
     ```ts
     export function shouldCompact(runningTokens: number, config: CompactionConfig): boolean {
       const threshold = (config.thresholdPct / 100) * config.contextWindow;
       return runningTokens > threshold;
     }
     ```
   - Update `compactConversation`'s `log.info(...)` at [src/runtime/compaction.ts](src/runtime/compaction.ts#L92-L94): replace `~${estimateTokens(messages)}` with `~${router.countTokens(modelSpec, messages, systemPrompt, tools)}`. Threshold log already comes from `config`, unchanged.
   - Change `compactConversation`'s signature to add `modelSpec: string` and `tools: ToolSchema[] | undefined` after the existing parameters; one full re-count per compaction is fine because compaction is rare.

8. **Rewrite `BaseAgent` to maintain the running counter (mandatory).**
   - Add fields on the class:
     ```ts
     private runningInputTokens = 0;
     private staticInputTokens = 0;
     ```
     (No `runningCountedMsgIdx`. `pushMessage` does the delta inline; `replaceMessages` resets and recounts in a single call.)
   - In the constructor, after the agent has its `ctx`, `systemPrompt`, and tool dispatcher available, compute once:
     ```ts
     this.staticInputTokens = this.ctx.router.countTokens(
       this.ctx.modelSpec,
       [],
       this.systemPrompt,
       this.getToolSchemas(),
     );
     ```
     Place this initialisation right after `getToolSchemas()` is callable (the dispatcher field is set in the existing constructor flow).
   - Modify `pushMessage` at [src/agents/base.ts](src/agents/base.ts#L718-L734) to add one line right after `this.messages.push(message);`:
     ```ts
     this.runningInputTokens += this.ctx.router.countTokens(this.ctx.modelSpec, [message]);
     ```
   - Modify `replaceMessages` at [src/agents/base.ts](src/agents/base.ts#L734) to reset and recount inside the same method:
     ```ts
     this.messages = messages;
     this.runningInputTokens = this.ctx.router.countTokens(this.ctx.modelSpec, messages);
     // …existing timestamp/source/round-id resets…
     ```
   - Rewrite the compaction guard at [src/agents/base.ts](src/agents/base.ts#L225):
     ```ts
     if (shouldCompact(this.runningInputTokens + this.staticInputTokens, this.compactionConfig)) {
       …
     }
     ```
     The surrounding `isMaxCompactionsReached` check at [src/agents/base.ts](src/agents/base.ts#L226) and the `compactWithReinjection` call at [src/agents/base.ts](src/agents/base.ts#L236) are unchanged.
   - In the overflow-retry branch at [src/agents/base.ts](src/agents/base.ts#L515-L538), the existing `await this.compactWithReinjection()` call (defined at [src/agents/base.ts](src/agents/base.ts#L820), invokes `replaceMessages` at [src/agents/base.ts](src/agents/base.ts#L850)) automatically resets `runningInputTokens` via the recount path above. No new code needed in this branch.
   - Update the two call sites of `compactConversation`: pass `this.ctx.modelSpec` and `this.getToolSchemas()`. Currently called from inside `compactWithReinjection` at [src/agents/base.ts](src/agents/base.ts#L820-L850).
   - Rewrite `maybeStash` at [src/agents/base.ts](src/agents/base.ts#L666-L675):
     ```ts
     private maybeStash(content: string, toolUseId: string): string {
       const tokenBudget = Math.floor(this.compactionConfig.contextWindow * 0.05);
       const tokens = this.ctx.router.countTokens(this.ctx.modelSpec, [
         { role: "user", content: [{ type: "tool_result", tool_use_id: toolUseId, content }] },
       ]);
       if (tokens <= tokenBudget) return content;
       const path = stashResult(content, `tool_${toolUseId}`);
       return (
         `[Result stashed to disk — too large for context window (${tokens} tokens)]\n` +
         `Use read_stash(path="${path}") to read portions of this result.`
       );
     }
     ```
     The `4 *` factor at [src/agents/base.ts](src/agents/base.ts#L667) is deleted. The user-visible stash diagnostic now reports token count instead of char count (intentional; matches the new semantic).
   - **Monotonically-tightening calibration** after `router.chat` success at [src/agents/base.ts](src/agents/base.ts#L496): inside the existing `try` block right before the `return response;`:
     ```ts
     const reported = response.usage?.inputTokens;
     const estimated = this.runningInputTokens + this.staticInputTokens;
     if (typeof reported === "number" && reported > estimated * 1.1) {
       this.runningInputTokens = Math.max(0, reported - this.staticInputTokens);
     }
     ```
     The guard is **strict greater-than** with a 10% margin. If the provider reports a smaller number than the local estimate, the local estimate is kept as-is. This guarantees calibration can only **tighten** the trigger (move it earlier) and never weakens it (moves it later). The decision to ignore an apparent provider under-count is deliberate: provider usage often omits cached/system overhead the runtime accounts for, and we prefer false positives (slightly-early compaction) over false negatives (missed overflow).

9. **Add tests.**
   - **New file: `src/runtime/token-counting.test.ts`** (does not exist today). Cover:
     - A message list with a `thinking` block returns a strictly positive token count and is reproducible.
     - A message list with an `image` block adds at least 1568 tokens vs. the same list without.
     - `cl100k_base` and `o200k_base` both return finite positive numbers for a non-empty text.
     - Tool-call `input` JSON is counted.
   - **New file: `src/runtime/compaction.test.ts`** (does not exist today). Cover:
     - `shouldCompact(runningTokens, config)` returns `true` once `runningTokens` crosses the threshold and `false` below it.
     - A message list with a `thinking` block would have triggered compaction with the new counting but not with the legacy `chars/4` — assert by computing both directly (proves the regression is fixed).
   - **New file: `src/providers/openai.test.ts`** gains a `countTokens` block:
     - For `gpt-5-foo` model, `countTokens` selects `o200k_base` (verifiable via spy on `countWithTiktoken`).
     - For `gpt-4o`, `gpt-3.5-turbo`, and unknown model strings like `acme/llama-3`, `countTokens` selects `cl100k_base`.
   - **New file: `src/providers/anthropic.test.ts`** gains a `countTokens` block:
     - A `thinking` block contributes tokens.
     - An `image` block contributes ≥1568.
     - `client.messages.countTokens` is **not** called (network-free).
   - **New file: `src/providers/ollama.test.ts`** (or extension of existing tests if any): assert `OllamaProvider.countTokens("gpt-5-foo", …)` still selects `cl100k_base` (proving the override beats the OpenAI-family heuristic).
   - **New file: `src/providers/llamacpp.test.ts`**: same assertion as ollama for `LlamaCppProvider`.
   - **New file: `src/providers/openrouter.test.ts`** (or extension): assert `OpenRouterProvider.countTokens("anthropic/claude-3.5-sonnet", …)` selects `cl100k_base` via the inherited `OpenAIProvider` method; assert `countTokens("openai/gpt-5-foo", …)` selects `o200k_base` (documents the intended inheritance).
   - **Touched: existing provider tests in `src/providers/router.test.ts`** — every `makeProvider(...)` helper gets a `countTokens` returning a constant (e.g. `() => 100`). One new test: `router.countTokens(modelSpec, …)` returns the active provider's value through the candidate chain.
   - **Touched: existing `src/agents/agents.test.ts`** — assert that `pushMessage` increments `runningInputTokens` and `replaceMessages` resets-then-recounts. Use a stub router whose `countTokens` returns `messages.length` so increments are observable. Add one calibration test: when `response.usage.inputTokens` exceeds the maintained estimate by >10%, `runningInputTokens` is updated; when it is below the estimate, `runningInputTokens` is **unchanged**.

10. **Bundle and runtime validation.**
    - `npm run typecheck` — must pass. The interface change at step 3 will surface every provider that has not yet been updated; step 4 (default) and step 5 (overrides) resolve them.
    - `npm run build` — `tsup` must bundle `js-tiktoken` without warnings. If a WASM/BPE-table loading warning appears, switch the encoder initialisation in `countWithTiktoken` to a top-of-module lazy import (already structured for that).
    - `npx vitest run src/runtime/token-counting.test.ts src/runtime/compaction.test.ts`.
    - `npx vitest run src/providers/openai.test.ts src/providers/anthropic.test.ts src/providers/ollama.test.ts src/providers/llamacpp.test.ts src/providers/openrouter.test.ts src/providers/router.test.ts`.
    - `npx vitest run src/agents/agents.test.ts`.
    - Full suite: `npx vitest run`.

## Test strategy

- Pre-change baseline: clean working tree, `npm run typecheck && npm run build` to confirm green starting point.
- After step 3 (interface change): typecheck deliberately breaks until step 5 lands. This is the canary that proves every concrete provider was visited.
- After step 5: the new ollama/llamacpp/openrouter tests pin the OpenAI-compatible subclass encoding decisions — any future regression that flips a local model to `o200k_base` fails these tests.
- After step 8 (`BaseAgent` rewrite): the existing agent loop tests should still pass; the new running-counter and calibration assertions in `src/agents/agents.test.ts` are the new regressions.
- After step 9: the new `src/runtime/compaction.test.ts` proves the thinking-block under-count is fixed (the original symptom).
- No live-runtime smoke test required — the planner happy-path agent test exercises the full loop with stubbed providers.

## Rollback strategy

Single squashed commit. Revert is `git revert <sha>` followed by `npm uninstall js-tiktoken`. No on-disk schema changes; no migration. Conversation state is in-memory only — a runtime restart clears it.

Per `_LOOP-CONVENTIONS.md` §"Mandatory project guidelines", no transitional shim is created: `estimateTokens` is deleted in the same commit that adds `countTokens`. Reverting that commit restores the old behaviour atomically.

## Cross-issue ordering

- **F07 must land before F20.** F20 (per-model `maxContextTokens`) fixes the *denominator* of the compaction threshold; F07 fixes the *numerator*. Fixing the denominator first leaves the agent compacting on an under-counted numerator against a now-larger denominator — strictly worse than today. F07-then-F20 monotonically improves the trigger.
- **F07 is independent of F09.** F09 will move worker-shared code into a `WorkerAgent` base; the counter fields live on `BaseAgent` and are inherited.
- **F07 is independent of F18.** F18 changes *where* prompts live; F07 only changes *how big* they're measured.
- **F07 is independent of F11.** F11 wants `compaction_threshold_pct` and `max_compactions` extracted into typed config; F07 doesn't touch those values, only the signal compared against them. If F11 lands first, F07's `shouldCompact` signature stays the same — only the source of `config.thresholdPct` shifts.
