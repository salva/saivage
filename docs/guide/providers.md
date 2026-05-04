# LLM Providers & Authentication

Saivage routes every LLM call through a single **`ModelRouter`** that
multiplexes across registered providers, applies retry & failover, and
respects per-model health backoff.

## Supported providers

| ID                | Auth                     | Notes |
|-------------------|--------------------------|-------|
| `github-copilot`  | OAuth (device-code flow) | Default. Hosts many models including Claude, GPT-5.x, o-series. |
| `anthropic`       | OAuth or `apiKey`        | Direct Anthropic API. |
| `openai`          | `apiKey`                 | Direct OpenAI API. |
| `openai-codex`    | OAuth (PKCE)             | Codex CLI compatible. |
| `openrouter`      | `apiKey`                 | Aggregator. |
| `pi-ai`           | (varies)                 | `@mariozechner/pi-ai` adapter. |
| `ollama`          | none                     | Local; `baseUrl` defaults to `http://localhost:11434`. |
| `llamacpp`        | none                     | Local llama.cpp HTTP server. |

A model is identified by a `provider/model` string, e.g.
`github-copilot/claude-sonnet-4` or `anthropic/claude-3-5-sonnet-20241022`.

## Where credentials live

- **OAuth tokens**: `~/.saivage/auth-profiles.json` (or
  `<project>/.saivage/auth-profiles.json` when scoped to a project). Managed
  by [`src/auth/store.ts`](https://github.com/salva/saivage/blob/main/src/auth/store.ts).
- **API keys**: in `saivage.json` under `providers.<id>.apiKey`. Strings
  support `${ENV_VAR}` interpolation, so you can keep secrets in env files.
- **Telegram bot token**: under `telegram.botToken` (also interpolated).

## Logging in

```bash
saivage login                  # interactive picker (run inside the daemon host)
saivage login github-copilot
saivage login openai-codex
saivage login anthropic
```

The flow opens a device-code URL on stdout (Copilot) or starts a local
PKCE callback server (Codex / Anthropic) and stores tokens on success.

```bash
saivage logout                 # remove a stored profile
```

Token refresh is performed lazily on each LLM request — the router calls
`getOAuthApiKey()` before sending and refreshes if necessary.

## Selecting models

Resolution precedence (most specific wins):

1. `ProjectConfig.model_overrides[<role>]`
2. `ProjectConfig.routing` profiles (see [Routing](./routing))
3. `RuntimeConfig.models[<role>]`
4. `RuntimeConfig.models.default`
5. The provider's "most capable" registered model.

A role string is one of `planner`, `manager`, `coder`, `researcher`,
`reviewer`, `inspector`, `chat`, `data_agent`.

## Multiple accounts per provider

Both `routing` (project-level) and `providers.<id>.accounts` (runtime-level)
let you bind a request to a specific OAuth profile or API key:

```jsonc
"providers": {
  "github-copilot": {
    "accounts": {
      "personal": { "authProfile": "github-copilot/me@example.com" },
      "work":     { "authProfile": "github-copilot/me@work.com" }
    }
  }
}
```

You can then reference an account in routing: `provider:github-copilot@personal`.

## Failover

```json
"failover": {
  "github-copilot": ["openai-codex", "anthropic"]
}
```

The router maintains per-model health: consecutive failures push the model
into a cooldown that grows by ×1.5 (15 s → 10 min cap). When all healthy
models for a request are exhausted, the router walks the failover chain
provider-by-provider.

## Rate limiting

429 responses with `Retry-After` are honored. The router exposes a
`RateLimitStatus` snapshot per provider via the `/api/state` endpoint —
displayed in the web dashboard as the "providers" panel.

## Adding a new provider

1. Implement `ModelProvider` (`src/providers/types.ts`) — `chat`,
   `chatStream`, `listModels`, error mapping, optional `RateLimitStatus`.
2. Extend `ModelRouter.initProviders()` to register the new id.
3. (Optional) add a built-in OAuth flow under `src/auth/`.
4. Document the new `provider/model` strings here.

See the [Provider Router](/internals/provider-router) page for the full
algorithm and types.
