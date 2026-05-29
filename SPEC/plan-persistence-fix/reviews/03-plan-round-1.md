# Round 1 Review — 03-plan.md

## RUBRIC: P1, P2, P5, P7 PASS. P3, P4, P6, P8, P9, P10 FAIL.

## REQUIRED CHANGES (substantial)
1. Stage B claims to write through `PlanService` but `writeDoc` is private and no public history-append method exists. Either (a) add a public `plan_append_history(stage: CompletedStage)` method on PlanService, or (b) redesign script to write `plan.json` directly with atomic tmp+rename (importing the same helper PlanService uses) — pick (a) for symmetry with architecture §3.1.
2. Backfill script under `saivage/scripts/` is NOT covered by tsconfig.json (which includes only `src/**/*.ts`) nor by package.json lint. Either place it under `src/scripts/` OR update tsconfig + package.json lint glob in the plan, and document it.
3. Don't defer behavioral/integration tests. Architecture §2.5 and §4.5 require them. Stage A must add prompt behavior + self-correction tests; Stage C must add scripted-planner integration tests (happy path + rejection cases).
4. Citation hygiene: remove `file:///memories/...` links; replace with workspace-relative or omit. Add real `#Lx-Ly` anchors where labels claim ranges (currently several `L24-L29` labels link only to file).
5. Stage A verification grep checks `plan_add_stage|plan_set_current|run_manager` but acceptance text says `plan_get|plan_get_history`. Fix inconsistency. Also dispatch-gate `grep "[dispatch-gate]"` is a regex char class — use `grep -F` or escape.
6. Acceptance Criterion 4 says "zero or a small bounded number" — too vague. Specify exact bound and time window.

## SUGGESTED
- Use `curl -sf http://127.0.0.1:8080/api/plan` inside LXC.
- Add `jq` validation after rollback restore before restart.
- Clarify whether `plan-history.json` is legacy or maintained.

## VERDICT
CHANGES_REQUESTED
