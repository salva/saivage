# G21 — Design (round 1)

**Writer**: Claude Opus 4.7. Two proposals; one recommended.

## Proposal A (focused fix) — extract one tuple, keep the switches

Introduce a module-local `const KNOWN_PROVIDERS = [...] as const` tuple, derive `type ProviderName = (typeof KNOWN_PROVIDERS)[number]`, and:

- Replace `knownProviders` (function-local literal at [src/providers/router.ts](../../../../src/providers/router.ts#L105-L114)) by iteration over the tuple.
- Replace the fallback literal inside `isProviderName` ([src/providers/router.ts](../../../../src/providers/router.ts#L871-L881)) by `(KNOWN_PROVIDERS as readonly string[]).includes(value)`.
- Keep the `shouldRegisterProvider` switch and the `createProvider` switch but type their parameter as `ProviderName`, with `assertExhaustive(providerName)` in the `default` branch so `tsc` flags missing cases.

Effect: four literal lists collapse to one; the two switches survive but become exhaustiveness-checked over the same union.

Cost: still two pieces of code that must be edited per new provider (the tuple plus each switch). The switches remain dense per-provider branches; the editing burden falls from 4 to 3 sites but the file shape barely changes.

## Proposal B (one conceptual level up) — single descriptor table, switches deleted

Replace the four duplicate sites with one descriptor tuple at the top of [src/providers/router.ts](../../../../src/providers/router.ts) that pairs each provider name with its registration predicate and its factory closure.

```
type ProviderDescriptor = {
  name: string;
  shouldRegister: (ctx: { cfg?: RuntimeProviderConfigLike; hasAccounts: boolean }) => boolean;
  create: (ctx: { providerConfig?: RuntimeProviderConfigLike; accountConfig?: RuntimeProviderAccountLike }) => ModelProvider;
};

const PROVIDER_DESCRIPTORS = [
  {
    name: "github-copilot",
    shouldRegister: ({ cfg, hasAccounts }) => !!cfg || hasAccounts || hasOAuthCredentials("github-copilot"),
    create: ({ providerConfig, accountConfig }) => {
      const merged = { ...(providerConfig?.headers ?? {}), ...(accountConfig?.headers ?? {}) };
      const headers = Object.keys(merged).length > 0 ? merged : undefined;
      return new CopilotProvider(accountConfig?.apiKey ?? providerConfig?.apiKey, headers);
    },
  },
  { name: "anthropic",     shouldRegister: ({ cfg, hasAccounts }) => !!cfg || hasAccounts || hasOAuthCredentials("anthropic") || !!process.env["ANTHROPIC_API_KEY"],   create: ({ providerConfig, accountConfig }) => piAi("anthropic", providerConfig, accountConfig) },
  { name: "openai",        shouldRegister: ({ cfg, hasAccounts }) => !!cfg || hasAccounts || !!process.env["OPENAI_API_KEY"],                                          create: ({ providerConfig, accountConfig }) => piAi("openai", providerConfig, accountConfig) },
  { name: "openai-codex",  shouldRegister: ({ cfg, hasAccounts }) => !!cfg || hasAccounts || hasOAuthCredentials("openai-codex") || !!process.env["OPENAI_CODEX_API_KEY"], create: ({ providerConfig, accountConfig }) => piAi("openai-codex", providerConfig, accountConfig) },
  { name: "opencode",      shouldRegister: ({ cfg, hasAccounts }) => !!cfg || hasAccounts || !!process.env["OPENCODE_API_KEY"],                                        create: ({ providerConfig, accountConfig }) => piAi("opencode", providerConfig, accountConfig) },
  { name: "opencode-go",   shouldRegister: ({ cfg, hasAccounts }) => !!cfg || hasAccounts || !!process.env["OPENCODE_API_KEY"],                                        create: ({ providerConfig, accountConfig }) => piAi("opencode-go", providerConfig, accountConfig) },
  { name: "ollama",        shouldRegister: () => true,                                                                                                                 create: ({ providerConfig, accountConfig }) => new OllamaProvider(accountConfig?.baseUrl ?? providerConfig?.baseUrl, providerConfig?.defaultContextWindow) },
  { name: "llamacpp",      shouldRegister: ({ cfg, hasAccounts }) => !!cfg || hasAccounts || !!process.env["LLAMACPP_BASE_URL"],                                       create: ({ providerConfig, accountConfig }) => new LlamaCppProvider(accountConfig?.baseUrl ?? providerConfig?.baseUrl ?? process.env["LLAMACPP_BASE_URL"], providerConfig?.defaultContextWindow) },
] as const satisfies readonly ProviderDescriptor[];

const PROVIDER_DESCRIPTORS_BY_NAME: ReadonlyMap<string, ProviderDescriptor> =
  new Map(PROVIDER_DESCRIPTORS.map((d) => [d.name, d]));
const PROVIDER_NAMES: readonly string[] =
  PROVIDER_DESCRIPTORS.map((d) => d.name);
```

Where `piAi` is a tiny module-private helper that captures the four-line `new PiAiProvider(name); if (apiKey) setApiKey(apiKey); return provider;` pattern shared by the five pi-ai-backed names:

```
function piAi(name: string, providerConfig?: RuntimeProviderConfigLike, accountConfig?: RuntimeProviderAccountLike): ModelProvider {
  const provider = new PiAiProvider(name);
  const apiKey = accountConfig?.apiKey ?? providerConfig?.apiKey;
  if (apiKey) provider.setApiKey(apiKey);
  return provider;
}
```

The four duplication sites then collapse:

- `initProviders` iterates `PROVIDER_DESCRIPTORS`, calls `descriptor.shouldRegister`, then `descriptor.create`.
- `shouldRegisterProvider` becomes a one-liner that looks up the descriptor and delegates (or returns `!!cfg || hasAccounts` if no descriptor is found — preserves the prior `default` branch semantics for unknown configured-only names).
- `createProvider(providerName, accountName?)` looks up the descriptor and calls `descriptor.create({ providerConfig, accountConfig })`. The switch is gone.
- `isProviderName` becomes `PROVIDER_DESCRIPTORS_BY_NAME.has(value) || Object.prototype.hasOwnProperty.call(providerConfigs, value)`.

Adding a 9th provider = append one entry. There is nowhere else to forget to edit.

## Trade-off matrix

| Dimension | Proposal A | Proposal B |
| --- | --- | --- |
| Sites touched per new provider | 3 (tuple + 2 switches) | 1 (descriptor entry) |
| Compile-time safety on forgotten branch | exhaustiveness via union | inherent — no branch can exist to forget |
| File-level LOC delta | small (+5 / −10) | moderate (+50 / −80) |
| Reader effort to see all behaviour for a provider | scan 3 switch sites | one row in one table |
| Risk of unintended behavioural drift | none | low — closures must mirror current branches |
| Plays with G22 (PROVIDER_TO_OAUTH cleanup) | no help | descriptor is the natural future home for `oauthId` |
| Plays with F-G20-RENAME | no impact | no impact (constructor names are referenced from descriptor closures, same as today) |

## Recommendation

Adopt **Proposal B**. Rationale:

1. The finding is explicitly about *silent partial registration when a single switch case is forgotten*. Proposal A retains both switches and so retains the failure mode in attenuated form (a future contributor still has to remember "the predicate and the factory must agree"). Proposal B removes the failure mode by removing the switches entirely; the predicate and factory live in the same descriptor row and cannot be added or removed independently.
2. The descriptor table is the same structure G22's follow-up will want for the OAuth-id mapping. Doing Proposal A now means G22 either re-touches the same surface or introduces a parallel descriptor — exactly the duplication this finding objects to, one level higher.
3. The added LOC is paid for by deleting four blocks; the net file shrinks slightly and the cognitive load drops more.
4. There is no backward-compatibility consideration: nothing outside `router.ts` reads any of the four sites, and every external string-typed reference to a provider name continues to work because the union type is structurally compatible with `string`.

## Why Proposal A is rejected

Proposal A is a textbook "minimal change" that preserves the original sin: two switches with implicit per-case correlation. The whole point of G21 is that the correlation is invisible to `tsc`, code review, and tests. Exhaustiveness checks on the union close the "missing branch" hole but leave the "branch present, wrong constructor or wrong predicate" hole open, and they double the number of places a reader must consult to understand how provider X is wired. Given the project rule "actively REMOVE code supporting old structures rather than keeping migration shims", switches that exist only because they used to are exactly the structures to remove.

## Public-surface impact

None. All four sites are private (`initProviders`, `shouldRegisterProvider`, `createProvider` are class-private methods; `isProviderName` is module-private; `knownProviders` is function-local). `ModelRouter`'s exported API and constructor signature are unchanged. No exports added or removed.

## Test impact

- [src/providers/router.test.ts](../../../../src/providers/router.test.ts) — all assertions are on resolved chains and on `listProviders()` output (a `Map.keys()` snapshot). The descriptor iteration order is the same as the previous literal array, so `listProviders()` ordering is preserved.
- [src/providers/copilot-router.test.ts](../../../../src/providers/copilot-router.test.ts) — exercises the `github-copilot` create-branch including header merging. The descriptor's `create` closure mirrors the current branch exactly, so this test continues to pass.
- Provider unit tests ([anthropic.test.ts](../../../../src/providers/anthropic.test.ts), [openai.test.ts](../../../../src/providers/openai.test.ts), …) are not touched by G21 — they construct providers directly without going through the router.

## Coordination notes (for the reviewer and downstream tickets)

- Do **not** touch `PROVIDER_TO_OAUTH` ([src/providers/router.ts](../../../../src/providers/router.ts#L64-L69)) in this batch. The descriptor type intentionally does **not** carry an `oauthId` field yet — that is G22's seam.
- The follow-up F-G20-RENAME can later rename `OpenAIProvider` to `OpenAICompatProvider` without touching G21's descriptors, because the closures use `PiAiProvider`/`OllamaProvider`/`LlamaCppProvider`/`CopilotProvider` only.
- The descriptor pattern intentionally does not export the table; if a future caller needs `ProviderName` as a literal union, it can be exported in a separate ticket after the table stabilises.
