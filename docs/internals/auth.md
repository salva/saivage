# Auth & Token Stores

[`src/auth/`](https://github.com/salva/saivage/tree/main/src/auth)

Saivage supports two credential models:

- **API keys**: a string in `saivage.json`'s `providers.<id>.apiKey`
  (env-interpolated).
- **OAuth profiles**: token bundles stored in `auth-profiles.json` and
  managed by per-provider OAuth flows.

## Profile store

`src/auth/store.ts` exposes:

- `loadProfiles()` / `saveProfile(profile)` — JSON read/write.
- `getOAuthApiKey(providerId, { profileKey? })` — returns a usable bearer
  token, refreshing if necessary.
- `hasOAuthCredentials(providerId)` — used by the router to decide whether
  to register the provider.
- `getProfileByKey(key)` — explicit lookup.

A profile's `key` is `"<provider>/<account-label>"` (e.g.
`"github-copilot/me@example.com"`). Multiple profiles per provider are
allowed and selectable through [routing](/guide/routing).

## Stored fields

```ts
interface OAuthCredentials {
  providerId: string;       // "github-copilot" | "anthropic" | "openai-codex"
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;       // epoch ms
  scope?: string;
  metadata?: Record<string, unknown>;
}
```

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
  label: string;
  login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials>;
  refresh?(creds: OAuthCredentials): Promise<OAuthCredentials>;
}
```

Implement, register in `getOAuthProviders()`, and the `saivage login`
picker will surface it automatically.

## Refresh

The router calls `getOAuthApiKey(...)` before each request. If the token
is expired (`expiresAt < now`) and `refresh()` is implemented, a refresh
is attempted in-line. On refresh failure the router treats the request as
a normal authentication error (which usually triggers failover).

## Scoping to a project

Profiles live in `~/.saivage/auth-profiles.json` by default but can be
scoped to a project (`<project>/.saivage/auth-profiles.json`) by setting
`SAIVAGE_ROOT` to the project's `.saivage/` directory. Useful for
isolating client A's API keys from client B's.
