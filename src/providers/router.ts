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
const PRIMARY_RETRY_BASE_DELAY_MS = 30_000;
const PRIMARY_RETRY_BACKOFF_MULT = 1.5;
const PRIMARY_RETRY_MAX_DELAY_MS = 20 * 60_000;

interface StickyFailoverState {
  spec: string;
  retryDelayMs: number;
  nextPrimaryRetryAt: number;
}

/** Per-model health state for exponential recovery. */
interface ModelHealth {
  consecutiveFailures: number;
  disabledUntil: number;   // epoch ms — model is skipped until this time
  backoffMs: number;       // current backoff duration (grows × BACKOFF_MULTIPLIER each failure)
}

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
  private providerConfigs: Record<string, RuntimeProviderConfigLike>;
  private stickyFailovers = new Map<string, StickyFailoverState>();

  // ── Model health tracking (exponential recovery) ──────────────────────
  private modelHealth = new Map<string, ModelHealth>();

  /** Initial cooldown after a model's first failure. */
  private static readonly INITIAL_BACKOFF_MS = 15_000;
  /** Backoff multiplier after each subsequent failure. */
  private static readonly BACKOFF_MULTIPLIER = 1.5;
  /** Maximum cooldown duration (10 minutes). */
  private static readonly MAX_BACKOFF_MS = 10 * 60 * 1000;

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
      "opencode",
      "opencode-go",
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

  /**
   * Chat with exponential-recovery failover.
   *
   * 1. Build the full failover chain (primary → fallback₁ → fallback₂ → …)
   * 2. Filter out models whose disabledUntil is still in the future
   * 3. Try the first available model; on failure mark it disabled and move on
   * 4. On success reset that model's health to pristine
   *
   * Each model tracks its own consecutive failure count and backoff duration.
   * After the first failure the cooldown is short (15 s), then grows × 1.5
   * each time, capped at 10 min. A single success resets fully.
   */
  async chat(request: ChatRequest & { modelSpec: string }): Promise<ChatResponse> {
    const chain = this.buildChain(request.modelSpec);
    let lastError: Error | undefined;
    let attemptedPrimary = false;

    for (const spec of chain) {
      const health = this.getHealth(spec);

      // Skip models still in cooldown
      const now = Date.now();
      if (health.disabledUntil > now) {
        const remainSec = Math.round((health.disabledUntil - now) / 1000);
        log.info(`[router] Skipping ${spec} (disabled for ${remainSec}s more)`);
        continue;
      }

      // Resolve provider
      const { provider: providerName, model } = parseModelId(spec);
      const provider = this.getProviderForRequest(providerName, request);
      if (!provider) {
        log.warn(`Provider "${providerName}" not registered, skipping`);
        continue;
      }
      if (provider.setApiKey) {
        const oauthKey = await this.resolveApiKey(providerName, request);
        if (oauthKey) provider.setApiKey(oauthKey);
      }
      if (provider.getRateLimitStatus().limited) {
        log.warn(`Provider "${providerName}" rate-limited, skipping`);
        continue;
      }

      if (spec === request.modelSpec) attemptedPrimary = true;

      // Attempt the call
      let result = await this.callProvider(spec, provider, model, request);

      // If the call failed and the provider has alternate accounts, retry with each
      if (!result.ok && !result.nonRetryable && provider.setApiKey) {
        const altAccounts = this.getAlternateAccounts(providerName, request);
        for (const altKey of altAccounts) {
          provider.setApiKey(altKey);
          log.info(`[router] Retrying ${spec} with alternate account`);
          result = await this.callProvider(spec, provider, model, request);
          if (result.ok || result.nonRetryable) break;
        }
      }

      if (result.ok) {
        const sticky = this.stickyFailovers.get(request.modelSpec);
        if (spec === request.modelSpec && sticky) {
          this.stickyFailovers.delete(request.modelSpec);
          log.info(`Model switch: ${sticky.spec} -> ${request.modelSpec} (primary recovered after cooldown)`);
        }

        // If we failed over after actually trying the primary, stick to the failover
        // until the next primary retry window. Successful sticky calls before the
        // window expires must not push the retry window forward indefinitely.
        if (spec !== request.modelSpec) {
          if (attemptedPrimary || !sticky) {
            const previousDelay = sticky?.retryDelayMs ?? 0;
            const retryDelayMs = Math.min(
              previousDelay > 0 ? previousDelay * PRIMARY_RETRY_BACKOFF_MULT : PRIMARY_RETRY_BASE_DELAY_MS,
              PRIMARY_RETRY_MAX_DELAY_MS,
            );
            this.stickyFailovers.set(request.modelSpec, {
              spec,
              retryDelayMs,
              nextPrimaryRetryAt: Date.now() + retryDelayMs,
            });
            log.info(
              `Model switch: ${request.modelSpec} -> ${spec} ` +
              `(primary failed, using failover; retrying primary in ${Math.round(retryDelayMs / 1000)}s)`,
            );
          }
        }

        // Success — reset health for this model
        if (health.consecutiveFailures > 0) {
          log.info(`[router] ${spec} recovered after ${health.consecutiveFailures} failure(s)`);
        }
        this.resetHealth(spec);
        return result.response;
      }

      // Non-retryable → propagate immediately (context overflow, etc.)
      if (result.nonRetryable) throw result.error;

      // Record failure, apply exponential cooldown
      lastError = result.error;
      this.recordFailure(spec, health);
    }

    const summary = `All providers failed for ${describeRequestedModel(request.modelSpec)}`;
    if (lastError) {
      throw new Error(`${summary}: ${lastError.message}`, { cause: lastError });
    }
    throw new Error(summary);
  }

  // ── Provider call ─────────────────────────────────────────────────────

  /**
   * Single provider call with timeout.
   * Returns a result object — never throws for retryable errors.
   */
  private async callProvider(
    spec: string,
    provider: ModelProvider,
    model: string,
    request: ChatRequest & { modelSpec: string },
  ): Promise<{ ok: true; response: ChatResponse } | { ok: false; error: Error; nonRetryable?: boolean }> {
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
      const { provider: providerName } = parseModelId(spec);
      return {
        ok: true,
        response: {
          ...response,
          provider: providerName,
          model,
          modelSpec: spec,
          requestedModelSpec: request.modelSpec,
        },
      };
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      const errMsg = error.message;
      recordLlmCall(spec, { error: true, timeout: errMsg.includes("timed out") });
      log.warn(`[router] ${spec} failed: ${errMsg}`);

      const nonRetryable =
        errMsg.includes("exceeds the context window") ||
        errMsg.includes("context_length_exceeded");

      return { ok: false, error, nonRetryable };
    }
  }

  // ── Model health ──────────────────────────────────────────────────────

  private getHealth(spec: string): ModelHealth {
    let h = this.modelHealth.get(spec);
    if (!h) {
      h = { consecutiveFailures: 0, disabledUntil: 0, backoffMs: ModelRouter.INITIAL_BACKOFF_MS };
      this.modelHealth.set(spec, h);
    }
    return h;
  }

  private recordFailure(spec: string, health: ModelHealth): void {
    health.consecutiveFailures++;
    health.disabledUntil = Date.now() + health.backoffMs;
    log.warn(
      `[router] ${spec} disabled for ${Math.round(health.backoffMs / 1000)}s ` +
      `(${health.consecutiveFailures} consecutive failure${health.consecutiveFailures > 1 ? "s" : ""})`,
    );
    // Grow backoff for next time
    health.backoffMs = Math.min(
      health.backoffMs * ModelRouter.BACKOFF_MULTIPLIER,
      ModelRouter.MAX_BACKOFF_MS,
    );
  }

  private resetHealth(spec: string): void {
    this.modelHealth.delete(spec);
  }

  /** Force-reset health for all models in a failover chain (used by agent retry logic). */
  resetModelHealth(modelSpec: string): void {
    const chain = this.buildChain(modelSpec);
    for (const spec of chain) {
      if (this.modelHealth.has(spec)) {
        log.info(`[router] Resetting health for ${spec}`);
        this.modelHealth.delete(spec);
      }
    }
  }

  private buildChain(modelSpec: string): string[] {
    const sticky = this.stickyFailovers.get(modelSpec);
    const chain: string[] = [];

    if (sticky && sticky.spec !== modelSpec) {
      if (Date.now() < sticky.nextPrimaryRetryAt) {
        chain.push(sticky.spec);
      } else {
        log.info(`Model switch: ${sticky.spec} -> ${modelSpec} (retrying primary after cooldown)`);
      }
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
      case "opencode":
        return !!cfg || hasAccounts || !!process.env["OPENCODE_API_KEY"];
      case "opencode-go":
        return !!cfg || hasAccounts || !!process.env["OPENCODE_API_KEY"];
      case "ollama":
        return true;
      case "llamacpp":
        return !!cfg || hasAccounts || !!process.env["LLAMACPP_BASE_URL"];
      default:
        return !!cfg || hasAccounts;
    }
  }

  /** Reset sticky failover for a model */
  clearStickyFailover(modelSpec: string): void {
    const was = this.stickyFailovers.get(modelSpec);
    if (was) {
      log.info(`Model switch: ${was.spec} -> ${modelSpec} (retrying primary after cooldown)`);
    }
    this.stickyFailovers.delete(modelSpec);
  }

  /**
   * Return API keys from alternate accounts for a provider, excluding the
   * key that was already used for the current request.
   */
  private getAlternateAccounts(
    providerName: string,
    request: { accountRef?: string },
  ): string[] {
    const providerConfig = this.providerConfigs[providerName];
    if (!providerConfig?.accounts) return [];

    const primaryKey = providerConfig.apiKey;
    const usedAccountRef = request.accountRef;

    const keys: string[] = [];
    for (const [accountName, accountCfg] of Object.entries(providerConfig.accounts)) {
      if (!accountCfg?.apiKey) continue;
      // Skip the account that was already used
      const ref = `${providerName}.${accountName}`;
      if (ref === usedAccountRef) continue;
      // Skip if same key as primary (already tried)
      if (accountCfg.apiKey === primaryKey) continue;
      keys.push(accountCfg.apiKey);
    }
    return keys;
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
      case "opencode": {
        const provider = new PiAiProvider("opencode");
        if (apiKey) provider.setApiKey(apiKey);
        return provider;
      }
      case "opencode-go": {
        const provider = new PiAiProvider("opencode-go");
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
