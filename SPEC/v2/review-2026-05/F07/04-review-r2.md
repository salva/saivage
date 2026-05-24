# F07 — Review (r2)

## Reviewer

GPT-5.5 (copilot)

## Documents reviewed

- [SPEC/v2/review-2026-05/F07-token-estimation-chars-over-4.md](SPEC/v2/review-2026-05/F07-token-estimation-chars-over-4.md)
- [SPEC/v2/review-2026-05/F07/04-review-r1.md](SPEC/v2/review-2026-05/F07/04-review-r1.md)
- [SPEC/v2/review-2026-05/F07/01-analysis-r2.md](SPEC/v2/review-2026-05/F07/01-analysis-r2.md)
- [SPEC/v2/review-2026-05/F07/02-design-r2.md](SPEC/v2/review-2026-05/F07/02-design-r2.md)
- [SPEC/v2/review-2026-05/F07/03-plan-r2.md](SPEC/v2/review-2026-05/F07/03-plan-r2.md)

## Findings

### Analysis

- The r1 compaction-budget correction is now accurate. The analysis correctly separates `estimateTokens` consumers in [src/runtime/compaction.ts](src/runtime/compaction.ts#L57-L63) and [src/runtime/compaction.ts](src/runtime/compaction.ts#L90-L94) from `isMaxCompactionsReached`, which reads only `state.compactionCount` at [src/runtime/compaction.ts](src/runtime/compaction.ts#L69-L73).
- The overflow-error discussion is substantively improved, but at least one corrected reference is still stale enough to violate the loop convention. The agent regex is currently at [src/agents/base.ts](src/agents/base.ts#L872-L878), not the r2 analysis link to `L773-L778`. Likewise, the pre-call compaction guard is at [src/agents/base.ts](src/agents/base.ts#L224-L236), not `L222`.

### Design

- The recommended architecture is still the right one: token counting belongs behind `ModelProvider`/`ModelRouter`, and `shouldCompact` reading a maintained token count avoids both the old `chars / 4` heuristic and a new Anthropic HTTP call per loop tick.
- The provider inheritance section fixes the r1 factual error that `openrouter`, `ollama`, and `llamacpp` extend `OpenAIProvider` at [src/providers/openrouter.ts](src/providers/openrouter.ts#L6), [src/providers/ollama.ts](src/providers/ollama.ts#L7), and [src/providers/llamacpp.ts](src/providers/llamacpp.ts#L7). However, the chosen inherited encoding behavior is still not specified consistently. The prose says `ollama`/`llamacpp` models are usually llama/mistral derivatives closer to `cl100k_base`, but the proposed `OpenAIProvider.countTokens` fallback says "anything else newer" uses `o200k_base`. Local model names such as `llama3.1` or `mistral` do not match the listed GPT/O-series prefixes, so the actual plan would count them with `o200k_base` unless those subclasses override or the fallback rule changes.
- Minor cleanup: Proposal B still mentions `runningCountedMsgIdx` in the new-field list, but the r2 plan does not add or use that field. If it is unnecessary, remove it from the design so implementers do not create an unused state slot.

### Plan

- The running-token counter is now a mandatory implementation step, which satisfies the most important r1 objection. `pushMessage` and `replaceMessages` are the right mutation hooks in the current file at [src/agents/base.ts](src/agents/base.ts#L718-L740), and the overflow retry path flows through `compactWithReinjection` at [src/agents/base.ts](src/agents/base.ts#L515-L533) and [src/agents/base.ts](src/agents/base.ts#L820-L850).
- Step 6 is not executable as written. It proposes `const { provider, model } = this.resolveActive(modelSpec); // existing helper`, but `ModelRouter` has no `resolveActive` helper. The current `getMaxContextTokens` logic uses `tryParseModelId`, `buildCandidateChain`, `parseModelId`, and `getProviderForRequest` at [src/providers/router.ts](src/providers/router.ts#L245-L258). The plan should either extract a real private helper in a stated edit step or spell out the concrete candidate-chain code for `countTokens`.
- The optional calibration snippet can weaken the compaction trigger despite the plan saying it "never weakens" it. If `response.usage.inputTokens` is lower than the local estimate by more than 10%, `this.runningInputTokens = Math.max(0, reported - this.staticInputTokens)` lowers the maintained count. That may be acceptable if provider usage is treated as authoritative, but then the text must say calibration can adjust in either direction. If the intended safety property is monotonic tightening, the snippet must clamp with the current estimate instead of replacing it.

## Required changes

1. Fix the remaining stale or misleading references in the r2 docs, especially the `BaseAgent` regex and compaction-guard links, and replace the nonexistent `resolveActive` router helper with an explicit, current implementation step.
2. Make the OpenAI-compatible subclass encoding behavior exact. Either change the OpenAI fallback so non-GPT local model names use the intended encoding, or add deliberate `ollama`/`llamacpp`/`openrouter` overrides and tests that prove the chosen fallback.
3. Correct the usage-calibration semantics. Document that calibration may lower the maintained count when provider usage is authoritative, or change the snippet so it is genuinely monotonic and cannot weaken the trigger.
4. Remove or justify the unused `runningCountedMsgIdx` design mention so the design and plan describe the same state.

## Strengths

- The r2 documents correctly remove the per-loop Anthropic `messages.countTokens` RPC and keep `shouldCompact` synchronous.
- The mandatory running-counter design is a real architectural improvement over both the legacy estimator and r1's optional shortcut.
- The test plan now covers the key regression surfaces: thinking blocks, image blocks, router delegation, provider-specific counting, and BaseAgent counter maintenance.

VERDICT: CHANGES_REQUESTED