# F07 — Plan (r1)

For the recommended Proposal B (token counting as a provider capability).

## Ordered edit steps

1. **New module: `src/runtime/token-counting.ts`.**
   Add `countWithTiktoken(messages, system, tools, encoding)` and `flattenForTiktoken(messages)`. `flattenForTiktoken` mirrors the OpenAI adapter's message conversion at [src/providers/openai.ts](src/providers/openai.ts#L80-L131) so the local count matches the wire format. Includes thinking-block `block.thinking` and image-block fixed surcharge (1568 per image, OpenAI's documented `low` detail tile cost; Anthropic uses its own native counter). `encoding` defaults to `"o200k_base"`; callers can pass `"cl100k_base"` for older models. Re-export `countTokensForText(text, encoding)` for the `maybeStash` use case.

2. **Add dependency.** `npm install --save js-tiktoken`. Pin to a current stable release. (Verify it bundles cleanly under `tsup` by running `npm run build` after step 6.)

3. **Extend `ModelProvider` interface.** Edit [src/providers/types.ts](src/providers/types.ts#L80-L98) — add the required method:

   ```ts
   countTokens(
     model: string,
     messages: Message[],
     system?: string,
     tools?: ToolSchema[],
   ): Promise<number>;
   ```

4. **Add default in `BaseProvider`.** Edit [src/providers/base.ts](src/providers/base.ts#L19) — add an `async countTokens` default that calls `countWithTiktoken(messages, system, tools, "o200k_base")`. This covers `ollama`, `llamacpp`, `openrouter`, `pi-ai` without per-file changes.

5. **Override in each first-class provider:**
   - [src/providers/openai.ts](src/providers/openai.ts) — override that selects encoding per model (`gpt-4o*`, `gpt-4*`, `gpt-3.5*` → `cl100k_base`; everything newer including `gpt-5*`, `o1*`, `o3*`, `o4*` → `o200k_base`) and delegates to `countWithTiktoken`.
   - [src/providers/openai-codex.ts](src/providers/openai-codex.ts) — same as openai.
   - [src/providers/copilot.ts](src/providers/copilot.ts) — same as openai (Copilot rides the same tokenizers).
   - [src/providers/anthropic.ts](src/providers/anthropic.ts) — call `this.client.messages.countTokens({ model, messages: convertedMessages, system, tools })`. Cache results in a `Map<string, number>` (key = SHA1 of `JSON.stringify({system, tools, messages})` truncated to first/last 256 chars + message count). On HTTP error, fall back to `countWithTiktoken(messages, system, tools, "cl100k_base")` and log a `warn` once per failure type.

6. **Router pass-through.** Edit [src/providers/router.ts](src/providers/router.ts#L244-L258) — add `async countTokens(modelSpec, messages, system?, tools?)` mirroring `getMaxContextTokens`'s candidate-chain resolution. On no provider resolvable, fall back to `countWithTiktoken(messages, system, tools, "o200k_base")` and warn (matching the existing `200_000` fallback's defensive shape).

7. **Rewrite `compaction.ts`.**
   - Delete `function estimateTokens` ([src/runtime/compaction.ts](src/runtime/compaction.ts#L11-L26)) and its preceding doc comment.
   - Change `shouldCompact` signature: `async shouldCompact(messages, systemPrompt, tools, config, router, modelSpec) -> Promise<boolean>`. Body: `const tokens = await router.countTokens(modelSpec, messages, systemPrompt, tools); return tokens > config.thresholdPct/100 * config.contextWindow;`.
   - Update the log line inside `compactConversation` ([src/runtime/compaction.ts](src/runtime/compaction.ts#L91-L94)) to call `await router.countTokens(...)` for the logged token count. Acceptable because compaction is rare.

8. **Rewrite `BaseAgent` call sites.**
   - [src/agents/base.ts](src/agents/base.ts#L221-L240) — `if (await shouldCompact(this.messages, this.systemPrompt, tools, this.compactionConfig, this.ctx.router, this.ctx.modelSpec))`. The `tools` value is already resolved a few lines later via `this.getToolSchemas()`; hoist it above the compaction check.
   - [src/agents/base.ts](src/agents/base.ts#L517-L546) — same change inside the overflow-retry branch.
   - [src/agents/base.ts](src/agents/base.ts#L673-L685) (`maybeStash`) — rewrite: `const tokenBudget = Math.floor(this.compactionConfig.contextWindow * 0.05); const tokens = countTokensForText(content, encodingFor(this.ctx.modelSpec)); if (tokens <= tokenBudget) return content; ...`. Stash threshold is now a real token threshold, not `contextWindow * 4 * 0.05`.

9. **Add `lastReportedInputTokens` shortcut (optional acceleration).**
   - On `BaseAgent`: `private lastReportedInputTokens: number | null = null; private lastReportedMessageCount = 0;`.
   - After a successful `router.chat(...)` at [src/agents/base.ts](src/agents/base.ts#L246-L249), store `response.usage?.inputTokens ?? null` and `this.messages.length`.
   - In the compaction check, if `lastReportedInputTokens != null && this.messages.length >= lastReportedMessageCount`, count only the slice `this.messages.slice(lastReportedMessageCount)` and add it to `lastReportedInputTokens`. On any compaction or message-replacement (`replaceMessages`), reset both fields to `null` / `0`.
   - This avoids re-counting the unchanged prefix every tick. Acceptable to land in step 10 if step 8 already typechecks and works without it.

10. **Validate against existing tests, add new ones:**
    - New: `src/runtime/compaction.test.ts` (does not exist today). Cover:
      - A message list with a `thinking` block contributes to the count (regression for the original symptom).
      - A message list with an `image` block contributes the surcharge.
      - `shouldCompact` returns `true` once `router.countTokens` crosses the threshold (mock router).
      - `shouldCompact` returns `false` below threshold even if the chars count would have been over (verifies the old chars/4 path is gone).
    - New: `src/providers/anthropic.test.ts` gains a `countTokens` test that stubs the SDK call and asserts caching behaviour (same input → one underlying call).
    - New: `src/providers/openai.test.ts` gains a `countTokens` test asserting the result is reproducible and non-zero for a non-empty conversation.
    - Touched: [src/providers/router.test.ts](src/providers/router.test.ts) — every `makeProvider(...)` helper gains a `countTokens` mock returning `Promise.resolve(0)`. One new test: `router.countTokens(modelSpec, ...)` resolves to the candidate provider's value.

## Test strategy

- Pre-change baseline: `npm run typecheck && npm run build` (clean tree).
- After each major step (3, 6, 7, 8) re-run `npm run typecheck` to catch interface ripple early. The interface change at step 3 will surface every provider implementation that has not yet been updated; resolve in step 4 (default) and step 5 (overrides) before proceeding.
- Focused vitest runs during development:
  - `npx vitest run src/runtime/compaction.test.ts`
  - `npx vitest run src/providers/anthropic.test.ts src/providers/openai.test.ts src/providers/router.test.ts`
  - `npx vitest run src/agents/agents.test.ts` (covers `BaseAgent` loop)
- Full suite before commit: `npx vitest run`.
- Build verification: `npm run build` (tsup). Verify `js-tiktoken` bundles without warnings; if the BPE table loading triggers a warning, switch to lazy `import()` of the encoding inside `countWithTiktoken`.
- No live-runtime smoke test is required for this change — the existing planner happy-path test will exercise the loop with mocked providers.

## Rollback strategy

Single squashed commit. Revert is `git revert <sha>` plus `npm uninstall js-tiktoken`. No on-disk schema changes; no migration. Conversation state is in memory only — restart of the runtime clears it.

Per `_LOOP-CONVENTIONS.md` §"Mandatory project guidelines", no transitional shim is created: `estimateTokens` is deleted in the same commit that adds `countTokens`. Reverting that commit restores the old behaviour atomically.

## Cross-issue ordering

- **F07 should land before F20.** F20 (per-model `maxContextTokens`) is the *denominator* of the compaction threshold; F07 is the *numerator*. Fixing the denominator first leaves the agent compacting on an under-counted numerator against a now-larger denominator — strictly worse than today. Doing F07 first gives a correct numerator against today's hardcoded denominator (which is high, so still compacts late but at least correctly proportionally). F20 then completes the picture.
- **F07 is independent of F09 (worker base).** F09 will move worker-shared code into a `WorkerAgent` base; the changes here are inside `BaseAgent` which both worker and non-worker agents inherit, so the ripple is zero either way.
- **F07 is independent of F18 (prompt extraction).** F18 changes *where* prompts live; F07 only changes *how big they look*. After both land, F18's per-role prompt files become measurable in real tokens via `router.countTokens(modelSpec, [], systemPrompt)`.
- **F07 is independent of F11.** F11 wants `compaction_threshold_pct` and `max_compactions` moved into a typed config block; F07 doesn't touch those values, only the signal they're compared against. If F11 lands first, F07's edits at [src/agents/base.ts](src/agents/base.ts#L185-L193) re-target the new config field — a trivial rename.
