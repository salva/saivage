# G41 - Review (r2)

## Findings

No blocking findings. Round 2 resolves the round-1 blockers and keeps the chosen fix aligned with the live `/api/state` contract. The proposed `pollTitleStatus` replacement consumes the `{ state, plan }` envelope returned by [src/server/server.ts](src/server/server.ts#L173-L177), reads the canonical runtime fields from [src/types.ts](src/types.ts#L250-L258), and deletes the phantom `phase` / `currentStage` reads that still exist in [web/src/App.vue](web/src/App.vue#L127-L131).

## Blocker Resolution

1. `PlanStage` now mirrors the full canonical `StageSchema`.

   Round 2 includes all seven required stage fields in the shared type in [02-design-r2.md](SPEC/v2/review-2026-05-round2/G41/02-design-r2.md#L117-L133) and [03-plan-r2.md](SPEC/v2/review-2026-05-round2/G41/03-plan-r2.md#L53-L69). That matches the live server schema in [src/types.ts](src/types.ts#L34-L48), including required arrays for `starting_points`, `expected_outcomes`, `acceptance_criteria`, `references`, and `tags`. This resolves the round-1 objection in [04-review-r1.md](SPEC/v2/review-2026-05-round2/G41/04-review-r1.md#L11-L16) and preserves the PlanView template reads in [web/src/components/PlanView.vue](web/src/components/PlanView.vue#L241-L257).

2. The `HistoryEntry` contradiction is resolved.

   Round 2 consistently keeps plan-history shapes local instead of folding them into the `/api/state` shared module. The design calls this out for StatusPanel in [02-design-r2.md](SPEC/v2/review-2026-05-round2/G41/02-design-r2.md#L37-L44), and the plan preserves the local `HistoryEntry` declarations in [03-plan-r2.md](SPEC/v2/review-2026-05-round2/G41/03-plan-r2.md#L158-L164) and [03-plan-r2.md](SPEC/v2/review-2026-05-round2/G41/03-plan-r2.md#L190-L194). That matches the live history refs in [web/src/components/StatusPanel.vue](web/src/components/StatusPanel.vue#L40-L50) and [web/src/components/PlanView.vue](web/src/components/PlanView.vue#L25-L56).

3. PlanView's local `Stage` and `Plan` are now in the deletion plan.

   The r1 plan missed the local `Stage` interface in [web/src/components/PlanView.vue](web/src/components/PlanView.vue#L9-L17). Round 2 explicitly deletes both local plan interfaces in [03-plan-r2.md](SPEC/v2/review-2026-05-round2/G41/03-plan-r2.md#L179-L187), and the duplicate-interface self-check now includes `interface Stage` in [03-plan-r2.md](SPEC/v2/review-2026-05-round2/G41/03-plan-r2.md#L226-L240). That is the coherent model the first review asked for.

4. `vue-tsc` is wired as a real web check.

   Round 2 no longer claims the current build already type-checks Vue SFCs. It adds `vue-tsc` and changes the web build to `vue-tsc --noEmit -p tsconfig.json && vite build` in [02-design-r2.md](SPEC/v2/review-2026-05-round2/G41/02-design-r2.md#L208-L225) and [03-plan-r2.md](SPEC/v2/review-2026-05-round2/G41/03-plan-r2.md#L81-L96). That closes the actual gap: the root build delegates to the web package in [package.json](package.json#L13-L14), the current web build is Vite-only in [web/package.json](web/package.json#L6-L9), and the web tsconfig already includes `.vue` files in [web/tsconfig.json](web/tsconfig.json#L1-L18).

5. `agent_type` is narrowed to an `AgentRole` literal union.

   The shared `AgentState` now uses `agent_type: AgentRole` in [02-design-r2.md](SPEC/v2/review-2026-05-round2/G41/02-design-r2.md#L82-L99) and [03-plan-r2.md](SPEC/v2/review-2026-05-round2/G41/03-plan-r2.md#L19-L35). That mirrors the live `AgentStateSchema` enum in [src/types.ts](src/types.ts#L240-L248) and the roster-derived `AgentRole` source in [src/agents/roster.ts](src/agents/roster.ts#L40-L226), replacing the widened local strings in [web/src/components/AgentsView.vue](web/src/components/AgentsView.vue#L12-L18) and [web/src/components/StatusPanel.vue](web/src/components/StatusPanel.vue#L10-L17).

## Project-Wide Principles

- No regex for user intent: not triggered. The only regex use in the plan is validation grep/self-checking, not runtime user-intent parsing.
- Avoid hardcoded values: no new runtime magic values or dispatch decisions are introduced. The role literal list is a type-level mirror with a canonical-source pointer; acceptable for this hand-written SPA schema mirror.
- No fragile agent-tool-call heuristics: not triggered. G41 does not add or modify tool-call classification logic.

## Residual Risk

The implementation should still run the SFC duplicate-block sanity check from [03-plan-r2.md](SPEC/v2/review-2026-05-round2/G41/03-plan-r2.md#L244-L253), because this workspace has a known Vue edit-buffer corruption mode. That is an execution hygiene risk, not a design blocker.

VERDICT: APPROVED