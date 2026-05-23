# F09 Review — Round 2

## Reviewer
GPT-5.5 (copilot)

## Documents reviewed
- 01-analysis-r2.md
- 02-design-r2.md
- 03-plan-r2.md
- 04-review-r1.md

## Findings
### Analysis
- The round-1 stale helper/source references are mostly fixed. The worker helper definitions now match current source: `normalizeTask` at [coder.ts L212](../../../../src/agents/coder.ts#L212), [researcher.ts L208](../../../../src/agents/researcher.ts#L208), [data-agent.ts L125](../../../../src/agents/data-agent.ts#L125), [reviewer.ts L148](../../../../src/agents/reviewer.ts#L148), and [designer.ts L142](../../../../src/agents/designer.ts#L142); `parseTaskReport` at [coder.ts L263](../../../../src/agents/coder.ts#L263), [researcher.ts L260](../../../../src/agents/researcher.ts#L260), [data-agent.ts L176](../../../../src/agents/data-agent.ts#L176), [reviewer.ts L206](../../../../src/agents/reviewer.ts#L206), and [designer.ts L191](../../../../src/agents/designer.ts#L191); `buildFailureReport` at [coder.ts L319](../../../../src/agents/coder.ts#L319), [researcher.ts L313](../../../../src/agents/researcher.ts#L313), [data-agent.ts L229](../../../../src/agents/data-agent.ts#L229), [reviewer.ts L259](../../../../src/agents/reviewer.ts#L259), and [designer.ts L244](../../../../src/agents/designer.ts#L244).
- The r2 correction to inspector evidence is sound: inspector uses schema-distinct helpers, with `normalizeInspectionRequest` at [inspector.ts L185](../../../../src/agents/inspector.ts#L185) and `parseInspectionReport` at [inspector.ts L219](../../../../src/agents/inspector.ts#L219). Keeping inspector outside `WorkerAgent` remains the correct boundary.
- The semantic-drift analysis remains correct. Coder/researcher failure reports still return empty `issues_found` at [coder.ts L335](../../../../src/agents/coder.ts#L335) and [researcher.ts L329](../../../../src/agents/researcher.ts#L329), while data-agent/reviewer/designer return a single error issue at [data-agent.ts L249](../../../../src/agents/data-agent.ts#L249), [reviewer.ts L279](../../../../src/agents/reviewer.ts#L279), and [designer.ts L264](../../../../src/agents/designer.ts#L264).
- One part of round-1 item 1 is still not fully addressed: [01-analysis-r2.md L47](01-analysis-r2.md#L47) links `TaskReportSchema.agent` to [types.ts L164](../../../../src/types.ts#L164), but the `agent` enum is actually at [types.ts L160](../../../../src/types.ts#L160). [01-analysis-r2.md L136](01-analysis-r2.md#L136) links `TaskReportSchema` to [types.ts L161](../../../../src/types.ts#L161), but the schema begins at [types.ts L157](../../../../src/types.ts#L157). Because r1 explicitly required current file:line evidence, and the project guidelines repeat that file:line refs must be accurate, this must be corrected before approval.

### Design
- Round-1 item 2 is addressed. Proposal C now explicitly preserves `ReviewerAgent.run()` as the one-line delegate at [reviewer.ts L102-L104](../../../../src/agents/reviewer.ts#L102-L104) and keeps `review()` as the owner of re-normalisation, `reviewCount`, and follow-up message injection starting at [reviewer.ts L106](../../../../src/agents/reviewer.ts#L106). This prevents the accidental generic `WorkerAgent.run()` inheritance path called out in r1.
- The reviewer double-push handling is now tied to the lifecycle refactor in the right way. Removing the manual push at [reviewer.ts L121](../../../../src/agents/reviewer.ts#L121) is justified because `BaseAgent.runLoop()` already records the terminal assistant message at [base.ts L269](../../../../src/agents/base.ts#L269). The design also keeps the manager's direct `review()` dispatch unchanged at [bootstrap.ts L372-L374](../../../../src/server/bootstrap.ts#L372-L374).
- Proposal C remains the best fit for the guidelines. It introduces one abstraction used by the three pure workers plus reviewer, keeps `BaseAgent` focused on the LLM/tool/compaction loop, leaves inspector on its schema-distinct path, and deletes `designer.ts` instead of preserving dead code or adding compatibility shims.

### Plan
- Round-1 item 3 is addressed. The validation section now correctly states that the workspace `saivage-development-validation` skill is scoped to `saivage-v3`/Jest and is not applicable to this `saivage`/Vitest change. The repo-local command references are accurate: `npm run build` at [package.json L13](../../../../package.json#L13), `npm test` / `vitest run` at [package.json L17](../../../../package.json#L17), `npm run lint` at [package.json L19](../../../../package.json#L19), and `npm run typecheck` at [package.json L20](../../../../package.json#L20).
- Step 6 is now executable and explicit about reviewer semantics: `ReviewerAgent.run()` must remain an override that delegates to `review(this.input)`, while `review()` calls the shared `executeTask()` only after preserving the follow-up-message path. This satisfies the r1 requirement.
- The ordered steps, tests, validation commands, rollback notes, and cross-issue ordering are coherent. The plan has no migration shim, no transitional alias, and no preservation of `designer.ts` dead code.

## Required changes (if any)
1. Correct the remaining stale schema line references in [01-analysis-r2.md](01-analysis-r2.md): `TaskReportSchema.agent` should link to [types.ts L160](../../../../src/types.ts#L160), and `TaskReportSchema` should link to [types.ts L157](../../../../src/types.ts#L157). After that correction, the analysis claim that all r2 line numbers were re-verified will be true.

## Strengths
- The writer accepted the substantive r1 objections rather than working around them.
- The chosen Proposal C is architecture-first without overreaching into `BaseAgent` or inspector.
- The plan explicitly documents the two intended behavioural changes: uniform failure `issues_found` and removal of the reviewer assistant double-push.

VERDICT: CHANGES_REQUESTED