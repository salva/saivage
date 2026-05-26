# G07 — Analysis r2

**Finding**: [../G07-compaction-fallback-orphan-tool-results.md](../G07-compaction-fallback-orphan-tool-results.md)
**Round-1 reference**: F07 (tiktoken-backed token counting) and F13 (typed `ProviderError` with `orphaned_tool_result` kind).
**Supersedes**: [./01-analysis-r1.md](./01-analysis-r1.md). Round 2 narrows §2.2 to the single proven producer path (change 3 of [./04-review-r1.md](./04-review-r1.md)).

## 1. Where the fallback truncation runs

The summarization fallback is the `catch` arm of `compactConversation` in [src/runtime/compaction.ts](../../../../src/runtime/compaction.ts#L102-L123). It executes whenever the summarizer LLM call throws — provider timeout (`raceTimeout` at [src/runtime/compaction.ts](../../../../src/runtime/compaction.ts#L155-L166)), `ProviderError` of any kind from `router.chat`, abort, or any other thrown error. The summarizer uses `config.summaryModelSpec` ([src/runtime/compaction.ts](../../../../src/runtime/compaction.ts#L86-L97)), which `BaseAgent` hardcodes to `ctx.modelSpec` at [src/agents/base.ts](../../../../src/agents/base.ts#L193-L195); a provider outage on the agent's model spec sends every concurrent agent down this fallback path simultaneously.

The fallback is invoked from two call sites in `BaseAgent`:

- Pre-LLM threshold check in the agent loop: [src/agents/base.ts](../../../../src/agents/base.ts#L237-L249).
- Model-repair retry triggered by `pe.kind === "context_overflow" || pe.kind === "orphaned_tool_result"` inside `callLLM`'s catch: [src/agents/base.ts](../../../../src/agents/base.ts#L539-L559).

Both call sites go through `compactWithReinjection` at [src/agents/base.ts](../../../../src/agents/base.ts#L856-L890), which awaits `compactConversation` and then calls `replaceMessages(next)` ([src/agents/base.ts](../../../../src/agents/base.ts#L769-L779)). `replaceMessages` recomputes `runningInputTokens` against the new array but does **not** validate that the new array is a well-formed tool-call transcript.

## 2. How the fallback can leave orphans

The fallback body, verbatim:

```ts
} catch (err) {
  log.error(`[compaction] Summarization failed, falling back to hard truncation: ${err}`);
  const keepCount = Math.max(2, Math.ceil(messages.length * 0.2));
  const recent = messages.slice(-keepCount);
  state.compactionCount++;
  return [
    { role: "user" as const,
      content: "[Context was truncated due to length. Re-read state from disk to continue.]" },
    ...recent,
  ];
}
```

`slice(-keepCount)` keeps the suffix and prepends a single synthetic `user` text message. There is no inspection of the kept suffix's content blocks.

### 2.1 Canonical tool-call transcript shape

`BaseAgent.run` writes the conversation in strict adjacent pairs in the same loop body:

1. Assistant message: zero or more `tool_use` blocks under `content: ContentBlock[]`, each with `id`, pushed at [src/agents/base.ts](../../../../src/agents/base.ts#L323).
2. Dispatcher executes the tool calls at [src/agents/base.ts](../../../../src/agents/base.ts#L327-L331).
3. User message with one `tool_result` block per assistant `tool_use`, pushed at [src/agents/base.ts](../../../../src/agents/base.ts#L338-L344).

Steps 1–3 run within one iteration of the `while` loop; the assistant `tool_use` half is never observed without its paired user `tool_result` from the producer side. Pre-call compaction at [src/agents/base.ts](../../../../src/agents/base.ts#L237-L248) runs **before** the next `callLLM`, so the message tail at compaction time is either a pure-text user message (initial / injected / tool result that just landed) or the result half of a completed pair. Model-repair compaction at [src/agents/base.ts](../../../../src/agents/base.ts#L540-L558) catches the provider error from `callLLM` before the new assistant response is ever pushed, so the tail there is also the result half of the prior round (the failed response is discarded).

The `ContentBlock` carrier is shared ([src/providers/types.ts](../../../../src/providers/types.ts#L8-L19)): `tool_use.id` is matched to `tool_result.tool_use_id`. Anthropic provider serializes both shapes 1:1; OpenAI provider rewrites `tool_use_id` to `tool_call_id` at [src/providers/openai.ts](../../../../src/providers/openai.ts#L137).

### 2.2 The single proven failure mode (revised)

Let `M` be the message array at the moment of fallback and `R = M.slice(-keepCount)`.

**Orphan — leading `tool_result` without matching `tool_use`.** Because the tail of `M` is almost always the user-side `tool_result` half of the last completed round (see §2.1), `slice(-keepCount)` cuts roughly half the time inside a pair: `R[0]` is a user message whose `content` is a block array containing a `tool_result`, and the matching assistant `tool_use` lives in `M[len-keepCount-1]` (just outside `R`). The synthetic notice prepended at [src/runtime/compaction.ts](../../../../src/runtime/compaction.ts#L113-L116) is a plain text `user` message and contains no `tool_use`, so the kept `tool_result` is the first block-bearing entry with no matching `tool_use` anywhere upstream.

**Defensive note on trailing assistant `tool_use`.** A dangling assistant `tool_use` at the tail is not produced by `BaseAgent.run`'s happy path (§2.1). The round parser in [./02-design-r2.md](./02-design-r2.md) still classifies such a half as `DanglingHalf` and drops it as a belt-and-braces invariant — guarding against future producer-path changes and against the case where a prior broken fallback already corrupted the tail. It is **not** treated as a proven current bug.

Both modes pass the in-process happy path. `replaceMessages` recomputes token count and returns. The agent then proceeds to the next `router.chat` call with a broken transcript.

### 2.3 Compaction state bookkeeping

`state.compactionCount++` runs unconditionally inside the catch ([src/runtime/compaction.ts](../../../../src/runtime/compaction.ts#L110)). Combined with `isMaxCompactionsReached` at [src/runtime/compaction.ts](../../../../src/runtime/compaction.ts#L52-L57) and the abort paths at [src/agents/base.ts](../../../../src/agents/base.ts#L242-L247) and [src/agents/base.ts](../../../../src/agents/base.ts#L544-L552), a transient summarizer outage that fires three times silently consumes the entire compaction budget and aborts the agent without ever producing a successful summary.

The 20% heuristic is unanchored to the next outbound request's token budget. The token cost of the next call is `staticInputTokens + runningInputTokens`, where `staticInputTokens` is precomputed from `systemPrompt + tools` at [src/agents/base.ts](../../../../src/agents/base.ts#L204-L208) and `compaction.ts` itself passes `tools` into the budget call at [src/runtime/compaction.ts](../../../../src/runtime/compaction.ts#L76-L77). Slicing the message tail by count without consulting the system-prompt + tool-schema overhead can leave the post-fallback transcript still above `thresholdPct * contextWindow`. If the summarizer is still down, the same fallback runs again — same orphan risk, another `compactionCount++`.

A further pathology: if the new fallback returns a `Message[]` whose token count is still above threshold, the pre-call check at [src/agents/base.ts](../../../../src/agents/base.ts#L237-L248) immediately re-fires `compactWithReinjection` before any `callLLM`. With the round-parser fix the slice is no longer ad-hoc, but if the fallback path does not also advance some bounded counter, a persistently oversized atomic round (one giant `ToolRound` that cannot be split) loops without ever calling the LLM. The design must close this loop with an explicit consecutive-fallback cap that participates in `isMaxCompactionsReached`.

## 3. What providers reject

Provider classification lives in [src/providers/error.ts](../../../../src/providers/error.ts). The two patterns that map to the agent's repair path:

- `ORPHAN_RE = /no tool.{0,20}(call|use).{0,20}found|orphaned tool|tool_use_id.{0,20}not found|unexpected tool.{0,5}result/i` at [src/providers/error.ts](../../../../src/providers/error.ts#L79).
- Anthropic API type `invalid_request_error` at [src/providers/error.ts](../../../../src/providers/error.ts#L115-L120) classifies as `non_retryable` *unless* the message also matches `ORPHAN_RE` (matched earlier at [src/providers/error.ts](../../../../src/providers/error.ts#L162-L164)).

Concrete provider behaviour for the leading-`tool_result` orphan:

- **Anthropic** rejects with HTTP 400 `invalid_request_error` carrying `tool_use_id ... not found in previous turn` (matches `ORPHAN_RE`). Classified as `orphaned_tool_result` ⇒ `callLLM` runs `compactWithReinjection` again at [src/agents/base.ts](../../../../src/agents/base.ts#L558). If the summarizer is still failing, the second call hits the same fallback and produces another orphan — recursive failure, bounded only by `maxCompactions`.
- **OpenAI / OpenAI-Codex** ([src/providers/openai.ts](../../../../src/providers/openai.ts#L137)): each `tool_result` is rewritten into a `role: "tool"` message keyed on `tool_call_id`. The leading orphan makes the OpenAI request body invalid (`"messages with role 'tool' must be a response to a preceding message with 'tool_calls'"`) — HTTP 400. Matches `ORPHAN_RE` via the `unexpected tool` arm.
- **Copilot / OpenRouter** proxy OpenAI shape and surface the same 400.
- **Ollama / llama.cpp / pi-ai**: tolerant of pair mismatches (they treat tool messages as opaque text), so the orphan is *silently* injected as garbage context. No bounce, no recovery — the agent keeps drifting on bad context. This is arguably worse than the Anthropic case because there is no signal.

## 4. Why the explosion is delayed and hard to diagnose

The orphan is produced inside `compactConversation`; the provider rejection happens on the **next** `router.chat` call inside `callLLM`. The two log lines (`[compaction] Summarization failed …` and `BadRequestError: tool_use_id … not found`) appear seconds-to-minutes apart with unrelated round IDs. The base-agent retry path at [src/agents/base.ts](../../../../src/agents/base.ts#L539-L559) treats the bounce as a fresh `orphaned_tool_result` and triggers another compaction — exactly the wrong response, because the orphan was created **by** the previous compaction. The agent burns through the compaction budget and then aborts with `non_retryable` after `isMaxCompactionsReached`.

## 5. Test gap

[src/runtime/compaction.test.ts](../../../../src/runtime/compaction.test.ts#L1-L40) only covers `shouldCompact`. There is no test that constructs `messages` with tool pairs and exercises `compactConversation`. [src/agents/base.compaction.test.ts](../../../../src/agents/base.compaction.test.ts#L1-L160) drives `compactWithReinjection` end-to-end but seeds plain-text `user` messages — pairing invariants are never exercised, and the test router never throws so the fallback branch is unreachable from the existing suite. The leading-`tool_result` orphan mode is completely untested.

## 6. Honest-accounting / fallback-cap requirement

The original finding names "honest accounting" (don't double-increment on fallback) and "different summarizer model spec from the agent". The first is mandatory (without it the budget is consumed silently); the second is operational policy and is **out of scope** for this round per change 5 of [./04-review-r1.md](./04-review-r1.md). The fallback-cap requirement (do not loop pre-call compaction indefinitely on a still-oversized fallback result) is mandatory and is treated explicitly in [./02-design-r2.md](./02-design-r2.md) §2 and the test list in [./03-plan-r2.md](./03-plan-r2.md).

## 7. Cross-links

- Adjacent to F13 ([src/providers/error.ts](../../../../src/providers/error.ts)) — the `orphaned_tool_result` discriminant is the consumer-side last line of defence; the round-parser closes the producer side but does not weaken the discriminant.
- Cross-finding with G06 (sync fs in stash) — slow disk in [src/runtime/stash.ts](../../../../src/runtime/stash.ts) can stretch a tool-call cycle past the summarizer timeout, raising fallback frequency. **Not a hard dependency.** The orphan-correctness fix must hold under any summarizer failure mode, including a healthy stash.
- Cross-finding with G29 (plan-server serialize-blocks-reads) — under load, summarizer requests competing with planner reads inflate latency on the same model spec, making timeout-driven fallback more likely. Same status: independent, not blocking.
