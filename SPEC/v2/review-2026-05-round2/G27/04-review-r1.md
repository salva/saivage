# G27 - Review r1

## Verdict

Option A is the right shape for this finding. The analysis correctly identifies the root bug: `plan_complete_stage` fabricates `started_at` from the same `now` value used for `completed_at` ([src/mcp/plan-server.ts](../../../../src/mcp/plan-server.ts#L214-L221)), while active `Stage` has no durable start timestamp ([src/types.ts](../../../../src/types.ts#L32-L43)). Recording start time on the active stage when it becomes current is a focused fix, and Option B's lifecycle log is not justified by the current consumers ([SPEC/v2/review-2026-05-round2/G27/02-design-r1.md](02-design-r1.md#L286-L295)).

Changes are still required before approval. The remaining issues are in the contract around `plan_set_stages`, deterministic validation, and G28/rollback coordination.

## Required Changes

1. **Resolve the `plan_set_stages` timestamp-preservation contract.** The design says the `plan_set_stages` test should keep `stg-1.started_at` unchanged when switching the current stage to `stg-2` ([SPEC/v2/review-2026-05-round2/G27/02-design-r1.md](02-design-r1.md#L123-L127)), but the plan says the same scenario should not preserve `stg-1.started_at` because the caller passed a fresh stage object ([SPEC/v2/review-2026-05-round2/G27/03-plan-r1.md](03-plan-r1.md#L86-L96)). That contradiction is implementation-significant because `plan_set_stages` is one of the two paths that can set `current_stage_id` today ([src/mcp/plan-server.ts](../../../../src/mcp/plan-server.ts#L115-L137)), and a normal planner rewrite could otherwise erase or reset an already recorded stage start.

   The next round should pick one contract and make analysis, design, plan, and tests agree. I recommend preserving existing `started_at` by stage id when `plan_set_stages` receives a stage without one, then stamping the selected `currentStageId` only if it still has no timestamp. That keeps `plan_set_stages` from silently shortening durations while still allowing an explicit caller-provided `started_at` to win.

2. **Make the timestamp tests deterministic.** The plan asks the updated completion test to assert `result.completed_stage.completed_at > capturedStartedAt` ([SPEC/v2/review-2026-05-round2/G27/03-plan-r1.md](03-plan-r1.md#L70-L76)), and the design repeats the strict ordering expectation ([SPEC/v2/review-2026-05-round2/G27/02-design-r1.md](02-design-r1.md#L128-L132)). Two independent `new Date().toISOString()` calls can still land in the same millisecond, especially inside a local Vitest process, making that assertion flaky. Do not weaken this to `>=`, because equality is exactly the bug G27 is removing. Use a deterministic clock in the tests, for example `vi.useFakeTimers()` with an explicit system-time advance between `plan_set_current` and `plan_complete_stage`, so the test proves the completed timestamp is distinct without depending on wall-clock timing.

3. **Tighten the G28 landing-order contingency.** The normal coordination is correct: G28 is approved and explicitly says G27 must land first ([SPEC/v2/review-2026-05-round2/G28/APPROVED.md](../G28/APPROVED.md#L7)), and G27's plan says G28 then embeds `StageSchema` with `started_at?: string` ([SPEC/v2/review-2026-05-round2/G27/03-plan-r1.md](03-plan-r1.md#L166-L174)). The inverted-order fallback is not aligned, though: the approved G28 plan says that if G28 lands first it should add `started_at: z.string()` to `StageSchema` ([SPEC/v2/review-2026-05-round2/G28/03-plan-r2.md](../G28/03-plan-r2.md#L5-L13), [SPEC/v2/review-2026-05-round2/G28/03-plan-r2.md](../G28/03-plan-r2.md#L287-L290)). A required `started_at` cannot be the placeholder for active stages that are created before they become current; it would reject ordinary queued stages.

   G27 r2 should either remove the inverted-order path and state that G27-first is mandatory, or explicitly say any G28-first emergency patch must add `started_at: z.string().optional()` and must amend the approved G28 contingency before the order is inverted.

4. **Make rollback dependency-aware once G28 has landed.** The rollback section is safe only for a standalone G27 deployment before G28 starts: revert the G27 change, rebuild, restart, and rely on the old `PlanSchema` stripping unknown `started_at` fields ([SPEC/v2/review-2026-05-round2/G27/03-plan-r1.md](03-plan-r1.md#L135-L158)). After G28 lands, G27 is no longer an isolated patch; G28's single-document `PlanDocument` embeds the G27-extended `StageSchema` and removes `plan-history.json` ([SPEC/v2/review-2026-05-round2/G28/03-plan-r2.md](../G28/03-plan-r2.md#L45-L66)). Reverting G27 alone after that point can leave the code and on-disk shape out of phase.

   Add an explicit rollback boundary: the documented G27-only rollback applies only before G28 is merged/deployed. If G28 has landed, rollback must be coordinated as a G28+G27 revert or a clearly ordered recovery that first restores the split-document model and only then removes the active-stage timestamp behavior. The live deployment section should carry the same boundary so operators do not perform a one-commit revert against a post-G28 daemon.

## Verified Good

- The issue analysis is correct that `plan_set_current` is the right start hook and that `plan_get_current_stage` should not become a write-on-read path ([SPEC/v2/review-2026-05-round2/G27/01-analysis-r1.md](01-analysis-r1.md#L71-L85)).
- Keeping `plan_init` at `current_stage_id: null` is the right invariant; it avoids inventing a start time during plan creation ([src/mcp/plan-server.ts](../../../../src/mcp/plan-server.ts#L273-L294), [SPEC/v2/review-2026-05-round2/G27/02-design-r1.md](02-design-r1.md#L56-L60)).
- The no-migration-shim stance is consistent with the project guideline: existing active stages without `started_at` should fail completion rather than receiving a fabricated fallback ([SPEC/v2/review-2026-05-round2/G27/02-design-r1.md](02-design-r1.md#L102-L112)).
- The validation sweep includes the right broad commands (`tsc`, targeted runtime/store tests, full Vitest, and build); it just needs the deterministic clock fix above ([SPEC/v2/review-2026-05-round2/G27/03-plan-r1.md](03-plan-r1.md#L118-L132)).

## Required Change Count

4

VERDICT: CHANGES_REQUESTED