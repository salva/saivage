# G46 — Review (r1)

## Findings

1. The proposed regex-free round-id parser is not a strict deterministic replacement.

   [02-design-r1.md](SPEC/v2/review-2026-05-round2/G46/02-design-r1.md#L207-L215) replaces anchored regexes with `Number.parseInt`. That still accepts malformed IDs such as `r1x`, `r-msg:3junk`, and `r-1`, because `Number.parseInt` stops at the first non-digit and still returns a finite number. The old parser in [web/src/components/AgentsView.vue](web/src/components/AgentsView.vue#L404-L411) accepted only the exact shapes `r-msg:N`, `r-compacted-N`, and `rN`; the replacement must preserve that strictness without regex. Add a tiny decimal scanner, reject empty/trailing/negative input, and add tests for malformed IDs.

2. The scroll-anchor ownership is split across files without a working prop/ref boundary.

   The design has `useAgentConversation` expose `threadBody` in [02-design-r1.md](SPEC/v2/review-2026-05-round2/G46/02-design-r1.md#L263), while [AgentConversationPane.vue](SPEC/v2/review-2026-05-round2/G46/02-design-r1.md#L281) owns the thread rendering and [03-plan-r1.md](SPEC/v2/review-2026-05-round2/G46/03-plan-r1.md#L191) says the `ref="threadBody"` is bound from the composable. The proposed coordinator wiring does not pass that ref into the pane, and the pane prop table does not include it. In the live monolith the DOM ref and scroll helpers live in the same component ([web/src/components/AgentsView.vue](web/src/components/AgentsView.vue#L134), [web/src/components/AgentsView.vue](web/src/components/AgentsView.vue#L258-L264), [web/src/components/AgentsView.vue](web/src/components/AgentsView.vue#L647)); after the split, one layer must clearly own the element ref and scroll behavior.

3. The timeline test plan is good, but the validation command is currently false.

   The design claims the test runs through an existing [web/package.json](web/package.json) Vitest runner in [02-design-r1.md](SPEC/v2/review-2026-05-round2/G46/02-design-r1.md#L248), and the plan requires `cd web && npm test` in [03-plan-r1.md](SPEC/v2/review-2026-05-round2/G46/03-plan-r1.md#L319). Live [web/package.json](web/package.json#L6-L10) has only `dev`, `build`, and `preview`; Vitest is wired at the repo root in [package.json](package.json#L17-L18) and [package.json](package.json#L54). Either add a real web-level test script/dependency as part of G46, or change validation to the actual root-level command that will execute [web/src/components/agents/timeline.test.ts](SPEC/v2/review-2026-05-round2/G46/03-plan-r1.md#L102-L114).

4. The sub-component line targets are directionally right but not yet credible enough for the ≤240 SFC target.

   The component list is complete and reflects real responsibilities, but the estimates understate the largest files. [ToolCallRow.vue](SPEC/v2/review-2026-05-round2/G46/02-design-r1.md#L283) is budgeted at ≤140/~130 lines while [03-plan-r1.md](SPEC/v2/review-2026-05-round2/G46/03-plan-r1.md#L187) assigns it the dense tool-pair template, formatting wrapper, click handling, and its CSS. [AgentConversationPane.vue](SPEC/v2/review-2026-05-round2/G46/02-design-r1.md#L281) is budgeted at ≤240 while [03-plan-r1.md](SPEC/v2/review-2026-05-round2/G46/03-plan-r1.md#L191) gives it the header, timeline computed, standalone diagnostic/context/compacted branches, footer, time helpers, role coloring, and the scroll body. The plan should either split one more layer or state the fallback if `wc -l` proves these estimates wrong.

## Checks That Pass

- Decomposition is not just code movement. The proposed coordinator, sidebar, agent pane, round card, tool row, chat pane, composables, constants, parser, and transformer separate fetching, selection, transformation, and rendering responsibilities.
- G41 sequencing is explicit: [02-design-r1.md](SPEC/v2/review-2026-05-round2/G46/02-design-r1.md#L16) requires G46 to land after [G41/APPROVED.md](SPEC/v2/review-2026-05-round2/G41/APPROVED.md). The live checkout does not yet contain web/src/api/types.ts; the approved G41 source for `AgentRole`, `AgentState`, and `PlanStage` is [03-plan-r2.md](SPEC/v2/review-2026-05-round2/G41/03-plan-r2.md#L22-L75).
- The plan correctly removes the `messageIndex:blockIndex` fallback and drops missing-`toolUseId` entries with a warning ([02-design-r1.md](SPEC/v2/review-2026-05-round2/G46/02-design-r1.md#L232-L233), [03-plan-r1.md](SPEC/v2/review-2026-05-round2/G46/03-plan-r1.md#L87-L94)). That matches principle 3.
- The constants module covers the meaningful runtime/rendering tunables called out by the analysis. If principle 2 is meant to include CSS layout dimensions too, the plan should say those remain CSS-local by design.
- The pure transformer test matrix is strong: it covers empty input, reasoning, matched/pending/orphan/error tool pairs, missing `toolUseId`, diagnostics, compaction, and deterministic same-timestamp ordering ([03-plan-r1.md](SPEC/v2/review-2026-05-round2/G46/03-plan-r1.md#L102-L117)). The blocker is execution wiring, not coverage intent.

## Required Revision

Round 2 should make the no-regex parser strict, close the `threadBody` ownership boundary, correct the Vitest command or add web test wiring, and make the line-count target mechanically enforceable for the largest SFCs.

VERDICT: CHANGES_REQUESTED