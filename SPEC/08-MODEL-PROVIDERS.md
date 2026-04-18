# Saivage — Model Providers

## 1. Purpose

The Model Provider layer provides a **unified interface** for interacting with multiple LLM providers and models. Each Orchestrator and sub-agent role can be assigned a different model. The system handles auth, failover, rate limits, and cost tracking transparently.

Inspired by OpenClaw's approach: models are specified as `provider/model-id` strings, and failover chains allow automatic fallback when a provider is unavailable.

## 2. Provider/Model Addressing

Models are referenced as `provider/model-id`:

```
anthropic/claude-sonnet-4-20250514
openai/gpt-5
google/gemini-2.5-pro
ollama/llama3.3:70b
openrouter/meta-llama/llama-3.3-70b
```

This format is used everywhere: config, CLI, agent definitions, runtime overrides.

## 3. Provider Interface

All providers implement a common interface:

```typescript
interface ModelProvider {
  readonly name: string;          // "anthropic", "openai", etc.

  chat(request: ChatRequest): Promise<ChatResponse>;
  streamChat(request: ChatRequest): AsyncIterable<ChatChunk>;

  // Capabilities
  supportsTools(): boolean;
  supportsImages(): boolean;
  supportsStreaming(): boolean;
  maxContextTokens(model: string): number;

  // Health
  isAvailable(): Promise<boolean>;
  getRateLimitStatus(): RateLimitStatus;
}

interface ChatRequest {
  model: string;                   // Model ID (without provider prefix)
  system: string;
  messages: Message[];
  tools?: ToolSchema[];
  maxTokens?: number;
  temperature?: number;
  stopSequences?: string[];
}

interface ChatResponse {
  type: "text" | "tool_use";
  text?: string;
  toolCalls?: ToolCall[];
  usage: { inputTokens: number; outputTokens: number };
  model: string;                   // Actual model used (may differ on failover)
  provider: string;
  durationMs: number;
}
```

## 4. Built-in Providers

### 4.1 Anthropic

```typescript
class AnthropicProvider implements ModelProvider {
  // Uses @anthropic-ai/sdk
  // Supports: chat, tools, images, streaming
  // Auth: API key (ANTHROPIC_API_KEY or config)
  // Models: claude-sonnet-4-20250514, claude-haiku-3, etc.
}
```

### 4.2 OpenAI

```typescript
class OpenAIProvider implements ModelProvider {
  // Uses openai SDK
  // Supports: chat, tools, images, streaming
  // Auth: API key (OPENAI_API_KEY or config)
  // Models: gpt-5, gpt-4.1, o3, o4-mini, etc.
  // Also supports Azure OpenAI via baseUrl override
}
```

### 4.3 Google (Gemini)

```typescript
class GoogleProvider implements ModelProvider {
  // Uses @google/genai SDK
  // Supports: chat, tools, images, streaming
  // Auth: API key (GOOGLE_API_KEY or config)
  // Models: gemini-2.5-pro, gemini-2.5-flash, etc.
}
```

### 4.4 Ollama (Local)

```typescript
class OllamaProvider implements ModelProvider {
  // HTTP client to local Ollama server
  // Supports: chat, tools (model-dependent), streaming
  // Auth: none (localhost)
  // Models: llama3.3, codellama, mistral, etc.
  // Config: baseUrl (default http://localhost:11434)
}
```

### 4.5 OpenRouter

```typescript
class OpenRouterProvider implements ModelProvider {
  // Proxies to many providers via OpenRouter API
  // Auth: API key (OPENROUTER_API_KEY or config)
  // Models: any model available on OpenRouter
  // Useful as a failover target
}
```

### 4.6 Custom Provider

Users can add custom providers by implementing the interface and registering them:

```jsonc
// ~/.saivage/saivage.json
{
  "providers": {
    "my-company": {
      "type": "openai-compatible",   // Use OpenAI-compatible adapter
      "baseUrl": "https://llm.internal.company.com/v1",
      "apiKey": "${MY_LLM_API_KEY}"
    }
  }
}
```

## 5. Model Router

The Model Router resolves a `provider/model-id` to a configured provider instance and handles failover:

```typescript
class ModelRouter {
  private providers: Map<string, ModelProvider>;
  private failoverChains: Map<string, string[]>;

  async chat(modelId: string, request: ChatRequest): Promise<ChatResponse> {
    const chain = this.resolveChain(modelId);

    for (const candidate of chain) {
      const [providerName, model] = parseModelId(candidate);
      const provider = this.providers.get(providerName);

      if (!provider) continue;

      // Check rate limits
      const rateStatus = provider.getRateLimitStatus();
      if (rateStatus.isLimited) {
        continue; // Skip to next in chain
      }

      try {
        return await provider.chat({ ...request, model });
      } catch (error) {
        if (isRetryable(error)) {
          continue; // Try next in chain
        }
        throw error; // Non-retryable (bad request, auth error)
      }
    }

    throw new AllProvidersUnavailable(modelId);
  }

  private resolveChain(modelId: string): string[] {
    const chain = this.failoverChains.get(modelId) ?? [];
    return [modelId, ...chain];
  }
}
```

## 6. Failover

### 6.1 Configuration

```jsonc
{
  "failover": {
    // If Claude Sonnet fails, try GPT-5, then OpenRouter as last resort
    "anthropic/claude-sonnet-4-20250514": [
      "openai/gpt-5",
      "openrouter/anthropic/claude-sonnet-4-20250514"
    ],
    // If GPT-5 fails, fall back to Gemini
    "openai/gpt-5": [
      "google/gemini-2.5-pro"
    ]
  }
}
```

### 6.2 Failover Triggers

| Trigger | Behaviour |
|---|---|
| HTTP 429 (rate limited) | Skip to next in chain, apply backoff |
| HTTP 500/502/503 | Skip to next in chain |
| Network timeout (30s) | Skip to next in chain |
| HTTP 401/403 (auth error) | Mark provider as misconfigured, skip |
| HTTP 400 (bad request) | **Do not failover** — fix the request |

### 6.3 Sticky Failover

When a provider fails, the router **remembers** and avoids it for a cooldown period (configurable, default 60s). After cooldown, it tries the original provider again.

## 7. Role-Based Model Assignment

Each agent role can be assigned a different model:

```jsonc
{
  "models": {
    "orchestrator": "anthropic/claude-sonnet-4-20250514",  // Strong reasoning for decisions
    "coder": "anthropic/claude-sonnet-4-20250514",          // Best at code generation
    "researcher": "openai/gpt-5",                     // Good at synthesis
    "executor": "anthropic/claude-haiku-3",            // Fast, cheap for simple commands
    "planner": "anthropic/claude-sonnet-4-20250514",        // Strong reasoning for planning
    "default": "anthropic/claude-sonnet-4-20250514"         // Fallback for unlisted roles
  }
}
```

The Orchestrator can also **override** the model for a specific task:

```typescript
taskQueue.create({
  agentType: "coder",
  model: "anthropic/claude-sonnet-4-20250514",  // Use stronger model for this specific task
  prompt: "...",
});
```

## 8. Authentication

### 8.1 Sources (priority order)

1. **Environment variables:** `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, etc.
2. **Config file:** `providers.{name}.apiKey` in `~/.saivage/saivage.json`.
3. **System keyring:** If `security.secretsBackend = "keyring"`.

### 8.2 Environment Variable Interpolation

Config values support `${ENV_VAR}` syntax:

```jsonc
{
  "providers": {
    "anthropic": {
      "apiKey": "${ANTHROPIC_API_KEY}"
    }
  }
}
```

### 8.3 API Key Rotation

Multiple API keys per provider for load distribution:

```jsonc
{
  "providers": {
    "anthropic": {
      "apiKeys": [
        "${ANTHROPIC_API_KEY_1}",
        "${ANTHROPIC_API_KEY_2}"
      ],
      "keyRotation": "round-robin"   // or "random"
    }
  }
}
```

## 9. Rate Limiting & Backoff

Each provider tracks its rate-limit state:

```typescript
interface RateLimitStatus {
  isLimited: boolean;
  retryAfterMs?: number;           // From Retry-After header
  requestsRemaining?: number;       // From rate-limit headers
  tokensRemaining?: number;         // For token-based limits
}
```

- On 429, parse `Retry-After` and sleep.
- Exponential backoff: 1s, 2s, 4s, 8s, max 30s.
- If all providers are rate-limited, the router waits for the shortest `retryAfterMs`.

## 10. Cost Tracking

Every LLM call is logged with cost data:

```typescript
interface LLMUsageEntry {
  timestamp: Date;
  provider: string;
  model: string;
  role: string;                     // "orchestrator", "coder", etc.
  taskId?: string;
  inputTokens: number;
  outputTokens: number;
  estimatedCostUsd: number;
  durationMs: number;
}
```

The user can query usage:
```bash
saivage usage                    # Summary for today
saivage usage --last 7d          # Last 7 days
saivage usage --by model         # Breakdown by model
saivage usage --by role          # Breakdown by agent role
```

## 11. Model Discovery

```bash
saivage models list                         # List all configured models
saivage models test anthropic/claude-sonnet-4-20250514  # Test connectivity & latency
saivage models test --all                   # Test all configured providers
```

Output:
```
Provider       Model                   Status    Latency
anthropic      claude-sonnet-4-20250514     ✓ ok      320ms
anthropic      claude-haiku-3          ✓ ok      180ms
openai         gpt-5                   ✓ ok      290ms
ollama         llama3.3:70b            ✓ ok      150ms
openrouter     anthropic/claude-sonnet-4-20250514  ✓ ok      450ms
```
