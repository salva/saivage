# G07 — Analysis r1

**Finding**: [../G07-compaction-fallback-orphan-tool-results.md](../G07-compaction-fallback-orphan-tool-results.md)
**Subsystem**: runtime (context compaction)
**Round-1 reference**: F07 (tiktoken-backed token counting) and F13 (typed `ProviderError` with `orphaned_tool_result` kind) are both in play; this finding sits on top of both.

## 1. Where the fallback truncation runs

The summarization fallback is the `catch` arm of `compactConversation` in [src/runtime/compaction.ts](../../../../src/runtime/compaction.ts#L102-L123). It executes whenever the summarizer LLM call throws — provider timeout (`raceTimeout` at [src/runtime/compaction.ts](../../../../src/runtime/compaction.ts#L155-L166)), `ProviderError` of any kind from `router.chat`, abort, or any other thrown error. The summarizer uses `config.summaryModelSpec` ([src/runtime/compaction.ts](../../../../src/runtime/compaction.ts#L86-L97)); a provider outage on that model spec sends every concurrent agent down this fallback path simultaneously.

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

`BaseAgent.run` writes the conversation in strict pairs ([src/agents/base.ts](../../../../src/agents/base.ts#L303-L344)):

1. Assistant message: zero or more `tool_use` blocks under `content: ContentBlock[]`, each with `id`.
2. User message immediately after: one `tool_result` block per assistant `tool_use`, with `tool_use_id` matching the assistant `id`.

The `ContentBlock` carrier is shared ([src/providers/types.ts](../../../../src/providers/types.ts#L8-L19)): `tool_use.id` is matched to `tool_result.tool_use_id`. Anthropic provider serializes both shapes 1:1; OpenAI provider rewrites `tool_use_id` to `tool_call_id` at [src/providers/openai.ts](../../../../src/providers/openai.ts#L137).

### 2.2 The two failure modes

Let `M` be the message array at the moment of fallback and `R = M.slice(-keepCount)`.

**Orphan A — leading `tool_result` without matching `tool_use`.** If `R[0]` is the user message of a pair whose assistant `tool_use` lives in `M[len-keepCount-1]` (i.e. just outside the kept window), then `R[0].content` contains a `tool_result` block whose `tool_use_id` does not appear in any earlier assistant message in `R`. Because the synthetic notice message we prepend is a plain text `user` message, the kept `tool_result` is now the very first block-bearing entry, with no matching `tool_use` anywhere upstream. With the typical 2-message cadence (1 assistant tool_use, 1 user tool_result) and `keepCount` even, the boundary lands on a `tool_result` roughly half the time and on a `tool_use` the other half.

**Orphan B — trailing `tool_use` without matching `tool_result`.** Symmetric case: if `R[R.length-1]` is an assistant message containing `tool_use` blocks whose user response was never produced before the trigger (compaction can fire on the threshold check at [src/agents/base.ts](../../../../src/agents/base.ts#L237-L238) before the dispatcher writes the result, or fires during the `model-repair` retry from `callLLM` *before* the assistant message ever got a paired user message). The kept window ends on a dangling `tool_use`.

Both orphans pass the in-process happy path. `replaceMessages` reads token count and returns. The agent then either prepends a survivor block from [src/agents/base.ts](../../../../src/agents/base.ts#L876-L883) (a text `user` message — does not help) or proceeds to the next `router.chat` call with a broken transcript.

### 2.3 Compaction state bookkeeping

`state.compactionCount++` runs unconditionally inside the catch ([src/runtime/compaction.ts](../../../../src/runtime/compaction.ts#L110)). Combined with `isMaxCompactionsReached` at [src/runtime/compaction.ts](../../../../src/runtime/compaction.ts#L52-L57) and the abort path at [src/agents/base.ts](../../../../src/agents/base.ts#L242-L247) and [src/agents/base.ts](../../../../src/agents/base.ts#L544-L552), a transient summarizer outage that fires three times silently consumes the entire compaction budget and aborts the agent without ever producing a successful summary.

The 20% heuristic is unanchored to the token-window budget. A 200-message transcript truncated to ~40 messages may still exceed `thresholdPct * contextWindow`, re-triggering compaction on the very next LLM call. If the summarizer is still down, the same fallback runs again — same orphan risk, another `compactionCount++`.

## 3. What providers reject

Provider classification lives in [src/providers/error.ts](../../../../src/providers/error.ts). The two patterns that map to the agent's repair path:

- `ORPHAN_RE = /no tool.{0,20}(call|use).{0,20}found|orphaned tool|tool_use_id.{0,20}not found|unexpected tool.{0,5}result/i` at [src/providers/error.ts](../../../../src/providers/error.ts#L79).
- Anthropic API type `invalid_request_error` at [src/providers/error.ts](../../../../src/providers/error.ts#L115-L120) classifies as `non_retryable` *unless* the message also matches `ORPHAN_RE` (matched earlier at [src/providers/error.ts](../../../../src/providers/error.ts#L162-L164)).

Concrete provider behaviour:

- **Anthropic** rejects orphan A with HTTP 400 `invalid_request_error` carrying a message of the form `tool_use_id ... not found in previous turn` (matches `ORPHAN_RE`). Classified as `orphaned_tool_result` ⇒ `callLLM` runs `compactWithReinjection` again at [src/agents/base.ts](../../../../src/agents/base.ts#L558). If the summarizer is still failing, the second call hits the same fallback and produces another orphan — recursive failure, bounded only by `maxCompactions`. Anthropic also rejects orphan B with `messages.<n>: tool_use ids were found without tool_result blocks immediately after`, which also matches `ORPHAN_RE`.
- **OpenAI / OpenAI-Codex** ([src/providers/openai.ts](../../../../src/providers/openai.ts#L137)): each `tool_result` is rewritten into a `role: "tool"` message keyed on `tool_call_id`. An orphan A makes the OpenAI request body invalid (`"messages with role 'tool' must be a response to a preceeding message with 'tool_calls'"`) — HTTP 400. Matches `ORPHAN_RE` via the `unexpected tool` arm.
- **Copilot / OpenRouter** proxy OpenAI shape and surface the same 400.
- **Ollama / llama.cpp / pi-ai**: tolerant of pair mismatches (they treat tool messages as opaque text), so the orphan is *silently* injected as garbage context. No bounce, no recovery — the agent keeps drifting on bad context. This is arguably worse than the Anthropic case because there is no signal.

## 4. Why the explosion is delayed and hard to diagnose

The orphan is produced inside `compactConversation`; the provider rejection happens on the **next** `router.chat` call inside `callLLM`. The two log lines (`[compaction] Summarization failed …` and `BadRequestError: tool_use_id … not found`) appear seconds-to-minutes apart with unrelated round IDs. The base-agent retry path at [src/agents/base.ts](../../../../src/agents/base.ts#L539-L559) treats the bounce as a fresh `orphaned_tool_result` and triggers another compaction — exactly the wrong response, because the orphan was created **by** the previous compaction. The agent burns through the compaction budget and then aborts with `non_retryable` after `isMaxCompactionsReached`.

## 5. Test gap

[src/runtime/compaction.test.ts](../../../../src/runtime/compaction.test.ts#L1-L40) only covers `shouldCompact`. There is no test that constructs `messages` with tool pairs and exercises `compactConversation`. [src/agents/base.compaction.test.ts](../../../../src/agents/base.compaction.test.ts#L1-L160) drives `compactWithReinjection` end-to-end but seeds plain-text `user` messages — pairing invariants are never exercised, and the test router never throws so the fallback branch is unreachable from the existing suite. Both A and B orphan modes are completely untested.

## 6. Sibling worry that this analysis does *not* expand on

The original finding also names "honest accounting" (don't double-increment on fallback) and "different summarizer model spec from the agent". Both are real but they are operational/policy choices that depend on what the design picks. They are flagged in §3 of the design rather than as additional pieces of this analysis — fixing the orphan correctness bug is the lower bound; the rest is upside.

## 7. Cross-links

- Adjacent to F13 ([src/providers/error.ts](../../../../src/providers/error.ts)) — the `orphaned_tool_result` discriminant is the producer signal that exposes this bug; the fallback is the producer of the orphans the discriminant catches.
- Cross-finding with G06 (sync fs in stash) — slow disk in the stash writer at [src/runtime/stash.ts](../../../../src/runtime/stash.ts) can stretch a tool-call cycle past the summarizer timeout, raising fallback frequency.
- Cross-finding with G29 (plan-server serialize-blocks-reads) — under load, summarizer requests competing with planner reads inflate latency on the same model spec, making timeout-driven fallback more likely.
