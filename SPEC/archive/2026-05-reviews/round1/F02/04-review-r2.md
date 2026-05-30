# F02 — Review (r2)

## Reviewer

GPT-5.5 (copilot)

## Documents reviewed

- [SPEC/v2/review-2026-05/_LOOP-CONVENTIONS.md](SPEC/v2/review-2026-05/_LOOP-CONVENTIONS.md)
- [SPEC/v2/review-2026-05/F02-agent-roster-drift.md](SPEC/v2/review-2026-05/F02-agent-roster-drift.md)
- [SPEC/v2/review-2026-05/F02/04-review-r1.md](SPEC/v2/review-2026-05/F02/04-review-r1.md)
- [SPEC/v2/review-2026-05/F02/01-analysis-r1.md](SPEC/v2/review-2026-05/F02/01-analysis-r1.md)
- [SPEC/v2/review-2026-05/F02/02-design-r2.md](SPEC/v2/review-2026-05/F02/02-design-r2.md)
- [SPEC/v2/review-2026-05/F02/03-plan-r2.md](SPEC/v2/review-2026-05/F02/03-plan-r2.md)
- Source spot-checks: [src/agents/types.ts](src/agents/types.ts), [src/types.ts](src/types.ts), [src/runtime/dispatcher.ts](src/runtime/dispatcher.ts), [src/server/bootstrap.ts](src/server/bootstrap.ts), [src/agents/base.ts](src/agents/base.ts), [src/runtime/supervisor.ts](src/runtime/supervisor.ts), [src/runtime/self-check.ts](src/runtime/self-check.ts), [src/agents/conventions.ts](src/agents/conventions.ts), [src/config.ts](src/config.ts), [src/routing/resolver.ts](src/routing/resolver.ts), [src/providers/router.test.ts](src/providers/router.test.ts), [src/agents/planner.ts](src/agents/planner.ts), [src/agents/manager.ts](src/agents/manager.ts), [src/agents/designer.ts](src/agents/designer.ts)

## Findings

### Analysis

The retained r1 analysis is still the right authoritative inventory for F02. The live source still matches its central facts: `AgentRole` lists the eight non-designer roles in [src/agents/types.ts](src/agents/types.ts#L20-L28), task/report worker schemas list `coder`, `researcher`, `data_agent`, and `reviewer` in [src/types.ts](src/types.ts#L109) and [src/types.ts](src/types.ts#L160), runtime agent state lists the same eight live roles in [src/types.ts](src/types.ts#L269-L278), dispatcher tools expose the six child-spawnable roles in [src/runtime/dispatcher.ts](src/runtime/dispatcher.ts#L16-L33), and the resolver still contains the vestigial `executor` model key in [src/routing/resolver.ts](src/routing/resolver.ts#L3-L16). Keeping the analysis at r1 is acceptable because the r2 design/plan now carry the missing review-driven details forward.

### Design

The r2 design addresses the r1 prompt drift objection. It explicitly changes Proposal A so the prompt role list is rendered from `renderRosterSummary(role)` instead of leaving handwritten headers for F18, and it removes the old guarantee that handwritten prompts could not diverge from schemas in [SPEC/v2/review-2026-05/F02/02-design-r2.md](SPEC/v2/review-2026-05/F02/02-design-r2.md#L5). That closes the original planner omission verified in [src/agents/planner.ts](src/agents/planner.ts#L21-L29), while preserving F18 as a later extraction step.

The model-key semantics are now precise enough to implement. The accepted key set and removals are stated in [SPEC/v2/review-2026-05/F02/02-design-r2.md](SPEC/v2/review-2026-05/F02/02-design-r2.md#L6) and [SPEC/v2/review-2026-05/F02/02-design-r2.md](SPEC/v2/review-2026-05/F02/02-design-r2.md#L30-L31), and they match the current source split between the overly broad config schema in [src/config.ts](src/config.ts#L34-L46) and the actual role-to-model routing in [src/routing/resolver.ts](src/routing/resolver.ts#L3-L16). The r1 strict-Zod misstatement is corrected: stale keys are stripped rather than rejected.

The selected design no longer has a material conflict with F01. There is a small wording inconsistency where one scope bullet mentions rewriting the orphaned designer prompt in [SPEC/v2/review-2026-05/F02/02-design-r2.md](SPEC/v2/review-2026-05/F02/02-design-r2.md#L33), but the recommendation and plan clearly leave designer unlisted until F01 in [SPEC/v2/review-2026-05/F02/02-design-r2.md](SPEC/v2/review-2026-05/F02/02-design-r2.md#L157) and [SPEC/v2/review-2026-05/F02/03-plan-r2.md](SPEC/v2/review-2026-05/F02/03-plan-r2.md#L71). That is not a blocker because the actionable plan chooses the F01-safe interpretation.

### Plan

The plan is executable at the level expected for this review loop. It threads `DispatchableRole` through dispatcher and bootstrap as requested in [SPEC/v2/review-2026-05/F02/03-plan-r2.md](SPEC/v2/review-2026-05/F02/03-plan-r2.md#L32-L42) and [SPEC/v2/review-2026-05/F02/03-plan-r2.md](SPEC/v2/review-2026-05/F02/03-plan-r2.md#L128-L131), which fixes the r1 `strictFunctionTypes` issue against the current `ChildSpawner` shape in [src/runtime/dispatcher.ts](src/runtime/dispatcher.ts#L36-L39) and [src/server/bootstrap.ts](src/server/bootstrap.ts#L268-L378). The SPEC consistency promise is now backed by an explicit roster test in [SPEC/v2/review-2026-05/F02/03-plan-r2.md](SPEC/v2/review-2026-05/F02/03-plan-r2.md#L161).

The test strategy is sufficient. One minor note for the implementing engineer: the negative spawner assertion described in [SPEC/v2/review-2026-05/F02/03-plan-r2.md](SPEC/v2/review-2026-05/F02/03-plan-r2.md#L162) should not cast the value to `DispatchableRole`, because a type assertion defeats the negative check. This is not a required revision because production `tsc` still enforces the meaningful exhaustiveness condition through the narrowed switch and `assertExhaustive` path.

I ran `npm run typecheck` during review as a spot-check. The current baseline fails in pre-existing files, including designer's unmerged F01 state at [src/agents/designer.ts](src/agents/designer.ts#L85) and provider SDK call typing outside F02. Those baseline failures are outside this document set; they do not reopen the r1 F02 objections.

## Required changes

None.

## Strengths

- The r2 documents directly answer all four r1 required changes without introducing compatibility shims.
- Proposal A is now genuinely architectural: the schemas, dispatch tools, routing, prompt roster, conventions, self-check frequency, and supervisor priority all derive from one roster.
- The plan gives focused validation commands and adds the missing SPEC-to-roster drift test promised by the analysis.

VERDICT: APPROVED
