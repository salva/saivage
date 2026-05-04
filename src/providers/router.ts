import type { SaivageConfig } from "../config.js";
import type {
  ChatRequest,
  ChatResponse,
  ModelProvider,
} from "./types.js";
import { parseModelId } from "./types.js";
import { PiAiProvider } from "./pi-ai.js";
import { CopilotProvider } from "./copilot.js";
import { OllamaProvider } from "./ollama.js";
import { LlamaCppProvider } from "./llamacpp.js";
import { getOAuthApiKey, getProfileByKey, hasOAuthCredentials } from "../auth/index.js";
import { log } from "../log.js";
import type { RuntimeProviderAccountLike, RuntimeProviderConfigLike } from "../routing/resolver.js";
import { parseAccountRef } from "../routing/resolver.js";

const PROVIDER_REQUEST_TIMEOUT_MS = 300_000;

/** Lightweight LLM call metrics (replaces v1 telemetry module). */
function recordLlmCall(_spec: string, _data: Record<string, unknown>): void {
  // Metrics are logged via the log module; no separate telemetry store needed.
}

/**
 * Maps OAuth provider IDs -> pi-ai provider names.
 * Also used to decide which pi-ai provider to register for each OAuth credential.
 */
const OAUTH_TO_PI: Record<string, string> = {
  "openai-codex": "openai-codex",
  "anthropic": "anthropic",
};

/**
 * Maps Saivage provider names -> OAuth provider IDs (for resolveApiKey).
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
  private modelEquivalents: Map<string, string[]>;
  private modelAssignments: Record<string, string>;
  private stickyFailovers = new Map<string, string>();
  private providerConfigs: Record<string, RuntimeProviderConfigLike>;

  constructor(config: SaivageConfig) {
    this.failoverChains = config.failover;
    this.modelEquivalents = buildModelEquivalenceIndex(config.modelEquivalents);
    this.modelAssignments = config.models as Record<string, string>;
    this.providerConfigs = config.providers as Record<string, RuntimeProviderConfigLike>;
    this.initProviders(config);
  }

  private initProviders(config: SaivageConfig): void {
    void config;

    const knownProviders = [
      "github-copilot",
      "anthropic",
      "openai",
      "openai-codex",
      "ollama",
      "llamacpp",
    ];

    for (const providerName of knownProviders) {
      if (!this.shouldRegisterProvider(providerName)) continue;
      const provider = this.createProvider(providerName);
      if (provider) this.providers.set(providerName, provider);
    }
  }

  /**
   * Resolve API key for a provider, trying OAuth credentials if no static key.
   * Called lazily before each request so token refresh happens on demand.
   */
  async resolveApiKey(
    providerName: string,
    options: { authProfileKey?: string; accountRef?: string } = {},
  ): Promise<string | null> {
    const oauthId = PROVIDER_TO_OAUTH[providerName] ?? providerName;

    if (options.authProfileKey) {
      const explicitProfile = getProfileByKey(options.authProfileKey);
      if (explicitProfile?.provider === oauthId) {
        const key = await getOAuthApiKey(oauthId, { profileKey: options.authProfileKey });
        if (key) return key;
      }
    }

    const accountConfig = this.getRequestedAccountConfig(providerName, options);
    if (accountConfig?.authProfile) {
      const profiledKey = await getOAuthApiKey(oauthId, { profileKey: accountConfig.authProfile });
      if (profiledKey) return profiledKey;
    }

    if (accountConfig?.apiKey) return accountConfig.apiKey;

    const providerConfig = this.providerConfigs[providerName];
    if (providerConfig?.apiKey) return providerConfig.apiKey;

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

  /** List model IDs exposed by a registered provider, when supported. */
  async listModels(providerName: string): Promise<string[]> {
    const provider = this.getProviderForRequest(providerName);
    if (!provider?.listModels) return [];

    if (provider.setApiKey) {
      const oauthKey = await this.resolveApiKey(providerName);
      if (oauthKey) provider.setApiKey(oauthKey);
    }

    return provider.listModels();
  }

  /** Get context window size (tokens) for a model spec like "github-copilot/gpt-5.3-codex" */
  getMaxContextTokens(modelSpec: string): number {
    const { provider: providerName, model } = parseModelId(modelSpec);
    const provider = this.getProviderForRequest(providerName);
    return provider?.maxContextTokens(model) ?? 200_000;
  }

  /** Chat with failover */
  async chat(request: ChatRequest & { modelSpec: string }): Promise<ChatResponse> {
    const chain = this.buildChain(request.modelSpec);

    for (const spec of chain) {
      const { provider: providerName, model } = parseModelId(spec);
      const provider = this.getProviderForRequest(providerName, request);

      if (!provider) {
        log.warn(`Provider "${providerName}" not registered, skipping`);
        continue;
      }

      // Always resolve fresh OAuth API key before each request.
      // Copilot tokens are short-lived (~30 min) and getOAuthApiKey()
      // handles auto-refresh transparently.
      if (provider.setApiKey) {
        const oauthKey = await this.resolveApiKey(providerName, request);
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
        const controller = new AbortController();
        let timeoutId: ReturnType<typeof setTimeout> | undefined;
        const response = await Promise.race([
          provider.chat({ ...request, model, signal: controller.signal }),
          new Promise<never>((_, reject) => {
            timeoutId = setTimeout(() => {
              controller.abort();
              reject(new Error(`Request timed out after ${PROVIDER_REQUEST_TIMEOUT_MS / 1000}s`));
            }, PROVIDER_REQUEST_TIMEOUT_MS);
          }),
        ]).finally(() => {
          if (timeoutId) clearTimeout(timeoutId);
        });
        recordLlmCall(spec, {
          inputTokens: response.usage?.inputTokens,
          outputTokens: response.usage?.outputTokens,
          latencyMs: Date.now() - t0,
        });
        // If we failed over, stick to this provider
        if (spec !== request.modelSpec) {
          this.stickyFailovers.set(request.modelSpec, spec);
          log.info(`Model switch: ${request.modelSpec} -> ${spec} (primary failed, using failover)`);
        }
        return {
          ...response,
          provider: providerName,
          model,
          modelSpec: spec,
          requestedModelSpec: request.modelSpec,
        };
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        const isTimeout = errMsg.includes("timed out");
        recordLlmCall(spec, { error: true, timeout: isTimeout });
        log.warn(`Provider "${providerName}" (model: ${model}) failed: ${errMsg}`);

        // Non-retryable errors that apply regardless of provider - propagate immediately
        const isContextOverflow =
          errMsg.includes("exceeds the context window") ||
          errMsg.includes("context_length_exceeded");
        if (isContextOverflow) {
          throw err;
        }

        continue;
      }
    }

    throw new Error(`All providers failed for ${describeRequestedModel(request.modelSpec)}`);
  }

  private buildChain(modelSpec: string): string[] {
    // If we have a sticky failover, use that first
    const sticky = this.stickyFailovers.get(modelSpec);
    const chain: string[] = [];

    if (sticky && sticky !== modelSpec) {
      chain.push(sticky);
    }

    this.appendFailoverChain(modelSpec, chain, new Set<string>());
    return chain;
  }

  private appendFailoverChain(modelSpec: string, chain: string[], expanded: Set<string>): void {
    if (!chain.includes(modelSpec)) chain.push(modelSpec);
    if (expanded.has(modelSpec)) return;
    expanded.add(modelSpec);

    for (const equivalent of this.modelEquivalents.get(modelSpec) ?? []) {
      this.appendFailoverChain(equivalent, chain, expanded);
    }

    // Look up failover by full spec first, then by provider-only key.
    const { provider: providerName, model } = parseModelId(modelSpec);
    const failovers = this.failoverChains[modelSpec] ?? this.failoverChains[providerName];
    if (!failovers) return;

    // Expand provider-only failover entries to full specs using the same model.
    for (const fallback of failovers) {
      if (!fallback.includes("/") && this.modelEquivalents.has(modelSpec)) {
        continue;
      }
      this.appendFailoverChain(fallback.includes("/") ? fallback : `${fallback}/${model}`, chain, expanded);
    }
  }

  /** Reset sticky failover for a model */
  clearStickyFailover(modelSpec: string): void {
    const was = this.stickyFailovers.get(modelSpec);
    if (was) {
      log.info(`Model switch: ${was} -> ${modelSpec} (retrying primary after cooldown)`);
    }
    this.stickyFailovers.delete(modelSpec);
  }

  private shouldRegisterProvider(providerName: string): boolean {
    const cfg = this.providerConfigs[providerName];
    const hasAccounts = Object.keys(cfg?.accounts ?? {}).length > 0;

    switch (providerName) {
      case "github-copilot":
        return !!cfg || hasAccounts || hasOAuthCredentials("github-copilot");
      case "anthropic":
        return !!cfg || hasAccounts || hasOAuthCredentials("anthropic") || !!process.env["ANTHROPIC_API_KEY"];
      case "openai":
        return !!cfg || hasAccounts || !!process.env["OPENAI_API_KEY"];
      case "openai-codex":
        return !!cfg || hasAccounts || hasOAuthCredentials("openai-codex") || !!process.env["OPENAI_CODEX_API_KEY"];
      case "ollama":
        return true;
      case "llamacpp":
        return !!cfg || hasAccounts || !!process.env["LLAMACPP_BASE_URL"];
      default:
        return !!cfg || hasAccounts;
    }
  }

  private createProvider(providerName: string, accountName?: string): ModelProvider | undefined {
    const accountConfig = accountName ? this.getAccountConfig(providerName, accountName) : undefined;
    const providerConfig = this.providerConfigs[providerName];
    const apiKey = accountConfig?.apiKey ?? providerConfig?.apiKey;
    const baseUrl = accountConfig?.baseUrl ?? providerConfig?.baseUrl;

    switch (providerName) {
      case "github-copilot":
        return new CopilotProvider(apiKey);
      case "anthropic": {
        const provider = new PiAiProvider("anthropic");
        if (apiKey) provider.setApiKey(apiKey);
        return provider;
      }
      case "openai": {
        const provider = new PiAiProvider("openai");
        if (apiKey) provider.setApiKey(apiKey);
        return provider;
      }
      case "openai-codex": {
        const provider = new PiAiProvider("openai-codex");
        if (apiKey) provider.setApiKey(apiKey);
        return provider;
      }
      case "ollama":
        return new OllamaProvider(baseUrl);
      case "llamacpp":
        return new LlamaCppProvider(baseUrl ?? process.env["LLAMACPP_BASE_URL"]);
      default:
        return undefined;
    }
  }

  private getProviderForRequest(
    providerName: string,
    request?: { authProfileKey?: string; accountRef?: string },
  ): ModelProvider | undefined {
    const accountName = this.resolveRequestedAccountName(providerName, request);
    if (!accountName) return this.providers.get(providerName);

    const key = `${providerName}#${accountName}`;
    const existing = this.providers.get(key);
    if (existing) return existing;

    const provider = this.createProvider(providerName, accountName);
    if (!provider) return this.providers.get(providerName);
    this.providers.set(key, provider);
    return provider;
  }

  private resolveRequestedAccountName(
    providerName: string,
    request?: { authProfileKey?: string; accountRef?: string },
  ): string | undefined {
    if (request?.authProfileKey) return undefined;
    if (request?.accountRef) {
      const parsed = parseAccountRef(request.accountRef.includes(".") ? request.accountRef : `${providerName}.${request.accountRef}`);
      if (parsed.provider === providerName) return parsed.account;
    }

    const defaultAccount = this.providerConfigs[providerName]?.defaultAccount;
    if (defaultAccount && this.getAccountConfig(providerName, defaultAccount)) return defaultAccount;
    return undefined;
  }

  private getRequestedAccountConfig(
    providerName: string,
    request?: { authProfileKey?: string; accountRef?: string },
  ): RuntimeProviderAccountLike | undefined {
    const accountName = this.resolveRequestedAccountName(providerName, request);
    return accountName ? this.getAccountConfig(providerName, accountName) : undefined;
  }

  private getAccountConfig(providerName: string, accountName: string): RuntimeProviderAccountLike | undefined {
    return this.providerConfigs[providerName]?.accounts?.[accountName];
  }
}

function describeRequestedModel(modelSpec: string): string {
  const { provider, model } = parseModelId(modelSpec);
  return `model "${model}" via provider "${provider}"`;
}

function buildModelEquivalenceIndex(groups: Record<string, string[]>): Map<string, string[]> {
  const index = new Map<string, string[]>();
  for (const [primary, alternatives] of Object.entries(groups)) {
    const members = unique([primary, ...alternatives]);
    for (const member of members) {
      const existing = index.get(member) ?? [];
      index.set(member, unique([...existing, ...members.filter((candidate) => candidate !== member)]));
    }
  }
  return index;
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}
