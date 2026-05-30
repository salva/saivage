# G07 — APPROVED

**Chosen proposal**: Proposal B (round-parser; per [02-design-r2.md](02-design-r2.md)) — replace `slice(-keepCount)` + post-hoc tool-pair repair with a `parseRounds(messages)` walk that builds atomic `TextRound` / `ToolRound` units and drops `DanglingHalf` tails by construction. `selectKeptRounds` selects complete rounds against the projected outbound token cost (system prompt + tool schemas + flattened kept rounds) with a safety margin and oversized-atomic case. Bounded fallback escape via `consecutiveFallbacks`, `maxConsecutiveFallbacks`, and `oversizedAtomicFallback`, with `isMaxCompactionsReached` extended accordingly. Runtime state exposes an optional `active_agents[*].compaction` object plumbed through `RuntimeTracker.agentCompactionUpdate` and `BaseAgentConfig.onCompactionUpdate`. Proposal A explicitly rejected on order/adjacency correctness grounds.

**Approved by**: GPT-5.5 (copilot) reviewer at round 2 — see [04-review-r2.md](04-review-r2.md). All six r1 changes addressed; the optional fallback-summarizer-spec plumbing is dropped from this round.

**Implementation pointer**: [03-plan-r2.md](03-plan-r2.md). Tests inspecting `BaseAgent.compactionState` follow the existing harness style in [src/agents/base.compaction.test.ts](../../../../src/agents/base.compaction.test.ts).

**Daemon impact**: Validation restarts are limited to `saivage-v3` (10.0.3.112); `saivage` (10.0.3.111) and `diedrico` (10.0.3.113) are operator-gated. `saivage-v3-getrich-v2` (10.0.3.170) unaffected.
