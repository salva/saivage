import type { SaivageConfig } from "../config.js";
import type {
  ChatRequest,
  ChatResponse,
  ModelProvider,
} from "./types.js";
import { parseModelId } from "./types.js";
import { PiAiProvider } from "./pi-ai.js";
import { OllamaProvider } from "./ollama.js";
import { LlamaCppProvider } from "./llamacpp.js";
import { getOAuthApiKey, hasOAuthCredentials } from "../auth/index.js";
import { log } from "../log.js";

/** Lightweight LLM call metrics (replaces v1 telemetry module). */
function recordLlmCall(_spec: string, _data: Record<string, unknown>): void {
  // Metrics are logged via the log module; no separate telemetry store needed.
}

/**
 * Maps OAuth provider IDs → pi-ai provider names.
 * Also used to decide which pi-ai provider to register for each OAuth credential.
 */
const OAUTH_TO_PI: Record<string, string> = {
  "openai-codex": "openai-codex",
  "anthropic": "anthropic",
  "github-copilot": "github-copilot",
};

/**
 * Maps Saivage provider names → OAuth provider IDs (for resolveApiKey).
 */
const PROVIDER_TO_OAUTH: Record<string, string> = {
  "openai-codex": "openai-codex",
  "anthropic": "anthropic",
  "github-copilot": "github-copilot",
  "copilot": "github-copilot",
};

export class ModelRouter {
  private providers = new Map<string, ModelProvider>();
  private failoverChains: Record<string, string[]>;
  private modelAssignments: Record<string, string>;
  private stickyFailovers = new Map<string, string>();

  constructor(config: SaivageConfig) {
    this.failoverChains = config.failover;
    this.modelAssignments = config.models as Record<string, string>;
    this.initProviders(config);
  }

  private initProviders(config: SaivageConfig): void {
    const providerConfigs = config.providers;

    // Register pi-ai backed providers for all available OAuth credentials
    for (const [oauthId, piProvider] of Object.entries(OAUTH_TO_PI)) {
      if (hasOAuthCredentials(oauthId)) {
        this.providers.set(piProvider, new PiAiProvider(piProvider));
      }
    }

    // Anthropic: also register via direct API key / env var
    const anthropicCfg = providerConfigs["anthropic"];
    if (!this.providers.has("anthropic") && (anthropicCfg?.apiKey || process.env["ANTHROPIC_API_KEY"])) {
      const p = new PiAiProvider("anthropic");
      p.setApiKey(anthropicCfg?.apiKey ?? process.env["ANTHROPIC_API_KEY"]!);
      this.providers.set("anthropic", p);
    }

    // OpenAI (standard api.openai.com): direct API key / env var
    const openaiCfg = providerConfigs["openai"];
    if (!this.providers.has("openai") && (openaiCfg?.apiKey || process.env["OPENAI_API_KEY"])) {
      const p = new PiAiProvider("openai");
      p.setApiKey(openaiCfg?.apiKey ?? process.env["OPENAI_API_KEY"]!);
      this.providers.set("openai", p);
    }

    // OpenAI Codex: API key / env var fallback (also usable via OAuth)
    const openaiCodexCfg = providerConfigs["openai-codex"];
    if (!this.providers.has("openai-codex") && (openaiCodexCfg?.apiKey || process.env["OPENAI_CODEX_API_KEY"])) {
      const p = new PiAiProvider("openai-codex");
      p.setApiKey(openaiCodexCfg?.apiKey ?? process.env["OPENAI_CODEX_API_KEY"]!);
      this.providers.set("openai-codex", p);
    }

    // Ollama: always registered (local, no auth)
    const ollamaCfg = providerConfigs["ollama"];
    this.providers.set("ollama", new OllamaProvider(ollamaCfg?.baseUrl));

    // llama.cpp: register if configured or env var present
    const llamacppCfg = providerConfigs["llamacpp"];
    if (llamacppCfg?.baseUrl || process.env["LLAMACPP_BASE_URL"]) {
      this.providers.set("llamacpp", new LlamaCppProvider(llamacppCfg?.baseUrl));
    }
  }

  /**
   * Resolve API key for a provider, trying OAuth credentials if no static key.
   * Called lazily before each request so token refresh happens on demand.
   */
  async resolveApiKey(providerName: string): Promise<string | null> {
    const oauthId = PROVIDER_TO_OAUTH[providerName] ?? providerName;
    return getOAuthApiKey(oauthId);
  }

  /** Resolve a role (e.g. "coder") to a model spec string */
  resolveModelForRole(role: string): string {
    return this.modelAssignments[role] ?? this.modelAssignments["default"] ?? "anthropic/claude-sonnet-4-20250514";
  }

  /** Get provider instance by name */
  getProvider(name: string): ModelProvider | undefined {
    return this.providers.get(name);
  }

  /** List all registered providers */
  listProviders(): string[] {
    return [...this.providers.keys()];
  }

  /** Get context window size (tokens) for a model spec like "github-copilot/gpt-5.3-codex" */
  getMaxContextTokens(modelSpec: string): number {
    const { provider: providerName, model } = parseModelId(modelSpec);
    const provider = this.providers.get(providerName);
    return provider?.maxContextTokens(model) ?? 200_000;
  }

  /** Chat with failover */
  async chat(request: ChatRequest & { modelSpec: string }): Promise<ChatResponse> {
    const chain = this.buildChain(request.modelSpec);

    for (const spec of chain) {
      const { provider: providerName, model } = parseModelId(spec);
      const provider = this.providers.get(providerName);

      if (!provider) {
        log.warn(`Provider "${providerName}" not registered, skipping`);
        continue;
      }

      // Always resolve fresh OAuth API key before each request.
      // Copilot tokens are short-lived (~30 min) and getOAuthApiKey()
      // handles auto-refresh transparently.
      if (provider.setApiKey) {
        const oauthKey = await this.resolveApiKey(providerName);
        if (oauthKey) {
          provider.setApiKey(oauthKey);
        }
      }

      const rateLimit = provider.getRateLimitStatus();
      if (rateLimit.limited) {
        log.warn(`Provider "${providerName}" rate-limited, trying next`);
        continue;
      }

      try {
        const t0 = Date.now();
        const response = await Promise.race([
          provider.chat({ ...request, model }),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error(`Request timed out after 300s`)), 300_000),
          ),
        ]);
        recordLlmCall(spec, {
          inputTokens: response.usage?.inputTokens,
          outputTokens: response.usage?.outputTokens,
          latencyMs: Date.now() - t0,
        });
        // If we failed over, stick to this provider
        if (spec !== request.modelSpec) {
          this.stickyFailovers.set(request.modelSpec, spec);
          log.info(`Model switch: ${request.modelSpec} → ${spec} (primary failed, using failover)`);
        }
        return response;
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        const isTimeout = errMsg.includes("timed out");
        recordLlmCall(spec, { error: true, timeout: isTimeout });
        log.warn(`Provider "${providerName}" (model: ${spec}) failed: ${errMsg}`);

        // Non-retryable errors that apply regardless of provider — propagate immediately
        const isContextOverflow =
          errMsg.includes("exceeds the context window") ||
          errMsg.includes("context_length_exceeded");
        if (isContextOverflow) {
          throw err;
        }

        continue;
      }
    }

    throw new Error(`All providers failed for model "${request.modelSpec}"`);
  }

  private buildChain(modelSpec: string): string[] {
    // If we have a sticky failover, use that first
    const sticky = this.stickyFailovers.get(modelSpec);
    const chain = [modelSpec];

    if (sticky && sticky !== modelSpec) {
      chain.unshift(sticky);
    }

    // Look up failover by full spec first, then by provider-only key
    const { provider: providerName, model } = parseModelId(modelSpec);
    const failovers = this.failoverChains[modelSpec] ?? this.failoverChains[providerName];
    if (failovers) {
      // Expand provider-only failover entries to full specs using the same model
      const expanded = failovers.map((f) => (f.includes("/") ? f : `${f}/${model}`));
      chain.push(...expanded.filter((f) => !chain.includes(f)));
    }

    return chain;
  }

  /** Reset sticky failover for a model */
  clearStickyFailover(modelSpec: string): void {
    const was = this.stickyFailovers.get(modelSpec);
    if (was) {
      log.info(`Model switch: ${was} → ${modelSpec} (retrying primary after cooldown)`);
    }
    this.stickyFailovers.delete(modelSpec);
  }
}
