# F08 - Review (r2)

## Reviewer

GPT-5.5 (copilot)

## Documents reviewed

- [SPEC/v2/review-2026-05/F08-legacy-runtime-state-mirror.md](SPEC/v2/review-2026-05/F08-legacy-runtime-state-mirror.md)
- [SPEC/v2/review-2026-05/F08/01-analysis-r1.md](SPEC/v2/review-2026-05/F08/01-analysis-r1.md) (retained)
- [SPEC/v2/review-2026-05/F08/02-design-r2.md](SPEC/v2/review-2026-05/F08/02-design-r2.md)
- [SPEC/v2/review-2026-05/F08/03-plan-r1.md](SPEC/v2/review-2026-05/F08/03-plan-r1.md) (retained)
- [SPEC/v2/review-2026-05/F08/04-review-r1.md](SPEC/v2/review-2026-05/F08/04-review-r1.md)

## Findings

### Analysis

The retained r1 analysis remains acceptable. It correctly scopes F08 to deletion of the legacy runtime-state mirror, identifies that the mirror has no production reader, and preserves the important constraints: no migration shim, no legacy cleanup shim, and no broadening into F22/F24.

### Design

The r1 substantive blocker is fixed: Proposal B now uses `tracker.setStatus("error")`, does not propose adding a `"failed"` runtime status, and describes the bootstrap fatal path as the existing error-state write.

However, the r2 design still has stale concrete file-line references in the changed Proposal B text. The design cites the runtime status enum as [src/types.ts](src/types.ts#L287-L288) in [SPEC/v2/review-2026-05/F08/02-design-r2.md](SPEC/v2/review-2026-05/F08/02-design-r2.md#L5) and [SPEC/v2/review-2026-05/F08/02-design-r2.md](SPEC/v2/review-2026-05/F08/02-design-r2.md#L59), but the current `RuntimeStateSchema.status` line is [src/types.ts](src/types.ts#L269-L270). It also cites the fatal-handler error-state write as [src/server/bootstrap.ts](src/server/bootstrap.ts#L687-L689) in [SPEC/v2/review-2026-05/F08/02-design-r2.md](SPEC/v2/review-2026-05/F08/02-design-r2.md#L5) and [SPEC/v2/review-2026-05/F08/02-design-r2.md](SPEC/v2/review-2026-05/F08/02-design-r2.md#L60), but the current `failState.status = "error"` and `writeRuntimeState(...)` lines are [src/server/bootstrap.ts](src/server/bootstrap.ts#L693-L695). The loop conventions make verified concrete file-line references mandatory, and reviewer policy lists wrong file-line refs as a rejection reason.

Proposal A remains the right recommendation once those references are corrected. The recommended scope is still clean, local, and aligned with the architecture-first rule to delete compatibility code outright.

### Plan

The retained r1 plan remains executable for Proposal A. It uses the right repo validation commands, removes the pinning mirror test instead of adding a permanent negative test, and keeps the work disjoint from F22/F24 and skills/memory areas. No plan changes are required for the stale Proposal B line references.

## Required changes

1. Revise [SPEC/v2/review-2026-05/F08/02-design-r2.md](SPEC/v2/review-2026-05/F08/02-design-r2.md): replace both `src/types.ts#L287-L288` references with `src/types.ts#L269-L270`, and replace both `src/server/bootstrap.ts#L687-L689` references with `src/server/bootstrap.ts#L693-L695`.

## Strengths

- The r1 semantic issue is fixed cleanly: Proposal B now matches the existing runtime-state schema and fatal-handler behavior.
- Proposal A remains a well-scoped dead-code deletion with no compatibility path, migration shim, or unrelated runtime refactor.
- The retained plan is narrow and runnable with Vitest-based validation.

VERDICT: CHANGES_REQUESTED