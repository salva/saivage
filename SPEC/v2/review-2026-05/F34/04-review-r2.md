# F34 r2 — Review

## Reviewer

GPT-5.5 (copilot)

## Documents reviewed

- [SPEC/v2/review-2026-05/_LOOP-CONVENTIONS.md](SPEC/v2/review-2026-05/_LOOP-CONVENTIONS.md)
- [SPEC/v2/review-2026-05/F34-plan-server-no-cache-or-read-gate.md](SPEC/v2/review-2026-05/F34-plan-server-no-cache-or-read-gate.md)
- [SPEC/v2/review-2026-05/F34/04-review-r1.md](SPEC/v2/review-2026-05/F34/04-review-r1.md)
- [SPEC/v2/review-2026-05/F34/01-analysis-r2.md](SPEC/v2/review-2026-05/F34/01-analysis-r2.md)
- [SPEC/v2/review-2026-05/F34/02-design-r2.md](SPEC/v2/review-2026-05/F34/02-design-r2.md)
- [SPEC/v2/review-2026-05/F34/03-plan-r2.md](SPEC/v2/review-2026-05/F34/03-plan-r2.md)
- [SPEC/v2/review-2026-05/F22/03-plan-r2.md](SPEC/v2/review-2026-05/F22/03-plan-r2.md)

Spot-checked: [src/mcp/plan-server.ts](src/mcp/plan-server.ts) and [src/store/documents.ts](src/store/documents.ts).

## Findings

### Analysis

Approved. The r2 analysis withdraws the r1 ordering claim and now treats F34 as post-F22 work. That matches F22's approved ordering contract, where F22 is explicitly before F34 because F34 depends on async `writeDoc` / `readDoc` in [SPEC/v2/review-2026-05/F22/03-plan-r2.md](SPEC/v2/review-2026-05/F22/03-plan-r2.md#L13). The analysis also correctly frames the current source defect: [src/mcp/plan-server.ts](src/mcp/plan-server.ts#L82-L108) re-reads plan/history documents for read operations, [src/mcp/plan-server.ts](src/mcp/plan-server.ts#L54) and [src/mcp/plan-server.ts](src/mcp/plan-server.ts#L354-L355) show the mutation-only queue, and [src/store/documents.ts](src/store/documents.ts#L6-L17) is still the pre-F22 synchronous document store that F22 will replace.

### Design

Approved. The first r1 blocker is fixed: the design now states that F34 lands after F22 and is rewritten against async `documents.ts`, async `PlanService` methods, and `PlanService.init()` in [SPEC/v2/review-2026-05/F34/02-design-r2.md](SPEC/v2/review-2026-05/F34/02-design-r2.md#L5). The second blocker is also fixed: Proposal B now uses one cache/disk commit model everywhere, namely build the new value, `await writeDoc(...)`, then assign to cache only on success in [SPEC/v2/review-2026-05/F34/02-design-r2.md](SPEC/v2/review-2026-05/F34/02-design-r2.md#L7) and, for `plan_complete_stage`, only after both plan and history writes resolve in [SPEC/v2/review-2026-05/F34/02-design-r2.md](SPEC/v2/review-2026-05/F34/02-design-r2.md#L75). The residual second-write disk drift is explicitly named as out of scope rather than hidden by a partial rollback scheme, which is acceptable for this issue.

### Plan

Approved. The plan is now executable only after F22: it has an explicit F22-merged precondition in [SPEC/v2/review-2026-05/F34/03-plan-r2.md](SPEC/v2/review-2026-05/F34/03-plan-r2.md#L17-L24), and its cross-issue ordering says F34 must happen after F22 while targeting the post-F22 async `documents.ts` / `PlanService.init()` shape in [SPEC/v2/review-2026-05/F34/03-plan-r2.md](SPEC/v2/review-2026-05/F34/03-plan-r2.md#L144). The implementation steps match the design's write-first/cache-commit-on-success model for single-document mutators in [SPEC/v2/review-2026-05/F34/03-plan-r2.md](SPEC/v2/review-2026-05/F34/03-plan-r2.md#L54) and for `plan_complete_stage` in [SPEC/v2/review-2026-05/F34/03-plan-r2.md](SPEC/v2/review-2026-05/F34/03-plan-r2.md#L62-L72). The test plan covers cache encapsulation, queued read/write ordering, init behavior, and both first-write and second-write failure paths.

## Required changes

None.

## Strengths

- The r2 documents directly address both r1 blockers without widening scope.
- Proposal B remains the right architectural fix: one in-process owner, no read-through fallback, no transition shim, and no new abstraction used only once.
- The failure semantics are now consistent enough for implementation handoff.

VERDICT: APPROVED