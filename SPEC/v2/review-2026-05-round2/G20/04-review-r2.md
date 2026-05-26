# G20 - Review r2

Requested changes: 0

## Summary

All six required changes from [SPEC/v2/review-2026-05-round2/G20/04-review-r1.md](04-review-r1.md#L8-L75) are addressed in the r2 analysis, design, and implementation plan. The selected Design A path is now implementation-ready as a focused dead-code deletion, with the larger `OpenAIProvider` rename/fold and `openai` package removal tracked as explicit follow-ups rather than implied benefits.

## Required-change verification

1. **The missed capability test file is now handled.** [SPEC/v2/review-2026-05-round2/G20/01-analysis-r2.md](01-analysis-r2.md#L68-L96) identifies [src/providers/model-capabilities.test.ts](../../../../src/providers/model-capabilities.test.ts#L43-L93) as a dual-purpose test file, keeps the live suites, and removes only the dead direct-class cases. [SPEC/v2/review-2026-05-round2/G20/02-design-r2.md](02-design-r2.md#L32-L48) and [SPEC/v2/review-2026-05-round2/G20/03-plan-r2.md](03-plan-r2.md#L62-L83) give the exact imports and `it` blocks to delete, including the corrected test-impact delta.

2. **The false B.2 dependency claim is corrected.** [SPEC/v2/review-2026-05-round2/G20/02-design-r2.md](02-design-r2.md#L147-L169) now states that folding local providers into PiAi does not remove the `openai` package on its own, and grounds that correction in [src/providers/copilot.ts](../../../../src/providers/copilot.ts#L214-L280). The separate package-removal follow-up is explicit in [SPEC/v2/review-2026-05-round2/G20/02-design-r2.md](02-design-r2.md#L262-L272) and [SPEC/v2/review-2026-05-round2/G20/03-plan-r2.md](03-plan-r2.md#L303-L311).

3. **The architecture decision is no longer vague.** [SPEC/v2/review-2026-05-round2/G20/02-design-r2.md](02-design-r2.md#L214-L272) recommends Design A for G20, explains why the narrower deletion satisfies the architecture-first rule for this finding, and records concrete follow-up acceptance criteria for renaming or folding `OpenAIProvider` and later dropping the `openai` dependency.

4. **The useless `--version` smoke is replaced.** [SPEC/v2/review-2026-05-round2/G20/03-plan-r2.md](03-plan-r2.md#L176-L211) replaces the Commander-only `--version` check with a ModelRouter construction smoke that loads real config, calls `listProviders()`, and asserts `openrouter` is absent from the registered provider set.

5. **The active `openrouter` test vocabulary is audited.** [SPEC/v2/review-2026-05-round2/G20/01-analysis-r2.md](01-analysis-r2.md#L99-L146) explains why [src/providers/types.test.ts](../../../../src/providers/types.test.ts#L11-L13) remains functionally provider-agnostic but should stop using `openrouter` as the nested-model example. [SPEC/v2/review-2026-05-round2/G20/02-design-r2.md](02-design-r2.md#L50-L56) and [SPEC/v2/review-2026-05-round2/G20/03-plan-r2.md](03-plan-r2.md#L86-L94) specify the replacement literal and assertions.

6. **Live validation now covers every affected daemon host.** [SPEC/v2/review-2026-05-round2/G20/03-plan-r2.md](03-plan-r2.md#L213-L232) lists post-build health checks for `saivage`, `saivage-v3`, and `diedrico`, while explicitly making restarts operator-gated when deployment is not authorized. The rollback section repeats the same three-host bind-mount and probe set in [SPEC/v2/review-2026-05-round2/G20/03-plan-r2.md](03-plan-r2.md#L262-L275).

## Blocking findings

None.

## Residual risk

This review validates the writer documents, not a code implementation. The plan's proposed compile, unit, lint, build, router-construction smoke, and operator-gated live health checks remain required once the deletion is implemented.

VERDICT: APPROVED