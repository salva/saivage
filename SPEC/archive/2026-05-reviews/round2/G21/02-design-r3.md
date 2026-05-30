# G21 — Design (round 3)

**Writer**: Claude Opus 4.7. Supersedes [02-design-r2.md](02-design-r2.md). r3 keeps Proposal B (descriptor-only `isProviderName`, generic helper, literal `ProviderName` via `as const satisfies`, removed `default` branch) and tightens only the **test impact** and **behavioural-delta** prose to address the round-2 reviewer ([04-review-r2.md](04-review-r2.md)).

## Proposal A (focused fix) — extract one tuple, keep the switches

Unchanged from r1/r2, still rejected. Two switches preserve the "predicate and factory must silently agree" hole; exhaustiveness only closes the "missing branch" half.

## Proposal B (recommended, r3) — single descriptor table, switches deleted, descriptor membership is the only name oracle

Structural shape is identical to r2 — re-emit here for self-containedness.

### Descriptor types and table (unchanged from r2)

```
interface ProviderDescriptor<N extends string = string> {
  readonly name: N;
  shouldRegister(ctx: { cfg: RuntimeProviderConfigLike | undefined; hasAccounts: boolean }): boolean;
  create(ctx: { providerConfig: RuntimeProviderConfigLike | undefined; accountConfig: RuntimeProviderAccountLike | undefined }): ModelProvider;
}

function makePiAiDescriptor<N extends string>(
  name: N,
  shouldRegister: ProviderDescriptor<N>["shouldRegister"],
): ProviderDescriptor<N> {
  return {
    name,
    shouldRegister,
    create: ({ providerConfig, accountConfig }) => {
      const provider = new PiAiProvider(name);
      const apiKey = accountConfig?.apiKey ?? providerConfig?.apiKey;
      if (apiKey) provider.setApiKey(apiKey);
      return provider;
    },
  };
}

const PROVIDER_DESCRIPTORS = [
  {
    name: "github-copilot",
    shouldRegister: ({ cfg, hasAccounts }) =>
      !!cfg || hasAccounts || hasOAuthCredentials("github-copilot"),
    create: ({ providerConfig, accountConfig }) => {
      const merged = { ...(providerConfig?.headers ?? {}), ...(accountConfig?.headers ?? {}) };
      const headers = Object.keys(merged).length > 0 ? merged : undefined;
      const apiKey = accountConfig?.apiKey ?? providerConfig?.apiKey;
      return new CopilotProvider(apiKey, headers);
    },
  },
  makePiAiDescriptor("anthropic", ({ cfg, hasAccounts }) =>
    !!cfg || hasAccounts || hasOAuthCredentials("anthropic") || !!process.env["ANTHROPIC_API_KEY"]),
  makePiAiDescriptor("openai", ({ cfg, hasAccounts }) =>
    !!cfg || hasAccounts || !!process.env["OPENAI_API_KEY"]),
  makePiAiDescriptor("openai-codex", ({ cfg, hasAccounts }) =>
    !!cfg || hasAccounts || hasOAuthCredentials("openai-codex") || !!process.env["OPENAI_CODEX_API_KEY"]),
  makePiAiDescriptor("opencode", ({ cfg, hasAccounts }) =>
    !!cfg || hasAccounts || !!process.env["OPENCODE_API_KEY"]),
  makePiAiDescriptor("opencode-go", ({ cfg, hasAccounts }) =>
    !!cfg || hasAccounts || !!process.env["OPENCODE_API_KEY"]),
  {
    name: "ollama",
    shouldRegister: () => true,
    create: ({ providerConfig, accountConfig }) =>
      new OllamaProvider(
        accountConfig?.baseUrl ?? providerConfig?.baseUrl,
        providerConfig?.defaultContextWindow,
      ),
  },
  {
    name: "llamacpp",
    shouldRegister: ({ cfg, hasAccounts }) =>
      !!cfg || hasAccounts || !!process.env["LLAMACPP_BASE_URL"],
    create: ({ providerConfig, accountConfig }) =>
      new LlamaCppProvider(
        accountConfig?.baseUrl ?? providerConfig?.baseUrl ?? process.env["LLAMACPP_BASE_URL"],
        providerConfig?.defaultContextWindow,
      ),
  },
] as const satisfies readonly ProviderDescriptor[];

type ProviderName = (typeof PROVIDER_DESCRIPTORS)[number]["name"];

const PROVIDER_DESCRIPTORS_BY_NAME: ReadonlyMap<ProviderName, ProviderDescriptor<ProviderName>> =
  new Map(PROVIDER_DESCRIPTORS.map((d) => [d.name, d as ProviderDescriptor<ProviderName>]));
```

Typing rationale unchanged from r2: literal `name` fields are preserved by `as const`; the generic `makePiAiDescriptor` carries the `N` literal through its return type; `satisfies readonly ProviderDescriptor[]` validates without widening; `typeof PROVIDER_DESCRIPTORS[number]["name"]` resolves to the literal union of all 8 names.

### Collapsed sites (unchanged from r2)

- **`initProviders`** iterates `PROVIDER_DESCRIPTORS` directly. No string-name re-lookup.
- **`shouldRegisterProvider`** is deleted (preferred) or reduced to a descriptor-only lookup that returns `false` for unknown names. No `default` branch returning truthy.
- **`createProvider`** looks up the descriptor; returns `undefined` for unknown names (defensive sentinel, structurally unreachable from real call sites).
- **`isProviderName(value)`** becomes `PROVIDER_DESCRIPTORS_BY_NAME.has(value as ProviderName)`. The function loses its second parameter; the failover-expansion call site at [src/providers/router.ts](../../../../src/providers/router.ts#L556) drops the `this.providerConfigs` argument.

Adding a 9th provider = append one entry.

## Trade-off matrix (unchanged from r2)

| Dimension | Proposal A | Proposal B (r3) |
| --- | --- | --- |
| Sites touched per new provider | 3 (tuple + 2 switches) | 1 (descriptor entry) |
| Compile-time safety on forgotten branch | exhaustiveness via union | inherent — no branch can exist to forget |
| `ProviderName` literal union derivable | yes (from tuple) | yes (from descriptor table via `as const satisfies` + generic helper) |
| `isProviderName` truth source | tuple | descriptor table only |
| `shouldRegisterProvider` `default` branch | retained | removed |
| File-level LOC delta | small (+5 / −10) | moderate (+50 / −85) |
| Reader effort to see all behaviour for a provider | scan 3 switch sites | one row in one table |
| Risk of unintended behavioural drift | none | low — closures mirror current branches; one intentional delta documented |
| Plays with G22 (PROVIDER_TO_OAUTH cleanup) | no help | descriptor is the natural future home for `oauthId` |
| Plays with F-G20-RENAME | no impact | no impact |

## Recommendation

Adopt **Proposal B (r3)**. Same rationale as r2: fewer name oracles (one); shape compatible with G22; literal `ProviderName` lands now; no public surface change.

## Why Proposal A is rejected (unchanged)

Two switches with implicit per-case correlation. Exhaustiveness closes "missing branch" but not "wrong constructor / wrong predicate".

## Public-surface impact

None. All four collapsing sites are private. `ModelRouter`'s exported API and constructor signature are unchanged. `ProviderName` is declared but not exported.

## Behavioural-delta acknowledgement (r3-rewritten)

The post-r3 implementation has one documented behavioural delta at the failover-expansion call site [src/providers/router.ts](../../../../src/providers/router.ts#L556). Split explicitly into a *preservation* clause and a *removal* clause so the test plan can target each one:

- **Preservation — descriptor names still expand.** Given no `modelEquivalents` and `failover: { "github-copilot": ["openai-codex"] }`, building `"github-copilot/claude-sonnet-4.6"` continues to produce `"openai-codex/claude-sonnet-4.6"` in the chain. `isProviderName("openai-codex")` is `true` against `PROVIDER_DESCRIPTORS_BY_NAME`, so the expansion at [src/providers/router.ts](../../../../src/providers/router.ts#L556) fires exactly as before. This is the contract that protects every existing real-world deployment using built-in provider-only failover chains.
- **Removal — arbitrary `providerConfigs` keys no longer expand.** Given `providerConfigs["not-a-real-provider"] = { apiKey: "x" }` and `failover["github-copilot/claude-sonnet-4.6"] = ["not-a-real-provider"]`, the post-r3 implementation no longer expands to `"not-a-real-provider/claude-sonnet-4.6"`. With descriptor-only `isProviderName`, the fallback is passed as a literal candidate spec to `appendCandidatesForModelSpec` at [src/providers/router.ts](../../../../src/providers/router.ts#L561). `tryParseModelId("not-a-real-provider")` returns `null` (no slash), the code falls into `expandProviderIndependentCandidates` at [src/providers/router.ts](../../../../src/providers/router.ts#L578), which filters registered providers that can serve model id `"not-a-real-provider"` — none can. The chain therefore contains *neither* `"not-a-real-provider/claude-sonnet-4.6"` *nor* the raw string `"not-a-real-provider"`. The only stable assertion the regression test can make is the non-containment of `"not-a-real-provider/claude-sonnet-4.6"`.

This delta:

- Has no documented or tested user scenario relying on the old behaviour. The only test using arbitrary `providerConfigs` keys ([src/providers/router.test.ts](../../../../src/providers/router.test.ts#L416-L442)) supplies a `gateway` key and only references full `provider/model` specs in failover.
- Matches the boot path's actual behaviour (only descriptor names ever instantiate, since `createProvider` already returns `undefined` for unknown names at [src/providers/router.ts](../../../../src/providers/router.ts#L811)).
- Is a deliberate removal of a second name oracle, per the round-1 reviewer's required change.

## Test impact (r3-rewritten)

- **Existing positive coverage of descriptor-name expansion is missing.** The live tests at [src/providers/router.test.ts](../../../../src/providers/router.test.ts#L73-L122) use full `provider/model` failover entries or explicit `modelEquivalents`; they do not exercise the provider-only expansion path at [src/providers/router.ts](../../../../src/providers/router.ts#L556). The legacy test at [src/providers/router.test.ts](../../../../src/providers/router.test.ts#L267-L283) is a **suppression** test, not positive expansion coverage:
  - It configures `modelEquivalents["github-copilot/claude-sonnet-4.6"] = ["openai-codex/gpt-5.3-codex"]` and `failover["github-copilot"] = ["openai-codex"]`.
  - It asserts the chain equals `["github-copilot/claude-sonnet-4.6", "openai-codex/gpt-5.3-codex"]` and explicitly `not.toContain("openai-codex/claude-sonnet-4.6")`.
  - The non-expansion is driven by the explicit-equivalent guard at [src/providers/router.ts](../../../../src/providers/router.ts#L555) (`this.modelEquivalents.has(modelSpec)` skips the provider-only expansion), *not* by the descriptor map. The test therefore proves nothing about descriptor membership.
- **New positive test (r3) — descriptor-name expansion preserved.** Added in the plan ([03-plan-r3.md](03-plan-r3.md)). No `modelEquivalents`. `failover: { "github-copilot": ["openai-codex"] }`. `buildChain("github-copilot/claude-sonnet-4.6")` must contain `"openai-codex/claude-sonnet-4.6"`. This is the only direct coverage of descriptor-name expansion through [src/providers/router.ts](../../../../src/providers/router.ts#L556).
- **New arbitrary-key regression (r3, corrected) — non-descriptor key not expanded.** `providerConfigs: { "not-a-real-provider": { apiKey: "x" } }`. `failover: { "github-copilot/claude-sonnet-4.6": ["not-a-real-provider"] }`. The only stable assertion is `expect(chain).not.toContain("not-a-real-provider/claude-sonnet-4.6")` — the raw fallback string is also absent (see the removal clause above), but the contract being defended is the non-expansion to `provider/model` form. The r2 form of this test asserted containment of the raw fallback string; r3 drops that assertion because the post-r3 implementation does not produce it.
- **Legacy suppression test preserved verbatim.** [src/providers/router.test.ts](../../../../src/providers/router.test.ts#L267-L283) continues to pass because the explicit-equivalent guard at [src/providers/router.ts](../../../../src/providers/router.ts#L555) is unchanged. r3 only relabels it in our prose; the file is not edited.
- **Header / constructor coverage unchanged.** [src/providers/copilot-router.test.ts](../../../../src/providers/copilot-router.test.ts#L25-L43) continues to pass — the descriptor's `create` closure mirrors the current branch exactly.

## Coordination notes (unchanged)

- Do not touch `PROVIDER_TO_OAUTH` ([src/providers/router.ts](../../../../src/providers/router.ts#L64-L69)) — G22.
- Descriptor type does not carry an `oauthId` field yet.
- F-G20-RENAME unaffected.

## r3 deltas vs r2

- **Behavioural-delta section rewritten.** Split into a *preservation* clause (descriptor names still expand) and a *removal* clause (arbitrary keys no longer expand). Removal clause explicitly states that the raw non-slashed fallback string is absent from the chain too, with the chain-builder line numbers ([src/providers/router.ts](../../../../src/providers/router.ts#L561), [src/providers/router.ts](../../../../src/providers/router.ts#L578)) that prove it.
- **Test impact section rewritten.**
  - [src/providers/router.test.ts](../../../../src/providers/router.test.ts#L267-L283) is now correctly described as a *suppression* test driven by the explicit-equivalent guard at [src/providers/router.ts](../../../../src/providers/router.ts#L555), not as positive built-in provider-only expansion coverage.
  - New positive expansion test announced (concrete shape in [03-plan-r3.md](03-plan-r3.md)).
  - Arbitrary-key regression assertion corrected: the only stable assertion is the non-containment of `"not-a-real-provider/claude-sonnet-4.6"`; the r2 `expect(chain).toContain("not-a-real-provider")` assertion is dropped because the post-r3 implementation does not produce that raw string.
- **Descriptor types/table, collapsed-sites prose, trade-off matrix, recommendation, public-surface impact, coordination notes** — unchanged from r2.
