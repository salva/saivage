# F04 - Review (r3)

## Reviewer

GPT-5.5 (copilot)

## Documents reviewed

- [SPEC/v2/review-2026-05/F04-hardcoded-default-models.md](SPEC/v2/review-2026-05/F04-hardcoded-default-models.md)
- [SPEC/v2/review-2026-05/F04/04-review-r2.md](SPEC/v2/review-2026-05/F04/04-review-r2.md)
- [SPEC/v2/review-2026-05/F04/01-analysis-r3.md](SPEC/v2/review-2026-05/F04/01-analysis-r3.md)
- [SPEC/v2/review-2026-05/F04/02-design-r3.md](SPEC/v2/review-2026-05/F04/02-design-r3.md)
- [SPEC/v2/review-2026-05/F04/03-plan-r3.md](SPEC/v2/review-2026-05/F04/03-plan-r3.md)

## Findings

### Analysis

1. The r3 analysis resolves the r2 production-source sweep blocker. It now treats the [src/agents/types.ts](src/agents/types.ts) `AgentContext.modelSpec` JSDoc example as an in-scope source literal to rewrite, so the proposed `rg ... | grep -v '\.test\.ts'` sweep is executable rather than false-positive-prone.

2. The r3 analysis also resolves the r2 resolver-source blocker. It correctly identifies that `resolvePreferredModels` can return an `allowed_models`-only candidate, and it makes `rule.allowedModels?.length` part of the post-F04 routing-source contract before removing `"hardcoded-default"`.

3. Spot checks against [src/config.ts](src/config.ts), [src/security/prompt-injection-cop.ts](src/security/prompt-injection-cop.ts), [src/runtime/supervisor.ts](src/runtime/supervisor.ts), [src/providers/router.ts](src/providers/router.ts), [src/routing/resolver.ts](src/routing/resolver.ts), [src/server/cli.ts](src/server/cli.ts), and [src/agents/types.ts](src/agents/types.ts) found the cited hardcoded literals and resolver behavior consistent with the analysis.

### Design

1. Proposal A now includes both r2-required design corrections: rewrite the production JSDoc model example and classify `allowed_models`-only rules as `source: "routing"` before deleting the hardcoded source branch. That keeps the strict no-production-model-literal sweep while preserving an existing valid routing shape.

2. The recommendation remains aligned with the operator directive: remove built-in model defaults and fail loudly when required model configuration is absent. Proposal B and Proposal Z are correctly kept out of the recommended F04 scope.

### Plan

1. Step 6 now sequences the resolver edits correctly: classify `allowedModels` first, then remove the terminal `"hardcoded-default"` branch. The added resolver test for an `allowed_models`-only rule directly covers the r2 regression risk.

2. Step 6b makes the source sweep achievable by changing the existing `AgentContext.modelSpec` example to `"provider/model"`. This is a small edit to an in-scope existing comment, not a new comment or compatibility shim.

3. Step 11's manual and executable sweep now has a credible zero-match target for production TypeScript files. Test literals remain allowed as fixtures, matching the analysis constraint.

## Required changes

None.

## Strengths

- r3 fixes both r2 blockers without widening the issue into a broader model-taxonomy redesign.
- The plan is concrete enough for an implementer to execute and includes focused regression coverage for the subtle `allowed_models` path.
- The strict production-source sweep is simple and enforceable after the JSDoc rewrite.

VERDICT: APPROVED