# F08 - Review (r3)

## Reviewer

GPT-5.5 (copilot)

## Documents reviewed

- [SPEC/v2/review-2026-05/F08-legacy-runtime-state-mirror.md](SPEC/v2/review-2026-05/F08-legacy-runtime-state-mirror.md)
- [SPEC/v2/review-2026-05/F08/01-analysis-r1.md](SPEC/v2/review-2026-05/F08/01-analysis-r1.md) (retained)
- [SPEC/v2/review-2026-05/F08/02-design-r3.md](SPEC/v2/review-2026-05/F08/02-design-r3.md)
- [SPEC/v2/review-2026-05/F08/03-plan-r1.md](SPEC/v2/review-2026-05/F08/03-plan-r1.md) (retained)
- [SPEC/v2/review-2026-05/F08/04-review-r2.md](SPEC/v2/review-2026-05/F08/04-review-r2.md)

## Findings

### Analysis

The retained r1 analysis is still directionally correct, but its line references are not all correct against the current source. Because this review was explicitly asked to confirm line refs, these stale references must be fixed before approval:

- [SPEC/v2/review-2026-05/F08/01-analysis-r1.md](SPEC/v2/review-2026-05/F08/01-analysis-r1.md#L20) cites [src/store/project.ts](src/store/project.ts#L74-L76) for `tmp/state/` runtime paths, but those lines are currently `stages`, `notes`, and `inspections`. The current runtime-state/shutdown path lines are [src/store/project.ts](src/store/project.ts#L82-L84).
- [SPEC/v2/review-2026-05/F08/01-analysis-r1.md](SPEC/v2/review-2026-05/F08/01-analysis-r1.md#L38) cites [src/server/bootstrap.ts](src/server/bootstrap.ts#L688) for the failure-state write. Current line 688 is the fatal log call; the failure-state block is [src/server/bootstrap.ts](src/server/bootstrap.ts#L693-L695).
- [SPEC/v2/review-2026-05/F08/01-analysis-r1.md](SPEC/v2/review-2026-05/F08/01-analysis-r1.md#L39) cites [src/runtime/recovery.ts](src/runtime/recovery.ts#L402) for `RuntimeTracker.flush()`'s hot-path write. Current line 402 is the `active_agents` field; the write call is [src/runtime/recovery.ts](src/runtime/recovery.ts#L407), or the whole flush body is [src/runtime/recovery.ts](src/runtime/recovery.ts#L397-L407).
- [SPEC/v2/review-2026-05/F08/01-analysis-r1.md](SPEC/v2/review-2026-05/F08/01-analysis-r1.md#L48) and [SPEC/v2/review-2026-05/F08/01-analysis-r1.md](SPEC/v2/review-2026-05/F08/01-analysis-r1.md#L55) cite [src/server/server.ts](src/server/server.ts#L475-L498) as a runtime-state endpoint and call it `/api/status`. Current line 475 is inside the file-read failure path; the current runtime-state readers are [src/server/server.ts](src/server/server.ts#L127-L131), [src/server/server.ts](src/server/server.ts#L179-L183), and [src/server/server.ts](src/server/server.ts#L481-L505). The web UI currently calls `/api/state`, not `/api/status`, as shown by [web/src/components/StatusPanel.vue](web/src/components/StatusPanel.vue#L58).
- [SPEC/v2/review-2026-05/F08/01-analysis-r1.md](SPEC/v2/review-2026-05/F08/01-analysis-r1.md#L50) cites [src/agents/chat.ts](src/agents/chat.ts#L347) for chat status. Current line 347 is unrelated note command text; the status command reads runtime state at [src/agents/chat.ts](src/agents/chat.ts#L391-L393).

These are factual line-reference errors under the loop conventions, not style preferences. No new semantic objection is raised against the analysis's conclusion.

### Design

The r2 blocker is fixed. The revised Proposal B references now correctly identify `RuntimeStateSchema.status` at [src/types.ts](src/types.ts#L269-L270) and the fatal-handler error-state write at [src/server/bootstrap.ts](src/server/bootstrap.ts#L693-L695). The design no longer proposes a new `"failed"` runtime status, and it correctly keeps Proposal A as the recommendation.

The other checked r3 design references also line up with current source: the mirror writer/helper at [src/runtime/recovery.ts](src/runtime/recovery.ts#L297-L315), the pinning mirror test at [src/runtime/runtime.test.ts](src/runtime/runtime.test.ts#L1026-L1043), the planner prompt bullet at [src/agents/planner.ts](src/agents/planner.ts#L47), the direct bootstrap writes at [src/server/bootstrap.ts](src/server/bootstrap.ts#L199), [src/server/bootstrap.ts](src/server/bootstrap.ts#L235), and [src/server/bootstrap.ts](src/server/bootstrap.ts#L693-L695), and the test import/call sites at [src/runtime/runtime.test.ts](src/runtime/runtime.test.ts#L46), [src/runtime/runtime.test.ts](src/runtime/runtime.test.ts#L1114), [src/runtime/runtime.test.ts](src/runtime/runtime.test.ts#L1203), and [src/runtime/runtime.test.ts](src/runtime/runtime.test.ts#L1246).

### Plan

The retained r1 plan remains executable for Proposal A. Its edit targets still match current source, including [src/runtime/recovery.ts](src/runtime/recovery.ts#L297-L315), [src/runtime/runtime.test.ts](src/runtime/runtime.test.ts#L1026-L1043), [src/agents/planner.ts](src/agents/planner.ts#L47), and the shutdown-handoff test fixture/write range at [src/runtime/shutdown-handoff.test.ts](src/runtime/shutdown-handoff.test.ts#L55-L67). The validation commands use the repository's Vitest conventions and no plan change is required for the corrected design.

## Required changes

1. Create a revised analysis file, [SPEC/v2/review-2026-05/F08/01-analysis-r2.md](SPEC/v2/review-2026-05/F08/01-analysis-r2.md), correcting the stale references listed above. Keep the analysis semantics unchanged unless a corrected reference forces a wording adjustment, such as replacing `/api/status` with the current `/api/state` web/API path.

## Strengths

- The exact r2 design blocker is fixed and independently verified.
- Proposal A remains a clean dead-code deletion with no compatibility shim, migration path, or unrelated runtime refactor.
- The plan remains narrow, testable, and aligned with the architecture-first project guidelines.

VERDICT: CHANGES_REQUESTED
