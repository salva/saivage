# Round 1 Review — 02-architecture.md

## RUBRIC: A1-A3, A7-A10 PASS. A4, A5, A6 FAIL.

## REQUIRED CHANGES
1. Fix citation issues: `plan-server.ts#L51-L55` misses error codes; `#L113-L116` points at historyView not writeDoc; `#L67-L70` doesn't substantiate embedded-history claim. Some link labels use short text rather than full workspace-relative format.
2. Remove ordered Implementation Outline in §3.3 — that's doc-03 material. Restate as design properties/constraints.
3. Open-question Q5 disposition is wrong: I substituted a May-11 git question; the real Q5 in analysis is about `tracker.setCurrentStage`/`getCurrentStage` runtime tracker behavior.

## SUGGESTED
- Make duplicate-id edge case more explicit in §3.4.
- Clarify whether `STAGE_MISMATCH` is in shared PlanErrorCode vocabulary.

## VERDICT
CHANGES_REQUESTED
