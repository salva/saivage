# F34 r1 — Review

## Reviewer

GPT-5.5 (copilot)

## Documents reviewed

- [SPEC/v2/review-2026-05/_LOOP-CONVENTIONS.md](SPEC/v2/review-2026-05/_LOOP-CONVENTIONS.md)
- [SPEC/v2/review-2026-05/F34-plan-server-no-cache-or-read-gate.md](SPEC/v2/review-2026-05/F34-plan-server-no-cache-or-read-gate.md)
- [SPEC/v2/review-2026-05/F34/01-analysis-r1.md](SPEC/v2/review-2026-05/F34/01-analysis-r1.md)
- [SPEC/v2/review-2026-05/F34/02-design-r1.md](SPEC/v2/review-2026-05/F34/02-design-r1.md)
- [SPEC/v2/review-2026-05/F34/03-plan-r1.md](SPEC/v2/review-2026-05/F34/03-plan-r1.md)
- [SPEC/v2/review-2026-05/F22/APPROVED.md](SPEC/v2/review-2026-05/F22/APPROVED.md)
- [SPEC/v2/review-2026-05/F22/01-analysis-r2.md](SPEC/v2/review-2026-05/F22/01-analysis-r2.md)
- [SPEC/v2/review-2026-05/F22/02-design-r2.md](SPEC/v2/review-2026-05/F22/02-design-r2.md)
- [SPEC/v2/review-2026-05/F22/03-plan-r2.md](SPEC/v2/review-2026-05/F22/03-plan-r2.md)

Spot-checked: [src/mcp/plan-server.ts](src/mcp/plan-server.ts) and [src/store/documents.ts](src/store/documents.ts).

## Findings

### Analysis

The local code characterization is accurate: [src/mcp/plan-server.ts](src/mcp/plan-server.ts#L81-L113) reads plan/history documents directly for read tools, [src/mcp/plan-server.ts](src/mcp/plan-server.ts#L343-L350) queues only mutating tool calls, and [src/store/documents.ts](src/store/documents.ts#L30-L36) plus [src/store/documents.ts](src/store/documents.ts#L60-L96) are synchronous read/write primitives with atomic tmp+rename writes.

### Design

The F22/F34 ordering is factually inconsistent with the already-approved F22 docs. F34 says Proposal B is enabling/precondition work for F22 in [SPEC/v2/review-2026-05/F34/02-design-r1.md](SPEC/v2/review-2026-05/F34/02-design-r1.md#L96) and [SPEC/v2/review-2026-05/F34/02-design-r1.md](SPEC/v2/review-2026-05/F34/02-design-r1.md#L125), but approved F22 says the opposite: F34 must land after F22 in [SPEC/v2/review-2026-05/F22/01-analysis-r2.md](SPEC/v2/review-2026-05/F22/01-analysis-r2.md#L202), [SPEC/v2/review-2026-05/F22/02-design-r2.md](SPEC/v2/review-2026-05/F22/02-design-r2.md#L149), and [SPEC/v2/review-2026-05/F22/03-plan-r2.md](SPEC/v2/review-2026-05/F22/03-plan-r2.md#L11-L13). This is not just wording: the approved F22 plan changes PlanService and document-store signatures, including async public methods and `PlanService.init()` in [SPEC/v2/review-2026-05/F22/03-plan-r2.md](SPEC/v2/review-2026-05/F22/03-plan-r2.md#L153-L162), while F34's implementation plan is written against the current synchronous shape.

Proposal B also contains an internal cache-commit ordering contradiction. It says `plan_complete_stage` commits the cache before any disk write in [SPEC/v2/review-2026-05/F34/02-design-r1.md](SPEC/v2/review-2026-05/F34/02-design-r1.md#L64), but the same design says cache assignment happens only after `writeDoc` succeeds in [SPEC/v2/review-2026-05/F34/02-design-r1.md](SPEC/v2/review-2026-05/F34/02-design-r1.md#L79), and the plan follows write-first semantics in [SPEC/v2/review-2026-05/F34/03-plan-r1.md](SPEC/v2/review-2026-05/F34/03-plan-r1.md#L30-L34). The implementation needs one executable failure model.

### Plan

The plan's explicit ordering statement, [SPEC/v2/review-2026-05/F34/03-plan-r1.md](SPEC/v2/review-2026-05/F34/03-plan-r1.md#L105), conflicts with F22's approved ordering and therefore is not handoff-ready. If F34 is revised to run after F22, the edit steps and tests need to target the post-F22 async `documents.ts` / `PlanService` shape rather than the current synchronous methods.

## Required changes

1. Reconcile the cross-issue ordering with approved F22. Either revise F34 to run after F22 and update the design/plan for F22's async document-store and `PlanService.init()` shape, or explicitly state that F22's approved docs must be revised before F34 can proceed. The current `F34 before F22` claim cannot stand beside approved F22's `F22 before F34` contract.
2. Make Proposal B's cache/disk commit ordering consistent across design and plan, especially for `plan_complete_stage`. Pick the intended sequence and describe the write-failure behavior without contradicting the implementation steps.

## Strengths

- The issue is real and well scoped: the read-per-operation pattern and mutation-only queueing are verified against the current code.
- The proposal set is useful, and the recommendation for a single in-process cache fits the single-owner service model.
- The test strategy covers cache encapsulation, read-after-write behavior, and the affected PlanService module.

VERDICT: CHANGES_REQUESTED