# Provider Router

[`src/providers/router.ts`](https://github.com/salva/saivage/blob/main/src/providers/router.ts)

The `ModelRouter` is the single point of contact between agents and LLM
APIs. It abstracts away provider-specific details (auth, base URL,
request shape) and adds three cross-cutting concerns: **retry**,
**failover**, and **per-model health**.

## Registered providers

`ModelRouter.initProviders()` walks a fixed list of provider ids and
registers any for which configuration or OAuth credentials are present:

```
github-copilot · anthropic · openai · openai-codex
opencode · opencode-go
ollama · llamacpp · openrouter · pi-ai
```

Each registration creates a concrete `ModelProvider` instance and binds it
to the runtime config (`apiKey`, `baseUrl`, accounts).

## Resolution (per LLM call)

```mermaid
flowchart TD
    A[Agent calls router.chat(role, request)] --> B[Routing resolver]
    B --> C[provider/model + auth profile]
    C --> D{Model healthy?}
    D -- no --> E[Try preferred fallback model]
    D -- yes --> F[Resolve API key OAuth or static]
    F --> G[Provider.chat]
    G -- 200 --> H[Return]
    G -- 4xx/5xx --> I{Retryable?}
    I -- yes --> J[Backoff exp. 1s→60s ±20%]
    J --> G
    I -- no --> K[Mark model unhealthy]
    K --> E
    E --> L{Models exhausted?}
    L -- no --> D
    L -- yes --> M[Walk failover provider chain]
    M --> N[Repeat with next provider/model]
```

## Retry

Retryable errors:

- HTTP 429 with `Retry-After` (honored).
- HTTP 5xx.
- Network/timeout errors.
- Provider-specific transient codes (mapped per provider).

Backoff is exponential with ±20% jitter; cap is 60 seconds. The total
wait is bounded by `PROVIDER_REQUEST_TIMEOUT_MS` (5 min default per call).

## Failover

```jsonc
"failover": {
  "github-copilot": ["openai-codex", "anthropic"]
}
```

When a primary provider produces 5+ consecutive failures within 2 min the
router rotates the active provider for that role. On the next request the
primary is tried again — failover is sticky-per-error, not sticky-per-
session.

## Per-model health

```ts
interface ModelHealth {
  consecutiveFailures: number;
  disabledUntil: number;   // epoch ms
  backoffMs: number;       // grows ×1.5 per failure, max 10 min
}
```

A model is skipped while `Date.now() < disabledUntil`. The router prefers
healthy models from `preferred_models` (set by [routing](/guide/routing))
before falling back to the first available.

## Request timeout

Per-provider, defaults to 120 s; overridable in `providers.<id>.timeoutMs`.

## Rate-limit visibility

Providers update a `RateLimitStatus` blob after each call (limit,
remaining, reset). The router exposes it under
`/api/providers` for the dashboard.

## Telemetry

Every LLM call is logged via `recordLlmCall()` to the structured logger:
provider, model, role, token usage, latency, success flag. The dashboard
aggregates these.

## Adding a provider

1. Implement `ModelProvider` (`src/providers/types.ts`).
2. Add the id to `initProviders()`'s `knownProviders` array.
3. Implement `createProvider()` + (if applicable) OAuth glue.
4. Document the user-facing `provider/model` strings in
   [Providers](/guide/providers).
