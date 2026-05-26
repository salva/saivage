# G21 — Plan (round 2)

**Writer**: Claude Opus 4.7. Implements **Proposal B (r2-tightened)** from [02-design-r2.md](02-design-r2.md). Supersedes [03-plan-r1.md](03-plan-r1.md). Two-file change: [src/providers/router.ts](../../../../src/providers/router.ts) (refactor) and [src/providers/router.test.ts](../../../../src/providers/router.test.ts) (one new regression test).

## 0. Preconditions

- Working tree clean on the saivage repo, or only G21-scoped edits pending.
- G20 already landed (verified: router.ts imports only `CopilotProvider`, `PiAiProvider`, `OllamaProvider`, `LlamaCppProvider` at [src/providers/router.ts](../../../../src/providers/router.ts#L15-L18)).
- No concurrent in-flight edit to [src/providers/router.ts](../../../../src/providers/router.ts) from G22-G26.

## 1. Edits

### 1.1 Add descriptor types and table — [src/providers/router.ts](../../../../src/providers/router.ts)

Insert a new block immediately **after** the existing `PROVIDER_TO_OAUTH` constant ([src/providers/router.ts](../../../../src/providers/router.ts#L62-L69)) and **before** `export class ModelRouter` ([src/providers/router.ts](../../../../src/providers/router.ts#L71)). New code:

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

Iteration order matches the prior `knownProviders` literal exactly, so `ModelRouter.listProviders()` ordering is preserved (used by the existing snapshot expectation at [src/providers/router.test.ts](../../../../src/providers/router.test.ts#L65)).

Notes on typing:

- The descriptor interface is generic in `N extends string` so each row's `name` keeps its literal.
- The pi-ai helper is generic; `makePiAiDescriptor("anthropic", …)` infers `N = "anthropic"` and returns `ProviderDescriptor<"anthropic">`.
- `as const satisfies readonly ProviderDescriptor[]` validates the shape without widening. `typeof PROVIDER_DESCRIPTORS[number]["name"]` resolves to the literal union.
- `PROVIDER_DESCRIPTORS_BY_NAME`'s value type is widened to `ProviderDescriptor<ProviderName>` via the `as` inside `.map` only — the public observable type still narrows the key set to `ProviderName`.

### 1.2 Collapse `initProviders` — descriptor-driven loop, no string re-lookup

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

The `void config` no-op disappears; we just rename the parameter to `_config` to keep the existing signature for callers that pass `config`.

### 1.3 Delete `shouldRegisterProvider`

Remove the method entirely at [src/providers/router.ts](../../../../src/providers/router.ts#L731-L754). Verified via grep that the only caller is the prior `initProviders` body, which 1.2 replaces. No external consumer.

If linting prefers retaining a public-ish predicate for symmetry, replace the body with the descriptor-only form below — but the recommended action is full removal.

```
  // OPTIONAL alternative form, only if a defensive predicate is desired:
  // private shouldRegisterProvider(providerName: string): boolean {
  //   const descriptor = PROVIDER_DESCRIPTORS_BY_NAME.get(providerName as ProviderName);
  //   if (!descriptor) return false;
  //   const cfg = this.providerConfigs[providerName];
  //   const hasAccounts = Object.keys(cfg?.accounts ?? {}).length > 0;
  //   return descriptor.shouldRegister({ cfg, hasAccounts });
  // }
```

No `default` branch returning `!!cfg || hasAccounts`. Unknown names are not providers.

### 1.4 Collapse `createProvider` — descriptor lookup only

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

The unused locals `apiKey` and `baseUrl` at [src/providers/router.ts](../../../../src/providers/router.ts#L769-L770) move into each descriptor's `create` closure (already encoded in §1.1). The `undefined` return path remains as a defensive sentinel; the per-account caller [src/providers/router.ts](../../../../src/providers/router.ts) (`getProviderForRequest`) only supplies provider names already registered, so the path is structurally unreachable from real call sites.

### 1.5 Collapse `isProviderName` — descriptor-map only, single parameter

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

The 8-name literal array goes away; the descriptor map is the single source. The OR with `providerConfigs`-key membership is removed.

### 1.6 New regression test — [src/providers/router.test.ts](../../../../src/providers/router.test.ts)

Add the following test inside the existing `describe("ModelRouter", …)` block, adjacent to the existing provider-only failover test at [src/providers/router.test.ts](../../../../src/providers/router.test.ts#L268-L283). Insert immediately after that test so the contrast between "built-in provider expands" and "arbitrary config key does not expand" reads together.

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

    // Built-in provider-only failover still expands (see the test above):
    //   failover["github-copilot/..."] = ["openai-codex"] → "openai-codex/<model>".
    // An arbitrary providerConfigs key MUST NOT be treated as a provider:
    // it stays as a literal candidate spec, not expanded with the requesting model.
    expect(chain).toContain("not-a-real-provider");
    expect(chain).not.toContain("not-a-real-provider/claude-sonnet-4.6");
  });
```

Why this is the right regression:

- It populates `providerConfigs` with a non-descriptor key, the exact second-name-oracle pattern the r1 reviewer flagged.
- It pairs that key with a provider-only failover entry, which is the only call site of `isProviderName`.
- It asserts the post-r2 contract: descriptor membership is the only answer, so the key is **not** expanded into `<key>/<model>`.
- It deliberately does **not** touch the existing built-in test at [src/providers/router.test.ts](../../../../src/providers/router.test.ts#L268-L283); that test continues to assert the *negation case* (no expansion when explicit equivalents exist), and the older positive expansion behaviour for built-in provider names is exercised by the rest of the failover suite around [src/providers/router.test.ts](../../../../src/providers/router.test.ts#L73-L122) where `failover["github-copilot"]: [...]` is implicitly expanded into provider/model specs.

If the failover test file has a positive built-in provider-only expansion test that we want to point at explicitly, the reviewer-quoted reference [src/providers/router.test.ts](../../../../src/providers/router.test.ts#L268-L283) covers the relevant region; no edit there is required.

### 1.7 No other edits

- Do **not** touch `PROVIDER_TO_OAUTH` ([src/providers/router.ts](../../../../src/providers/router.ts#L64-L69)) — owned by G22.
- Do **not** change imports (`PiAiProvider`, `CopilotProvider`, `OllamaProvider`, `LlamaCppProvider`, `hasOAuthCredentials` are all already imported at [src/providers/router.ts](../../../../src/providers/router.ts#L14-L19)).
- Do **not** modify other `*.test.ts` files.
- Do **not** export `ProviderName` — only declare it module-locally. Future exports are a separate ticket once a consumer materialises.

## 2. Validation (run in [/home/salva/g/ml/saivage](../../../../))

Run in order; do not move on if any step regresses.

1. **Typecheck** — `npm run typecheck` (i.e. `tsc --noEmit`). Expected: clean, identical to baseline. Pay attention to the `as const satisfies readonly ProviderDescriptor[]` block — if the generic `makePiAiDescriptor` inference is wrong, `ProviderName` collapses to `string` and downstream `Map<ProviderName, …>` typing may complain.
2. **Focused router tests** — `npx vitest run src/providers/router.test.ts src/providers/copilot-router.test.ts`. Expected: all green, including:
   - `listProviders()` ordering snapshot at [src/providers/router.test.ts](../../../../src/providers/router.test.ts#L65).
   - GitHub-copilot header path at [src/providers/copilot-router.test.ts](../../../../src/providers/copilot-router.test.ts#L25-L43).
   - Existing built-in provider-only failover test at [src/providers/router.test.ts](../../../../src/providers/router.test.ts#L268-L283).
   - New regression test from §1.6.
3. **Focused provider unit tests** touching the constructors invoked by descriptors — `npx vitest run src/providers/copilot.test.ts src/providers/ollama.test.ts src/providers/llamacpp.test.ts src/providers/pi-ai.test.ts`. Expected: all green (sanity).
4. **Lint** — `npm run lint`. Known broken upstream (missing `typescript-eslint` dep, per workspace memory). If lint still fails with the same dependency error, it is not a G21 regression. If lint surfaces *new* warnings on [src/providers/router.ts](../../../../src/providers/router.ts), fix them before merge.
5. **Full vitest** — `npm test`. Expected: identical pass count to baseline plus the one new test from §1.6.
6. **Build** — `npm run build`. Expected: `tsup` succeeds; `dist/cli.js` produced.

If any step fails, stop and report. Do not "rebalance" by editing existing tests — the descriptor must mirror current behaviour exactly except for the documented delta in [02-design-r2.md](02-design-r2.md#L23) (failover expansion no longer fires for arbitrary `providerConfigs` keys).

## 3. Operator-gated deployment

Internal-wiring change. Same set of providers registered under the same names, same constructors, same iteration order. One documented behavioural delta (failover expansion for arbitrary `providerConfigs` keys is removed) — no existing deployment exercises that path. Therefore:

- **No automatic restart of `saivage.service` on any container.**
- Ask the operator before bouncing `saivage-v3` (10.0.3.112). The `saivage` (10.0.3.111) and `diedrico` (10.0.3.113) services bind-mount the host `saivage/` tree too — confirm before restart.
- A restart is only justified after steps 1, 2, 5, 6 are green.

Health-check command after any operator-approved restart:

```
ssh root@10.0.3.112 'systemctl restart saivage.service && sleep 4 && systemctl is-active saivage.service && curl -fsS http://127.0.0.1:8080/health'
```

## 4. Done criteria

- All four duplication sites listed in [01-analysis-r2.md](01-analysis-r2.md) §2 are gone. `grep -n 'knownProviders\|"github-copilot",\s*"anthropic"' src/providers/router.ts` returns at most the descriptor table itself.
- `shouldRegisterProvider` is either deleted or has no `default` branch returning truthy for unknown names. `grep -n 'shouldRegisterProvider' src/providers/router.ts` returns either zero hits or only the method definition + a single call site.
- `isProviderName` takes one parameter and reads only `PROVIDER_DESCRIPTORS_BY_NAME`. `grep -n 'isProviderName' src/providers/router.ts` shows the single call site at the failover expansion with one argument.
- `type ProviderName` is declared in [src/providers/router.ts](../../../../src/providers/router.ts) and derives from the descriptor table.
- `tsc --noEmit` clean.
- `vitest run` full suite passes with one additional passing test (§1.6) vs. baseline.
- `npm run build` produces a bundle.
- No new exports introduced; `git diff --stat` shows changes only in [src/providers/router.ts](../../../../src/providers/router.ts) and [src/providers/router.test.ts](../../../../src/providers/router.test.ts).

## 5. Rollback

`git checkout -- src/providers/router.ts src/providers/router.test.ts` reverts the entire change atomically; no other file is touched.

## 6. Follow-ups (filed, not implemented here)

- **F-G21-OAUTH-IN-DESCRIPTOR** — once G22 lands, fold the OAuth-id mapping into `ProviderDescriptor` as an optional `oauthId` field and drop `PROVIDER_TO_OAUTH`. Out of scope for G21.
- (F-G21-EXPORT-PROVIDERNAME from r1 is **dropped** — the type lands in r2 as an internal declaration. A future export is trivial when a consumer materialises and does not warrant a placeholder ticket.)

## 7. r2 deltas vs r1

- §1.1 — descriptor types are generic; table declared `as const satisfies readonly ProviderDescriptor[]`; `ProviderName` derived inside the file (not deferred). r1's `readonly name: string` widening is removed.
- §1.2 — `initProviders` iterates descriptors directly and passes the descriptor object through. No string-name `shouldRegisterProvider`/`createProvider` re-lookup at boot.
- §1.3 — `shouldRegisterProvider` is **deleted** (preferred) rather than reduced to a descriptor-plus-fallback predicate. The optional alternative form, if retained, has no `default` branch returning truthy.
- §1.4 — `createProvider`'s `default → undefined` path is preserved as a defensive sentinel only; behaviour is unchanged in r2 vs r1 here.
- §1.5 — `isProviderName` drops its `providerConfigs` parameter and consults the descriptor map only. The single call site at [src/providers/router.ts](../../../../src/providers/router.ts#L556) drops the second argument.
- §1.6 (new) — focused regression test for arbitrary `providerConfigs` keys not being treated as provider-only failover names. r1 had no test edit.
- §2 — validation step 2 explicitly lists the new regression test alongside the preserved provider-only failover test at [src/providers/router.test.ts](../../../../src/providers/router.test.ts#L268-L283).
- §4 — done criteria add explicit assertions on `shouldRegisterProvider` removal, `isProviderName` single-arg form, and the `ProviderName` declaration.
- §6 — F-G21-EXPORT-PROVIDERNAME is dropped (now landed); F-G21-OAUTH-IN-DESCRIPTOR retained.
