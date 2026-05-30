# G21 - Review of round 1

## Findings

### 1. CHANGES_REQUESTED - The plan keeps providerConfigs as a second provider-name authority

R1 says the fixed state is one provider-name source inside [src/providers/router.ts](../../../../src/providers/router.ts#L105-L119), and its own analysis calls out the current `shouldRegisterProvider` default branch as an opaque partial-registration path ([SPEC/v2/review-2026-05-round2/G21/01-analysis-r1.md](01-analysis-r1.md#L38), [SPEC/v2/review-2026-05-round2/G21/01-analysis-r1.md](01-analysis-r1.md#L63-L65)). The proposed implementation then preserves exactly that compatibility behavior: [SPEC/v2/review-2026-05-round2/G21/03-plan-r1.md](03-plan-r1.md#L111-L116) returns `!!cfg || hasAccounts` for names outside the descriptor table, and [SPEC/v2/review-2026-05-round2/G21/03-plan-r1.md](03-plan-r1.md#L143-L145) makes `isProviderName` true for any key present in `providerConfigs`.

That is still a second truth source for what counts as a provider. `providerConfigs` is an arbitrary string-keyed runtime map ([src/routing/resolver.ts](../../../../src/routing/resolver.ts#L48-L61)), while the live router can only instantiate the hard-coded provider set: boot iterates the local list at [src/providers/router.ts](../../../../src/providers/router.ts#L102-L119), and unknown factories return `undefined` at [src/providers/router.ts](../../../../src/providers/router.ts#L766-L811). Keeping the fallback means provider-only failover expansion at [src/providers/router.ts](../../../../src/providers/router.ts#L556) can still treat an uninstantiable configured key as a provider and manufacture `unknown/model` candidates that will later skip as unregistered. That is the same silent partial state G21 is meant to remove, and it conflicts with the project rule against backward-compatibility shims.

R2 should make descriptor membership the only provider-name predicate. `isProviderName` should be descriptor-map only, `shouldRegisterProvider` should not have an unknown-provider fallback, and `initProviders` can pass the descriptor object directly rather than re-looking up by string. If custom providers are intended as a real future surface, that needs an explicit plugin/descriptor design; the current fallback is dead compatibility behavior, not architecture.

### 2. CHANGES_REQUESTED - The implementation plan drops the derived ProviderName type promised by the analysis

The analysis defines a fixed state where `ProviderName` is derivable from the canonical source so future call sites can opt into literal typing without a second edit ([SPEC/v2/review-2026-05-round2/G21/01-analysis-r1.md](01-analysis-r1.md#L63-L65)). The plan does the opposite: [SPEC/v2/review-2026-05-round2/G21/03-plan-r1.md](03-plan-r1.md#L20-L42) widens descriptor names to `string` via `readonly name: string`, `makePiAiDescriptor(name: string)`, and `const PROVIDER_DESCRIPTORS: readonly ProviderDescriptor[]`. It then files literal narrowing as a follow-up in [SPEC/v2/review-2026-05-round2/G21/03-plan-r1.md](03-plan-r1.md#L199) instead of making it part of the one canonical table.

That loses one of the main architectural gains of the refactor. With the planned typing, `typeof PROVIDER_DESCRIPTORS[number]["name"]` is just `string`, so the descriptor table cannot provide a real `ProviderName` union for internal tightening or future call sites. R2 should keep the descriptor-table design but preserve literals now, for example with an `as const satisfies readonly ProviderDescriptor[]` table and a generic helper that does not widen `name`. The type does not need to be exported in G21, but it should be derivable in the implementation that lands.

## What is solid

The core direction is right. Proposal B removes the two switch blocks in [src/providers/router.ts](../../../../src/providers/router.ts#L731-L811), keeps G20's post-deletion constructor set, and correctly avoids touching the separate OAuth cleanup owned by G22. The planned constructor closures mirror the current built-in providers closely, including the `github-copilot` header merge that is covered by [src/providers/copilot-router.test.ts](../../../../src/providers/copilot-router.test.ts#L25-L57).

The validation set is also mostly appropriate: typecheck, focused router tests, focused constructor-provider tests, full tests, and build are the right gates for this refactor. R2 should add one focused regression around provider-only failover so an arbitrary key in `providers` no longer counts as a provider unless it is in the descriptor table, while built-in provider-only failover such as [src/providers/router.test.ts](../../../../src/providers/router.test.ts#L268-L283) still expands.

## Required round-2 changes

- Remove the unknown-provider fallback from the descriptor design and plan. Descriptor membership must be the only answer to `isProviderName`, and the private registration path should not preserve the current `default` branch behavior.
- Preserve provider-name literal types in the descriptor implementation now. Do not defer the derivable `ProviderName` union to a follow-up.
- Add a focused regression test proving arbitrary `providerConfigs` keys are not treated as provider-only failover names, while existing built-in provider-only failover remains valid.

VERDICT: CHANGES_REQUESTED