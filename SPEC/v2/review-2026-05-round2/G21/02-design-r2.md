# G21 — Design (round 2)

**Writer**: Claude Opus 4.7. Supersedes [02-design-r1.md](02-design-r1.md). Same two proposals; r2 tightens **Proposal B** to address the two CHANGES_REQUESTED items from [04-review-r1.md](04-review-r1.md): drop the unknown-provider fallback, and keep the `ProviderName` literal union derivable now.

## Proposal A (focused fix) — extract one tuple, keep the switches

Unchanged from r1, and still rejected for the same reason: Proposal A keeps both per-provider switches, so the "predicate and factory must silently agree" hole remains. Adding exhaustiveness on a derived union closes the "missing branch" hole but not the "branch present, wrong constructor" hole. Project rule against keeping structures that exist only because they used to → reject.

## Proposal B (recommended, r2-tightened) — single descriptor table, switches deleted, descriptor membership is the only name oracle

Replace the four duplication sites with one descriptor tuple at the top of [src/providers/router.ts](../../../../src/providers/router.ts) that pairs each provider name with its registration predicate and its factory closure. Three structural choices in r2 differ from r1:

- The tuple is declared `as const satisfies readonly ProviderDescriptor[]`, with a generic helper for the pi-ai entries. Each row's `name` keeps its literal type.
- `shouldRegisterProvider` has no `default` branch. Unknown names return `false`. In practice the method is inlined into `initProviders` (descriptor-driven loop), so the method either disappears or shrinks to a one-line descriptor lookup. The "configured-only registers" behaviour for non-descriptor names is removed.
- `isProviderName` answers from `PROVIDER_DESCRIPTORS_BY_NAME` only. The OR with `providerConfigs`-key membership is removed.

### Descriptor types and table

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
  new Map(PROVIDER_DESCRIPTORS.map((d) => [d.name, d]));
```

Why the typing actually works:

- Each inline object literal is written directly (not through a factory that widens), so `as const` pins each `name` field to its literal.
- `makePiAiDescriptor<N extends string>(name: N, …): ProviderDescriptor<N>` carries `N` through the return type, so `makePiAiDescriptor("anthropic", …)` infers `N = "anthropic"` and the returned object's `name` field is `"anthropic"`, not `string`. The `as const` on the outer array preserves that literal across the tuple.
- `satisfies readonly ProviderDescriptor[]` validates each row against the descriptor shape without widening — `satisfies` keeps the literal information.
- `typeof PROVIDER_DESCRIPTORS[number]["name"]` therefore reduces to the literal union `"github-copilot" | "anthropic" | "openai" | "openai-codex" | "opencode" | "opencode-go" | "ollama" | "llamacpp"`.
- `ProviderName` does not need to be exported in G21; nothing outside `router.ts` consumes it yet. It is available for internal tightening (the descriptor map key type, future `parseModelId` callers, etc.) and trivially exportable when a downstream consumer materialises.

### Collapsed sites

- **`initProviders`** iterates `PROVIDER_DESCRIPTORS` directly. No string-name re-lookup. For each descriptor it builds `cfg`, calls `descriptor.shouldRegister`, and on success `descriptor.create` — registering under `descriptor.name`.
- **`shouldRegisterProvider`** is removed or reduced to a defensive descriptor lookup that returns `false` for unknown names. The r1 `default` branch (`!!cfg || hasAccounts`) is gone. Concretely: there is no remaining call site outside `initProviders` (full-file grep), so the cleanest path is to delete the method and inline its logic into `initProviders` via the descriptor closure.
- **`createProvider(providerName, accountName?)`** survives because `getProviderForRequest` calls it for per-account provider instantiation. r2 form looks up the descriptor and returns `undefined` for unknown names — no switch, no per-provider branches. Per-account `getProviderForRequest` only ever supplies provider names already present in `this.providers`, so the `undefined` path is structurally unreachable from real call sites; it remains as a defensive sentinel.
- **`isProviderName(value)`** becomes `PROVIDER_DESCRIPTORS_BY_NAME.has(value as ProviderName)`. No OR with `providerConfigs`. The function loses its second parameter; the failover-expansion call site at [src/providers/router.ts](../../../../src/providers/router.ts#L556) drops the `this.providerConfigs` argument.

Adding a 9th provider = append one entry. There is nowhere else to forget to edit.

## Trade-off matrix

| Dimension | Proposal A | Proposal B (r2) |
| --- | --- | --- |
| Sites touched per new provider | 3 (tuple + 2 switches) | 1 (descriptor entry) |
| Compile-time safety on forgotten branch | exhaustiveness via union | inherent — no branch can exist to forget |
| `ProviderName` literal union derivable | yes (from tuple) | yes (from descriptor table via `as const satisfies` + generic helper) |
| `isProviderName` truth source | tuple | descriptor table only |
| `shouldRegisterProvider` `default` branch | retained | removed |
| File-level LOC delta | small (+5 / −10) | moderate (+50 / −85) |
| Reader effort to see all behaviour for a provider | scan 3 switch sites | one row in one table |
| Risk of unintended behavioural drift | none | low — closures mirror current branches; one intentional delta documented in [01-analysis-r2.md](01-analysis-r2.md#L6) |
| Plays with G22 (PROVIDER_TO_OAUTH cleanup) | no help | descriptor is the natural future home for `oauthId` |
| Plays with F-G20-RENAME | no impact | no impact |

## Recommendation

Adopt **Proposal B (r2)**. Rationale:

1. The finding is about *silent partial registration when sources disagree*. r2 reduces the number of provider-name sources to one (the descriptor table) — strictly fewer than r1's two (descriptor + `providerConfigs`-key fallback). Proposal A retains both switches.
2. The descriptor table is the same shape G22's follow-up will want for the OAuth-id mapping. Doing Proposal A now means G22 either re-touches the same surface or introduces a parallel descriptor — duplication one level higher.
3. r2 preserves the literal `ProviderName` union in the implementation that lands. This is the type-level deliverable the r1 reviewer asked for; deferring it loses the main architectural gain of the refactor.
4. There is no backward-compatibility consideration: nothing outside `router.ts` reads any of the four sites, and every external string-typed reference continues to work because `ProviderName` is a subtype of `string`.

## Why Proposal A is rejected (unchanged)

Proposal A preserves the original sin: two switches with implicit per-case correlation. Exhaustiveness on a union closes the "missing branch" hole but leaves the "branch present, wrong constructor or wrong predicate" hole open, and it doubles the number of places a reader must consult to understand how provider X is wired.

## Public-surface impact

None. All four collapsing sites are private (`initProviders`, `shouldRegisterProvider`, `createProvider` are class-private; `isProviderName` is module-private; `knownProviders` is function-local). `ModelRouter`'s exported API and constructor signature are unchanged. No exports added or removed. `ProviderName` is declared but not exported.

## Behavioural-delta acknowledgement

One observable behavioural delta exists vs head, documented in detail in [01-analysis-r2.md](01-analysis-r2.md#L6): failover expansion at [src/providers/router.ts](../../../../src/providers/router.ts#L556) no longer treats arbitrary `providerConfigs` keys as provider names for the purpose of expanding `failover.<spec>: ["X"]` into `X/<model>`. Only descriptor names trigger expansion. This delta:

- Has no documented or tested user scenario relying on the old behaviour.
- Matches the boot path's actual behaviour (only descriptor names ever instantiate, since `createProvider` returns `undefined` for unknown names at [src/providers/router.ts](../../../../src/providers/router.ts#L811)).
- Is a deliberate removal of a second name oracle, per the round-1 reviewer's required change.

## Test impact

- [src/providers/router.test.ts](../../../../src/providers/router.test.ts) — all existing assertions are on resolved chains and on `listProviders()` output (a `Map.keys()` snapshot). Descriptor iteration order matches the prior `knownProviders` literal exactly. The existing built-in provider-only failover test at [src/providers/router.test.ts](../../../../src/providers/router.test.ts#L268-L283) continues to pass: `"openai-codex"` and `"github-copilot"` are descriptor names, so the expansion path still fires.
- A **new focused regression test** is added in [src/providers/router.test.ts](../../../../src/providers/router.test.ts) that proves an arbitrary `providerConfigs` key is **not** treated as a provider-only failover name. See the plan §1.6 for the concrete test body.
- [src/providers/copilot-router.test.ts](../../../../src/providers/copilot-router.test.ts) — exercises the `github-copilot` create-branch including header merging. The descriptor's `create` closure mirrors the current branch exactly, so this test continues to pass.
- Provider unit tests are not touched.

## Coordination notes

- Do **not** touch `PROVIDER_TO_OAUTH` ([src/providers/router.ts](../../../../src/providers/router.ts#L64-L69)) in this batch — G22's seam.
- The descriptor type intentionally does **not** carry an `oauthId` field yet.
- F-G20-RENAME stays unaffected; descriptor closures reference the same constructor symbols as today.

## r2 deltas vs r1

- Type-level — descriptor interface is generic in `N extends string`, the pi-ai helper is generic, the table is declared `as const satisfies readonly ProviderDescriptor[]`. `ProviderName` is derivable inside the file as the landed type, not a follow-up.
- Registration path — `shouldRegisterProvider` no longer has a `default` branch. Either it is removed (preferred — only `initProviders` calls it) or it returns `false` for non-descriptor names.
- Name oracle — `isProviderName` consults the descriptor map only. The OR with `providerConfigs`-key membership is removed and the function's second parameter is dropped. Call site at [src/providers/router.ts](../../../../src/providers/router.ts#L556) updated accordingly.
- Boot path — `initProviders` iterates `PROVIDER_DESCRIPTORS` directly and passes the descriptor object through, rather than re-looking up by string.
- Test surface — adds one targeted regression around arbitrary `providerConfigs` keys; existing built-in provider-only failover test at [src/providers/router.test.ts](../../../../src/providers/router.test.ts#L268-L283) explicitly listed as a preservation check.
- Follow-ups — F-G21-EXPORT-PROVIDERNAME removed (the type lands in r2). F-G21-OAUTH-IN-DESCRIPTOR retained.
