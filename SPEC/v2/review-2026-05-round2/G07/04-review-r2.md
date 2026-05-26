# G07 - Review r2

**Reviewed**: [01-analysis-r2.md](./01-analysis-r2.md), [02-design-r2.md](./02-design-r2.md), [03-plan-r2.md](./03-plan-r2.md)
**Previous review**: [04-review-r1.md](./04-review-r1.md)
**Verdict**: APPROVED
**Required change count**: 0

## Summary

Round 2 resolves the blocking issues from r1. The analysis now narrows the proven producer-side failure to the leading `tool_result` orphan created by raw suffix truncation, while keeping dangling assistant halves only as a defensive invariant. The design correctly rejects Proposal A on order/adjacency grounds and chooses the round-parser approach, with a budgeted selector and an explicit bounded escape for failed summarization.

The implementation plan is now grounded in the current code surfaces: [src/runtime/compaction.ts](../../../../src/runtime/compaction.ts), [src/agents/base.ts](../../../../src/agents/base.ts), [src/runtime/recovery.ts](../../../../src/runtime/recovery.ts), [src/types.ts](../../../../src/types.ts), and [src/server/bootstrap.ts](../../../../src/server/bootstrap.ts). It specifies the new compaction-state fields, runtime-state publication path, BaseAgent callback wiring, and test coverage required to prove the fallback no longer emits protocol-invalid tool transcripts or loops indefinitely.

## Required changes

None.

## R1 change checklist

1. **Bounded fallback escape path**: addressed with `consecutiveFallbacks`, `maxConsecutiveFallbacks`, `oversizedAtomicFallback`, and an extended `isMaxCompactionsReached` predicate.
2. **Real token-budget selector**: addressed by selecting complete rounds against projected outbound token cost, including system prompt and tool schemas, with a safety margin and oversized-atomic case.
3. **Trailing `tool_use` claim corrected**: addressed; the analysis now treats leading orphan `tool_result` as the single proven current failure mode.
4. **Runtime-state exposure specified**: addressed through an optional `active_agents[*].compaction` object, `RuntimeTracker.agentCompactionUpdate`, and `BaseAgentConfig.onCompactionUpdate`.
5. **Fallback summarizer config surface resolved**: addressed by dropping the optional alternate summarizer spec from this round.
6. **Deployment-validation contradiction fixed**: addressed; validation restarts only `saivage-v3`, avoids live provider-routing mutation, and leaves other containers alone pending operator approval.
7. **Proposal A rejection stated**: addressed; A is explicitly rejected because its Set-based repair is neither order-aware nor adjacency-aware.

## Non-blocking implementation notes

- The optional `compaction` schema object should be implemented with the semantics the plan now relies on: absent means the agent has not reported compaction state yet. Inner field defaults will not materialize an absent optional object unless the schema explicitly defaults the object itself; this is only a wording issue in the design, not a blocker.
- The selector's safety margin should leave room for the fallback notice and any survivor reinjection appended by `BaseAgent.compactWithReinjection`. The bounded fallback cap still prevents an infinite loop if survivor reinjection makes the post-compaction request too large, but the implementation tests should keep this edge in mind.
- Tests that inspect `BaseAgent.compactionState` will need to follow the existing harness style in [src/agents/base.compaction.test.ts](../../../../src/agents/base.compaction.test.ts), either by exposing a test helper on `TestAgent` or using the same controlled `any` access pattern already used for private compaction methods/messages.

## Approval rationale

The revised proposal fixes the root bug at the protocol boundary instead of filtering raw messages after the fact. It preserves complete adjacent tool rounds, drops dangling halves, measures kept context against the next request's real static overhead, and gives failed summarization an honest counter path separate from successful compaction. The runtime-state addition is concrete and testable, and the validation plan respects the workspace's container-operation constraints.

VERDICT: APPROVED