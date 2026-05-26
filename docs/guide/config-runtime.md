# Runtime Configuration

The runtime config (`saivage.json`) controls the *daemon* — providers, ports,
MCP servers, security, supervisor. It is separate from the per-project
`config.json` and is shared across all projects served by a single daemon.

The schema lives in [`src/config.ts`](https://github.com/salva/saivage/blob/main/src/config.ts) (`SaivageConfig`).

## Location

The runtime config path is `<saivageDir>/saivage.json`, where `<saivageDir>`
is computed by `saivageDir()` ([`src/config.ts`](https://github.com/salva/saivage/blob/main/src/config.ts)):

1. If the `SAIVAGE_ROOT` environment variable is set (and no explicit project
   root is passed by the caller), `<saivageDir>` is `${SAIVAGE_ROOT}`
   directly; the runtime config is therefore `${SAIVAGE_ROOT}/saivage.json`.
2. Otherwise, `<saivageDir>` is `<projectRoot>/.saivage`, where
   `projectRoot` is resolved by `resolveProjectRoot()` in this precedence:
   1. `PROJECT_ROOT` env var, if set.
   2. `dirname(SAIVAGE_ROOT)` env var, if set.
   3. Walk up from `process.cwd()` looking for a `.saivage/config.json`
      marker.
   4. Fall back to `process.cwd()` itself.

There is **no `${HOME}/.saivage/saivage.json` fallback** — the daemon never
picks the home directory on its own.

::: tip
For a multi-project deployment, set `SAIVAGE_ROOT` per service to whatever
shared path you want; the daemon will read `${SAIVAGE_ROOT}/saivage.json`
from there. For per-project isolation, leave `SAIVAGE_ROOT` unset and let
each project carry its own `.saivage/saivage.json`.
:::

## Default content

`seedProject()` writes this on `saivage init` (truncated):

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
  "idleShutdownMs": 300000,
  "recoveryDelayMs": 60000,
  "notes": { "volatileTtlMs": 7200000 }
}
```

`recoveryDelayMs` is the cooldown before the runtime retries a crashed
service (F11). `notes.volatileTtlMs` is the lifetime of volatile user notes
before they are auto-expired (2h default).

### `security`

```json
"security": {
  "injectionScanner": true,
  "maxScanLengthBytes": 100000
}
```

Drives the [Prompt-Injection Cop](/internals/security). `injectionModel` is
required when the scanner is enabled; the daemon refuses to boot otherwise.
See [F04](../../SPEC/v2/review-2026-05/F04-hardcoded-default-models.md).

### `supervisor`

```json
"supervisor": {
  "enabled": true,
  "intervalMs": 1200000,
  "consecutiveStuckVerdicts": 3,
  "logLines": 400,
  "forceCancelDelayMs": 600000
}
```

The supervisor runs in the background, periodically inspecting recent logs
and asking an LLM whether the system is making progress. After
`consecutiveStuckVerdicts` consecutive *stuck* verdicts it triggers an
abort, and waits `forceCancelDelayMs` before force-cancelling an
unresponsive run. `model` is required when the supervisor is enabled; the
daemon refuses to boot otherwise. See
[F04](../../SPEC/v2/review-2026-05/F04-hardcoded-default-models.md).

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

### `mcp`

Wall-clock and output caps for the in-process MCP tooling layer (F11).

```json
"mcp": {
  "shellTimeoutMs": 14400000,
  "shellTimeoutFloorMs": 600000,
  "inProcessTimeoutMs": 300000,
  "maxOutputBytes": 102400,
  "maxFetchBytes": 200000,
  "maxDownloadBytes": 262144000,
  "maxFileReadBytes": 200000,
  "maxSearchResults": 1000,
  "maxSearchDepth": 20,
  "maxSearchMs": 10000,
  "fetchTimeoutMs": 60000,
  "webSearchMaxBytes": 2097152,
  "webSearchMaxResults": 20,
  "webSearchTimeoutMs": 15000
}
```

`shellTimeoutMs` is the hard upper bound for a single shell tool call.
`shellTimeoutFloorMs` is the minimum effective timeout enforced even when the
caller requests less; it must not exceed `shellTimeoutMs - WALL_CLOCK_HEADROOM_MS`
(the runtime rejects misconfiguration at boot).

`maxFileReadBytes` is the per-call cap (in bytes) for the `read_file` MCP tool.
Whole-file reads above the cap return `FILE_TOO_LARGE`; callers must use the
`offset`/`length` window (each capped by the same value) or fall back to
`run_command` with `head`/`tail`/`grep`.

`maxSearchResults`, `maxSearchDepth`, and `maxSearchMs` bound the in-process
async `search_files` walker (G32). `maxSearchResults` is the absolute ceiling
on returned file paths (default `1000`); per-call `max_results` may only lower
this — values above the configured ceiling are clamped, not rejected. Negative
or non-integer `max_results` returns `INVALID_ARGUMENT`. `maxSearchDepth` is
the maximum recursion depth measured from the root directory (default `20`)
and `maxSearchMs` is the per-call wall-clock budget covering the entire walk
(default `10000`). When any cap binds the walker stops cleanly and emits
`truncated: true` with `truncated_reason` set to `"results"`, `"depth"`, or
`"time"`. Patterns use a segment-aware glob dialect: `*` matches within a
single path segment, `?` matches a single character within a segment, `[…]`
forms a character class, and `**` matches zero or more whole segments and may
only appear as a complete segment (`foo**`, `**bar`, and `foo**bar` are
rejected with `INVALID_PATTERN`). The success envelope is
`{ files, truncated, truncated_reason, max_results, max_depth, max_ms,
skipped? }`; `skipped[]` (present only when non-empty) enumerates subtrees the
walker observed but could not enter, each entry shaped
`{ path, code, errno? }` with `code` ∈ {`PERMISSION_DENIED`, `NOT_FOUND`}.
Error envelopes carry a stable `code` field — one of `INVALID_ARGUMENT`,
`INVALID_PATTERN`, `NOT_FOUND`, `NOT_A_DIRECTORY`, `PERMISSION_DENIED`,
`IO_ERROR`, or `READ_DIRECTORY_FAILED` — alongside the human-readable
`error` message and an optional `errno`. `READ_DIRECTORY_FAILED` is reserved
for unrecoverable mid-walk errors (e.g. `EMFILE`/`EIO`); the walker discards
any partial result and surfaces only the envelope.

`maxFetchBytes` is the cap on **raw upstream response bytes** read by the
`fetch_url` and `fetch_page_text` MCP tools (clamped to `[1_000, 1_000_000]`
when overridden per call via `max_bytes`). For `fetch_page_text` it bounds the
raw HTML stream before stripping — the returned `text` is therefore bounded by
this byte cap, not by character count. Truncation is non-lossy at the UTF-8
codepoint boundary: partial multi-byte runes at the cap are dropped rather
than emitted as U+FFFD. Responses are returned with `bytes_read` and
`truncated` so callers can detect cap-induced truncation. Note: the legacy
`maxFetchChars` field was removed without a migration shim — stale configs
that still reference it fail loud at load time.

`fetchTimeoutMs` is the per-request wall-clock cap for every outbound HTTP
fetch (`fetch_url`, `fetch_page_text`, `download_file`,
`download_with_fallbacks`). The timer covers both the time to receive headers
and the time to drain the body; expiry cancels the upstream socket via
`AbortSignal` and produces a structured error envelope. Valid range:
`[1_000, 600_000]`, default `60_000`.

Error envelopes from these tools carry a stable `code` field — one of
`INVALID_ARGUMENT`, `TIMEOUT`, `NETWORK_ERROR`, `UPSTREAM_HTTP_ERROR`,
`RESPONSE_TOO_LARGE`, or `IO_ERROR` — alongside the human-readable `error`
message and an optional `errno` (e.g. `ECONNREFUSED`, `EACCES`) when the
underlying failure exposed one.

`webSearchMaxBytes`, `webSearchMaxResults`, and `webSearchTimeoutMs` bound the
DOM-parsed `web_search` tool independently of the general fetch ceilings.
`webSearchMaxBytes` caps the HTML response read from the DuckDuckGo HTML
endpoint (valid `[65_536, 16_777_216]`, default `2_097_152` ≈ 2 MiB) and a
breach maps to `RESPONSE_TOO_LARGE`. `webSearchMaxResults` is the ceiling on
returned result rows (valid `[1, 50]`, default `20`); callers that pass
`max_results` above this value are clamped, not rejected.
`webSearchTimeoutMs` is the per-search wall-clock cap covering header receipt
and body drain (valid `[1_000, 60_000]`, default `15_000`); expiry produces a
`TIMEOUT` envelope with `timeout_ms` echoed. In addition to the codes above,
`web_search` envelopes can carry `PARSE_FAILURE` (DOM parser threw) or
`NO_RESULTS_PARSED` (parser saw no result anchors — usually upstream markup
drift; the envelope includes a `markup_signature` to aid triage).

### `oauth`

Client ids for the built-in OAuth flows. Defaults to the public client ids
shipped with Saivage; override only if you have provisioned your own apps.

```json
"oauth": {
  "anthropic":     { "clientId": "..." },
  "openaiCodex":   { "clientId": "..." },
  "githubCopilot": { "clientId": "..." }
}
```

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
