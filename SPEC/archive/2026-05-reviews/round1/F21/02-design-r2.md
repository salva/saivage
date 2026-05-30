# F21 r2 — Design

## Changes from r1

- Made the production wiring explicit. r1's "the route layer can pass overrides via a closure" was hand-wavy; r2 names every call site that constructs or refreshes a Copilot client and specifies exactly which config field reaches it. The reviewer correctly flagged that constructor-only overrides would be erased by later `setApiKey` calls and that the OAuth refresh path was deferred to a post-F15 follow-up. Both gaps are now closed.
- Switched from "two-argument `setApiKey(apiKey, headerOverride?)`" to **stored header state on the provider**. The override is set once at construction (or via a dedicated `setHeaderOverrides` setter) and survives every subsequent `setApiKey(apiKey)` refresh. This keeps the 7 existing `provider.setApiKey(key)` call sites in [src/providers/router.ts](src/providers/router.ts#L238), [src/providers/router.ts](src/providers/router.ts#L299), [src/providers/router.ts](src/providers/router.ts#L640), [src/providers/router.ts](src/providers/router.ts#L731), [src/security/prompt-injection-cop.ts](src/security/prompt-injection-cop.ts#L113), and [src/server/bootstrap.ts](src/server/bootstrap.ts#L754) untouched — they cannot accidentally erase a configured override because they no longer have a headers argument to omit.
- Promoted the OAuth-refresh wiring from "follow-up after F15" to **part of this change**. `OAuthProviderDef.refreshToken` and `OAuthProviderDef.login` widen to accept an options object, `getOAuthApiKey` accepts and forwards a `headers` option, and `ModelRouter.resolveApiKey` looks up the per-account/per-provider `headers` field and supplies it.
- Schema change moved from `runtimeProviderAccountSchema` only to **both** `runtimeProviderAccountSchema` and the precedence rule "account headers shallow-merged over provider headers over defaults". This matches the existing precedence rule for `apiKey` / `baseUrl` already used at [src/providers/router.ts](src/providers/router.ts#L723-L726).
- Test plan expanded: router-level test asserts the configured header reaches the outgoing chat request after lazy OAuth `setApiKey`, and an auth-level test asserts `refreshGitHubCopilotToken` applies a supplied override on the `copilot_internal/v2/token` exchange. These tests fail without the production wiring (constructor-only tests would not).

Two proposals below. Both delete the duplicate `COPILOT_HEADERS` literal and the dead `ANTHROPIC_API_MODELS` Set; they differ only in whether the impersonation triple is auto-detected from the host.

## Proposal A — Focused fix: single source of truth + config override end-to-end

### Scope

Touched files (production):

- [src/providers/copilot.ts](src/providers/copilot.ts) — remove local `COPILOT_HEADERS` const, remove `ANTHROPIC_API_MODELS` Set; add a `private headers` field; widen constructor to `(apiKey?: string, headerOverride?: Record<string, string>)`; add `setHeaderOverrides(override?: Record<string, string>): void`; rebuild SDK clients and `createCopilotFetch` from `this.headers`.
- [src/auth/github-copilot.ts](src/auth/github-copilot.ts) — remove local `COPILOT_HEADERS` const and the two inline `"User-Agent": "GitHubCopilotChat/0.35.0"` strings at [L80](src/auth/github-copilot.ts#L80) and [L134](src/auth/github-copilot.ts#L134); import shared defaults; widen `startDeviceFlow`, `pollForAccessToken`, `refreshGitHubCopilotToken`, `loginGitHubCopilot` to accept and propagate a header override.
- `src/providers/copilot-client-headers.ts` (new, ~25 lines) — exports `DEFAULT_COPILOT_HEADERS` and `resolveCopilotHeaders(override?)`.
- [src/auth/types.ts](src/auth/types.ts#L29-L36) — widen `OAuthProviderDef.login` and `OAuthProviderDef.refreshToken` to accept an optional `options` argument carrying provider-specific extras (today: `headers?: Record<string, string>`).
- [src/auth/store.ts](src/auth/store.ts#L88-L122) — `getOAuthApiKey(providerId, options)` accepts `options.headers?: Record<string, string>` and forwards it to `provider.refreshToken(profile, { headers: options.headers })`.
- [src/providers/router.ts](src/providers/router.ts#L728) — `createProvider("github-copilot", ...)` reads merged headers from `accountConfig?.headers ?? providerConfig?.headers` and passes them to the `CopilotProvider` constructor. The existing 7 `provider.setApiKey(key)` sites in router/security/bootstrap remain unchanged because the provider preserves its own `headers` field across refreshes.
- [src/providers/router.ts](src/providers/router.ts#L174-L199) — `resolveApiKey` builds a `headers` argument for `getOAuthApiKey` from the same account/provider lookup it already uses to resolve `apiKey` / `authProfile`, and forwards it.
- [src/routing/resolver.ts](src/routing/resolver.ts#L38-L52) — add `headers: z.record(z.string(), z.string()).optional()` to `runtimeProviderAccountSchema`; add the matching field to `RuntimeProviderAccountLike`.
- [src/server/cli.ts](src/server/cli.ts#L451-L470) — pass the configured headers to `provider.login(callbacks, { headers })` when `providerId === "github-copilot"`, by reading the active project's `SaivageConfig.providers["github-copilot"]`.

Touched files (tests):

- [src/providers/copilot.test.ts](src/providers/copilot.test.ts) — add a defaults-present assertion and a constructor-override-wins assertion (regex matches on version-pinned headers so future bumps don't churn the test).
- `src/providers/copilot-router.test.ts` (new) — boots a `ModelRouter` against a `SaivageConfig` whose `providers["github-copilot"].headers` sets a sentinel `Editor-Version`, monkeypatches `getOAuthApiKey` to return a fake token, dispatches a chat, and asserts the captured outgoing `init.headers` carries the sentinel. **This is the test that fails if router→provider wiring breaks.**
- `src/auth/github-copilot.test.ts` (new, single test) — stubs `fetch`, calls `refreshGitHubCopilotToken("ghp-test", { headers: { "Editor-Version": "vscode/9.9.9" } })`, asserts the captured token-exchange request carries `Editor-Version: vscode/9.9.9`. **This is the test that fails if OAuth-refresh wiring breaks.**

### Precedence (single rule)

```
effective_headers = { ...DEFAULT_COPILOT_HEADERS, ...providerConfig.headers, ...accountConfig.headers }
```

Shallow merge, account beats provider beats defaults. Same precedence the router already uses for `apiKey` and `baseUrl` at [src/providers/router.ts](src/providers/router.ts#L723-L726), so no new mental model.

### Wiring map (every code path)

| Surface | Today | After |
|---|---|---|
| Module-level constant | duplicated in [src/providers/copilot.ts](src/providers/copilot.ts#L33-L39) and [src/auth/github-copilot.ts](src/auth/github-copilot.ts#L17-L22) | one `DEFAULT_COPILOT_HEADERS` in `src/providers/copilot-client-headers.ts` |
| Inline `User-Agent` strings | [src/auth/github-copilot.ts#L80](src/auth/github-copilot.ts#L80), [src/auth/github-copilot.ts#L134](src/auth/github-copilot.ts#L134) | gone; both read `headers["User-Agent"]` from the resolved set |
| Provider construction | `new CopilotProvider(apiKey)` at [src/providers/router.ts](src/providers/router.ts#L728) | `new CopilotProvider(apiKey, mergedHeaders)` |
| Lazy OAuth refresh of provider | `provider.setApiKey(oauthKey)` at [src/providers/router.ts](src/providers/router.ts#L238), [src/providers/router.ts](src/providers/router.ts#L299), [src/providers/router.ts](src/providers/router.ts#L640), [src/providers/router.ts](src/providers/router.ts#L731), [src/security/prompt-injection-cop.ts](src/security/prompt-injection-cop.ts#L113), [src/server/bootstrap.ts](src/server/bootstrap.ts#L754) | **unchanged** — provider preserves `this.headers` across `setApiKey` calls |
| OAuth token-exchange (`/copilot_internal/v2/token`) | `refreshGitHubCopilotToken(githubToken, enterpriseDomain?)` baking the literal | `refreshGitHubCopilotToken(githubToken, options?: { enterpriseDomain?; headers? })`, headers reaches the exchange `fetch` |
| OAuth refresh via store | `provider.refreshToken(profile)` at [src/auth/store.ts](src/auth/store.ts#L113) | `provider.refreshToken(profile, { headers })` |
| Caller of `getOAuthApiKey` | `resolveApiKey` and `injectOAuthTokens` in [src/providers/router.ts](src/providers/router.ts#L184-L198), [src/server/bootstrap.ts](src/server/bootstrap.ts#L741-L760) | both look up `providers["github-copilot"][headers]` (and the matching account's `headers`) and pass via the new `options.headers` |
| CLI login | `provider.login(callbacks)` at [src/server/cli.ts](src/server/cli.ts#L451) | `provider.login(callbacks, { headers })` when target is `github-copilot` |
| Provider interface | `setApiKey?(apiKey: string): void` at [src/providers/types.ts](src/providers/types.ts#L99) | unchanged — the override goes via constructor + dedicated setter, not via `setApiKey` |

### Why not widen `setApiKey` instead of using a stored field

r1 proposed `setApiKey(apiKey, headerOverride?)` and the reviewer correctly observed that any later caller that omitted the second argument would erase the override. Today the router calls `setApiKey(oauthKey)` lazily before each chat at [src/providers/router.ts](src/providers/router.ts#L237-L238) and [src/providers/router.ts](src/providers/router.ts#L297-L299), and bootstrap and `prompt-injection-cop.ts` also call `setApiKey(key)` without any headers context. Six call sites would need to be updated, and any future call site introduced anywhere in the codebase would silently regress. Storing the override on the provider instance means the seven existing call sites stay untouched and any future caller of `setApiKey` is automatically safe. The constructor + `setHeaderOverrides` setter remain the only places to touch headers. This is the architecturally correct shape: `setApiKey` is for credential refresh, `setHeaderOverrides` is for client identity — different lifecycles, different setters.

### Why widen `OAuthProviderDef` instead of using a closure

r1 proposed wrapping `githubCopilotOAuthProvider.login`/`refreshToken` with a closure that captures the override. The reviewer flagged the "concrete caller and storage boundary" was missing. A closure approach would require either (a) re-registering the provider in `providers` at every config load (mutating the module-level `Map` in [src/auth/store.ts](src/auth/store.ts#L26-L30) — fragile across hot reload), or (b) intercepting at every call site of `getOAuthApiKey`. Widening the interface is a smaller, single, statically-checked change: one new optional argument on two methods, ignored by the other two providers (`anthropic`, `openai-codex`) that don't need impersonation headers. The interface stays accurate to its real signature space.

### What gets added

- `src/providers/copilot-client-headers.ts` (one file, two exports).
- One new optional zod field `headers` on `runtimeProviderAccountSchema`.
- One new optional second argument on `CopilotProvider` constructor.
- One new method `CopilotProvider.setHeaderOverrides(override?)`.
- One new optional second argument on `OAuthProviderDef.login` and `OAuthProviderDef.refreshToken`.
- One new optional `headers` field on the options argument of `getOAuthApiKey`.
- Three new tests (one in `copilot.test.ts`, one in new `copilot-router.test.ts`, one in new `github-copilot.test.ts`).

### What gets removed

- Both `COPILOT_HEADERS` const literals.
- Both inline `"User-Agent": "GitHubCopilotChat/0.35.0"` strings in `auth/github-copilot.ts`.
- The whole `ANTHROPIC_API_MODELS` Set; `isAnthropicModel` simplifies to `model.startsWith("claude-")`.
- `enterpriseDomain?` positional argument of `refreshGitHubCopilotToken` (rolled into the new options object — no compat shim per project guideline).

### Risk

Low. The only behavioral change visible to the network is that an operator-set override can change outgoing headers; the default is preserved byte-for-byte for both chat and token-exchange paths. The `OAuthProviderDef` widening is a strict superset — implementations that ignore the new options compile and behave identically.

### What it enables

- Operators can hotfix a Microsoft client-version tightening by editing one JSON file and restarting. The hotfix flows to **both** the chat path and the OAuth token-exchange path, so an upstream rejection at `copilot_internal/v2/token` is recoverable without a source edit.
- Unblocks F32 (saivage-config undocumented blocks) — the new `headers` field becomes part of the documented per-provider schema.
- Establishes the pattern for F11 (magic constants generally): "shared defaults module + optional override on the per-account schema."

### What it forbids

- No env-var fallback (`COPILOT_USER_AGENT` etc.).
- No per-call header injection at chat time (config-driven only).
- No per-header zod validation (headers are opaque HTTP key/value pairs).
- No header-override subsystem for non-Copilot providers in this change. The field lives on the generic account schema for forward extensibility but only `CopilotProvider` consumes it today.

### Recommendation note

This is the architecture-first fix wired end-to-end. Headers belong with the provider that sends them; overrides belong in provider config; the OAuth refresh path is part of the same Copilot integration so it consumes the same config slot through the same mechanism. Done.

## Proposal B — One level up: auto-derive from the host's installed VS Code + Copilot Chat

### Scope

Everything from Proposal A, plus:

- `src/providers/copilot-client-detect.ts` (new, ~80 lines) — at module load (memoized once), best-effort probe of:
  1. `$VSCODE_VERSION` / `$COPILOT_CHAT_VERSION` env (operator-pin escape hatch).
  2. `~/.vscode/extensions/github.copilot-chat-*/package.json` — newest version directory wins.
  3. `~/.vscode-server/extensions/github.copilot-chat-*/package.json` for SSH/remote setups.
  4. `code --version` (first line) as a last resort.
  Returns `{ vscodeVersion?: string; copilotChatVersion?: string }`; absent fields stay `undefined`.
- The merge order becomes: baked defaults < auto-detected < provider config < account config.
- `resolveCopilotHeaders(override?)` consults the memoized detection result internally.

### Risk

Medium. Behavior now depends on the host filesystem state. In CI / Docker images without VS Code installed, detection yields `undefined` and we fall back to baked defaults (Proposal A behavior). On a developer workstation, the deployed Copilot Chat extension version is likely newer than baked defaults and may push us past whatever the proxy actually checks for — usually safer than older, but not guaranteed.

### What it enables

The runtime stays current through Microsoft tightening on hosts where VS Code + Copilot Chat are co-installed, with zero operator action.

### What it forbids

Network-based version discovery (no probes to `update.code.visualstudio.com`). Periodic refresh (one-shot at boot). No IPC into a running VS Code.

### Recommendation note

The substantive F21 deliverable is "operator can recover without rebuilding", which Proposal A satisfies. Auto-detection adds value only where VS Code is colocated with the runtime — which is **not** the actual deployment topology (`saivage-v3` LXC, `saivage-v3-getrich-v2` LXC, `diedrico` LXC all run headless containers without VS Code). For those deployments, Proposal B degenerates to Proposal A plus dead detection code.

## Recommendation

**Proposal A.**

1. The substantive F21 ask — "operator can bump the impersonation triple from `.saivage/saivage.json` without rebuilding" — is delivered end-to-end (provider construction, lazy OAuth refresh, and the `copilot_internal/v2/token` exchange) by Proposal A's wiring map.
2. Proposal B's auto-detection only adds value on hosts where VS Code is colocated with the runtime. None of the documented Saivage v2 deployment hosts have that. Adding ~80 lines plus a stubbed-homedir test for zero benefit in production violates the no-over-engineering guideline.
3. Proposal A's "shared defaults module + per-account optional override" is the precedent F11 (magic constants generally) will reuse. Proposal B is a bespoke heuristic that does not generalize to other providers.
4. The architecture-first guideline says: delete duplicates, expose one knob, no shims, no env-var fallbacks. Proposal A is the minimal architecturally correct shape. Proposal B layers a heuristic on top of it.

If the failure mode ever materializes faster than operator-side config edits can react, Proposal B's detection module can be added as a follow-up without re-touching Proposal A's surface area.
