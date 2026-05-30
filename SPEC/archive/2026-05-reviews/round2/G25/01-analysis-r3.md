# G25 — Analysis (round 3, writer Claude Opus 4.7)

Round 2 analysis ([01-analysis-r2.md](01-analysis-r2.md)) is carried forward verbatim in substance. The round 2 reviewer ([04-review-r2.md](04-review-r2.md)) marked only one blocking issue: several proposed failure tests still omit `role` and/or `configPath` assertions, so Required Change 3 from round 1 is partly unmet. Round 3 fixes that on the test side only; analysis-level conclusions, the validator-narrowing decision, the typed-error contract, and the sequencing all stand.

## 1. Carried conclusions (unchanged from r2)

- The two empty-intersection scenarios still pivot the design:
  - Scenario X (candidates empty, only `allowed_models` set) — documented F04 r3, pinned by [src/routing/resolver.test.ts](../../../../src/routing/resolver.test.ts#L121-L137). Out of scope.
  - Scenario Y (candidates non-empty, every entry filtered) — the live bug at [src/routing/resolver.ts](../../../../src/routing/resolver.ts#L204-L219). Must throw `NoAllowedRouteMatchError` with the full payload.
- Symmetric fix on `resolvePreferredAccounts` at [src/routing/resolver.ts](../../../../src/routing/resolver.ts#L222-L244) lands in the same diff (no-shim rule, architecture-first).
- `validateModelCoverage` at [src/config-validation.ts](../../../../src/config-validation.ts#L41-L69) is narrowed to aggregate only `MissingModelForRoleError`; every other error from `routing.resolve(role)` is rethrown verbatim. This preserves the payload of both `NoAllowedRouteMatchError` (G25) and `RoutingProfileCycleError` (G23) all the way to the CLI try/catch at [src/server/cli.ts](../../../../src/server/cli.ts#L70-L97).
- Account-side `defaultAccount` is a distinct candidate kind: a test where it is the only candidate and is filtered out must exist.
- The accounts-only allow-list-as-candidate branch is deliberately kept symmetric with F04 r3; both branches are exercised by regression tests.
- No `RoutingTrace`, no `log.warn`, no UI hook, no new operator-facing knob.

## 2. Single change from round 2

The round 2 reviewer flagged that even after switching from `toThrow(Class)` to `instanceof` plus field assertions, several proposed failure cases still leave required fields unchecked. Round 3 closes that gap. Every test that asserts a `NoAllowedRouteMatchError` now asserts the full typed-error payload contract:

- `kind` — `"model"` or `"account"`.
- `role` — the failing role name (string).
- `candidates` — the array of model/account candidates considered (exact contents and order).
- `allowed` — the array passed in `allowed_models` / `allowed_accounts` (exact contents and order).
- `configPath` — the configured config path (string, truthy).

This applies uniformly to:

- Resolver-level failure tests for `resolvePreferredModels` (cases A and the secondary `rule.model` variant).
- Resolver-level failure tests for `resolvePreferredAccounts` (cases D and E).
- The `validateModelCoverage` boundary test (Task 6) that proves the error propagates verbatim.

No design contract changes. No new fields on the typed error. No additional acceptance criteria. The acceptance criteria from [01-analysis-r2.md](01-analysis-r2.md) §4 are unchanged; their underlying tests are simply assertion-complete now.

## 3. Cross-finding sequencing

Unchanged from round 2. Resolver batch order G23 → G24 → G25 → G26 stands; G23/G24 APPROVED docs ([G23/APPROVED.md](../G23/APPROVED.md#L9), [G24/APPROVED.md](../G24/APPROVED.md#L9)) still require the shared batch. The mechanical coordination with G26's `resolveLegacyModels` rename is unchanged.

## 4. Acceptance criteria (round 3)

Identical to [01-analysis-r2.md](01-analysis-r2.md) §4, criteria A through J. Round 3 only tightens the underlying tests; criterion semantics are stable.

## 5. Constraints

Unchanged from round 2. The validator narrowing in §2.1 of the round 2 analysis remains in scope; the round 3 update is test-side only.
