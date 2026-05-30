# G21 — APPROVED

**Chosen proposal**: Proposal B (per [02-design-r3.md](02-design-r3.md)) — replace the quadruple-duplicated provider-name lists in [src/providers/router.ts](../../../../src/providers/router.ts) with a single descriptor table typed `as const satisfies readonly ProviderDescriptor[]`. The descriptor uses a generic `makePiAiDescriptor<N extends string>(name: N, ...)` factory so each entry preserves its literal provider-name string. `ProviderName` is derived from the table (`(typeof PROVIDER_DESCRIPTORS)[number]["name"]`), `isProviderName` is a descriptor-only type guard, and the constructor-vs-class branching, OAuth-id resolution, registration predicate, and `KNOWN_PROVIDER_NAMES` set are all driven off the same table. No unknown-provider runtime fallback is introduced. Proposal A (extract a single shared `KNOWN_PROVIDER_NAMES` const) is rejected because it only removes three of the four duplications and still keeps the parallel constructor/OAuth/registration switches.

**Approved by**: GPT-5.5 (copilot) reviewer at round 3 — see [04-review-r3.md](04-review-r3.md).

**Implementation pointer**: [03-plan-r3.md](03-plan-r3.md). Touches only [src/providers/router.ts](../../../../src/providers/router.ts) and the router/provider tests. Done criteria require zero residual hard-coded provider-name lists, the descriptor-only `isProviderName` guard, and exact-shape preservation of the existing constructor closures so live behaviour is unchanged.

**Sequencing**: Batch with G22, since both touch [src/providers/router.ts](../../../../src/providers/router.ts). G20's removal of the dead concrete provider classes lands first; G21 and G22 then collapse into one router-cleanup commit set.

**Daemon impact**: None observable; the resolved `Provider` instances and OAuth ids are byte-identical to today. Any saivage-v3 restart remains operator-gated.
