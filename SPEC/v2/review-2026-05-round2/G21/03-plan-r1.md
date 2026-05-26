# G21 — Plan (round 1)

**Writer**: Claude Opus 4.7. Implements Proposal B from [02-design-r1.md](02-design-r1.md). Single-file change inside [src/providers/router.ts](../../../../src/providers/router.ts); no other source file or test fixture is touched.

## 0. Preconditions

- Working tree clean on the saivage repo, or only G21-scoped edits pending.
- G20 already landed (verified: router.ts imports only `CopilotProvider`, `PiAiProvider`, `OllamaProvider`, `LlamaCppProvider` at [src/providers/router.ts](../../../../src/providers/router.ts#L15-L18)).
- No concurrent in-flight edit to [src/providers/router.ts](../../../../src/providers/router.ts) from G22-G26.

## 1. Edits

All edits live in [src/providers/router.ts](../../../../src/providers/router.ts).

### 1.1 Add descriptor types and table

Insert a new block immediately **after** the existing `PROVIDER_TO_OAUTH` constant ([src/providers/router.ts](../../../../src/providers/router.ts#L62-L69)) and **before** `export class ModelRouter` ([src/providers/router.ts](../../../../src/providers/router.ts#L71)). New code:

```
interface ProviderDescriptor {
  readonly name: string;
  shouldRegister(ctx: { cfg: RuntimeProviderConfigLike | undefined; hasAccounts: boolean }): boolean;
  create(ctx: { providerConfig: RuntimeProviderConfigLike | undefined; accountConfig: RuntimeProviderAccountLike | undefined }): ModelProvider;
}

function makePiAiDescriptor(
  name: string,
  shouldRegister: ProviderDescriptor["shouldRegister"],
): ProviderDescriptor {
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

const PROVIDER_DESCRIPTORS: readonly ProviderDescriptor[] = [
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
];

const PROVIDER_DESCRIPTORS_BY_NAME: ReadonlyMap<string, ProviderDescriptor> =
  new Map(PROVIDER_DESCRIPTORS.map((d) => [d.name, d]));
```

Iteration order of `PROVIDER_DESCRIPTORS` matches the prior `knownProviders` literal exactly, so `ModelRouter.listProviders()` ordering and any test snapshots that rely on it are preserved.

### 1.2 Collapse `initProviders`

Replace [src/providers/router.ts](../../../../src/providers/router.ts#L102-L121) with:

```
  private initProviders(config: SaivageConfig): void {
    void config;
    for (const descriptor of PROVIDER_DESCRIPTORS) {
      if (!this.shouldRegisterProvider(descriptor.name)) continue;
      const provider = this.createProvider(descriptor.name);
      if (provider) this.providers.set(descriptor.name, provider);
    }
  }
```

### 1.3 Collapse `shouldRegisterProvider`

Replace the switch body at [src/providers/router.ts](../../../../src/providers/router.ts#L731-L754) with:

```
  private shouldRegisterProvider(providerName: string): boolean {
    const cfg = this.providerConfigs[providerName];
    const hasAccounts = Object.keys(cfg?.accounts ?? {}).length > 0;
    const descriptor = PROVIDER_DESCRIPTORS_BY_NAME.get(providerName);
    if (descriptor) return descriptor.shouldRegister({ cfg, hasAccounts });
    return !!cfg || hasAccounts;
  }
```

The unknown-provider fallback (`!!cfg || hasAccounts`) preserves the prior `default` branch behaviour for names that appear in `providerConfigs` but are not in the descriptor table.

### 1.4 Collapse `createProvider`

Replace the switch body at [src/providers/router.ts](../../../../src/providers/router.ts#L766-L816) with:

```
  private createProvider(providerName: string, accountName?: string): ModelProvider | undefined {
    const descriptor = PROVIDER_DESCRIPTORS_BY_NAME.get(providerName);
    if (!descriptor) return undefined;
    const accountConfig = accountName ? this.getAccountConfig(providerName, accountName) : undefined;
    const providerConfig = this.providerConfigs[providerName];
    return descriptor.create({ providerConfig, accountConfig });
  }
```

The two unused locals (`apiKey`, `baseUrl`) at [src/providers/router.ts](../../../../src/providers/router.ts#L769-L770) move into each descriptor's `create` closure where they are actually consumed.

### 1.5 Collapse `isProviderName`

Replace the function body at [src/providers/router.ts](../../../../src/providers/router.ts#L871-L881) with:

```
function isProviderName(value: string, providerConfigs: Record<string, RuntimeProviderConfigLike>): boolean {
  return PROVIDER_DESCRIPTORS_BY_NAME.has(value) ||
    Object.prototype.hasOwnProperty.call(providerConfigs, value);
}
```

The previously-inlined 8-name array goes away; the descriptor map is the single source.

### 1.6 No other edits

- Do **not** touch `PROVIDER_TO_OAUTH` ([src/providers/router.ts](../../../../src/providers/router.ts#L64-L69)) — owned by G22.
- Do **not** change imports (`PiAiProvider`, `CopilotProvider`, `OllamaProvider`, `LlamaCppProvider`, `hasOAuthCredentials` are all already imported at [src/providers/router.ts](../../../../src/providers/router.ts#L14-L19)).
- Do **not** modify any `*.test.ts` file. The test surface only depends on `listProviders()` output and behavioural equivalence of the create branches; both are preserved.

## 2. Validation (run in [/home/salva/g/ml/saivage](../../../../)):

Run in order; do not move on if any step regresses.

1. Typecheck — `npm run typecheck` (i.e. `tsc --noEmit`). Expected: clean, identical to baseline.
2. Focused router tests — `npx vitest run src/providers/router.test.ts src/providers/copilot-router.test.ts`. Expected: all green; pay attention to `listProviders()` ordering snapshot at [src/providers/router.test.ts](../../../../src/providers/router.test.ts#L65) and to the github-copilot header path at [src/providers/copilot-router.test.ts](../../../../src/providers/copilot-router.test.ts#L25-L43).
3. Focused provider unit tests touching the constructors invoked by descriptors — `npx vitest run src/providers/copilot.test.ts src/providers/ollama.test.ts src/providers/llamacpp.test.ts src/providers/pi-ai.test.ts`. Expected: all green (unaffected, sanity).
4. Lint — `npm run lint`. Note: lint is known-broken upstream (missing `typescript-eslint` dependency, per workspace memory). If lint still fails with the same dependency error, that is not a G21 regression; record the output and move on. If lint surfaces *new* warnings on `src/providers/router.ts`, fix them before merge.
5. Full vitest — `npm test`. Expected: identical pass count to baseline minus zero failures.
6. Build — `npm run build`. Expected: `tsup` succeeds; produces `dist/cli.js` etc.

If any step fails, stop and report. Do not attempt to "rebalance" by editing tests — the descriptor must match current behaviour exactly.

## 3. Operator-gated deployment

This change is internal to `ModelRouter`'s wiring and observable behaviour is unchanged for any currently-configured deployment (the same provider set is registered under the same names, with the same constructors, in the same iteration order). Therefore:

- **No automatic restart of `saivage.service` on any container.**
- Ask the operator before bouncing `saivage-v3` (10.0.3.112). The `saivage` (10.0.3.111) and `diedrico` (10.0.3.113) services bind-mount the host `saivage/` tree too — confirm with the operator before restart there as well.
- A restart is only justified after at least steps 1, 2, 5, 6 above are green.

Health-check command after any operator-approved restart:

```
ssh root@10.0.3.112 'systemctl restart saivage.service && sleep 4 && systemctl is-active saivage.service && curl -fsS http://127.0.0.1:8080/health'
```

## 4. Done criteria

- All four duplication sites listed in [01-analysis-r1.md](01-analysis-r1.md) §2 are gone; `grep -n 'knownProviders\|"github-copilot",\s*"anthropic"' src/providers/router.ts` returns at most the descriptor table itself (one match for the table, none for the four old sites).
- `tsc --noEmit` clean.
- `vitest run` full suite passes with no new failures vs. baseline.
- `npm run build` produces a bundle.
- No new exports introduced; `git diff --stat` shows changes only in [src/providers/router.ts](../../../../src/providers/router.ts).

## 5. Rollback

`git checkout -- src/providers/router.ts` reverts the entire change atomically; no other file is touched.

## 6. Follow-ups (filed, not implemented here)

- F-G21-OAUTH-IN-DESCRIPTOR — once G22 lands, fold the OAuth-id mapping into `ProviderDescriptor` as an optional `oauthId` field and drop `PROVIDER_TO_OAUTH`. Out of scope for G21.
- F-G21-EXPORT-PROVIDERNAME — if a downstream caller wants `ProviderName` as a literal union, narrow the `name` field via `as const` on the array literal and export the derived type. Defer until a real consumer exists.
