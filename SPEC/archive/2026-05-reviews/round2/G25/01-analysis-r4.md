# G25 — Analysis (round 4, writer Claude Opus 4.7)

Round 3 analysis ([01-analysis-r3.md](01-analysis-r3.md)) is carried forward verbatim in substance. The round 3 reviewer ([04-review-r3.md](04-review-r3.md)) marked only one blocking issue: the validator-boundary test (Task 6) asserts an exact `configPath` equal to its own argument, but the resolver throws `NoAllowedRouteMatchError` with `configPath()` (derived from `SAIVAGE_ROOT`/project root), and `validateModelCoverage` rethrows that error verbatim. Round 4 fixes the boundary-test contract; analysis-level conclusions, the validator-narrowing decision, the typed-error contract, and the sequencing all stand.

## 1. Carried conclusions (unchanged from r3)

- Two empty-intersection scenarios still pivot the design:
  - Scenario X (candidates empty, only `allowed_models` set) — F04 r3, pinned by [src/routing/resolver.test.ts](../../../../src/routing/resolver.test.ts#L121-L137). Out of scope.
  - Scenario Y (candidates non-empty, every entry filtered) — the live bug at [src/routing/resolver.ts](../../../../src/routing/resolver.ts#L204-L219). Must throw `NoAllowedRouteMatchError` with the full payload.
- Symmetric fix on `resolvePreferredAccounts` at [src/routing/resolver.ts](../../../../src/routing/resolver.ts#L222-L244) lands in the same diff.
- `validateModelCoverage` at [src/config-validation.ts](../../../../src/config-validation.ts#L41-L69) is narrowed to aggregate only `MissingModelForRoleError`; every other error from `routing.resolve(role)` is rethrown verbatim.
- Account-side `defaultAccount` is a distinct candidate kind; a test where it is the only candidate and is filtered out must exist.
- No `RoutingTrace`, no `log.warn`, no UI hook, no new operator-facing knob.
- The five-field payload contract on `NoAllowedRouteMatchError` (`kind`, `role`, `candidates`, `allowed`, `configPath`) is asserted in every failure test.

## 2. Single change from round 3

The round 3 reviewer flagged that Task 6 asserts `expect(e.configPath).toBe("/proj/.saivage/saivage.json")` while the resolver constructs the error with `configPath()` at [src/routing/resolver.ts](../../../../src/routing/resolver.ts#L111). `configPath()` is defined at [src/config.ts](../../../../src/config.ts#L224-L226) and derives from `SAIVAGE_ROOT` or `resolveProjectRoot()` via [src/config.ts](../../../../src/config.ts#L217-L222) — it does not consult the `configPathStr` argument passed to `validateModelCoverage` at [src/config-validation.ts](../../../../src/config-validation.ts#L41). The validator's `configPathStr` is consumed exclusively when constructing its own `MissingModelForRoleError` aggregate at [src/config-validation.ts](../../../../src/config-validation.ts#L67). Verbatim propagation of `NoAllowedRouteMatchError` therefore preserves the resolver's `configPath()` value, not the validator's argument.

The reviewer proposed two paths and the writer adopts the first:

- A. Loosen the Task 6 assertion to the same non-empty-string contract used by the resolver-level failure tests. The boundary test still proves typed-payload propagation; equality of `configPath` is dropped because no architecturally clean place exists for the validator's argument to influence a resolver-constructed error.
- B. Thread `configPathStr` into the resolver so its error sites can stamp the validator's path. Rejected. The resolver has no other `configPath` parameter on `resolve`, `resolvePreferredModels`, or `resolvePreferredAccounts`; the existing `MissingModelForRoleError` throw sites in the resolver at [src/routing/resolver.ts](../../../../src/routing/resolver.ts#L111) and [src/routing/resolver.ts](../../../../src/routing/resolver.ts#L261) already use `configPath()` unconditionally. Adding a path argument purely so the validator's argument can override the global function for one error class would (1) duplicate state that already exists as a module function, (2) force every resolver caller (cli, runtime, tests) to know and pass the same path, and (3) make `NoAllowedRouteMatchError` and `MissingModelForRoleError` carry differently-sourced `configPath` strings depending on whether the throw site is the resolver or the validator. Verbatim propagation means the resolver's view is preserved — that is the architectural property under test.

Exact-path coverage of `configPathStr` already exists for `MissingModelForRoleError` at [src/config-validation.test.ts](../../../../src/config-validation.test.ts#L106-L117). The validator-boundary test for `NoAllowedRouteMatchError` does not need to re-prove that property; it only needs to prove the typed payload survives unmodified.

No design contract changes. No new fields on the typed error. No additional acceptance criteria. The acceptance criteria from [01-analysis-r2.md](01-analysis-r2.md) §4 are unchanged.

## 3. Cross-finding sequencing

Unchanged from round 3. Resolver batch order G23 → G24 → G25 → G26 stands; G23/G24 APPROVED docs ([G23/APPROVED.md](../G23/APPROVED.md#L9), [G24/APPROVED.md](../G24/APPROVED.md#L9)) require the shared batch. The mechanical coordination with G26's `resolveLegacyModels` rename is unchanged.

## 4. Acceptance criteria (round 4)

Identical to [01-analysis-r2.md](01-analysis-r2.md) §4, criteria A through J. Round 4 only relaxes one assertion in Task 6 from exact equality to non-empty-string; criterion semantics are stable.

## 5. Constraints

Unchanged from round 3. The validator narrowing remains in scope; the round 4 update is test-side only.
