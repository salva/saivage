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
| `openai-codex`    | OAuth (PKCE) or `apiKey` | Codex CLI compatible. |
| `opencode`        | `apiKey`                 | `@mariozechner/pi-ai` adapter. |
| `opencode-go`     | `apiKey`                 | `@mariozechner/pi-ai` adapter. |
| `nvidia-nim`      | `apiKey`                 | NVIDIA NIM OpenAI-compatible API. |
| `ollama`          | none                     | Local; `baseUrl` defaults to `http://localhost:11434`. |
| `llamacpp`        | none                     | Local llama.cpp HTTP server. |

A model can be configured as a provider-independent model id, e.g.
`kimi-k2.6`, or as a `provider/model` string, e.g.
`github-copilot/claude-sonnet-4` or `anthropic/claude-3-5-sonnet-20241022`.
Provider-independent model ids are matched against provider and account
`models` declarations at runtime.

## Where credentials live

- **OAuth tokens**: `<project>/.saivage/auth-profiles.json` or
  `${SAIVAGE_ROOT}/auth-profiles.json` when `SAIVAGE_ROOT` is set. Managed
  by [`src/auth/store.ts`](https://github.com/salva/saivage/blob/main/src/auth/store.ts).
- **API keys**: in `saivage.json` under `providers.<id>.apiKey`. Strings
  support `${ENV_VAR}` interpolation, so you can keep secrets in env files.
- **Telegram bot token**: under `telegram.botToken` (also interpolated).

## Logging in

```bash
saivage login /path/to/project --provider github-copilot
saivage login /path/to/project --provider openai-codex
saivage login /path/to/project --provider anthropic
```

The flow opens a device-code URL on stdout (Copilot) or starts a local
PKCE callback server (Codex / Anthropic) and stores tokens on success.

```bash
saivage logout /path/to/project --provider github-copilot
saivage logout /path/to/project --profile github-copilot-me@example.com
```

Token refresh is performed lazily on each LLM request — the router calls
`getOAuthApiKey()` before sending and refreshes if necessary.

## Selecting models

Resolution precedence (most specific wins):

1. `ProjectConfig.routing` profiles (see [Routing](./routing))
2. The runtime model key for the role (`orchestrator`, `coder`, `researcher`,
   `data_agent`, `reviewer`, `designer`, `critic`, or `chat`)
3. `RuntimeConfig.models.default`

A role string is one of `planner`, `manager`, `coder`, `researcher`,
`data_agent`, `reviewer`, `designer`, `critic`, `inspector`, `chat`, or
`librarian`.

Role assignments may be ordered model lists:

```jsonc
"models": {
  "coder": ["kimi-k2.6", "deepseek-v4-pro"],
  "reviewer": ["gpt-5.5", "deepseek-v4-pro"]
}
```

For each model in the list, the router tries every configured provider/account
that can serve that model. At startup the router inspects usage snapshots for
each provider/account. Candidates with more unused tokens are tried first, then
those with a higher unused ratio, then static `priority` lower numbers first. If
all candidates for a model fail or are cooling down, the router advances to the
next model in the role list or model failover chain.

When a provider adapter does not expose account quota, `quota` can be used as a
startup hint for the same ordering logic:

```jsonc
{
  "providers": {
    "opencode-go": {
      "models": ["kimi-k2.6", "deepseek-v4-pro"],
      "accounts": {
        "opencode":    { "priority": 20, "apiKey": "${OPENCODE_GO_PRIMARY_KEY}", "quota": { "remainingTokens": 4000000 } },
        "opencode-go": { "priority": 10, "apiKey": "${OPENCODE_GO_SECONDARY_KEY}", "quota": { "remainingTokens": 9000000 } }
      }
    }
  }
}
```

## Multiple accounts per provider

Both `routing` (project-level) and `providers.<id>.accounts` (runtime-level)
let you bind a request to a specific OAuth profile or API key:

```jsonc
"providers": {
  "github-copilot": {
    "models": ["gpt-5.5", "claude-sonnet-4.6"],
    "accounts": {
      "personal": { "priority": 20, "authProfile": "github-copilot/me@example.com" },
      "work":     { "priority": 10, "authProfile": "github-copilot/me@work.com" }
    }
  }
}
```

You can then pin that account in routing:

```jsonc
"routing": {
  "roles": {
    "coder": { "model": "github-copilot/gpt-5.5", "account": "personal" }
  }
}
```

If no account is pinned, Saivage tries eligible accounts by priority.

## Failover

```json
"failover": {
  "github-copilot": ["openai-codex", "anthropic"]
}
```

The router maintains per-`provider/account/model` health: consecutive failures
push that candidate into a cooldown that grows by ×1.5 (15 s → 10 min cap).
When one provider/account fails, Saivage tries the next eligible provider/account
for the same model before it advances to the next configured model.

## Rate limiting

429 responses are classified as throttling. The router skips providers whose
`getRateLimitStatus()` reports `limited` and otherwise applies the normal
per-`provider/account/model` cooldown (`15s`, then ×1.5 up to `10m`) before
trying the next eligible candidate.

## Adding a new provider

1. Implement `ModelProvider` (`src/providers/types.ts`) — `chat`,
   `chatStream`, `listModels`, error mapping, optional `RateLimitStatus`.
2. Extend `ModelRouter.initProviders()` to register the new id.
3. (Optional) add a built-in OAuth flow under `src/auth/`.
4. Document the new `provider/model` strings here.

See the [Provider Router](/internals/providers/router) page for the full
algorithm and types.
