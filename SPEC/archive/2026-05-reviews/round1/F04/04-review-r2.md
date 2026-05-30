# F04 - Review (r2)

## Reviewer

GPT-5.5 (copilot)

## Documents reviewed

- [SPEC/v2/review-2026-05/F04-hardcoded-default-models.md](SPEC/v2/review-2026-05/F04-hardcoded-default-models.md)
- [SPEC/v2/review-2026-05/F04/04-review-r1.md](SPEC/v2/review-2026-05/F04/04-review-r1.md)
- [SPEC/v2/review-2026-05/F04/01-analysis-r2.md](SPEC/v2/review-2026-05/F04/01-analysis-r2.md)
- [SPEC/v2/review-2026-05/F04/02-design-r2.md](SPEC/v2/review-2026-05/F04/02-design-r2.md)
- [SPEC/v2/review-2026-05/F04/03-plan-r2.md](SPEC/v2/review-2026-05/F04/03-plan-r2.md)

## Findings

### Analysis

1. The r2 analysis now accounts for the r1-missed inline resolver fallback and CLI init seed. That resolves the main source-inventory objections from r1.

2. The new production-source sweep requirement is not executable as written. [SPEC/v2/review-2026-05/F04/01-analysis-r2.md](SPEC/v2/review-2026-05/F04/01-analysis-r2.md#L100) requires zero production `src/**/*.ts` matches for `openai-codex/gpt-5.3-codex`, but [src/agents/types.ts](src/agents/types.ts#L49) still contains that exact string in a production-source comment. This is not a runtime default, but it does make the proposed sweep fail unless the analysis/plan either removes/generalizes that comment or deliberately narrows the sweep contract.

### Design

1. Proposal A's `resolveSource` cleanup has a reachable path that is labelled unreachable. The design says deleting the final `return "hardcoded-default"` branch is safe because it becomes unreachable after the resolver throws on missing config ([SPEC/v2/review-2026-05/F04/02-design-r2.md](SPEC/v2/review-2026-05/F04/02-design-r2.md#L40)). But `resolvePreferredModels` can return `allowed_models` directly when no explicit `model` / `preferred_models` candidate exists ([src/routing/resolver.ts](src/routing/resolver.ts#L241)), while `resolveSource` only treats `rule.model`, `rule.preferredModels`, or `rule.profile` as routing-derived ([src/routing/resolver.ts](src/routing/resolver.ts#L289)). After the proposed edit, a valid rule like `{ allowed_models: ["provider/model"] }` can resolve a model and then hit the new terminal throw in `resolveSource`. The design needs to classify `allowedModels`-derived candidates as `"routing"` before removing `"hardcoded-default"`.

### Plan

1. Step 11 will fail on the current tree because of [src/agents/types.ts](src/agents/types.ts#L49). [SPEC/v2/review-2026-05/F04/03-plan-r2.md](SPEC/v2/review-2026-05/F04/03-plan-r2.md#L142-L144) must add an explicit edit for that production comment (for example, change the example to `provider/model`) or change the sweep/test contract so it only checks runtime defaults and fallbacks. The current text promises a failing validation step.

2. Step 6 needs an explicit resolver/test edit for `allowed_models`-only routing rules before deleting `"hardcoded-default"`. The plan currently tells the implementer to remove the final source branch and optionally add an `unreachable` throw ([SPEC/v2/review-2026-05/F04/03-plan-r2.md](SPEC/v2/review-2026-05/F04/03-plan-r2.md#L57-L59)), but that throw is reachable for the `allowed_models` path described above. Add a focused `src/routing/resolver.test.ts` case for an `allowed_models`-only role and assert `source: "routing"`.

## Required changes

1. Update analysis/design/plan so the production-source sweep is executable: either remove/generalize the existing production comment in [src/agents/types.ts](src/agents/types.ts#L49) or narrow the sweep and explain why comments/examples are out of scope.

2. Update the resolver design and plan to preserve `allowed_models`-only routing rules when removing `"hardcoded-default"`; add a focused resolver test that proves such a rule resolves with `source: "routing"`.

## Strengths

- r2 cleanly fixes the r1 blockers around the inline resolver literal, CLI init seed, disabled subsystem guards, and placeholder removal.
- The recommended Proposal A still matches the operator directive better than centralising defaults or redesigning the whole model taxonomy.

VERDICT: CHANGES_REQUESTED