# G21 - Review of round 2

## Findings

### 1. CHANGES_REQUESTED - The proposed arbitrary-key regression asserts a chain entry the desired implementation will not produce

Round 2 correctly removes `providerConfigs` as a provider-name oracle, but the new test body in [SPEC/v2/review-2026-05-round2/G21/03-plan-r2.md](03-plan-r2.md#L178-L193) expects `buildChain()` to contain the raw fallback string `"not-a-real-provider"`. That does not match the live router's chain semantics. `buildChain()` returns candidate specs produced by `appendCandidatesForModelSpec`, not raw failover entries. Once the r2 change makes `isProviderName("not-a-real-provider")` false at the provider-only expansion point in [src/providers/router.ts](../../../../src/providers/router.ts#L556), the fallback is treated as a provider-independent model id. Provider-independent expansion then emits only registered providers that can serve that model, via [src/providers/router.ts](../../../../src/providers/router.ts#L565-L584) and [src/providers/router.ts](../../../../src/providers/router.ts#L616-L631).

The proposed config only adds an arbitrary runtime provider key in [SPEC/v2/review-2026-05-round2/G21/03-plan-r2.md](03-plan-r2.md#L178-L179). That key is allowed syntactically because runtime providers are a string-keyed map in [src/routing/resolver.ts](../../../../src/routing/resolver.ts#L61), but it is not a registered router provider after the desired descriptor-only boot path. So a correct implementation can satisfy the architectural contract, avoid producing `"not-a-real-provider/claude-sonnet-4.6"`, and still fail the proposed `expect(chain).toContain("not-a-real-provider")` assertion in [SPEC/v2/review-2026-05-round2/G21/03-plan-r2.md](03-plan-r2.md#L192).

Fix the regression to assert the real observable contract. The narrow version is: with an arbitrary configured key in failover, `buildChain("github-copilot/claude-sonnet-4.6")` must not contain `"not-a-real-provider/claude-sonnet-4.6"`. If the test needs a positive chain entry too, configure a real descriptor provider to serve model id `"not-a-real-provider"` and assert the resulting registered-provider candidate, not the raw fallback string.

### 2. CHANGES_REQUESTED - Built-in provider-only expansion still lacks positive preservation coverage

Round 2 repeatedly treats the existing test at [src/providers/router.test.ts](../../../../src/providers/router.test.ts#L267-L283) as a built-in provider-only preservation test, including in [SPEC/v2/review-2026-05-round2/G21/02-design-r2.md](02-design-r2.md#L150) and [SPEC/v2/review-2026-05-round2/G21/03-plan-r2.md](03-plan-r2.md#L221). That live test is a suppression case: it configures `failover: { "github-copilot": ["openai-codex"] }`, but because the model has an explicit equivalent, it asserts that `"openai-codex/claude-sonnet-4.6"` is not present in [src/providers/router.test.ts](../../../../src/providers/router.test.ts#L267-L283). It does not prove that descriptor-backed provider-only fallback still expands when there is no explicit equivalent.

The plan notices the test is a negation case in [SPEC/v2/review-2026-05-round2/G21/03-plan-r2.md](03-plan-r2.md#L202), but then claims the positive behavior is covered around [src/providers/router.test.ts](../../../../src/providers/router.test.ts#L72-L122). Those tests use full model specs or explicit model equivalents; they do not exercise `failover["github-copilot"] = ["openai-codex"]` as a positive provider-only expansion. Since G21 changes the only provider-name guard used by failover expansion in [src/providers/router.ts](../../../../src/providers/router.ts#L556), the implementation needs a direct preservation test such as: no `modelEquivalents`, `failover: { "github-copilot": ["openai-codex"] }`, build `"github-copilot/claude-sonnet-4.6"`, and expect `"openai-codex/claude-sonnet-4.6"` in the chain.

## What is solid

The r2 architecture changes address the two round-1 blockers. The analysis now makes descriptor membership the only provider-name predicate, removes the unknown-provider registration fallback, and requires `ProviderName` to be derivable in the landed implementation in [SPEC/v2/review-2026-05-round2/G21/01-analysis-r2.md](01-analysis-r2.md#L53-L55). The design and plan also use a generic descriptor helper plus `as const satisfies readonly ProviderDescriptor[]`, with a local derived `ProviderName`, in [SPEC/v2/review-2026-05-round2/G21/02-design-r2.md](02-design-r2.md#L13) and [SPEC/v2/review-2026-05-round2/G21/03-plan-r2.md](03-plan-r2.md#L81-L85). That satisfies the no-shim, single-source direction the project rules require.

The implementation shape also stays appropriately scoped: it collapses the live `knownProviders`, registration switch, factory switch, and `isProviderName` fallback sites in [src/providers/router.ts](../../../../src/providers/router.ts#L105-L118), [src/providers/router.ts](../../../../src/providers/router.ts#L731-L754), [src/providers/router.ts](../../../../src/providers/router.ts#L766-L815), and [src/providers/router.ts](../../../../src/providers/router.ts#L871-L881), while leaving the separate OAuth map for G22.

## Required round-3 changes

- Correct the arbitrary-key regression so it does not expect the raw non-slash fallback string to appear in `buildChain()` output.
- Add an explicit positive test for built-in provider-only expansion with no explicit equivalent, proving descriptor names still expand through [src/providers/router.ts](../../../../src/providers/router.ts#L556).
- Update the test-impact and validation prose so [src/providers/router.test.ts](../../../../src/providers/router.test.ts#L267-L283) is described as a suppression test, not as positive built-in provider-only expansion coverage.

VERDICT: CHANGES_REQUESTED