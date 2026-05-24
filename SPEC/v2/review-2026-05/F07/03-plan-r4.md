# F07 — Plan (r4)

For the recommended Proposal B (token counting as a synchronous provider capability, with a mandatory running-token counter on `BaseAgent`).

## Changes from r3

Accepted reviewer items (both required changes):

1. **`PiAiProvider.countTokens` is now the load-bearing override.** r3's plan added overrides on `AnthropicProvider`, `OpenAIProvider`, and `OpenAICodexProvider`, but `ModelRouter.createProvider` at [src/providers/router.ts](src/providers/router.ts#L720-L760) instantiates `PiAiProvider` (not those direct classes) for `anthropic`, `openai`, `openai-codex`, `opencode`, and `opencode-go`. r4 adds a new mandatory step **5h** that introduces `PiAiProvider.countTokens` inspecting `this.piProvider` (currently `private` at [src/providers/pi-ai.ts](src/providers/pi-ai.ts#L45); promote to `readonly` of the same name so the encoding switch can access it without weakening encapsulation) and the model string. The encoding selection covers all five live `piProvider` values. Steps 5a (`OpenAIProvider`), 5b (`OpenAICodexProvider`), 5c (`CopilotProvider`), and 5d (`AnthropicProvider`) remain — `OpenAIProvider`'s override is reachable via `OllamaProvider`/`LlamaCppProvider` inheritance, `CopilotProvider` is reachable directly, and the rest are minimum-compliance to satisfy the new required interface method (their classes are unreachable through the live router today; their deletion is out of F07 scope).
2. **Tests pin live-router behaviour, not just direct legacy classes.** Step 9 now adds a new `src/providers/pi-ai.test.ts` file (no such file exists today) covering the five `piProvider` registrations, and the existing `src/providers/router.test.ts` gains a block exercising `router.countTokens("openai/gpt-5-foo", …)`, `router.countTokens("anthropic/claude-3.5-sonnet", …)`, `router.countTokens("openai-codex/gpt-5-codex", …)`, `router.countTokens("opencode/...", …)`, and `router.countTokens("opencode-go/...", …)`. The previous r3 wording — that the `BaseProvider` default is the only path `pi-ai` exercises — is removed; after r4, `pi-ai` exercises its own override.

The `BaseProvider` default still exists (step 4) so future provider classes that subclass `BaseProvider` without overriding compile and don't silently return zero. After r4 the default is reached only through future not-yet-existing subclasses; no live runtime path inherits it.

Rejected reviewer items: none.

Removed from r3: any wording that implied direct-class overrides on `AnthropicProvider`/`OpenAICodexProvider` were on a live runtime path. Those overrides remain in the plan as interface-compliance only and are explicitly labelled.

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
   The default is `cl100k_base` (not `o200k_base`): the safer baseline for any non-OpenAI BPE. After step 5h this default is no longer on any live runtime path; it exists for future subclasses.

5. **Override in providers that need per-model encoding selection or special-block handling:**

   5a. [src/providers/openai.ts](src/providers/openai.ts) — add `countTokens` that selects encoding by `model`:
       ```ts
       override countTokens(model: string, messages: Message[], system?: string, tools?: ToolSchema[]): number {
         const isNewGen = /^(gpt-5|o1|o3|o4)/.test(model);
         const encoding = isNewGen ? "o200k_base" : "cl100k_base";
         return countWithTiktoken(messages, system, tools, encoding);
       }
       ```
       Fallback for unknown / non-GPT model names is `cl100k_base` — the safer default for any OpenAI-compatible subclass passing through a non-OpenAI model name. `OpenRouterProvider` deliberately inherits this method without override; its vendor-prefixed model strings (`openai/gpt-4o`, `anthropic/claude-3.5-sonnet`, `meta-llama/llama-3.1-70b`, etc.) do not match the `gpt-5|o1|o3|o4` regex and so land on `cl100k_base`. `OpenAIProvider` is not directly instantiated by the router today; this override is reached at runtime only via `OllamaProvider`/`LlamaCppProvider` (each of which overrides it again in 5e/5f) — kept because the class is the structural base.

   5b. [src/providers/openai-codex.ts](src/providers/openai-codex.ts) — `OpenAICodexProvider` extends `BaseProvider` directly at [src/providers/openai-codex.ts](src/providers/openai-codex.ts#L79). Add the **same body** as 5a. Interface compliance only: this class is **not** instantiated by `createProvider` (live `openai-codex` traffic goes through `PiAiProvider` in step 5h).

   5c. [src/providers/copilot.ts](src/providers/copilot.ts) — `CopilotProvider` extends `BaseProvider` directly at [src/providers/copilot.ts](src/providers/copilot.ts#L121); Copilot rides OpenAI BPEs. Add the **same body** as 5a. **Live runtime path** (the only direct subclass of `BaseProvider` that the router actually constructs other than `PiAiProvider`).

   5d. [src/providers/anthropic.ts](src/providers/anthropic.ts) — override:
       ```ts
       override countTokens(_model: string, messages: Message[], system?: string, tools?: ToolSchema[]): number {
         return countWithTiktoken(messages, system, tools, "cl100k_base");
       }
       ```
       The flattening in `countWithTiktoken` already handles `thinking` and `image`. No call to `client.messages.countTokens`. Interface compliance only: `AnthropicProvider` is **not** instantiated by `createProvider` (live `anthropic` traffic goes through `PiAiProvider` in step 5h). `convertMessages` at [src/providers/anthropic.ts](src/providers/anthropic.ts#L74-L97) is **not** modified — wire conversion still drops `thinking`/`image`; counting and wiring are separate concerns. (Fixing wire-side image/thinking handoff is out of scope for F07; F18 territory.)

   5e. [src/providers/ollama.ts](src/providers/ollama.ts) — **explicit override** that ignores the model name and pins `cl100k_base`:
       ```ts
       override countTokens(_model: string, messages: Message[], system?: string, tools?: ToolSchema[]): number {
         return countWithTiktoken(messages, system, tools, "cl100k_base");
       }
       ```
       Ollama serves local LLaMA/Mistral/Qwen derivatives whose BPEs are closer to `cl100k_base` than to `o200k_base`. The override also guarantees that a model name accidentally matching the `gpt-5|o1|o3|o4` regex (e.g. a user-installed model tag) cannot flip the encoding to `o200k_base`.

   5f. [src/providers/llamacpp.ts](src/providers/llamacpp.ts) — **explicit override**, same body as 5e. Same reasoning.

   5g. [src/providers/openrouter.ts](src/providers/openrouter.ts) — **no file change**. Deliberately inherits `OpenAIProvider.countTokens`; vendor-prefixed model strings naturally land on `cl100k_base`. The plan adds an OpenRouter test that pins this behaviour (step 9). Not on the live router path.

   5h. [src/providers/pi-ai.ts](src/providers/pi-ai.ts) — **load-bearing live-path override.** Two edits in this file:
       - Promote `private piProvider: string;` at [src/providers/pi-ai.ts](src/providers/pi-ai.ts#L45) to `private readonly piProvider: string;` (no behaviour change; allows the override body to read it without weakening visibility). The constructor assignment at [src/providers/pi-ai.ts](src/providers/pi-ai.ts#L48) is compatible with `readonly` (assigned in constructor only).
       - Add the override and a small private helper:
         ```ts
         override countTokens(
           model: string,
           messages: Message[],
           system?: string,
           tools?: ToolSchema[],
         ): number {
           return countWithTiktoken(messages, system, tools, this.encodingFor(model));
         }

         private encodingFor(model: string): "cl100k_base" | "o200k_base" {
           switch (this.piProvider) {
             case "openai":
             case "openai-codex":
               return /^(gpt-5|o1|o3|o4)/.test(model) ? "o200k_base" : "cl100k_base";
             case "anthropic":
             case "opencode":
             case "opencode-go":
             default:
               return "cl100k_base";
           }
         }
         ```
         Rationale for switching on `this.piProvider` rather than `model` alone: a single `PiAiProvider` class is constructed for five distinct provider names ([src/providers/router.ts](src/providers/router.ts#L728-L750)); `this.piProvider` is the only stable disambiguator. Inside `openai`/`openai-codex`, model strings span both `gpt-5*`/`o*` (o200k_base) and `gpt-4o*`/`gpt-3.5*` (cl100k_base), so a model-level regex is still needed there. `anthropic` and `opencode*` map cleanly to `cl100k_base` regardless of model. The fallback `default` branch protects against a future contributor adding a new `case` in `createProvider` without extending this switch — the new test in step 9 makes that omission visible.

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
   - Update `compactConversation`'s `log.info(...)` at [src/runtime/compaction.ts](src/runtime/compaction.ts#L91-L94): replace `~${estimateTokens(messages)}` with `~${router.countTokens(modelSpec, messages, systemPrompt, tools)}`.
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
     The `4 *` factor at [src/agents/base.ts](src/agents/base.ts#L667) is deleted.
   - **Monotonically-tightening calibration** after `router.chat` success at [src/agents/base.ts](src/agents/base.ts#L496): inside the existing `try` block right before the `return response;`:
     ```ts
     const reported = response.usage?.inputTokens;
     const estimated = this.runningInputTokens + this.staticInputTokens;
     if (typeof reported === "number" && reported > estimated * 1.1) {
       this.runningInputTokens = Math.max(0, reported - this.staticInputTokens);
     }
     ```
     The guard is **strict greater-than** with a 10% margin. If the provider reports a smaller number than the local estimate, the local estimate is kept as-is. This guarantees calibration can only **tighten** the trigger.

9. **Add tests.**

   9a. **New file: `src/runtime/token-counting.test.ts`.** Cover:
   - A message list with a `thinking` block returns a strictly positive token count and is reproducible.
   - A message list with an `image` block adds at least 1568 tokens vs. the same list without.
   - `cl100k_base` and `o200k_base` both return finite positive numbers for non-empty text.
   - Tool-call `input` JSON is counted.

   9b. **New file: `src/runtime/compaction.test.ts`.** Cover:
   - `shouldCompact(runningTokens, config)` returns `true` once `runningTokens` crosses the threshold and `false` below.
   - A message list with a `thinking` block would have triggered compaction under accurate counting but not under the legacy `chars/4` — assert by computing both directly (proves the regression is fixed).

   9c. **New file: `src/providers/openai.test.ts`** with a `countTokens` block:
   - For `gpt-5-foo` / `o1-preview` / `o3-mini` / `o4-…`: selects `o200k_base`.
   - For `gpt-4o`, `gpt-3.5-turbo`, and unknown strings like `acme/llama-3`: selects `cl100k_base`.

   9d. **New file: `src/providers/anthropic.test.ts`** with a `countTokens` block:
   - A `thinking` block contributes tokens.
   - An `image` block contributes ≥1568.
   - `client.messages.countTokens` is **not** called (network-free).

   9e. **New file: `src/providers/ollama.test.ts`**: assert `OllamaProvider.countTokens("gpt-5-foo", …)` still selects `cl100k_base` (proving the override beats the OpenAI-family heuristic).

   9f. **New file: `src/providers/llamacpp.test.ts`**: same assertion as 9e for `LlamaCppProvider`.

   9g. **New file: `src/providers/openrouter.test.ts`**: assert `OpenRouterProvider.countTokens("anthropic/claude-3.5-sonnet", …)` selects `cl100k_base` via the inherited `OpenAIProvider` method; assert `countTokens("openai/gpt-5-foo", …)` selects `o200k_base` (documents the intended inheritance).

   9h. **New file: `src/providers/pi-ai.test.ts`** (no such file today). **This is the new live-runtime coverage.** For each of the five `piProvider` values constructed by the router, assert the encoding selected by `PiAiProvider.countTokens`:
   - `new PiAiProvider("openai").countTokens("gpt-5-foo", …)` → `o200k_base`.
   - `new PiAiProvider("openai").countTokens("gpt-4o", …)` → `cl100k_base`.
   - `new PiAiProvider("openai-codex").countTokens("gpt-5-codex", …)` → `o200k_base`.
   - `new PiAiProvider("openai-codex").countTokens("gpt-4o-codex", …)` → `cl100k_base`.
   - `new PiAiProvider("anthropic").countTokens("claude-3.5-sonnet", …)` → `cl100k_base`.
   - `new PiAiProvider("anthropic").countTokens("claude-4-opus", …)` → `cl100k_base`.
   - `new PiAiProvider("opencode").countTokens("moonshotai/kimi-…", …)` → `cl100k_base`.
   - `new PiAiProvider("opencode-go").countTokens("zhipuai/glm-…", …)` → `cl100k_base`.
   - A `thinking` block contributes tokens; an `image` block contributes ≥1568.
   Verification of the encoding choice is done by spying on `countWithTiktoken` (`vi.spyOn` over the module) and asserting the fourth argument.

   9i. **Touched: existing `src/providers/router.test.ts`.** Every `makeProvider(...)` helper that constructs a stub provider gets a `countTokens` returning a deterministic number (e.g. `(_, msgs) => msgs.length * 100`). New tests pin the **live runtime resolution** through the candidate chain:
   - `router.countTokens("openai/gpt-5-foo", […])` reaches `PiAiProvider("openai").countTokens(...)` (selects `o200k_base`).
   - `router.countTokens("anthropic/claude-3.5-sonnet", […])` reaches `PiAiProvider("anthropic").countTokens(...)` (selects `cl100k_base`).
   - `router.countTokens("openai-codex/gpt-5-codex", […])` reaches `PiAiProvider("openai-codex").countTokens(...)` (selects `o200k_base`).
   - `router.countTokens("opencode/moonshotai/kimi-…", […])` reaches `PiAiProvider("opencode").countTokens(...)` (selects `cl100k_base`).
   - `router.countTokens("opencode-go/zhipuai/glm-…", […])` reaches `PiAiProvider("opencode-go").countTokens(...)` (selects `cl100k_base`).
   - `router.countTokens("github-copilot/gpt-5", […])` reaches `CopilotProvider.countTokens(...)` (selects `o200k_base`).
   - `router.countTokens("ollama/gpt-5-tagged-local", […])` reaches `OllamaProvider.countTokens(...)` (selects `cl100k_base` — the override wins over model-name heuristic).
   For these tests, the spy on `countWithTiktoken` in the `token-counting` module is the assertion surface (encoding argument). The router-side test does not stub `countTokens` away (the goal is end-to-end resolution through the live class).

   9j. **Touched: existing `src/agents/agents.test.ts`.** Assert that `pushMessage` increments `runningInputTokens` and `replaceMessages` resets-then-recounts. Use a stub router whose `countTokens` returns `messages.length` so increments are observable. Add one calibration test: when `response.usage.inputTokens` exceeds the maintained estimate by >10%, `runningInputTokens` is updated; when it is below the estimate, `runningInputTokens` is **unchanged**.

10. **Bundle and runtime validation.**
    - `npm run typecheck` — must pass. The interface change at step 3 will surface every provider that has not yet been updated; step 4 (default) and step 5 (overrides, including the load-bearing 5h) resolve them.
    - `npm run build` — `tsup` must bundle `js-tiktoken` without warnings.
    - `npx vitest run src/runtime/token-counting.test.ts src/runtime/compaction.test.ts`.
    - `npx vitest run src/providers/pi-ai.test.ts src/providers/router.test.ts` — **the live-path coverage**.
    - `npx vitest run src/providers/openai.test.ts src/providers/anthropic.test.ts src/providers/ollama.test.ts src/providers/llamacpp.test.ts src/providers/openrouter.test.ts src/providers/copilot.test.ts`.
    - `npx vitest run src/agents/agents.test.ts`.
    - Full suite: `npx vitest run`.

## Test strategy

- Pre-change baseline: clean working tree, `npm run typecheck && npm run build` to confirm green starting point.
- After step 3 (interface change): typecheck deliberately breaks until step 5 lands. This is the canary that proves every concrete provider was visited — including `PiAiProvider`.
- After step 5h: `src/providers/pi-ai.test.ts` (9h) and the new router cases in `src/providers/router.test.ts` (9i) become the load-bearing regression net for the live runtime path. A future contributor adding a new `case` to `ModelRouter.createProvider` for a new `PiAiProvider("foo")` registration without extending `PiAiProvider.encodingFor` will not break a test directly — but the next time a `gpt-5*`-style model name appears under that registration, the cl100k_base default will under-count and the threshold tests in 9b will fire. The router test in 9i should be extended whenever step 5h's switch is extended.
- After step 5e/5f: ollama/llamacpp tests pin the OpenAI-compatible subclass encoding decisions — any future regression that flips a local model to `o200k_base` fails these tests.
- After step 8 (`BaseAgent` rewrite): the existing agent loop tests should still pass; the new running-counter and calibration assertions in `src/agents/agents.test.ts` are the new regressions.
- After step 9b: the new `src/runtime/compaction.test.ts` proves the thinking-block under-count is fixed (the original symptom).
- No live-runtime smoke test required — the planner happy-path agent test exercises the full loop with stubbed providers.

## Rollback strategy

Single squashed commit. Revert is `git revert <sha>` followed by `npm uninstall js-tiktoken`. No on-disk schema changes; no migration. Conversation state is in-memory only — a runtime restart clears it.

Per `_LOOP-CONVENTIONS.md` §"Mandatory project guidelines", no transitional shim is created: `estimateTokens` is deleted in the same commit that adds `countTokens`. Reverting that commit restores the old behaviour atomically.

## Cross-issue ordering

- **F07 must land before F20.** F20 (per-model `maxContextTokens`) fixes the *denominator* of the compaction threshold; F07 fixes the *numerator*. Fixing the denominator first leaves the agent compacting on an under-counted numerator against a now-larger denominator — strictly worse than today. F07-then-F20 monotonically improves the trigger.
- **F07 is independent of F09.** F09 will move worker-shared code into a `WorkerAgent` base; the counter fields live on `BaseAgent` and are inherited.
- **F07 is independent of F18.** F18 changes *where* prompts live; F07 only changes *how big* they're measured.
- **F07 is independent of F11.** F11 wants `compaction_threshold_pct` and `max_compactions` extracted into typed config; F07 doesn't touch those values, only the signal compared against them. If F11 lands first, F07's `shouldCompact` signature stays the same — only the source of `config.thresholdPct` shifts.
- **F07 paves the way for F-cleanup-providers.** The `AnthropicProvider`/`OpenAICodexProvider`/`OpenRouterProvider` overrides added in 5b/5d (and the inherited path in 5g) are interface-compliance for classes that are not on the live router path; deleting those classes is the cleanup issue's job and is explicitly out of F07 scope.
