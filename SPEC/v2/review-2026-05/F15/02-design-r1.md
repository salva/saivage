# F15 — Design r1

## Proposal A — focused fix: delete eager injection, centralise the mapping

**Scope (files touched):**
- [src/server/bootstrap.ts](src/server/bootstrap.ts) — remove `injectOAuthTokens` and its call site at step 3.
- [src/providers/router.ts](src/providers/router.ts) — keep `PROVIDER_TO_OAUTH` as the single mapping, exported for any future caller; drop the parallel `OAUTH_TO_PI` table if unused after the deletion.
- [src/auth/store.ts](src/auth/store.ts) — delete the now-unused `oauthToProviderName` helper (and its barrel re-export in [src/auth/index.ts](src/auth/index.ts)).

**What gets added:** nothing.

**What gets removed:**
- `injectOAuthTokens` function (entire body, ~22 lines).
- The `await injectOAuthTokens(router)` call in `bootstrap`.
- The unused `import { getOAuthApiKey, hasOAuthCredentials } from "../auth/index.js"` in [bootstrap.ts](src/server/bootstrap.ts#L13) (`hasOAuthCredentials` may still be needed; verify and prune).
- `oauthToProviderName` (definition + barrel export). No call sites in `src/`.
- `OAUTH_TO_PI` in [router.ts#L57-L62](src/providers/router.ts#L57-L62) — confirm no callers; if any consumer needs the OAuth→pi-ai mapping after the change, it can derive it from `PROVIDER_TO_OAUTH` inverted.

**Behavioural change:** OAuth tokens are no longer pushed onto provider singletons at startup. The very next user of each provider (the `inspectUsageAtStartup` probe that runs immediately after bootstrap, or the first real chat) calls `resolveApiKey` → `setApiKey`, which is what already happens today. There is no functional regression because `injectOAuthTokens` was overwritten before any chat call.

**Risk:** very low.
- The only externally observable changes are the disappearance of the `[v2] OAuth credentials loaded for ${providerName}` log line and a small reduction in startup latency (one fewer `getOAuthApiKey` per OAuth provider).
- `inspectUsageAtStartup` already calls `getOAuthApiKey` per candidate via `resolveApiKey` (see [router.ts#L638-L640](src/providers/router.ts#L638-L640)), so any refresh-on-startup behaviour clients may have relied on (warming the refresh-token cache) is preserved.
- `shouldRegisterProvider` consults `hasOAuthCredentials` directly, so provider registration is unaffected.

**What it enables:** any future work that requires per-request key isolation (per-account provider instances, request-scoped clients) becomes simpler because there is no longer a "globally set" key on the singleton to reason about. Also unblocks F27 cleanly: if `CLIENT_ID` constants get moved out of source, the only consumer that needs to keep working is `resolveApiKey`/`getOAuthApiKey`, which already reads from the OAuth provider registry.

**What it forbids:** any future code that resolves a key without going through `resolveApiKey`. (Today three call sites already follow that pattern; deleting the fourth makes it a convention.)

**Cross-link:** F27 (OAuth client IDs in source) — orthogonal but compatible. This proposal does not touch `CLIENT_ID` constants and does not introduce new hardcoded OAuth identifiers, leaving F27 free to centralise them.

**Recommendation note:** this is the minimal correct fix and matches the architecture-first guideline (delete the dead path, do not preserve it).

---

## Proposal B — one level up: make `resolveApiKey` the sole entry point and remove `setApiKey` from the public provider contract

**Scope (files touched):**
- All of Proposal A, plus:
- [src/providers/types.ts](src/providers/types.ts#L99) — remove the optional `setApiKey?(apiKey: string): void` from `ModelProvider`.
- [src/providers/router.ts](src/providers/router.ts) — change `chat`, `listModels`, `inspectUsageCandidate`, `callProvider` to thread the resolved key through the request (e.g. add an internal `_apiKey` field on the request object passed to `provider.chat`/`provider.listModels`, or pass an explicit `apiKey` argument). The provider implementations consume the per-call key instead of storing it.
- All provider implementations that today expose `setApiKey`: [openai.ts](src/providers/openai.ts#L27), [openai-codex.ts](src/providers/openai-codex.ts#L88-L94), [copilot.ts](src/providers/copilot.ts#L131-L134), [pi-ai.ts](src/providers/pi-ai.ts) — refactor to accept the key per call. Constructors that take an initial `apiKey` go away (or are kept only as a fallback for `process.env` keys at construction time).
- [src/security/prompt-injection-cop.ts](src/security/prompt-injection-cop.ts#L111-L113) — drop the local `setApiKey` invocation; the router-routed `chat` call already carries the key.

**What gets added:** an explicit `apiKey` channel on the provider chat/listModels contract. Likely shape: extend `ChatRequest` (`src/providers/types.ts`) with `_resolvedApiKey?: string` populated by the router, since changing every provider signature is more invasive.

**What gets removed:**
- The same set as Proposal A.
- Every call to `provider.setApiKey(...)` in [router.ts](src/providers/router.ts) (8+ occurrences) and in [prompt-injection-cop.ts](src/security/prompt-injection-cop.ts#L113).
- The mutable `apiKey` field on each provider class.

**Risk:** moderate.
- Touches every provider implementation.
- `PiAiProvider` is the same instance across multiple `providerName`s and uses `as any`/`as unknown as` heavily; refactoring its key handling needs care.
- The race noted in the analysis (concurrent `chat()` calls overwriting a shared provider's `apiKey` field) is eliminated entirely — that is the main upside.

**What it enables:** correct multi-account concurrency on a single provider singleton without the `providerName#accountName` cloning that `getProviderForRequest` does today. Also makes the provider implementations easier to test (no hidden state).

**What it forbids:** ad-hoc key injection from outside the router. Any consumer that wants to call a provider must go through `router.chat` or be passed a resolved key explicitly.

**Cross-link:** F27 — same as Proposal A. Additionally, if F27 ends up making CLIENT_IDs runtime-configurable, the per-call key model here makes it natural for the OAuth flow's resolved token to flow through the same channel as static `apiKey` values.

**Recommendation note:** the right end state, but it expands the diff to most providers in a single change. F15 alone does not justify it; it should be paired with a finding that targets the shared-singleton race (not in this batch's `00-INDEX.md`).

---

## Recommendation

**Proposal A.** The eager `injectOAuthTokens` path is dead for correctness — every consumer of the provider already resolves and re-applies the key lazily. Deleting it removes startup latency, a misleading log line, and a divergent OAuth-id mapping table without changing observable behaviour. The deeper redesign in Proposal B is the right long-term direction but belongs to a separate finding focused on the shared-`setApiKey` race; doing it under F15 would conflate two issues.

The architecture-first guideline applies cleanly: there is no migration step, no flag, no deprecation. The eager path is removed in the same commit as the (already canonical) lazy path becomes the only path.
