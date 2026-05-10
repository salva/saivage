# Runtime Configuration

The runtime config (`saivage.json`) controls the *daemon* — providers, ports,
MCP servers, security, supervisor. It is separate from the per-project
`config.json` and is shared across all projects served by a single daemon.

The schema lives in [`src/config.ts`](https://github.com/salva/saivage/blob/main/src/config.ts) (`SaivageConfig`).

## Location

The file is found by `configPath()`:

1. If `SAIVAGE_ROOT` is set, the config is `${SAIVAGE_ROOT}/saivage.json`.
2. Else, walk up from the launch directory for a `.saivage/config.json`
   marker; the runtime config sits in the same `.saivage/saivage.json`.
3. Otherwise: `${HOME}/.saivage/saivage.json`.

::: tip
For a multi-project deployment the runtime config naturally lives in
`~/.saivage/saivage.json` and is shared. If you want per-project runtime
isolation, set `SAIVAGE_ROOT` per service.
:::

## Default content

`writeDefaultConfig()` writes this on first run (truncated):

```json
{
  "models": {},
  "providers": {
    "anthropic": {},
    "openai": {},
    "ollama":   { "baseUrl": "http://localhost:11434" },
    "llamacpp": { "baseUrl": "http://localhost:8080" }
  },
  "server": { "port": 8080, "host": "0.0.0.0" },
  "agent":  { "maxConcurrentAgents": 3 },
  "mcpServers": {
    "playwright": {
      "command": "npx",
      "args": ["-y", "@playwright/mcp@latest", "--headless"],
      "env":    { "PLAYWRIGHT_BROWSERS_PATH": "${HOME}/.cache/ms-playwright" },
      "transport": "stdio"
    }
  }
}
```

## Sections

### `models`

Per-role model assignments. Values may be legacy `provider/model` strings
or ordered provider-independent model lists. Keys: `orchestrator`, `planner`,
`manager`, `coder`, `researcher`, `data_agent`, `reviewer`, `inspector`,
`executor`, `chat`, `default`. Project-level `model_overrides` take
precedence.

```json
"models": {
  "coder": ["kimi-k2.6", "deepseek-v4-pro"],
  "reviewer": "github-copilot/gpt-5.4",
  "default": ["deepseek-v4-flash"]
}
```

For provider-independent model names, the router finds providers and accounts
that advertise the requested model and tries them by usage and priority before
moving to the next configured model.

### `providers`

Map of provider id → settings (`apiKey`, `baseUrl`, `models`, `priority`,
`quota`, `accounts`, …). Provider ids are the well-known identifiers used by the router: `anthropic`,
`openai`, `openai-codex`, `github-copilot`, `ollama`, `llamacpp`,
`openrouter`, `pi-ai`. Settings are validated by `runtimeProviderConfigSchema`.

Providers can declare model capability and priority:

```json
"providers": {
  "opencode-go": {
    "priority": 10,
    "models": ["kimi-k2.6", "deepseek-v4-pro"],
    "apiKey": "${OPENCODE_GO_API_KEY}"
  },
  "opencode": {
    "priority": 20,
    "models": ["kimi-k2.6", "qwen3.5-plus"],
    "apiKey": "${OPENCODE_API_KEY}"
  }
}
```

At startup the router inspects provider/account usage snapshots when a provider
adapter exposes them. If the adapter cannot report quota, you can provide a
startup hint with `quota`. Candidates with more `remainingTokens` are tried
first; `remainingRatio` is used next; static `priority` breaks ties and remains
the fallback when usage is unknown.

```json
"providers": {
  "opencode-go": {
    "models": ["kimi-k2.6", "deepseek-v4-pro"],
    "accounts": {
      "primary": {
        "priority": 10,
        "apiKey": "${OPENCODE_GO_PRIMARY_KEY}",
        "quota": { "remainingTokens": 12000000, "totalTokens": 15000000 }
      },
      "secondary": {
        "priority": 20,
        "apiKey": "${OPENCODE_GO_SECONDARY_KEY}",
        "quota": { "remainingTokens": 18000000, "totalTokens": 20000000 }
      }
    }
  }
}
```

### `failover`

Map of model or provider id → ordered fallback chain. For provider-independent
models, provider/account failures are exhausted for the current model before the
router advances to the next model.

```json
"failover": {
  "kimi-k2.6": ["deepseek-v4-pro"],
  "github-copilot": ["openai-codex", "anthropic", "openai"]
}
```

### `modelEquivalents`

Map of canonical model id → list of equivalent ids across providers. The
router uses this to translate role overrides when failing over.

### `server`

```json
"server": { "port": 8080, "host": "0.0.0.0" }
```

### `agent`

```json
"agent": { "maxConcurrentAgents": 3 }
```

Caps total simultaneous agent dispatches. The 1 Coder + 1 Researcher
parallelism cap inside a single Manager is enforced separately by the runtime.

### `runtime`

```json
"runtime": {
  "maxServices": 50,
  "restartOnCrash": true,
  "continuousImprovement": true,
  "healthCheckIntervalMs": 30000,
  "idleShutdownMs": 300000
}
```

### `security`

```json
"security": {
  "injectionScanner": true,
  "injectionModel": "github-copilot/gpt-5.4",
  "maxScanLengthBytes": 100000
}
```

Drives the [Prompt-Injection Cop](/internals/security).

### `supervisor`

```json
"supervisor": {
  "enabled": true,
  "model":   "github-copilot/gpt-5.4",
  "intervalMs": 1200000,
  "consecutiveStuckVerdicts": 3,
  "logLines": 400
}
```

The supervisor runs in the background, periodically inspecting recent logs
and asking an LLM whether the system is making progress. After
`consecutiveStuckVerdicts` consecutive *stuck* verdicts it triggers an abort.

### `telegram`

```json
"telegram": {
  "botToken": "${TELEGRAM_BOT_TOKEN}",
  "allowedUserIds": [123456789]
}
```

`${VAR}` strings are interpolated from process env.

### `notifications`

```json
"notifications": {
  "channels": ["web"],
  "filters": { "min_severity": "info", "categories": [] }
}
```

Same shape as the project-level field; the runtime config is the fallback
default.

### `mcpServers`

Map of name → server spec for **external** MCP servers launched by the
runtime.

```json
"mcpServers": {
  "playwright": {
    "command": "npx",
    "args": ["-y", "@playwright/mcp@latest", "--headless"],
    "env":    { "PLAYWRIGHT_BROWSERS_PATH": "${HOME}/.cache/ms-playwright" },
    "disabled": false,
    "autostart": true,
    "transport": "stdio"
  }
}
```

Built-in services (`fs`, `shell`, `git`, `plan`, `notes`, `skills`) are
registered programmatically — they don't appear in this map.

## Environment-variable interpolation

Strings of the form `${NAME}` are replaced with `process.env.NAME` (empty
string if unset). Useful for secrets (`${ANTHROPIC_API_KEY}`) and platform
paths (`${HOME}`).

## Reloading

The config is cached after the first read. Restart the daemon to pick up
changes.
