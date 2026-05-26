# G24 - Review of round 1

## Findings

### 1. CHANGES_REQUESTED - The final parse grep cannot pass after following the test-helper plan

The core design direction is right, but the plan's verification gate contradicts its own fixture strategy. Step 5 tells the implementer to add a local test helper in [SPEC/v2/review-2026-05-round2/G24/03-plan-r1.md](SPEC/v2/review-2026-05-round2/G24/03-plan-r1.md#L101-L108) that calls projectRoutingSchema.parse inside [src/routing/resolver.test.ts](src/routing/resolver.test.ts#L33-L75). The final sweep then requires [SPEC/v2/review-2026-05-round2/G24/03-plan-r1.md](SPEC/v2/review-2026-05-round2/G24/03-plan-r1.md#L160-L162) to return zero hits for projectRoutingSchema.parse under saivage/src. Those two instructions cannot both be true, because the helper itself is a direct source-tree hit.

The design repeats the same mismatch: it recommends the same parse helper in [SPEC/v2/review-2026-05-round2/G24/02-design-r1.md](SPEC/v2/review-2026-05-round2/G24/02-design-r1.md#L87-L97), then says direct uses of projectRoutingSchema.parse in src/ must drop to zero in [SPEC/v2/review-2026-05-round2/G24/02-design-r1.md](SPEC/v2/review-2026-05-round2/G24/02-design-r1.md#L223-L226). The actual production target is narrower: remove the resolver's constructor parse in [src/routing/resolver.ts](src/routing/resolver.ts#L96-L100) and the per-call parse in [src/routing/resolver.ts](src/routing/resolver.ts#L145-L148). Bootstrap already passes the validated project config loaded at [src/server/bootstrap.ts](src/server/bootstrap.ts#L120-L130), so the production grep should exclude tests, or the tests should stop using the parse helper and spell the post-parse fixture shape explicitly.

Fix the round-2 plan by choosing one consistent path. Either keep the test helper and change the grep gate to assert zero production uses, excluding test files, or remove the helper and make every routing fixture a literal ProjectRoutingConfig output value. As written, an implementation can satisfy the intended architecture and still fail the prescribed validation.

### 2. CHANGES_REQUESTED - The test-fixture instructions need to name the allowed-models fixture explicitly

The plan says the implementation fixes three resolver fixtures in [SPEC/v2/review-2026-05-round2/G24/03-plan-r1.md](SPEC/v2/review-2026-05-round2/G24/03-plan-r1.md#L5-L6), but Step 5 explicitly lists only the profile fixture and the chat fixture in [SPEC/v2/review-2026-05-round2/G24/03-plan-r1.md](SPEC/v2/review-2026-05-round2/G24/03-plan-r1.md#L113-L119). The third live routing literal is the allowed_models-only regression in [src/routing/resolver.test.ts](src/routing/resolver.test.ts#L121-L127). It also matters for this change: after the constructor narrows to ProjectRoutingInput, that literal is no longer the post-parse ProjectRoutingConfig shape because it relies on projectRoutingSchema defaults for top-level profiles and routingRuleSchema defaults for preferred_models and preferred_accounts.

The catch-all "any other call site" instruction in [SPEC/v2/review-2026-05-round2/G24/03-plan-r1.md](SPEC/v2/review-2026-05-round2/G24/03-plan-r1.md#L119-L120) is easy to miss during a mechanical implementation. Round 2 should name [src/routing/resolver.test.ts](src/routing/resolver.test.ts#L121-L127) directly and state whether it is wrapped by the helper or expanded into an explicit post-parse object.

## What is solid

The analysis correctly identifies the two live duplicate parses in [src/routing/resolver.ts](src/routing/resolver.ts#L96-L100) and [src/routing/resolver.ts](src/routing/resolver.ts#L145-L148). It also correctly verifies the production validation path: bootstrap loads the project in [src/server/bootstrap.ts](src/server/bootstrap.ts#L120-L130), loadProject reads ProjectConfigSchema in [src/store/project.ts](src/store/project.ts#L66-L70), and ProjectConfigSchema embeds projectRoutingSchema in [src/types.ts](src/types.ts#L12-L17). Proposal A is the right architecture-first fix: narrow the resolver input to the validated shape, cache the routing reference, delete ProjectRoutingConfigLike, and remove both resolver-side parses instead of keeping a defensive shim.

The scope control is also good. Leaving RuntimeRoutingConfigLike and provider/account normalization alone respects the subsystem map's routing boundary in [SPEC/v2/review-2026-05-round2/00-SUBSYSTEM-MAP.md](SPEC/v2/review-2026-05-round2/00-SUBSYSTEM-MAP.md#L107-L108) and avoids pulling G23/G25/G26 work into a low-severity cleanup.

## Required round-2 changes

- Make the projectRoutingSchema.parse validation gate consistent with the chosen test-fixture strategy. If tests keep a parse helper, the grep must exclude test files and assert zero production uses only. If the grep must remain zero across all src/, remove the helper and expand test fixtures into ProjectRoutingConfig output literals.
- Explicitly include the allowed_models-only fixture at [src/routing/resolver.test.ts](src/routing/resolver.test.ts#L121-L127) in the test-update steps.
- Fix the grep command paths so they match the declared working directory. The plan says validation runs from saivage/ in [SPEC/v2/review-2026-05-round2/G24/03-plan-r1.md](SPEC/v2/review-2026-05-round2/G24/03-plan-r1.md#L136-L143), but several grep examples target saivage/src in [SPEC/v2/review-2026-05-round2/G24/03-plan-r1.md](SPEC/v2/review-2026-05-round2/G24/03-plan-r1.md#L14-L18) and [SPEC/v2/review-2026-05-round2/G24/03-plan-r1.md](SPEC/v2/review-2026-05-round2/G24/03-plan-r1.md#L160-L167).

VERDICT: CHANGES_REQUESTED