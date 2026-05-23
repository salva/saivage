# F07 — Token estimation is provider-agnostic `chars/4`

**Category**: short-sighted
**Severity**: medium
**Transversality**: cross-cutting

## Summary

Compaction triggers off `Math.ceil(chars / 4)` token counts. The estimate ignores tokenizer differences across providers, image content, reasoning/thinking blocks (counted as zero today), tool-result JSON nesting, and prompt-cache-eligible vs cache-miss content. It is the only signal feeding both `shouldCompact` and the safety check `isMaxCompactionsReached`.

## Evidence

- The estimator: [src/runtime/compaction.ts](src/runtime/compaction.ts#L10-L26).
- Trigger: [src/runtime/compaction.ts](src/runtime/compaction.ts#L52-L60).
- The estimator only sums `block.text` and `block.content` and JSON-stringifies `block.input`; `thinking_signature`, `thinking`, and image blocks contribute nothing: [src/runtime/compaction.ts](src/runtime/compaction.ts#L13-L24).
- `BaseAgent` assembles assistant messages with explicit `thinking` blocks that this estimator ignores: [src/agents/base.ts](src/agents/base.ts#L267-L284).

## Why this matters

A long reasoning chain (now common with Claude 4 / GPT-5 family models) doesn't move the estimator at all, so the agent keeps growing past the real context window and the next provider call fails with an opaque "context overflow" error — which the retry logic then masks as a generic transient error and retries forever. Provider-reported usage (when available) is more reliable; falling back to a model-specific multiplier (Anthropic ≈ 3.5 ch/tok, OpenAI ≈ 4, etc.) is still better than nothing.

## Related

- F11 (magic constants — `chars/4`)
- F20 (provider context-window stubs)
