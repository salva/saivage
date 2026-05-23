# F09 Review — Round 1

## Reviewer
GPT-5.5 (copilot)

## Documents reviewed
- 01-analysis-r1.md
- 02-design-r1.md
- 03-plan-r1.md

## Findings
### Analysis
- The core duplication analysis is correct: the five worker-style files duplicate `normalizeTask`, `parseTaskReport`, and `buildFailureReport`, and the inspector variant is correctly identified as similar but schema-distinct. Current source confirms the helper definitions in [saivage/src/agents/coder.ts](saivage/src/agents/coder.ts#L212), [saivage/src/agents/researcher.ts](saivage/src/agents/researcher.ts#L208), [saivage/src/agents/data-agent.ts](saivage/src/agents/data-agent.ts#L125), [saivage/src/agents/reviewer.ts](saivage/src/agents/reviewer.ts#L148), and [saivage/src/agents/designer.ts](saivage/src/agents/designer.ts#L142).
- The analysis correctly captures the important semantic drift in `buildFailureReport`: coder/researcher return empty `issues_found` while data-agent/reviewer/designer return one error issue. This is verified at [saivage/src/agents/coder.ts](saivage/src/agents/coder.ts#L319), [saivage/src/agents/researcher.ts](saivage/src/agents/researcher.ts#L313), [saivage/src/agents/data-agent.ts](saivage/src/agents/data-agent.ts#L229), [saivage/src/agents/reviewer.ts](saivage/src/agents/reviewer.ts#L259), and [saivage/src/agents/designer.ts](saivage/src/agents/designer.ts#L244).
- Factual line-reference errors need correction. The analysis claims all exact line refs were verified, but the current `parseTaskReport` definitions are [saivage/src/agents/coder.ts](saivage/src/agents/coder.ts#L263), [saivage/src/agents/researcher.ts](saivage/src/agents/researcher.ts#L260), and [saivage/src/agents/data-agent.ts](saivage/src/agents/data-agent.ts#L176), not the lines listed in [saivage/SPEC/v2/review-2026-05/F09/01-analysis-r1.md](saivage/SPEC/v2/review-2026-05/F09/01-analysis-r1.md#L10). The reviewer double-push is at [saivage/src/agents/reviewer.ts](saivage/src/agents/reviewer.ts#L121), and BaseAgent's terminal assistant push is at [saivage/src/agents/base.ts](saivage/src/agents/base.ts#L269), not the approximate/stale references in [saivage/SPEC/v2/review-2026-05/F09/01-analysis-r1.md](saivage/SPEC/v2/review-2026-05/F09/01-analysis-r1.md#L68).

### Design
- Project-guideline compliance is strong overall. The recommended path deletes the orphan designer instead of porting dead code, does not introduce a migration shim or compatibility alias, and uses abstractions (`task-report.ts`, `WorkerAgent`) that would be used by four live workers rather than once.
- Proposal A, Proposal B, and Proposal C are genuinely different. Proposal C is a substantive level-up from helper extraction because it targets the shared manager-dispatched TaskReport lifecycle while keeping planner/manager/chat/inspector on `BaseAgent`.
- Inspector handling is sound: [saivage/src/agents/inspector.ts](saivage/src/agents/inspector.ts#L207) normalizes `InspectionRequest` and [saivage/src/agents/inspector.ts](saivage/src/agents/inspector.ts#L237) parses `InspectionReport`, so leaving it outside `WorkerAgent` preserves a real boundary rather than preserving duplication.
- The design has one behavioral ambiguity that must be fixed before approval: current `ReviewerAgent.run()` delegates to `review(this.input)` at [saivage/src/agents/reviewer.ts](saivage/src/agents/reviewer.ts#L102-L103), while `review()` owns normalization, follow-up injection, `reviewCount`, and the current double-push site at [saivage/src/agents/reviewer.ts](saivage/src/agents/reviewer.ts#L106-L121). Proposal C says reviewer becomes the same shape as other workers with an extra `review()` method, and the plan says to apply the same `run()` transformation as other workers. If implemented literally, reviewer could inherit generic `WorkerAgent.run()` and change direct `run()` semantics, even though the public class is exported from [saivage/src/index.ts](saivage/src/index.ts#L61). Bootstrap currently calls `review()` directly for reviewer dispatch at [saivage/src/server/bootstrap.ts](saivage/src/server/bootstrap.ts#L372-L374), but the exported `run()` contract should remain explicit.
- The reviewer double-push handling is in scope if Proposal C owns reviewer lifecycle cleanup. Removing [saivage/src/agents/reviewer.ts](saivage/src/agents/reviewer.ts#L121) is justified because BaseAgent already pushes the final assistant message at [saivage/src/agents/base.ts](saivage/src/agents/base.ts#L269), but the plan should tie that removal to preserving reviewer follow-up semantics, not just to mechanical extraction.

### Plan
- The plan is mostly executable: `npm run typecheck`, `npm run lint`, `npm run build`, and `npx vitest run` are real commands in [saivage/package.json](saivage/package.json#L11-L20), and `npx vitest run src/agents/` is a plausible focused run for the agent tests.
- Designer deletion is executable and aligned with the no-dead-code guideline. A source search outside [saivage/src/agents/designer.ts](saivage/src/agents/designer.ts) found no live `designer` or `DesignerAgent` references under `src/`, and the live schema enums exclude designer at [saivage/src/types.ts](saivage/src/types.ts#L108-L109) and [saivage/src/types.ts](saivage/src/types.ts#L160).
- Cross-issue ordering is mostly correct: F01 is explicitly coupled to designer deletion, F03 is correctly sequenced after the shared parser extraction, and F18 is kept orthogonal. The F14/reviewer double-push overlap is acceptable only if the plan explicitly preserves reviewer follow-up behavior while removing the duplicate push.
- The validation-skill section is misleading as written. [saivage/SPEC/v2/review-2026-05/F09/03-plan-r1.md](saivage/SPEC/v2/review-2026-05/F09/03-plan-r1.md#L80-L84) cites the workspace `saivage-development-validation` skill, but that skill's local commands are for `/home/salva/g/ml/saivage-v3` and Jest, while this plan correctly targets `/home/salva/g/ml/saivage` and Vitest. The plan should state the repo-local validation commands directly and avoid claiming they come from that skill.

## Required changes (if any)
1. Correct the stale file:line references in the analysis/design/plan, especially the `parseTaskReport` locations and the reviewer/BaseAgent assistant-push references. Keep all evidence links concrete and current.
2. Clarify Proposal C and Step 6 so `ReviewerAgent.run()` remains an explicit delegate to `review(this.input)` or otherwise preserves the same review-count/follow-up semantics. Do not let reviewer silently inherit a generic `WorkerAgent.run()` that bypasses `review()`.
3. Rewrite the validation section to distinguish repo-local Saivage v2 commands from the `saivage-development-validation` skill, or remove the skill citation. The commands themselves can stay, but the source and applicability must be accurate.

## Strengths
- The recommended architecture is appropriately scoped and avoids backward-compatibility shims.
- The plan deletes dead designer code rather than preserving it, and it keeps inspector outside the worker abstraction for the right contract reasons.
- The F03/F01/F18 cross-links are useful and mostly sequenced correctly.

VERDICT: CHANGES_REQUESTED