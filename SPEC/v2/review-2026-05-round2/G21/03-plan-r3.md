# G21 — Plan (round 3)

**Writer**: Claude Opus 4.7. Implements **Proposal B (r3)** from [02-design-r3.md](02-design-r3.md). Supersedes [03-plan-r2.md](03-plan-r2.md). Two-file change: [src/providers/router.ts](../../../../src/providers/router.ts) (refactor) and [src/providers/router.test.ts](../../../../src/providers/router.test.ts) (two new tests: one positive expansion, one corrected arbitrary-key regression).

## 0. Preconditions

- Working tree clean on the saivage repo, or only G21-scoped edits pending.
- G20 already landed (router.ts imports only `CopilotProvider`, `PiAiProvider`, `OllamaProvider`, `LlamaCppProvider` at [src/providers/router.ts](../../../../src/providers/router.ts#L15-L18)).
- No concurrent in-flight edit to [src/providers/router.ts](../../../../src/providers/router.ts) from G22-G26.

## 1. Edits

### 1.1 Add descriptor types and table — [src/providers/router.ts](../../../../src/providers/router.ts) (unchanged from r2)

Insert immediately **after** `PROVIDER_TO_OAUTH` ([src/providers/router.ts](../../../../src/providers/router.ts#L62-L69)) and **before** `export class ModelRouter` ([src/providers/router.ts](../../../../src/providers/router.ts#L71)):

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
  new Map(
    PROVIDER_DESCRIPTORS.map((d) => [d.name, d as ProviderDescriptor<ProviderName>]),
  );
```

Iteration order matches the prior `knownProviders` literal exactly, so `ModelRouter.listProviders()` ordering is preserved (used by the snapshot expectation at [src/providers/router.test.ts](../../../../src/providers/router.test.ts#L65)).

Typing notes (unchanged from r2): each row's `name` keeps its literal via `as const`; `makePiAiDescriptor<N extends string>(...)` propagates `N`; `satisfies readonly ProviderDescriptor[]` validates without widening; `typeof PROVIDER_DESCRIPTORS[number]["name"]` resolves to the literal union of all 8 names.

### 1.2 Collapse `initProviders` — descriptor-driven loop (unchanged from r2)

Replace the body at [src/providers/router.ts](../../../../src/providers/router.ts#L102-L119) with:

```
  private initProviders(_config: SaivageConfig): void {
    for (const descriptor of PROVIDER_DESCRIPTORS) {
      const cfg = this.providerConfigs[descriptor.name];
      const hasAccounts = Object.keys(cfg?.accounts ?? {}).length > 0;
      if (!descriptor.shouldRegister({ cfg, hasAccounts })) continue;
      const provider = descriptor.create({ providerConfig: cfg, accountConfig: undefined });
      this.providers.set(descriptor.name, provider);
    }
  }
```

### 1.3 Delete `shouldRegisterProvider` (unchanged from r2)

Remove the method entirely at [src/providers/router.ts](../../../../src/providers/router.ts#L731-L754). Only caller is the prior `initProviders` body, replaced by §1.2. No external consumer.

### 1.4 Collapse `createProvider` — descriptor lookup only (unchanged from r2)

Replace the body at [src/providers/router.ts](../../../../src/providers/router.ts#L766-L815) with:

```
  private createProvider(providerName: string, accountName?: string): ModelProvider | undefined {
    const descriptor = PROVIDER_DESCRIPTORS_BY_NAME.get(providerName as ProviderName);
    if (!descriptor) return undefined;
    const accountConfig = accountName ? this.getAccountConfig(providerName, accountName) : undefined;
    const providerConfig = this.providerConfigs[providerName];
    return descriptor.create({ providerConfig, accountConfig });
  }
```

### 1.5 Collapse `isProviderName` — descriptor-map only, single parameter (unchanged from r2)

Replace the function body at [src/providers/router.ts](../../../../src/providers/router.ts#L871-L881) with:

```
function isProviderName(value: string): boolean {
  return PROVIDER_DESCRIPTORS_BY_NAME.has(value as ProviderName);
}
```

Update the single call site at [src/providers/router.ts](../../../../src/providers/router.ts#L556) to drop the `this.providerConfigs` argument:

```
    const next = parsed && isProviderName(fallback) ? `${fallback}/${model}` : fallback;
```

### 1.6 New positive expansion test (r3) — [src/providers/router.test.ts](../../../../src/providers/router.test.ts)

Add the following test inside the existing `describe("ModelRouter", …)` block, **before** the existing suppression test at [src/providers/router.test.ts](../../../../src/providers/router.test.ts#L267-L283) so the contrast reads in order: positive built-in expansion, then suppression by explicit equivalent.

```
  it("expands built-in provider-only failover into provider/model specs", () => {
    const router = new ModelRouter(makeConfig({
      failover: {
        "github-copilot": ["openai-codex"],
      },
    }));

    const chain = (router as unknown as { buildChain(modelSpec: string): string[] }).buildChain("github-copilot/claude-sonnet-4.6");

    // Descriptor membership is the sole oracle: "openai-codex" is a descriptor name,
    // so the provider-only failover entry expands with the requesting spec's model.
    expect(chain).toContain("openai-codex/claude-sonnet-4.6");
  });
```

Why this is the right positive test:

- It is the *only* direct coverage of the descriptor-name expansion path at [src/providers/router.ts](../../../../src/providers/router.ts#L556). No other test exercises this code path: full `provider/model` failover entries skip the expansion branch; explicit `modelEquivalents` trigger the suppression guard at [src/providers/router.ts](../../../../src/providers/router.ts#L555).
- It uses no `modelEquivalents`, so the suppression guard at [src/providers/router.ts](../../../../src/providers/router.ts#L555) does not fire. The only thing keeping the test green is `isProviderName("openai-codex")` returning `true` against the descriptor map.
- It uses a descriptor name as the failover target, so it proves the post-r3 descriptor-only `isProviderName` still expands real provider names.

### 1.7 Corrected arbitrary-key regression test (r3) — [src/providers/router.test.ts](../../../../src/providers/router.test.ts)

Add the following test inside the same `describe("ModelRouter", …)` block, **after** the existing suppression test at [src/providers/router.test.ts](../../../../src/providers/router.test.ts#L267-L283) so the three tests read together: positive expansion, suppression by explicit equivalent, arbitrary-key non-expansion.

```
  it("does not treat arbitrary providerConfigs keys as provider-only failover names", () => {
    const router = new ModelRouter(makeConfig({
      providers: {
        "not-a-real-provider": { apiKey: "x" },
      },
      failover: {
        "github-copilot/claude-sonnet-4.6": ["not-a-real-provider"],
      },
    }));

    const chain = (router as unknown as { buildChain(modelSpec: string): string[] }).buildChain("github-copilot/claude-sonnet-4.6");

    // Post-r3 contract: descriptor membership is the only provider-name oracle.
    // An arbitrary providerConfigs key is NOT a provider, so the failover entry
    // must NOT be expanded into "<key>/<model>".
    expect(chain).not.toContain("not-a-real-provider/claude-sonnet-4.6");
  });
```

Why the assertion is only the non-containment of the expanded form:

- With descriptor-only `isProviderName`, `isProviderName("not-a-real-provider")` returns `false`. The expansion at [src/providers/router.ts](../../../../src/providers/router.ts#L556) therefore leaves `"not-a-real-provider"` as the literal `next` value.
- `appendCandidatesForModelSpec("not-a-real-provider")` at [src/providers/router.ts](../../../../src/providers/router.ts#L561) calls `tryParseModelId("not-a-real-provider")`, which returns `null` because there is no slash.
- The code falls into `expandProviderIndependentCandidates("not-a-real-provider", ...)` at [src/providers/router.ts](../../../../src/providers/router.ts#L578), which iterates `this.providers.keys()` and emits only registered providers that can serve model id `"not-a-real-provider"`. No descriptor provider serves that model id, so the filter yields zero candidates.
- Result: neither `"not-a-real-provider/claude-sonnet-4.6"` nor the raw string `"not-a-real-provider"` appears in the chain. The r2 assertion `expect(chain).toContain("not-a-real-provider")` is wrong for the desired implementation and is dropped.
- The single non-containment assertion is the only stable contract the test can defend: it directly observes the round-1 reviewer's required behaviour (arbitrary keys not treated as providers) without baking in implementation details of `expandProviderIndependentCandidates`.

### 1.8 No other edits

- Do **not** touch `PROVIDER_TO_OAUTH` ([src/providers/router.ts](../../../../src/providers/router.ts#L64-L69)) — G22.
- Do **not** change imports.
- Do **not** modify other `*.test.ts` files.
- Do **not** edit the legacy suppression test at [src/providers/router.test.ts](../../../../src/providers/router.test.ts#L267-L283). It continues to pass because the explicit-equivalent guard at [src/providers/router.ts](../../../../src/providers/router.ts#L555) is unchanged. r3 only relabels it in prose.
- Do **not** export `ProviderName`.

## 2. Validation (run in [/home/salva/g/ml/saivage](../../../../))

Run in order; do not move on if any step regresses.

1. **Typecheck** — `npm run typecheck` (i.e. `tsc --noEmit`). Expected: clean. Pay attention to the `as const satisfies readonly ProviderDescriptor[]` block — if the generic `makePiAiDescriptor` inference is wrong, `ProviderName` collapses to `string`.
2. **Focused router tests** — `npx vitest run src/providers/router.test.ts src/providers/copilot-router.test.ts`. Expected: all green, including:
   - `listProviders()` ordering snapshot at [src/providers/router.test.ts](../../../../src/providers/router.test.ts#L65).
   - GitHub-copilot header path at [src/providers/copilot-router.test.ts](../../../../src/providers/copilot-router.test.ts#L25-L43).
   - **Existing suppression test** at [src/providers/router.test.ts](../../../../src/providers/router.test.ts#L267-L283) — asserts that the failover for `"github-copilot"` → `"openai-codex"` is *not* expanded into `"openai-codex/claude-sonnet-4.6"` when `modelEquivalents["github-copilot/claude-sonnet-4.6"]` exists. Pass condition is driven by the explicit-equivalent guard at [src/providers/router.ts](../../../../src/providers/router.ts#L555). This test does **not** exercise descriptor-name expansion.
   - **New positive expansion test (§1.6)** — the only direct coverage of descriptor-name expansion through [src/providers/router.ts](../../../../src/providers/router.ts#L556).
   - **New corrected arbitrary-key regression (§1.7)** — proves descriptor-only `isProviderName` rejects non-descriptor keys.
3. **Focused provider unit tests** — `npx vitest run src/providers/copilot.test.ts src/providers/ollama.test.ts src/providers/llamacpp.test.ts src/providers/pi-ai.test.ts`. Expected: all green.
4. **Lint** — `npm run lint`. Known broken upstream (missing `typescript-eslint` dep). If lint still fails with the same dependency error, it is not a G21 regression.
5. **Full vitest** — `npm test`. Expected: identical pass count to baseline plus the two new tests from §1.6 and §1.7.
6. **Build** — `npm run build`. Expected: `tsup` succeeds; `dist/cli.js` produced.

If any step fails, stop and report. Do not "rebalance" by editing existing tests — the descriptor must mirror current behaviour exactly except for the documented delta in [02-design-r3.md](02-design-r3.md) "Behavioural-delta acknowledgement".

## 3. Operator-gated deployment

Internal-wiring change. Same set of providers registered under the same names, same constructors, same iteration order. One documented behavioural delta (failover expansion no longer fires for arbitrary `providerConfigs` keys) — no existing deployment exercises that path. Therefore:

- **No automatic restart of `saivage.service` on any container.**
- Ask the operator before bouncing `saivage-v3` (10.0.3.112). `saivage` (10.0.3.111) and `diedrico` (10.0.3.113) bind-mount the host `saivage/` tree too — confirm before restart.
- A restart is only justified after steps 1, 2, 5, 6 are green.

Health-check after any operator-approved restart:

```
ssh root@10.0.3.112 'systemctl restart saivage.service && sleep 4 && systemctl is-active saivage.service && curl -fsS http://127.0.0.1:8080/health'
```

## 4. Done criteria

- All four duplication sites listed in [01-analysis-r3.md](01-analysis-r3.md) §2 are gone. `grep -n 'knownProviders\|"github-copilot",\s*"anthropic"' src/providers/router.ts` returns at most the descriptor table itself.
- `shouldRegisterProvider` is deleted. `grep -n 'shouldRegisterProvider' src/providers/router.ts` returns zero hits.
- `isProviderName` takes one parameter and reads only `PROVIDER_DESCRIPTORS_BY_NAME`. `grep -n 'isProviderName' src/providers/router.ts` shows the single call site at the failover expansion with one argument.
- `type ProviderName` is declared in [src/providers/router.ts](../../../../src/providers/router.ts) and derives from the descriptor table.
- `tsc --noEmit` clean.
- `vitest run` full suite passes with **two** additional passing tests (§1.6 positive expansion, §1.7 corrected arbitrary-key regression) vs. baseline.
- `npm run build` produces a bundle.
- No new exports introduced; `git diff --stat` shows changes only in [src/providers/router.ts](../../../../src/providers/router.ts) and [src/providers/router.test.ts](../../../../src/providers/router.test.ts).

## 5. Rollback

`git checkout -- src/providers/router.ts src/providers/router.test.ts` reverts the entire change atomically; no other file is touched.

## 6. Follow-ups

- **F-G21-OAUTH-IN-DESCRIPTOR** — once G22 lands, fold the OAuth-id mapping into `ProviderDescriptor` as an optional `oauthId` field and drop `PROVIDER_TO_OAUTH`. Out of scope for G21.

## 7. r3 deltas vs r2

- **§1.6 (new)** — added a positive expansion test for built-in provider-only failover (no `modelEquivalents`, `failover["github-copilot"] = ["openai-codex"]`, expect `"openai-codex/claude-sonnet-4.6"` in chain). This is the only direct coverage of descriptor-name expansion through [src/providers/router.ts](../../../../src/providers/router.ts#L556).
- **§1.7 (was §1.6 in r2, corrected)** — arbitrary-key regression assertion rewritten. r2 asserted `expect(chain).toContain("not-a-real-provider")` and `expect(chain).not.toContain("not-a-real-provider/claude-sonnet-4.6")`. r3 drops the containment assertion because the post-r3 implementation does not produce the raw fallback string in the chain (the path through `appendCandidatesForModelSpec` / `expandProviderIndependentCandidates` at [src/providers/router.ts](../../../../src/providers/router.ts#L561) and [src/providers/router.ts](../../../../src/providers/router.ts#L578) filters out the unknown name). The non-containment of the expanded form is the only stable contract.
- **§2 step 2** — explicitly describes [src/providers/router.test.ts](../../../../src/providers/router.test.ts#L267-L283) as a *suppression* test driven by the explicit-equivalent guard at [src/providers/router.ts](../../../../src/providers/router.ts#L555), not as positive built-in provider-only expansion coverage. r2 wrongly called this a preservation test.
- **§4 done criteria** — count of new passing tests updated from one to two.
- **§1.1–§1.5, §1.8, §3, §5, §6** — unchanged in substance from r2.
