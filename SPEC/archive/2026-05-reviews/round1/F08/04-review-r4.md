# F08 - Review (r4)

## Reviewer

GPT-5.5 (copilot)

## Documents reviewed

- [SPEC/v2/review-2026-05/F08-legacy-runtime-state-mirror.md](SPEC/v2/review-2026-05/F08-legacy-runtime-state-mirror.md)
- [SPEC/v2/review-2026-05/F08/04-review-r3.md](SPEC/v2/review-2026-05/F08/04-review-r3.md)
- [SPEC/v2/review-2026-05/F08/01-analysis-r2.md](SPEC/v2/review-2026-05/F08/01-analysis-r2.md)
- [SPEC/v2/review-2026-05/F08/02-design-r3.md](SPEC/v2/review-2026-05/F08/02-design-r3.md)
- [SPEC/v2/review-2026-05/F08/03-plan-r1.md](SPEC/v2/review-2026-05/F08/03-plan-r1.md)

## Findings

### Analysis

The r3 blocker is fixed. The r2 analysis now correctly points the runtime-state path declarations at [src/store/project.ts](src/store/project.ts#L82-L84), the fatal-handler error-state write at [src/server/bootstrap.ts](src/server/bootstrap.ts#L693-L695), the hot-path `RuntimeTracker.flush()` writer at [src/runtime/recovery.ts](src/runtime/recovery.ts#L397-L407), and the chat status reader at [src/agents/chat.ts](src/agents/chat.ts#L391-L393). It also correctly replaces the stale `/api/status` claim with the actual `/api/state` API/UI path at [src/server/server.ts](src/server/server.ts#L179-L188) and [web/src/components/StatusPanel.vue](web/src/components/StatusPanel.vue#L58).

The dead-code conclusion remains supported. A source search for the legacy mirror tokens shows them only in the current writer/helper, the pinning test, and the planner prompt text that Proposal A deletes; no production reader of `.saivage/runtime/runtime-state.json` was found.

### Design

The r3 design fixed the previous Proposal B line-reference issues and still recommends the right architectural shape: Proposal A deletes the mirror, its helper, its pinning test, and the prompt explanation without adding a migration shim or compatibility path. Proposal B remains a valid level-up alternative but is correctly deferred because it expands ownership changes into runtime-tracker/bootstrap behavior that belongs with later F22/F24 work.

One factual endpoint-name error remains in Proposal A's risk section: it says the web UI is unaffected because `/api/status` reads `paths.runtimeState`. Current source has no `/api/status` route; the route and UI callers use `/api/state` ([src/server/server.ts](src/server/server.ts#L179-L188), [web/src/components/StatusPanel.vue](web/src/components/StatusPanel.vue#L58)). This is the same factual endpoint-reference category as the prior analysis blocker, not a new semantic objection. The intended point is correct, but the document should not preserve the wrong route name.

### Plan

The retained r1 plan remains executable for Proposal A. The edit steps target the correct mirror writer/helper at [src/runtime/recovery.ts](src/runtime/recovery.ts#L297-L315), the exact pinning test at [src/runtime/runtime.test.ts](src/runtime/runtime.test.ts#L1026-L1043), and the planner prompt line at [src/agents/planner.ts](src/agents/planner.ts#L47). The grep checks and Vitest/typecheck/build validation commands are appropriate for the Saivage v2 repo.

## Required changes

1. Create [SPEC/v2/review-2026-05/F08/02-design-r4.md](SPEC/v2/review-2026-05/F08/02-design-r4.md) with no semantic change except correcting Proposal A's `/api/status` reference to `/api/state` in the web/API unaffectedness bullet. Keep Proposal A as the recommendation.

## Strengths

- The r2 analysis accurately repairs the stale references requested in r3.
- The chosen fix remains clean: delete the dead mirror and its documentation/test support in one patch, with no backward-compatibility shim.
- The implementation plan is narrow, verifiable, and correctly scoped away from F22/F24 runtime refactors and skills/memory work.

VERDICT: CHANGES_REQUESTED
