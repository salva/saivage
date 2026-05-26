# G07 — Compaction fallback truncation can leave orphaned `tool_result` blocks

**Subsystem:** src/runtime/
**Category:** correctness / protocol invariants
**Severity:** medium
**Transversality:** module (single function), high blast radius

## Summary

When LLM-based context compaction fails (timeout, provider error, or any thrown error), `compactConversation` falls back to **hard tail truncation** — it keeps the last `max(2, ceil(messages.length * 0.2))` raw messages and prepends a "Context was truncated" notice. This strategy ignores the tool-call protocol invariant that every `tool_result` block must be preceded by the matching `tool_use` block in an earlier assistant message. Truncating mid-pair produces a conversation that providers (Anthropic in particular, with strict tool-pair checking) reject with `400 invalid_request_error`, turning a recoverable compaction failure into an unrecoverable agent abort.

## Evidence

[src/runtime/compaction.ts](src/runtime/compaction.ts#L102-L123):

```ts
} catch (err) {
  log.error(`[compaction] Summarization failed, falling back to hard truncation: ${err}`);

  // Fallback: keep only the most recent 20% of messages
  const keepCount = Math.max(2, Math.ceil(messages.length * 0.2));
  const recent = messages.slice(-keepCount);

  state.compactionCount++;

  return [
    {
      role: "user" as const,
      content: "[Context was truncated due to length. Re-read state from disk to continue.]",
    },
    ...recent,
  ];
}
```

There is no scan over `recent` to ensure every `tool_result` block in it has a matching `tool_use` earlier in `recent`. With typical traffic (assistant turn = 1 tool_use, user turn = 1 tool_result), the `slice(-keepCount)` boundary lands on a tool_result roughly half the time. The orphan check that [src/agents/base.ts](src/agents/base.ts) does elsewhere (round-1 finding referencing `orphaned_tool_result`) catches this *only* on the next outbound call — by which time the fallback has already been committed and the agent's only recovery path is to fail upward.

A second cliff: `state.compactionCount++` fires inside the catch block. If the next compaction is also triggered at the (still-over-threshold) tail and *also* fails, `compactionCount` advances toward `maxCompactions` without ever producing a usable summary. The agent terminates with `finishReason === "max_compactions"`, which the worker layer maps to a hard failure — even though the underlying problem was transient provider trouble.

The 20% heuristic is also unjustified: it isn't tied to the token-window budget. A 200-message conversation truncated to 40 messages may still exceed the threshold that triggered compaction in the first place, causing immediate re-trigger.

## Why this matters

- Compaction is the agent's only defense against context overflow. A fallback that *also* fails is a single-point-of-failure for long-running stages.
- The orphan problem is silent on the producer side (the fallback returns happily) and explodes on the consumer side (provider 400). Diagnosing this from production logs requires correlating the `[compaction] Summarization failed` warning with a much later `BadRequestError: tool_use_id ... not found` — they look unrelated.
- The fact that the LLM summarization path uses the *same model spec* as the agent itself (line 24 of `base.ts` initialization) means a provider outage that breaks the agent also breaks its escape hatch. The bug surfaces precisely when the system can least afford it.

## Rough remediation direction

Two layered fixes:

1. **Pair-safe truncation.** Before returning the fallback, scan `recent` from the front and drop any leading `tool_result` block whose matching `tool_use` is not present in `recent`. Symmetrically, drop any trailing `tool_use` whose matching `tool_result` is not present. Extract the pair-walking logic into a `repairToolPairs(messages: Message[]): Message[]` helper and unit-test it directly; reuse the same helper at the *successful* compaction path as a safety net.
2. **Honest accounting.** Don't increment `compactionCount` on the fallback path, *or* increment it but additionally publish a runtime event (`compaction_fallback`) so the dashboard surfaces the degraded state. Consider a separate `summarizerFallbacks` counter that triggers human-visible escalation after N consecutive fallbacks rather than silently consuming the compaction budget.
3. (Optional, design call) Use a different model spec for the summarizer than for the agent — e.g. always a cheap, fast model — so the summarizer doesn't share fate with the primary model.

Add tests:

- Construct a conversation ending in a user `tool_result` whose `tool_use_id` is in the part being dropped; assert the returned `recent` does not contain that `tool_result`.
- Mock the summarizer to throw, run compaction, assert the returned messages are tool-pair-valid.

## Cross-links

- Adjacent to round-1 finding on orphaned tool-result handling (the per-call sanitiser in base.ts works around the same protocol invariant from the consumer side).
- Compounds with G06 — a slow-disk fault that blocks the event loop can race with compaction summarization timeouts.
