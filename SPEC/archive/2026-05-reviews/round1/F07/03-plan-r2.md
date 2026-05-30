# F07 — Plan (r2)

For the recommended Proposal B (token counting as a synchronous provider capability, with a mandatory running-token counter on `BaseAgent`).

## Changes from r1

Accepted reviewer items (all four required changes):

1. **Running-token shortcut is now mandatory and structural.** r1 step 9 ("optional acceleration") is deleted. r2 step 8 makes the running counter a required part of `BaseAgent` (`runningInputTokens` + `staticInputTokens`), maintained on every `pushMessage`/`replaceMessages`. `shouldCompact` reads the maintained number; the prefix is never re-counted on a per-tick basis.
2. **No provider HTTP call per loop tick.** `ModelProvider.countTokens` is `number`-returning (synchronous). Anthropic uses local BPE (`cl100k_base`) with an inline counting-only flattening, not `client.messages.countTokens`.
3. **Provider inheritance and per-class counting behaviour are now spelled out explicitly.** r2 step 5 enumerates which providers override and which inherit, and step 5d defines Anthropic's `thinking`/`image` block handling exactly.
4. **Stale call-site references corrected.** `getToolSchemas()` is at [src/agents/base.ts](src/agents/base.ts#L597) and called at [src/agents/base.ts](src/agents/base.ts#L474) (inside `callLLM`, **not** below the compaction check in `runLoop`); the successful `router.chat(...)` await is at [src/agents/base.ts](src/agents/base.ts#L496); `replaceMessages` is at [src/agents/base.ts](src/agents/base.ts#L734); `compactWithReinjection` is defined at [src/agents/base.ts](src/agents/base.ts#L820) and called at [src/agents/base.ts](src/agents/base.ts#L236) and [src/agents/base.ts](src/agents/base.ts#L533). `compactConversation` now receives `modelSpec` and `tools` so the log line counts under the active agent's model with active tool schemas.

Rejected reviewer items: none.

Removed from r1: step 9 ("optional acceleration") and the `async`/`await` ripple in steps 6–8.

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
     return countWithTiktoken(messages, system, tools, "o200k_base");
   }
   ```
   This single override is the **only** path reached by `pi-ai`. `openrouter`, `ollama`, `llamacpp` do not reach it because they extend `OpenAIProvider`.

5. **Override in providers that need per-model encoding selection or special-block handling:**
   5a. [src/providers/openai.ts](src/providers/openai.ts) — add `countTokens` that selects encoding by `model`:
       - `gpt-3.5*`, `gpt-4*`, `gpt-4o*` → `cl100k_base`.
       - `gpt-5*`, `o1*`, `o3*`, `o4*`, anything else newer → `o200k_base`.
       Delegates to `countWithTiktoken(messages, system, tools, encoding)`.
       **Inherited by** `OpenRouterProvider`, `OllamaProvider`, `LlamaCppProvider` deliberately (none of those three files are touched).
   5b. [src/providers/openai-codex.ts](src/providers/openai-codex.ts) — same body as `OpenAIProvider.countTokens` (no inheritance because Codex extends `BaseProvider` directly at [src/providers/openai-codex.ts](src/providers/openai-codex.ts#L79)).
   5c. [src/providers/copilot.ts](src/providers/copilot.ts) — same body as `OpenAIProvider.countTokens` (Copilot extends `BaseProvider` directly at [src/providers/copilot.ts](src/providers/copilot.ts#L121); Copilot rides OpenAI BPEs).
   5d. [src/providers/anthropic.ts](src/providers/anthropic.ts) — override with:
       ```ts
       countTokens(model: string, messages: Message[], system?: string, tools?: ToolSchema[]): number {
         return countWithTiktoken(messages, system, tools, "cl100k_base");
       }
       ```
       The flattening in `countWithTiktoken` already handles `thinking` (counts `block.thinking`) and `image` (1568 surcharge). No call to `client.messages.countTokens`.
       Note: `convertMessages` at [src/providers/anthropic.ts](src/providers/anthropic.ts#L74-L97) is **not** modified — wire conversion still drops `thinking`/`image` (those blocks are not Anthropic-API-shaped on send today). Counting and wiring are intentionally separate concerns. (Fixing wire-side image/thinking handoff is out of scope for F07; F18 territory.)
   5e. `pi-ai`, `openrouter`, `ollama`, `llamacpp` — **no file change**. `pi-ai` inherits from `BaseProvider` ([src/providers/pi-ai.ts](src/providers/pi-ai.ts#L43)); the others inherit `OpenAIProvider.countTokens`.

6. **Router pass-through.** Edit [src/providers/router.ts](src/providers/router.ts#L245-L258) — add:
   ```ts
   countTokens(
     modelSpec: string,
     messages: Message[],
     system?: string,
     tools?: ToolSchema[],
   ): number {
     // Mirror getMaxContextTokens's candidate-chain resolution.
     const { provider, model } = this.resolveActive(modelSpec); // existing helper
     return provider.countTokens(model, messages, system, tools);
   }
   ```
   Use whatever resolve helper `getMaxContextTokens` already uses ([src/providers/router.ts](src/providers/router.ts#L245)); do not introduce a parallel resolution path.

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
   - Modify `pushMessage` at [src/agents/base.ts](src/agents/base.ts#L721-L734) to add one line right after `this.messages.push(message);`:
     ```ts
     this.runningInputTokens += this.ctx.router.countTokens(this.ctx.modelSpec, [message]);
     ```
   - Modify `replaceMessages` at [src/agents/base.ts](src/agents/base.ts#L734) to reset and recount inside the same method:
     ```ts
     this.messages = messages;
     this.runningInputTokens = this.ctx.router.countTokens(this.ctx.modelSpec, messages);
     // …existing timestamp/source/round-id resets…
     ```
   - Rewrite the compaction guard in `runLoop` at [src/agents/base.ts](src/agents/base.ts#L222):
     ```ts
     if (shouldCompact(this.runningInputTokens + this.staticInputTokens, this.compactionConfig)) {
       …
     }
     ```
     No change to the surrounding `isMaxCompactionsReached` check.
   - In the overflow-retry branch at [src/agents/base.ts](src/agents/base.ts#L518-L546), the existing `await this.compactWithReinjection()` call (defined at [src/agents/base.ts](src/agents/base.ts#L820), invokes `replaceMessages` at [src/agents/base.ts](src/agents/base.ts#L850)) automatically resets `runningInputTokens` via the recount path above. No new code needed here.
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
   - Optional calibration after `router.chat` success at [src/agents/base.ts](src/agents/base.ts#L496): inside the existing `try` block right before the `return response;`, when `response.usage?.inputTokens` is present and the absolute drift exceeds 10%:
     ```ts
     const reported = response.usage?.inputTokens;
     if (typeof reported === "number" && Math.abs(reported - (this.runningInputTokens + this.staticInputTokens)) > 0.1 * Math.max(reported, 1)) {
       this.runningInputTokens = Math.max(0, reported - this.staticInputTokens);
     }
     ```
     This corrects local-BPE drift against authoritative provider numbers; it never weakens the trigger because the recount is monotonic by construction (we set, not subtract). Lands in this step, not deferred.

9. **Add tests.**
   - **New file: `src/runtime/token-counting.test.ts`** (does not exist today). Cover:
     - A message list with a `thinking` block returns a strictly positive token count and is reproducible.
     - A message list with an `image` block adds at least 1568 tokens vs. the same list without.
     - `cl100k_base` and `o200k_base` both return finite positive numbers for a non-empty text.
     - Tool-call `input` JSON is counted.
   - **New file: `src/runtime/compaction.test.ts`** (does not exist today). Cover:
     - `shouldCompact(runningTokens, config)` returns `true` once `runningTokens` crosses the threshold and `false` below it.
     - A message list with a `thinking` block would have triggered compaction with the new counting but not with the legacy `chars/4` — assert by computing both directly (proves the regression is fixed).
   - **New: `src/providers/openai.test.ts`** gains a `countTokens` block: stub the SDK; assert `countTokens(...)` returns a reproducible non-zero number for a non-empty conversation and selects `o200k_base` for `gpt-5*` model strings (verifiable via spy on `countWithTiktoken`).
   - **New: `src/providers/anthropic.test.ts`** gains a `countTokens` block: assert that a `thinking` block contributes tokens and an `image` block contributes ≥1568. Assert `client.messages.countTokens` is **not** called (network-free).
   - **Touched: existing provider tests in `src/providers/router.test.ts`** — every `makeProvider(...)` helper gets a `countTokens` returning a constant (e.g. `() => 100`). One new test: `router.countTokens(modelSpec, …)` returns the active provider's value through the candidate chain.
   - **Touched: existing `src/agents/agents.test.ts`** — assert that `pushMessage` increments `runningInputTokens` and `replaceMessages` resets-then-recounts. Use a stub router whose `countTokens` returns `messages.length` so increments are observable.

10. **Bundle and runtime validation.**
    - `npm run typecheck` — must pass. The interface change at step 3 will surface every provider that has not yet been updated; step 4 (default) and step 5 (overrides) resolve them.
    - `npm run build` — `tsup` must bundle `js-tiktoken` without warnings. If a WASM/BPE-table loading warning appears, switch the encoder initialisation in `countWithTiktoken` to a top-of-module lazy import (already structured for that).
    - `npx vitest run src/runtime/token-counting.test.ts src/runtime/compaction.test.ts`.
    - `npx vitest run src/providers/openai.test.ts src/providers/anthropic.test.ts src/providers/router.test.ts`.
    - `npx vitest run src/agents/agents.test.ts`.
    - Full suite: `npx vitest run`.

## Test strategy

- Pre-change baseline: clean working tree, `npm run typecheck && npm run build` to confirm green starting point.
- After step 3 (interface change): typecheck deliberately breaks until step 5 lands. This is the canary that proves every concrete provider was visited.
- After step 8 (`BaseAgent` rewrite): the existing agent loop tests should still pass; the new running-counter assertions in `src/agents/agents.test.ts` are the new regressions.
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
