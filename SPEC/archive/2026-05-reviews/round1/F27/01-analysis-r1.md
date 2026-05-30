# F27 — Analysis r1

## Problem restated

Each of the three OAuth modules declares its `client_id` as a module-scope literal constant. Rotating a provider's client id, supporting an alternate (per-tenant / per-deployment) client id, or pointing a fork at a different OAuth app all require editing source and rebuilding `dist/`:

- [src/auth/anthropic.ts](src/auth/anthropic.ts#L13) — `const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";`
- [src/auth/openai-codex.ts](src/auth/openai-codex.ts#L12) — `const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";`
- [src/auth/github-copilot.ts](src/auth/github-copilot.ts#L15) — `const CLIENT_ID = atob("SXYxLmI1MDdhMDhjODdlY2ZlOTg=");`

These three values are referenced from authorize, token exchange, and token refresh requests:

- Anthropic: [src/auth/anthropic.ts](src/auth/anthropic.ts#L57), [src/auth/anthropic.ts](src/auth/anthropic.ts#L88), [src/auth/anthropic.ts](src/auth/anthropic.ts#L170)
- OpenAI Codex: [src/auth/openai-codex.ts](src/auth/openai-codex.ts#L66), [src/auth/openai-codex.ts](src/auth/openai-codex.ts#L97), [src/auth/openai-codex.ts](src/auth/openai-codex.ts#L179)
- GitHub Copilot: [src/auth/github-copilot.ts](src/auth/github-copilot.ts#L83), [src/auth/github-copilot.ts](src/auth/github-copilot.ts#L137)

Note: these ids are *intentionally public* — PKCE (authorization_code) and the device-code flow do not use a client secret; the security boundary is the redirect URI registered on the provider, the PKCE code verifier, and (for Copilot) the device code. Treating them as secrets is wrong. The correct framing is "deployment-time configuration": they are constants the operator may legitimately want to override (forked OAuth app, enterprise tenant, post-rotation patch) without rebuilding the bundle.

## Contract

For each OAuth provider, the flow code needs exactly one `client_id` string that is used identically in:

1. Authorize URL (`response_type=code` PKCE flows) or device-code request body.
2. Token exchange (`grant_type=authorization_code` or `grant_type=urn:ietf:params:oauth:grant-type:device_code`).
3. Token refresh (`grant_type=refresh_token`) — only for the two PKCE flows; the GitHub Copilot flow doesn't refresh via `client_id` (it re-exchanges the GitHub token for a Copilot token at [src/auth/github-copilot.ts](src/auth/github-copilot.ts#L169-L189)).

Lifecycle: the value is read once when a flow function is invoked. It does not change mid-flow. There is no reason for hot-reload.

Error modes: a wrong / revoked `client_id` causes the provider to return an HTTP 400/401 from the token endpoint. The existing handlers surface this as `Token exchange failed: <status> <body>` (e.g. [src/auth/anthropic.ts](src/auth/anthropic.ts#L66)). No new error modes are introduced by making the value overridable.

## Call sites & dependencies

The OAuth flows are entered from the CLI / web `login` path through the provider registry in [src/auth/store.ts](src/auth/store.ts#L25-L29) and re-exported via [src/auth/index.ts](src/auth/index.ts#L1-L5). `getOAuthApiKey` ([src/auth/store.ts](src/auth/store.ts#L88-L130)) calls `provider.refreshToken(profile)` which is what triggers `refreshAnthropicToken` / `refreshOpenAICodexToken` / `refreshGitHubCopilotToken` — each of which currently reads the module-scope `CLIENT_ID`.

No tests today exercise the `CLIENT_ID` literal directly; [src/auth/store.test.ts](src/auth/store.test.ts) covers store persistence only.

The Saivage config schema lives at [src/config.ts](src/config.ts#L34-L113). It already validates and exposes provider routing, models, server, supervisor, security, telegram, etc., but has no `oauth` / `auth` section. `loadConfig` is the single entry point and is widely consumed (e.g. [src/providers/router.ts](src/providers/router.ts), [src/server/bootstrap.ts](src/server/bootstrap.ts)).

The `.saivage/saivage.json` file is the canonical operator-editable config (see `configPath` in [src/config.ts](src/config.ts#L143-L145)). Env-var interpolation (`${VAR}`) is already applied via `deepInterpolate` ([src/config.ts](src/config.ts#L150-L165)), so an override can come from either the JSON file or an env var without extra plumbing.

## Constraints any solution must respect

- **No backward compatibility.** The hardcoded literals must move; no "fall back to compiled default if the new config key is absent" pretense if we introduce a new contract. Defaults are still allowed — they are not migration shims, they are the shipped default values that make the bundle work out of the box. The forbidden pattern would be keeping a deprecated alternate location.
- **No leak into other subsystems.** Provider routing config (model, baseUrl, etc.) is a separate concern from OAuth client identification. Conflating them with the existing `providers.<id>` map in [src/config.ts](src/config.ts#L51) would couple two unrelated lifecycles (router uses these for *API key + base URL + model resolution*; OAuth uses these for *login flow only*).
- **Do not invent secrets handling.** These ids are public; do not encrypt them, do not move them into `.saivage/auth-profiles.json` (which is owner-only because it stores refresh tokens), do not gitignore them.
- **Single source of truth per provider.** Each `CLIENT_ID` must be referenced from exactly one place after the change; the three intra-file usages must read from the same resolved value.
- **Type-checked.** The config schema (`z`) must encode the new section; consumers must receive a typed value, not `string | undefined` smuggled in via `process.env`.
- **No new docstrings/comments** on call sites that we don't otherwise modify.
- **Out-of-scope boundary:** `oauthToProviderName` ([src/auth/store.ts](src/auth/store.ts#L148-L152)) is flagged as related but is its own issue (F15 — "oauth resolution overlap"). This finding only addresses the literal-constant problem; it does not redesign profile-name resolution.

## Cross-issue links

- F15 (oauth resolution overlap): the `openai-codex → openai` mapping is the related-but-separate concern noted in the F27 source.
- F19 (provider barrel): a later consolidation could fold OAuth provider descriptors into a shared barrel; F27 should not pre-empt that.
- F11 (magic constants not in config): same shape of fix (hoist literal → schema-typed config), so the implementation idiom should match whatever F11 lands on.
