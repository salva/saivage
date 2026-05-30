# G09 - Review r2

Reviewed:
- [SPEC/v2/review-2026-05-round2/G09-planner-plan-complete-text-protocol.md](SPEC/v2/review-2026-05-round2/G09-planner-plan-complete-text-protocol.md#L1-L59)
- [SPEC/v2/review-2026-05-round2/G09/01-analysis-r2.md](SPEC/v2/review-2026-05-round2/G09/01-analysis-r2.md#L1-L126)
- [SPEC/v2/review-2026-05-round2/G09/02-design-r2.md](SPEC/v2/review-2026-05-round2/G09/02-design-r2.md#L1-L272)
- [SPEC/v2/review-2026-05-round2/G09/03-plan-r2.md](SPEC/v2/review-2026-05-round2/G09/03-plan-r2.md#L1-L408)
- [SPEC/v2/review-2026-05-round2/G09/04-review-r1.md](SPEC/v2/review-2026-05-round2/G09/04-review-r1.md#L1-L78)

## Summary

R2 fixes the main R1 direction: it rejects the regex fallback, makes completion a terminal tool-call path, adds a tagged completion shape for recovery, types `plan_done` as a union, and corrects the focused Vitest command to real test files. The remaining blockers are narrower, but they affect executability and the shape of the protocol.

## Required changes

1. Make `AgentContext.planService` part of the actual completion path, or remove it.

   R2 promises explicit `PlanService` wiring through `AgentContext` in [SPEC/v2/review-2026-05-round2/G09/02-design-r2.md](SPEC/v2/review-2026-05-round2/G09/02-design-r2.md#L13) and [SPEC/v2/review-2026-05-round2/G09/02-design-r2.md](SPEC/v2/review-2026-05-round2/G09/02-design-r2.md#L84-L110). That matches the live source shape: the canonical service is created and registered through one closure in [src/server/bootstrap.ts](src/server/bootstrap.ts#L155-L169), and current `AgentContext` has only `mcpRuntime`, not `planService`, in [src/agents/types.ts](src/agents/types.ts#L30-L38).

   But R2 then splits the protocol. It adds `pendingCompletion` and `consumePendingCompletion()` in [SPEC/v2/review-2026-05-round2/G09/03-plan-r2.md](SPEC/v2/review-2026-05-round2/G09/03-plan-r2.md#L17-L36), and tests that the field is consumed in [SPEC/v2/review-2026-05-round2/G09/03-plan-r2.md](SPEC/v2/review-2026-05-round2/G09/03-plan-r2.md#L326-L333). The actual terminal hook, however, ignores `ctx.planService` and returns the reason directly from `tc.input` in [SPEC/v2/review-2026-05-round2/G09/03-plan-r2.md](SPEC/v2/review-2026-05-round2/G09/03-plan-r2.md#L153-L164). The design even says the hook does not call `consumePendingCompletion()` in [SPEC/v2/review-2026-05-round2/G09/02-design-r2.md](SPEC/v2/review-2026-05-round2/G09/02-design-r2.md#L108-L110).

   That leaves stale in-memory completion state after the planner exits. In continuous-improvement mode, the next planner cycle keeps using the same `PlanService`; a later `plan_done` can return `recorded: false` because the old pending completion was never cleared, while the planner still terminates because it trusts the tool input. It also turns `planService: runtime.planService` into global context churn that no agent actually reads.

   Required fix: choose one protocol surface. Preferred: keep the R2 `AgentContext.planService` design, and after a successful `plan_done` dispatch, read and clear `this.ctx.planService.consumePendingCompletion()` before returning `{ completion: "plan_done", summary }`. Add a planner test proving terminal success consumes the pending completion and a later planner cycle can record a fresh completion. If the control path is intentionally based only on the dispatched tool call, then delete `pendingCompletion`, `consumePendingCompletion`, `AgentContext.planService`, and the PlanService consumption tests from the proposal.

2. Make terminal `plan_done` exclusive and preserve abort precedence.

   The proposed hook terminates on the first non-error `plan_done` it sees in [SPEC/v2/review-2026-05-round2/G09/02-design-r2.md](SPEC/v2/review-2026-05-round2/G09/02-design-r2.md#L55-L62) and [SPEC/v2/review-2026-05-round2/G09/03-plan-r2.md](SPEC/v2/review-2026-05-round2/G09/03-plan-r2.md#L157-L164). The insertion point is also before the existing aborted check according to [SPEC/v2/review-2026-05-round2/G09/03-plan-r2.md](SPEC/v2/review-2026-05-round2/G09/03-plan-r2.md#L126-L137), while the live `runLoop()` currently returns abort after pushing tool results in [src/agents/base.ts](src/agents/base.ts#L327-L346).

   This is too permissive for a terminal protocol. The dispatcher separates local calls from dispatch calls and appends result buckets in [src/runtime/dispatcher.ts](src/runtime/dispatcher.ts#L80-L124), so a single model response can contain `plan_add_stage` plus `plan_done`, or `run_manager` plus `plan_done`, and the hook can still complete as long as the `plan_done` result is non-error. That accepts a turn that both schedules or runs more work and declares the project complete. It is the same family of fragile model-protocol trust that this finding is trying to remove.

   Required fix: specify that abort wins before terminal completion, match the `plan_done` result by `toolUseId`, and terminate only when the tool batch is exactly one successful `plan_done` call. If any sibling tool call appears, or any sibling result is an error/abort, the planner must not complete; it should continue through the existing nudge/recovery path. Add focused tests for `plan_done` plus another plan tool and for aborted/error dispatch results.

3. Reconcile the `PLAN_COMPLETE` grep with the required negative test.

   R2 correctly adds a regression test proving bare `PLAN_COMPLETE` text does not terminate the planner in [SPEC/v2/review-2026-05-round2/G09/03-plan-r2.md](SPEC/v2/review-2026-05-round2/G09/03-plan-r2.md#L317-L319), and the current test file already contains the old literal success token in [src/agents/planner.nudge.test.ts](src/agents/planner.nudge.test.ts#L81-L92). But the validation contract says `grep -rn PLAN_COMPLETE src/ prompts/` must return zero in [SPEC/v2/review-2026-05-round2/G09/03-plan-r2.md](SPEC/v2/review-2026-05-round2/G09/03-plan-r2.md#L368-L378).

   Those requirements cannot both be true if the negative test keeps the literal string, test name, or comments. The implementation would fail its own validation even after the source protocol is correctly removed.

   Required fix: make the grep production-scoped, for example excluding test files, and explicitly allow the old token only in regression fixtures; or construct the token in the test without a contiguous literal and state that choice in the plan. The validation command must be executable as written.

## Notes

R2 otherwise addresses the R1 blockers: the runLoop terminal path is explicit, `plan_done` has a union return type, the MCP error path is covered, `hasSummary` is replaced by a tagged completion guard, and rollback no longer restores a regex fallback. After the three fixes above, the proposal should be ready to approve.

VERDICT: CHANGES_REQUESTED