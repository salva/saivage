# G07 — Design r1

**Finding**: [../G07-compaction-fallback-orphan-tool-results.md](../G07-compaction-fallback-orphan-tool-results.md)
**Analysis**: [./01-analysis-r1.md](./01-analysis-r1.md)

Two proposals. Both fix the orphan-correctness bug; B also retires the heuristic suffix slice in favour of an invariant-preserving message-graph walk. Recommendation in §3.

---

## Proposal A — Orphan-cleanup pass over the heuristic slice

### Shape

Keep the 20% tail-slice fallback. After producing `recent = messages.slice(-keepCount)`, run a `repairToolPairs(recent)` pass that returns a tool-pair-valid prefix-and-suffix-trimmed array. Reuse the same helper as a safety net on the **successful** summarization return (it is a no-op when the array is a single text `user` message but defends against future call sites).

### Repair contract

`repairToolPairs(msgs: Message[]): Message[]`. Single linear scan, two-pass:

1. **Forward pass** — collect every `tool_use.id` from assistant messages into a `Set<string>`. Walk each `user` message: if its `content` is a block array, drop any `tool_result` block whose `tool_use_id` is not in the set. If the resulting block array is empty, drop the whole message.
2. **Backward pass** — collect every `tool_result.tool_use_id` from user messages into a `Set<string>`. Walk each assistant message: drop any `tool_use` block whose `id` is not in the set. If the assistant message now has zero `tool_use` *and* zero non-empty text blocks, drop the whole message; if it has text but no tool calls, keep it.

Order-preserving, idempotent, total. No new types; reuses `Message` and `ContentBlock` from [src/providers/types.ts](../../../../src/providers/types.ts#L3-L19).

### Files touched

- [src/runtime/compaction.ts](../../../../src/runtime/compaction.ts) — replace the catch body with `return prepend(notice, repairToolPairs(recent))`; export `repairToolPairs` for tests; apply it as a safety net to the success-branch return too.
- [src/runtime/compaction.test.ts](../../../../src/runtime/compaction.test.ts) — add unit tests for `repairToolPairs` against the two orphan modes, plus a mocked `router.chat` that throws to exercise the full fallback.
- [src/agents/base.compaction.test.ts](../../../../src/agents/base.compaction.test.ts) — extend with a scenario seeding a tool-pair conversation and asserting the post-`compactWithReinjection` array has no orphans.
- No change to [src/agents/base.ts](../../../../src/agents/base.ts) (consumer-transparent).

### Deletion list

- Drop the inline catch body of `compactConversation`. Replaced by a single helper call site.
- Nothing else.

### Test impact

- New test file slice covers `repairToolPairs` directly (≈4 cases: orphan-A only, orphan-B only, both, pair-valid no-op).
- Extend the `BaseAgent` compaction test to assert pair-validity post-fallback. The existing F06 tests are unaffected.

### What this does *not* fix

- The `state.compactionCount++` on the fallback path still consumes the budget even when the fallback "succeeded" only because the summarizer was down. Same-model summarizer fate-sharing remains.
- The 20% heuristic still has no relationship to `contextWindow * thresholdPct`; the repaired suffix may still re-trigger compaction immediately.

---

## Proposal B — Replace the suffix slice with a message-graph walk

### Shape

Treat `messages` as a graph of *rounds*. A round is one of:

- **TextRound** — a single `user` (or `assistant`) message whose content is a string or an array of only text/thinking blocks. Atomic.
- **ToolRound** — an `assistant` message containing ≥1 `tool_use` blocks, followed immediately by exactly one `user` message containing the matched `tool_result` blocks. Atomic.
- **DanglingHalf** — an assistant `tool_use` without its `user` partner, or a `user` `tool_result` without its assistant partner. Never emitted by `BaseAgent.run`'s happy path; appears only as a tail when compaction fires mid-cycle or a previous broken fallback ran.

Algorithm:

1. `parseRounds(messages: Message[]): Round[]` — single forward walk. On each assistant message with `tool_use`, peek the next user message; if it carries the matching set of `tool_result.tool_use_id`, emit `ToolRound{ rounds: [asst, user], toolIds }`. Otherwise emit `DanglingHalf`. Plain text/system messages become `TextRound`.
2. `selectKeptRounds(rounds: Round[], cfg): Round[]` — drop all `DanglingHalf`. From the tail, accumulate atomic rounds until either the kept-round count reaches `max(2, ceil(rounds.length * 0.2))` or the accumulated token estimate (via `router.countTokens` on a synthetic flattened array) drops below `0.5 * cfg.thresholdPct/100 * cfg.contextWindow` — whichever comes first. Tokens are the right axis; the count cap is the safety stop.
3. `flatten(rounds: Round[]): Message[]` — concatenate the rounds back into a flat `Message[]` in original order.

Result is by construction pair-valid: a `ToolRound` is the indivisible unit, so we never split a pair. `DanglingHalf` cannot survive.

### Honest accounting (folded in)

- Only increment `state.compactionCount` on the **success** branch. The fallback emits a `compaction_fallback` diagnostic via `BaseAgent.addDiagnostic`; the diagnostic is gated through a callback on `CompactionConfig` so `compactConversation` stays pure (no agent reference leak).
- Add a separate `summarizerFallbacks` counter on `CompactionState`; surface it through the runtime-state writer in [src/runtime/recovery.ts](../../../../src/runtime/recovery.ts) so dashboards can see consecutive fallbacks. Compaction still aborts after `maxCompactions`, but only the *successful* summarizations count toward that ceiling.
- Optional but cheap: take a `fallbackSummarizerSpec?: string` on `CompactionConfig`; if present, retry the summarizer call once against it before falling back to the truncation path. Wired from `bootstrap.ts` to a cheap-and-fast model spec that does not share fate with `modelSpec`.

### Files touched

- [src/runtime/compaction.ts](../../../../src/runtime/compaction.ts) — rewrite `compactConversation` around `parseRounds` / `selectKeptRounds` / `flatten`; remove the inline `slice(-keepCount)` and the inline `state.compactionCount++` from the catch. Add `summarizerFallbacks` and the fallback-diagnostic callback to `CompactionConfig` / `CompactionState`. Optionally add `fallbackSummarizerSpec` plumbing.
- [src/agents/base.ts](../../../../src/agents/base.ts) — `compactWithReinjection` ([src/agents/base.ts](../../../../src/agents/base.ts#L856-L890)) passes a fallback-diagnostic callback into `compactConversation`; `isMaxCompactionsReached` consumers ([src/agents/base.ts](../../../../src/agents/base.ts#L240-L247), [src/agents/base.ts](../../../../src/agents/base.ts#L544-L552)) are unchanged because the predicate still reads `compactionCount`.
- [src/runtime/recovery.ts](../../../../src/runtime/recovery.ts) — extend the runtime-state writer payload with `summarizerFallbacks` per agent. Plumb through whatever struct exposes `compactionCount` today.
- [src/server/bootstrap.ts](../../../../src/server/bootstrap.ts) — wire `fallbackSummarizerSpec` from `SaivageConfig` (if added) into the `CompactionConfig` built per agent.
- [src/runtime/compaction.test.ts](../../../../src/runtime/compaction.test.ts) — replace the single-function test with a round-parser test, a `selectKeptRounds` test, and a `compactConversation`-with-mocked-router success + fallback test.
- [src/agents/base.compaction.test.ts](../../../../src/agents/base.compaction.test.ts) — replace seed messages with a realistic tool-pair transcript and assert (a) post-fallback pair-validity, (b) `compactionCount` does **not** advance on fallback, (c) `summarizerFallbacks` increments.

### Deletion list

- `Math.max(2, Math.ceil(messages.length * 0.2))` heuristic and the `slice(-keepCount)` line in [src/runtime/compaction.ts](../../../../src/runtime/compaction.ts#L106-L107).
- The inline `state.compactionCount++` in the catch at [src/runtime/compaction.ts](../../../../src/runtime/compaction.ts#L110).
- The catch-branch synthetic notice string can stay; it is now prepended by `flatten` when the kept-round set is empty.

### Test impact

- `compaction.test.ts` doubles in size; the new structure is per-helper (parse, select, top-level). All new tests are fast (no I/O, mocked router).
- `base.compaction.test.ts` gains one new scenario for the orphan repair and one for the counter behaviour; existing F06 and §E.1/§E.2 cases keep their shape.
- No production behaviour change on the success path beyond the counter semantics; agents that already passed compaction successfully still do.

### What this does *not* fix

- Provider fate-sharing on the primary model is only mitigated by the optional `fallbackSummarizerSpec`. If the operator doesn't configure it, the summarizer is still on the same model.
- A pathological transcript with one giant `ToolRound` (single tool-use whose result exceeds half the window) cannot be split. `selectKeptRounds` must still respect the round atomicity and return that single round; the stash mechanism at [src/runtime/stash.ts](../../../../src/runtime/stash.ts) is the right fix for oversized tool results, not compaction.

---

## 3. Recommendation

**Adopt B.**

A is a strict subset of B's repair guarantee while preserving an unjustified heuristic. The workspace guideline is architecture-first with no preservation of structures that no longer hold up, and the `slice(-keepCount)` is exactly such a structure — it was always wrong on tool-pair invariants, A merely papers over the wrong-by-construction case after the fact. B's round-parser also gives the rest of the runtime a vocabulary (`Round`) that maps directly onto how `BaseAgent.run` actually writes messages, removing the gap that produced the bug in the first place.

The honest-accounting and `fallbackSummarizerSpec` pieces are folded into B (not A) because they only make sense if the fallback is structurally trustworthy. Bolting them onto A keeps the rotten core.

Two concrete caveats for the implementer:

1. The repository memory note `saivage-v3-getrich-v2` is not relevant here; v2-on-v3 harness changes in [src/runtime/compaction.ts](../../../../src/runtime/compaction.ts) propagate to all three v2-using LXC containers (`saivage`, `diedrico`, `saivage-v3`) via their bind mounts on `/home/salva/g/ml/saivage`. The plan must restart all three or none.
2. The plan must not deliver `fallbackSummarizerSpec` as a default-on opaque change to `SaivageConfig`. It is opt-in; the round-parser orphan fix is the mandatory part.
