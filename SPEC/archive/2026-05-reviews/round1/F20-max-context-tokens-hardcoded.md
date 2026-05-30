# F20 — `maxContextTokens` returns a single hardcoded number per provider

**Category**: short-sighted
**Severity**: medium
**Transversality**: cross-cutting

## Summary

`AnthropicProvider.maxContextTokens` returns `200_000` for every model. `OpenAIProvider.maxContextTokens` returns `128_000` for every model. Both ignore the `modelSpec` argument they receive. This is the only number the compaction logic feeds into `thresholdPct`, so compaction triggers at the same point whether the agent is on Claude Haiku, Sonnet, or Opus — or whether the OpenAI model is gpt-4o (128k), gpt-4o-mini (128k), o1 (200k), or gpt-5 (1M-ish).

## Evidence

- Anthropic: [src/providers/anthropic.ts](src/providers/anthropic.ts#L1-L125) (`maxContextTokens` body returns `200_000` after dead `if` branches).
- OpenAI: [src/providers/openai.ts](src/providers/openai.ts#L1-L158).
- Caller — feeds straight into compaction config: [src/agents/base.ts](src/agents/base.ts#L188-L194).

## Why this matters

Two failure modes: (1) a Claude Haiku run (200k) is compacted at the same `80%` threshold as Sonnet, fine. But a gpt-5 run with a 1M context window is being compacted at 102k tokens. (2) The `if` branches in `anthropic.maxContextTokens` look like they were *intended* to differentiate, but each branch returns the same number — vestigial code that fools the reader into thinking the differentiation exists.

## Related

- F07 (token estimation — both inputs are wrong)
