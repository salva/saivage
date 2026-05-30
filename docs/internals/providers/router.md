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
ollama · llamacpp · nvidia-nim
```

Each registration creates a concrete `ModelProvider` instance and binds it
to the runtime config (`apiKey`, `baseUrl`, headers, accounts, and provider
metadata such as priority/model lists).

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
    G -- non-retryable --> I[Throw]
    G -- transient/throttling --> K[Mark model unhealthy]
    K --> E
    E --> L{Models exhausted?}
    L -- no --> D
    L -- yes --> M[Walk failover provider chain]
    M --> N[Repeat with next provider/model]
```

## Retry

Retryable candidate failures:

- HTTP 429 with `Retry-After` (honored).
- HTTP 5xx.
- Network/timeout errors.
- Provider-specific transient codes (mapped per provider).

The router does not sleep and retry the same candidate inside one `chat()`
call. It classifies provider errors, throws non-retryable/context-overflow
errors immediately, and otherwise disables the failing provider/model/account
candidate before moving to the next candidate in the failover chain.

## Failover

```jsonc
"failover": {
  "github-copilot": ["openai-codex", "anthropic"]
}
```

Failover is expanded from the requested model spec, model equivalents, and
configured failover entries. If a fallback succeeds after the primary was
attempted, the router sticks to that fallback until the primary retry window
opens again. The retry window starts at 30 s, grows by 1.5x, and caps at
20 min.

## Per-model health

```ts
interface ModelHealth {
  consecutiveFailures: number;
  disabledUntil: number;   // epoch ms
  backoffMs: number;       // grows ×1.5 per failure, max 10 min
}
```

A model is skipped while `Date.now() < disabledUntil`. The router prefers
healthy candidates from the configured model assignment, equivalent models,
and failover chain before reporting that all candidates failed.

## Request timeout

Each provider call is bounded by `PROVIDER_REQUEST_TIMEOUT_MS`, currently
300 s. There is no per-provider `timeoutMs` override in the runtime config.

## Rate-limit visibility

Providers expose a `RateLimitStatus` snapshot through the `ModelProvider`
interface. The router checks that snapshot before calls and caches broader
usage snapshots at startup for provider/account ordering. The
`/api/providers` endpoint currently returns provider names and model lists.

## Telemetry

Every LLM call passes through a lightweight `recordLlmCall()` hook around the
provider boundary. It records latency/token/error metadata for the runtime log
path, but there is no separate telemetry store or dashboard aggregation layer.

## Adding a provider

1. Implement `ModelProvider` (`src/providers/types.ts`).
2. Add a descriptor to `PROVIDER_DESCRIPTORS`.
3. Implement descriptor creation/registration rules plus any OAuth glue.
4. Document the user-facing `provider/model` strings in
   [Providers](/guide/providers).
