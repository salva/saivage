# F06 — Review (r4)

## Reviewer

GPT-5.5 (copilot)

## Documents reviewed

- [SPEC/v2/review-2026-05/F06-dispatcher-notes-sidechannel.md](SPEC/v2/review-2026-05/F06-dispatcher-notes-sidechannel.md)
- [SPEC/v2/review-2026-05/F06/04-review-r3.md](SPEC/v2/review-2026-05/F06/04-review-r3.md)
- [SPEC/v2/review-2026-05/F06/01-analysis-r1.md](SPEC/v2/review-2026-05/F06/01-analysis-r1.md) (retained)
- [SPEC/v2/review-2026-05/F06/02-design-r4.md](SPEC/v2/review-2026-05/F06/02-design-r4.md)
- [SPEC/v2/review-2026-05/F06/03-plan-r4.md](SPEC/v2/review-2026-05/F06/03-plan-r4.md)

## Findings

### Analysis

The retained r1 analysis remains sufficient. It correctly identifies the hidden dispatcher side-channel, the existing clean Planner injection path, the need for mid-loop delivery, the single acknowledgement lifecycle, permanent-note reinjection after compaction, and deletion of the old marker / `planner_pointer_pending` surface rather than preserving compatibility.

No analysis revision is required for r4 because the r3 blocker was in the compaction integration design and implementation plan, not in the problem statement.

### Design

r4 resolves the r3 blocker. The design now extends the existing `compactWithReinjection()` helper in place instead of replacing it with a direct `compactConversation` wrapper: [SPEC/v2/review-2026-05/F06/02-design-r4.md](SPEC/v2/review-2026-05/F06/02-design-r4.md#L95-L168). That matches the live `BaseAgent` structure: both compaction sites already call `compactWithReinjection()` ([src/agents/base.ts](src/agents/base.ts#L236), [src/agents/base.ts](src/agents/base.ts#L533)), and the helper itself owns the Planner pre-compaction hook, survivor-block append, and `replaceMessages` call ([src/agents/base.ts](src/agents/base.ts#L820-L850).

The channel-reset placement is now correct: `onContextReset()` is a tail addition after `replaceMessages`, while `drainChannels()` remains a separate pre-provider-call operation. That preserves FR-16 and FR-15 behaviour while ensuring notes delivered before a compaction become eligible for reinjection into the fresh context.

The r4 test list also addresses the previous coverage gap. It explicitly requires forced-compaction coverage for survivor reinjection, Planner pre-compaction hook retention, and repair-branch reinjection after context-overflow / orphaned-tool-result recovery: [SPEC/v2/review-2026-05/F06/02-design-r4.md](SPEC/v2/review-2026-05/F06/02-design-r4.md#L221-L241).

### Plan

The plan is executable and aligned with the revised design. Step 3 now instructs the implementer to extend `compactWithReinjection()` without moving or deleting the existing hook, `compactConversation`, survivor-block append, or `replaceMessages` responsibilities: [SPEC/v2/review-2026-05/F06/03-plan-r4.md](SPEC/v2/review-2026-05/F06/03-plan-r4.md#L83-L164). It also names the two drain insertion sites precisely: the top-of-`runLoop` path and the `callLLM` repair-compaction branch.

Step 7 adds the missing retention assertions from the r3 review: non-Planner survivor reinjection, Planner pre-compaction hook retention, and repair-branch survivor retention plus channel reinjection: [SPEC/v2/review-2026-05/F06/03-plan-r4.md](SPEC/v2/review-2026-05/F06/03-plan-r4.md#L208-L267). The validation commands are appropriate for this repo and use Vitest rather than Jest: [SPEC/v2/review-2026-05/F06/03-plan-r4.md](SPEC/v2/review-2026-05/F06/03-plan-r4.md#L269-L279).

## Required changes

None.

## Strengths

- The r4 revision preserves the existing compaction contract rather than rebuilding it.
- Proposal B remains the right architecture: one `InputChannel` path in `BaseAgent`, no dispatcher role gate, no tool-result mutation, and no compatibility shim for the removed marker.
- The implementation plan is concrete enough for an engineer to apply without re-litigating the lifecycle decisions.

VERDICT: APPROVED