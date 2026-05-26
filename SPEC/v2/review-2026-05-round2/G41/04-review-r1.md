# G41 — Review (r1)

## Summary

Round 1 correctly identifies the live title-sync bug: [web/src/App.vue](web/src/App.vue#L127-L131) still consumes `/api/state` as a flat `{ status, phase, currentStage }` object, while the server returns `{ state, plan }` from [src/server/server.ts](src/server/server.ts#L173-L177) and the runtime fields are snake_case in [src/types.ts](src/types.ts#L250-L258). The proposed `pollTitleStatus` replacement is directionally correct: consume `data.state?.status`, consume `data.state?.current_stage_id`, and delete `phase` / `currentStage` entirely.

The round is not ready to approve because Proposal A and the implementation plan do not actually keep the new shared `ApiState` faithful to the canonical schemas, and the validation step claims a type-checker this repo does not currently run.

## Required Changes

1. Fix the shared `PlanStage` shape before using it as the canonical `Plan` type.

   The proposed shared type in [02-design-r1.md](SPEC/v2/review-2026-05-round2/G41/02-design-r1.md#L58-L67) and [03-plan-r1.md](SPEC/v2/review-2026-05-round2/G41/03-plan-r1.md#L35-L44) only includes `id`, `objective`, and optional `tags`. That does not match `StageSchema`: [src/types.ts](src/types.ts#L34-L41) requires `starting_points`, `expected_outcomes`, `acceptance_criteria`, `references`, and `tags`, and [src/types.ts](src/types.ts#L45-L48) makes `Plan.stages` an array of that full schema.

   This is not just theoretical schema purity. [web/src/components/PlanView.vue](web/src/components/PlanView.vue#L243-L257) reads `stage.expected_outcomes`, `stage.acceptance_criteria`, `stage.references`, and `stage.tags`. If `PlanView` imports the proposed shared `Plan`, its template is no longer typed against the fields it renders. Revise `PlanStage` to mirror the full server `StageSchema` with snake_case field names and the same required/nullable/optional semantics, or do not centralize `Plan` yet. A partial subset type should not be presented as the canonical `ApiState`/`Plan` derivation.

2. Clean up the duplicate-interface deletion plan so it is internally consistent and complete.

   Step 4 says to delete five local interfaces in [web/src/components/StatusPanel.vue](web/src/components/StatusPanel.vue#L10-L42), including `HistoryEntry`, then immediately says `HistoryEntry` stays local in [03-plan-r1.md](SPEC/v2/review-2026-05-round2/G41/03-plan-r1.md#L110-L120). Deleting it would break the live `history` ref at [web/src/components/StatusPanel.vue](web/src/components/StatusPanel.vue#L50). The design has the same contradiction in [02-design-r1.md](SPEC/v2/review-2026-05-round2/G41/02-design-r1.md#L119-L125).

   The plan also deletes only the local `Plan` interface from [web/src/components/PlanView.vue](web/src/components/PlanView.vue#L19), but leaves the local `Stage` interface at [web/src/components/PlanView.vue](web/src/components/PlanView.vue#L9-L17). If `Plan` is centralized, the local `Stage` becomes dead duplication; if `Stage` is still needed because the shared `PlanStage` is incomplete, the shared type is not ready. Pick one coherent model and update the deletion list and grep self-check accordingly. At minimum, the self-check in [03-plan-r1.md](SPEC/v2/review-2026-05-round2/G41/03-plan-r1.md#L150-L157) must include `interface Stage` if the plan claims to remove duplicate plan-stage shapes.

3. Replace the validation claim that `npm run build` runs `vue-tsc`.

   The design says `npm run build` is a `Vite + vue-tsc` load-bearing check in [02-design-r1.md](SPEC/v2/review-2026-05-round2/G41/02-design-r1.md#L162-L166), and the plan repeats that in [03-plan-r1.md](SPEC/v2/review-2026-05-round2/G41/03-plan-r1.md#L139-L144). The current scripts do not support that claim: [package.json](package.json#L13-L14) delegates the web build to the web package, and [web/package.json](web/package.json#L8) runs only `vite build`. The root typecheck does not cover web files because [tsconfig.json](tsconfig.json#L20-L21) includes only server source and excludes the web directory.

   This matters for this exact proposal: the incomplete `PlanStage` can affect Vue template expressions, and the proposed validation may not catch it. Either add a real web type-check command/dependency to the plan, or rewrite the validation section so it does not claim template/type safety that the repository does not currently enforce.

## Axis Check

- ApiState derivation correctness: `state` / `plan` nullability and `runtime_state.current_stage_id` are correctly identified, but the proposed shared `Plan` is not schema-faithful. `AgentState.agent_type` is also widened to `string` even though [src/types.ts](src/types.ts#L240-L248) derives it from `ALL_ROLES`; if the shared module is meant to mirror Zod, that widening should be intentional and called out.
- pollTitleStatus consumption: approved in concept. The replacement in [02-design-r1.md](SPEC/v2/review-2026-05-round2/G41/02-design-r1.md#L85-L99) reads the right snake_case state fields and preserves the 401 branch.
- Duplicate inline interfaces: good goal, but the plan misses [web/src/components/PlanView.vue](web/src/components/PlanView.vue#L9-L17) and contradicts itself on `HistoryEntry`.
- Orthogonality: mostly sound. G40 and G45 remain documentation-only neighbors. G46 is lightly coupled because both touch [web/src/components/AgentsView.vue](web/src/components/AgentsView.vue#L12-L18), but the round already acknowledges that import-only overlap.
- Plan anchors: the main live-code anchors for `pollTitleStatus`, `AgentsView`, `StatusPanel`, and `PlanView` match current code closely enough. The plan is stale on validation behavior, not on the core source ranges.

VERDICT: CHANGES_REQUESTED
