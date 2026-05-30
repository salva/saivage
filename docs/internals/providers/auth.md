# Auth & Token Stores

[`src/auth/`](https://github.com/salva/saivage/tree/main/src/auth)

Saivage supports two credential models:

- **API keys**: a string in `saivage.json`'s `providers.<id>.apiKey`
  (env-interpolated).
- **OAuth profiles**: token bundles stored in `auth-profiles.json` and
  managed by per-provider OAuth flows.

## Profile store

`src/auth/store.ts` exposes:

- `loadProfiles()` / `saveProfile(key, profile)` / `saveProfiles(store)` — JSON read/write.
- `getOAuthApiKey(providerId, { profileKey? })` — returns a usable bearer
  token, refreshing if necessary.
- `hasOAuthCredentials(providerId)` — used by the router to decide whether
  to register the provider.
- `hasOAuthProfile(key, providerId?)` — checks a named profile.
- `getProfileByKey(key)` — explicit lookup.

A profile's default key is `"<provider>-<accountId>"` when the OAuth flow
returns an account id, or `"<provider>-default"` otherwise. Operators can
override it with `saivage login --profile <name>`. Multiple profiles per
provider are allowed and selectable through [routing](/guide/routing).

## Stored fields

```ts
interface OAuthCredentials {
  access: string;
  refresh: string;
  expires: number;          // epoch ms
  accountId?: string;
  email?: string;
}
```

Persisted profiles add `type: "oauth"` and `provider` alongside those token
fields.

The store is a single JSON file: keep it readable only by the daemon user.

## Built-in OAuth flows

### GitHub Copilot — device-code

`src/auth/github-copilot.ts`. Follows the standard GitHub device-code
flow: poll-for-token, exchange for a Copilot-scoped token, persist. Token
exchange happens on demand and keeps the Copilot bearer fresh for chat &
completions endpoints.

### OpenAI Codex — PKCE

`src/auth/openai-codex.ts`. Local HTTP listener for the OAuth callback;
PKCE-protected.

### Anthropic — local PKCE

`src/auth/anthropic.ts`. Same shape; redirects to a local URL.

### Adding a flow

`src/auth/types.ts` defines `OAuthProviderDef`:

```ts
interface OAuthProviderDef {
  id: string;
  name: string;
  login(callbacks: OAuthLoginCallbacks, options?: OAuthProviderOptions): Promise<OAuthCredentials>;
  refreshToken(creds: OAuthCredentials, options?: OAuthProviderOptions): Promise<OAuthCredentials>;
  getApiKey(creds: OAuthCredentials): string;
}
```

Implement, register in `getOAuthProviders()`, and the `saivage login`
picker will surface it automatically.

## Refresh

The router calls `getOAuthApiKey(...)` before each request. If the token is
expired (`expires < now`), `refreshToken()` is attempted in-line. On refresh
failure, `getOAuthApiKey(...)` returns `null`; the provider call then proceeds
without a fresh bearer and is classified through the normal provider error
path.

## Scoping to a project

Profiles live in `<project>/.saivage/auth-profiles.json` under the resolved
project root. `SAIVAGE_ROOT` can point directly at a project's `.saivage/`
directory when the process needs an explicit store location.
