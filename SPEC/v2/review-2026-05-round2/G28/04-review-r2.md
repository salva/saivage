# G28 — Review r2

## Findings

None. The r2 documents address all seven required changes from round 1.

## Verification

1. The full `PlanService` rewrite is now specified, not just `plan_complete_stage`: the plan collapses the two cache fields into `doc: PlanDocument | null`, defines `doc === null` behavior, and covers `plan_init`, all active-plan readers and mutators, `plan_complete_stage`, `plan_get_history`, and `plan_commit` with history preservation where applicable ([SPEC/v2/review-2026-05-round2/G28/03-plan-r2.md](SPEC/v2/review-2026-05-round2/G28/03-plan-r2.md#L65-L119)).

2. The new public projection types and combined-document invariants are defined. `ActivePlanView` and `PlanHistoryView` replace the old public `Plan` / `PlanHistory` names, and `PlanDocumentSchema` hard-fails duplicate ids, active/history overlap, and invalid `current_stage_id` at parse time ([SPEC/v2/review-2026-05-round2/G28/02-design-r2.md](SPEC/v2/review-2026-05-round2/G28/02-design-r2.md#L72-L130), [SPEC/v2/review-2026-05-round2/G28/03-plan-r2.md](SPEC/v2/review-2026-05-round2/G28/03-plan-r2.md#L15-L48)).

3. Stale-reference and deletion coverage is broad enough. The analysis enumerates source exports, direct readers, tests, specs, operator docs, and generated TypeDoc as affected surfaces, while the plan updates tests, specs, docs, `docs/api/`, and includes a repository-wide stale-reference sweep for `plan-history.json`, `planHistory`, and removed schema/type names ([SPEC/v2/review-2026-05-round2/G28/01-analysis-r2.md](SPEC/v2/review-2026-05-round2/G28/01-analysis-r2.md#L82-L119), [SPEC/v2/review-2026-05-round2/G28/03-plan-r2.md](SPEC/v2/review-2026-05-round2/G28/03-plan-r2.md#L136-L235)).

4. The G29 analysis is corrected. The r2 analysis now distinguishes queued `PlanService` MCP reads from the true inconsistent-reader surface, which is the direct file-reader paths, and the coordination says G29 should land after the single-document model is in place ([SPEC/v2/review-2026-05-round2/G28/01-analysis-r2.md](SPEC/v2/review-2026-05-round2/G28/01-analysis-r2.md#L55-L73), [SPEC/v2/review-2026-05-round2/G28/03-plan-r2.md](SPEC/v2/review-2026-05-round2/G28/03-plan-r2.md#L271-L278)).

5. The G27 coordination is now concrete. The preferred order is G27 -> G28 -> G29, with an explicit fallback if G28 must land first by adding the `started_at` schema placeholder in the G28 commit ([SPEC/v2/review-2026-05-round2/G28/03-plan-r2.md](SPEC/v2/review-2026-05-round2/G28/03-plan-r2.md#L5-L13), [SPEC/v2/review-2026-05-round2/G28/03-plan-r2.md](SPEC/v2/review-2026-05-round2/G28/03-plan-r2.md#L263-L270)).

6. The atomicity and regression tests are executable and broad. The plan explains how to mock the ESM `writeDoc` binding with `vi.mock`, then requires failure and success atomicity tests, history-preservation tests, cross-source `plan_get_stage`, no `plan-history.json` creation, one-path `plan_commit`, HTTP projection tests, and invariant hard-fail tests ([SPEC/v2/review-2026-05-round2/G28/03-plan-r2.md](SPEC/v2/review-2026-05-round2/G28/03-plan-r2.md#L158-L201)).

7. The live deployment instructions are operationally safe enough. The plan names the three in-scope hosts, stops `saivage.service`, backs up files without printing contents, performs a `jq` merge into the new single shape, validates with `PlanDocumentSchema`, restarts, verifies both API projections, explicitly excludes `saivage-v3-getrich-v2`, and defines abort criteria ([SPEC/v2/review-2026-05-round2/G28/03-plan-r2.md](SPEC/v2/review-2026-05-round2/G28/03-plan-r2.md#L280-L390)).

## Summary

Change count: 0 required follow-up changes.

VERDICT: APPROVED