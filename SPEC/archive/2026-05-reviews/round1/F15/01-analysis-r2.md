# F15 — Analysis r2

## Changes from r1

- Removed the incorrect "[`router.callProvider` final retry path](src/providers/router.ts#L639)" entry from the lazy `resolveApiKey` caller list. `callProvider` ([src/providers/router.ts](src/providers/router.ts#L366-L413)) does not call `resolveApiKey` or `setApiKey`; it only invokes `provider.chat` with the request that `router.chat` already prepared (key resolution and `setApiKey` happen earlier, in the `router.chat` candidate loop at [src/providers/router.ts](src/providers/router.ts#L297-L299)). The L639 reference belongs to `inspectUsageCandidate`, which is already listed separately.

## Problem restated

The Saivage v2 runtime has two independent paths that resolve an OAuth access token and attach it to a provider instance:

1. **Eager path at startup.** [`injectOAuthTokens`](src/server/bootstrap.ts#L740-L762) iterates every registered provider name returned by `router.listProviders()` and, for each one that has any OAuth profile on disk, calls `getOAuthApiKey(oauthId)` (no `profileKey`), then `provider.setApiKey(key)` on the singleton `ModelProvider` registered under that name. It is awaited from [`bootstrap` step 3](src/server/bootstrap.ts#L135) before `inspectUsageAtStartup`.
2. **Lazy path per request.** [`ModelRouter.resolveApiKey`](src/providers/router.ts#L174-L200) accepts an `authProfileKey` and/or `accountRef` and resolves the correct profile (explicit profile → account-default profile → account `apiKey` → provider `apiKey` → first matching OAuth profile). Every router code path that actually calls the provider then re-applies the result via `setApiKey`: [`router.chat`](src/providers/router.ts#L297-L299), [`router.listModels`](src/providers/router.ts#L236-L238), [`router.inspectUsageAtStartup`](src/providers/router.ts#L638-L640), and the security pre-flight [`PromptInjectionCop.scanWithModel`](src/security/prompt-injection-cop.ts#L111-L113).

Because the same singleton `ModelProvider` is shared across all requests for a given `providerName` (only `providerName#accountName` variants get a separate instance — see [`getProviderForRequest`](src/providers/router.ts#L763-L778)), and every consumer of that singleton overwrites its key by calling `setApiKey` immediately before the chat call, the value pushed by `injectOAuthTokens` is overwritten on first use. The eager path is therefore **dead** for correctness purposes but it still:

- adds startup latency proportional to the number of OAuth providers (`getOAuthApiKey` may trigger a `refreshToken` HTTP round-trip per provider — see [`store.ts`](src/auth/store.ts#L107-L131));
- emits a misleading `[v2] OAuth credentials loaded for ${providerName}` log line that suggests credential affinity it does not actually provide;
- can mask configuration bugs: e.g. if `injectOAuthTokens` succeeds against the wrong profile and `resolveApiKey` then silently fails for the correct one, the eager-loaded value lingers on the provider singleton until the next lazy call;
- duplicates the OAuth-id → provider-name mapping that already exists in the router (see "Actual differences" below) and in [`oauthToProviderName`](src/auth/store.ts#L154-L158).

## Actual differences

OAuth ↔ provider name mappings exist in three places:

| Source | Direction | Entries |
|---|---|---|
| [`bootstrap.ts` `oauthIds`](src/server/bootstrap.ts#L741-L745) | provider → oauth | `openai-codex→openai-codex`, `anthropic→anthropic`, `github-copilot→github-copilot` |
| [`router.ts` `PROVIDER_TO_OAUTH`](src/providers/router.ts#L66-L71) | provider → oauth | adds `copilot→github-copilot`; same other entries |
| [`store.ts` `oauthToProviderName`](src/auth/store.ts#L154-L158) | oauth → provider | `openai-codex→openai`, `github-copilot→copilot`, identity otherwise |

`oauthToProviderName` disagrees with both `oauthIds` and `PROVIDER_TO_OAUTH` for `openai-codex`: the store says the OAuth credential authenticates the `openai` provider, but the router uses `openai-codex` as a distinct provider name (registered by [`shouldRegisterProvider`](src/providers/router.ts#L693-L695) and constructed by [`createProvider`](src/providers/router.ts#L739-L744)). `oauthToProviderName` has no callers in `src/` outside its own export and is dead.

## Contract

`injectOAuthTokens(router)` — fire-and-forget side-effecting routine. Takes no observable input beyond the router and the on-disk auth store; returns `void`; tolerates all errors silently. Pre-condition: providers are already registered. Post-condition (nominal): every provider with a matching OAuth profile has had `setApiKey` called once with whatever token the first matching profile resolves to.

`ModelRouter.resolveApiKey(providerName, options?)` — returns `Promise<string | null>`. Options:
- `authProfileKey?`: forces a specific profile (validated against the OAuth id derived via `PROVIDER_TO_OAUTH`).
- `accountRef?`: `provider.account` or bare `account` string; selects an `accounts[name]` entry on the provider config, whose `authProfile` and/or `apiKey` are then used.

Fallback order inside `resolveApiKey` (see [router.ts#L174-L200](src/providers/router.ts#L174-L200)):
1. explicit `authProfileKey` if the profile matches the OAuth id;
2. `accountConfig.authProfile`;
3. `accountConfig.apiKey`;
4. `providerConfig.apiKey`;
5. `getOAuthApiKey(oauthId)` with no profile key (first matching OAuth profile).

Error modes: `getOAuthApiKey` returns `null` on refresh failure (logged warn). `resolveApiKey` propagates that null; downstream `setApiKey` is gated on truthiness.

## Call sites & dependencies

Eager `injectOAuthTokens` callers: one — [bootstrap step 3](src/server/bootstrap.ts#L135).

Lazy `resolveApiKey` callers (all in this repo):
- [`router.chat` candidate loop](src/providers/router.ts#L297-L299) — happy path for every agent call. This is the path that wraps `callProvider`; `callProvider` itself does not touch `resolveApiKey`/`setApiKey` ([src/providers/router.ts](src/providers/router.ts#L366-L413)).
- [`router.listModels`](src/providers/router.ts#L236-L238) — model-discovery for `discoverModelEquivalents` and UI listings.
- [`router.inspectUsageAtStartup` → `inspectUsageCandidate`](src/providers/router.ts#L638-L640) — startup usage probe (also runs at boot, just after `injectOAuthTokens`).
- [`PromptInjectionCop.scanWithModel`](src/security/prompt-injection-cop.ts#L111-L113) — direct router consumer that intentionally bypasses `router.chat` for the security scan but reuses `resolveApiKey`.

The `setApiKey` mutator is implemented by [`OpenAIProvider`](src/providers/openai.ts#L27), [`OpenAICodexProvider`](src/providers/openai-codex.ts#L91), [`CopilotProvider`](src/providers/copilot.ts#L134), and the multi-flavour [`PiAiProvider`](src/providers/pi-ai.ts) (which router constructs for `anthropic`, `openai`, `openai-codex`, `opencode`, `opencode-go`). All implementations are a single field assignment — there is no copy-on-write, so two concurrent calls that resolve different keys for the same `providerName` singleton race on the field. The race is masked today only because the same eligible OAuth profile is almost always picked.

## Constraints any solution must respect

1. **No backward compatibility for the eager path.** Per the mandatory guideline, the fix must delete the eager injector, not keep both behind a flag.
2. **The lazy `resolveApiKey` must remain the single resolution authority** — it is the only path that honours `accountRef` and `authProfileKey`, which the runtime routing resolver already produces (see [`resolveAgentRoute`](src/server/bootstrap.ts#L765-L772)).
3. **OAuth-id ↔ provider-name mapping must live in one place.** Today it lives in `bootstrap.oauthIds`, `router.PROVIDER_TO_OAUTH`, the partial `OAUTH_TO_PI`, and (incorrectly) `store.oauthToProviderName`. The mapping is router-domain knowledge; centralising it inside the router (or moving it next to the OAuth provider registry in `src/auth/store.ts`) is required to prevent future drift.
4. **`shouldRegisterProvider` already consults `hasOAuthCredentials`** ([router.ts#L688-L697](src/providers/router.ts#L688-L697)) to decide whether to register a provider at all, so registration itself does not depend on `injectOAuthTokens`.
5. **`prompt-injection-cop.ts` is in scope** because it is the only non-router caller of `resolveApiKey` and must keep working after any change to `setApiKey` semantics.
6. **`src/skills/` and any memory-related code remain out of scope** per the loop conventions.
7. **F27 (OAuth `CLIENT_ID` constants in source)** is logically related — both findings ask for OAuth-related configuration to be consolidated — but is orthogonal: F27 is about *where the CLIENT_ID is configured*, F15 is about *how a resolved token reaches the provider*. The fix here must not block F27 (no new hardcoded mappings on the OAuth-id side).

## Out of scope for this finding

- The TOCTOU race on shared provider singletons (`setApiKey` is fundamentally a mutable per-singleton field). Eliminating it would require per-request provider instances or an explicit `chat({ apiKey })` parameter and is a larger redesign; this finding only ensures the race surface does not get worse and notes it as a follow-up.
- The `oauthToProviderName` dead helper (deleting it is part of the recommended proposal, but a separate dead-code item could subsume it; called out under "What gets removed").
