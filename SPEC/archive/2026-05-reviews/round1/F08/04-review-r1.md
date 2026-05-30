# F08 — Review (r1)

## Reviewer

GPT-5.5 (copilot)

## Documents reviewed

- [SPEC/v2/review-2026-05/F08-legacy-runtime-state-mirror.md](SPEC/v2/review-2026-05/F08-legacy-runtime-state-mirror.md)
- [SPEC/v2/review-2026-05/F08/01-analysis-r1.md](SPEC/v2/review-2026-05/F08/01-analysis-r1.md)
- [SPEC/v2/review-2026-05/F08/02-design-r1.md](SPEC/v2/review-2026-05/F08/02-design-r1.md)
- [SPEC/v2/review-2026-05/F08/03-plan-r1.md](SPEC/v2/review-2026-05/F08/03-plan-r1.md)

## Findings

### Analysis

The analysis is accurate and complete enough for Proposal A. It correctly identifies the dual-write in [src/runtime/recovery.ts](src/runtime/recovery.ts#L297-L315), the single test that pins the legacy mirror in [src/runtime/runtime.test.ts](src/runtime/runtime.test.ts#L1026-L1043), and the planner-prompt mention in [src/agents/planner.ts](src/agents/planner.ts#L47). The no-live-reader claim also holds: a production TypeScript search for `runtime-state.json` only finds the writer/helper and the planner prompt, plus the test assertion.

The `documents.ts` spot-check supports the cost model: `writeDoc` performs the synchronous data write, file fsync, rename, and parent-directory fsync in [src/store/documents.ts](src/store/documents.ts#L66-L91). The `dispatcher.ts` spot-check found no dependency on either runtime-state path, so F08 remains cleanly scoped to runtime recovery/state persistence rather than the tool-call dispatcher.

### Design

Proposal A is the right recommendation for this low-severity dead-code issue. It removes the mirror, the helper, the pinning test, and the prompt sentence without adding a compatibility shim or broadening into F22/F24 territory.

Proposal B has one factual error that should be fixed before approval even though it is not the recommended proposal. It says the fatal write should become `tracker.setStatus("failed")` and suggests that introducing `"failed"` may require a `RuntimeStateSchema` enum extension [SPEC/v2/review-2026-05/F08/02-design-r1.md](SPEC/v2/review-2026-05/F08/02-design-r1.md#L50). The current runtime-state schema already uses `"error"`, not `"failed"`, for fatal runtime state [src/types.ts](src/types.ts#L287-L288), and the existing fatal handler writes exactly that value [src/server/bootstrap.ts](src/server/bootstrap.ts#L687-L688). As written, Proposal B could send a future implementer toward an unnecessary schema change and the wrong status value.

### Plan

The plan is executable for Proposal A. The edit steps are appropriately narrow, the validation commands use Vitest rather than Jest, and the grep checks are useful for catching an incomplete deletion. No plan revision is required unless the writer chooses to mention Proposal B in the plan, which it currently does not.

## Required changes

1. Revise Proposal B in [SPEC/v2/review-2026-05/F08/02-design-r1.md](SPEC/v2/review-2026-05/F08/02-design-r1.md): replace `tracker.setStatus("failed")` with `tracker.setStatus("error")`, remove the suggested `"failed"` schema-extension decision, and describe the [src/server/bootstrap.ts](src/server/bootstrap.ts#L687-L688) write as the fatal-handler error-state write rather than a distinct `"failed"` runtime status. Analysis and plan can remain at r1 unless the writer wants to make the same wording correction there for consistency.

## Strengths

- Proposal A honors the project rule to delete compatibility code outright, with no migration or fallback path.
- The plan correctly removes the mirror assertion instead of adding a permanent negative test.
- The cross-issue notes keep F08 disjoint from the broader async document-store and shutdown-handoff work.

VERDICT: CHANGES_REQUESTED