import type { SaivageConfig } from "../config.js";
import { configPath } from "../config.js";
import { MissingModelForRoleError } from "../config-validation.js";
import type {
  ChatRequest,
  ChatResponse,
  ModelProvider,
  UsageStatus,
  Message,
  ToolSchema,
} from "./types.js";
import { parseModelId } from "./types.js";
import { PiAiProvider } from "./pi-ai.js";
import { CopilotProvider } from "./copilot.js";
import { OllamaProvider } from "./ollama.js";
import { LlamaCppProvider } from "./llamacpp.js";
import { ProviderError, classifyProviderError } from "./error.js";
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

interface ChatCandidate {
  spec: string;
  accountRef?: string;
  healthKey: string;
}

interface UsageSnapshot {
  usedTokens: number | null;
  totalTokens: number | null;
  remainingTokens: number | null;
  remainingRatio: number | null;
  resetAt: Date | null;
  source: "provider" | "config" | "rate-limit" | "unknown";
}

/** Lightweight LLM call metrics (replaces v1 telemetry module). */
function recordLlmCall(_spec: string, _data: Record<string, unknown>): void {
  // Metrics are logged via the log module; no separate telemetry store needed.
}

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
  private modelAssignments: Record<string, string | string[] | undefined>;
  private providerConfigs: Record<string, RuntimeProviderConfigLike>;
  private stickyFailovers = new Map<string, StickyFailoverState>();
  private usageSnapshots = new Map<string, UsageSnapshot>();

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
    this.modelAssignments = config.models as Record<string, string | string[] | undefined>;
    this.providerConfigs = config.providers as Record<string, RuntimeProviderConfigLike>;
    this.initProviders(config);

    // Build equivalence index: manual entries + autodiscovered from providers
    const manualEquivs = buildModelEquivalenceIndex(config.modelEquivalents);
    const discovered = this.discoverModelEquivalents();
    this.modelEquivalents = mergeEquivalenceIndexes(manualEquivs, discovered);
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
   * Autodiscover model equivalents by querying each registered provider's
   * model list.  Models with the same ID served by multiple providers are
   * equivalent (e.g. opencode-go/kimi-k2.6 ≡ opencode/kimi-k2.6).
   */
  private discoverModelEquivalents(): Map<string, string[]> {
    // model-id → list of provider/model specs
    const modelToSpecs = new Map<string, string[]>();

    for (const [providerName, provider] of this.providers) {
      if (!provider.listModels) continue;
      try {
        const models = provider.listModels();
        // listModels can return a Promise; only use sync results here
        if (!Array.isArray(models)) continue;
        for (const modelId of models) {
          const spec = `${providerName}/${modelId}`;
          const existing = modelToSpecs.get(modelId) ?? [];
          existing.push(spec);
          modelToSpecs.set(modelId, existing);
        }
      } catch {
        // Provider list unavailable — skip
      }
    }

    // Build equivalence entries only for models served by 2+ providers
    const index = new Map<string, string[]>();
    for (const specs of modelToSpecs.values()) {
      if (specs.length < 2) continue;
      for (const spec of specs) {
        const others = specs.filter((s) => s !== spec);
        const existing = index.get(spec) ?? [];
        index.set(spec, unique([...existing, ...others]));
      }
    }

    if (index.size > 0) {
      log.info(`[router] Autodiscovered ${index.size} model equivalents across providers`);
    }
    return index;
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
    const providerConfig = this.providerConfigs[providerName];
    const accountConfig = this.getRequestedAccountConfig(providerName, options);
    const mergedHeaders = {
      ...(providerConfig?.headers ?? {}),
      ...(accountConfig?.headers ?? {}),
    };
    const headers = Object.keys(mergedHeaders).length > 0 ? mergedHeaders : undefined;

    if (options.authProfileKey) {
      const explicitProfile = getProfileByKey(options.authProfileKey);
      if (explicitProfile?.provider === oauthId) {
        const key = await getOAuthApiKey(oauthId, { profileKey: options.authProfileKey, headers });
        if (key) return key;
      }
    }

    if (accountConfig?.authProfile) {
      const profiledKey = await getOAuthApiKey(oauthId, { profileKey: accountConfig.authProfile, headers });
      if (profiledKey) return profiledKey;
    }

    if (accountConfig?.apiKey) return accountConfig.apiKey;
    if (providerConfig?.apiKey) return providerConfig.apiKey;

    return getOAuthApiKey(oauthId, { headers });
  }

  /** Resolve a role (e.g. "coder") to a model spec string */
  resolveModelForRole(role: string): string {
    return firstModel(this.modelAssignments[role]) ?? firstModel(this.modelAssignments["default"]) ?? (() => { throw new MissingModelForRoleError([role], configPath()); })();
  }

  /** Get provider instance by name */
  getProvider(name: string): ModelProvider | undefined {
    return this.providers.get(name);
  }

  /** List all registered providers */
  listProviders(): string[] {
    return [...this.providers.keys()];
  }

  /** Inspect provider/account usage once at startup and cache routing weights. */
  async inspectUsageAtStartup(): Promise<void> {
    const candidates = this.listUsageCandidateKeys();
    await Promise.all(candidates.map((candidate) => this.inspectUsageCandidate(candidate)));
    const known = [...this.usageSnapshots.entries()].filter(([, snapshot]) => snapshot.source !== "unknown").length;
    if (known > 0) {
      log.info(`[router] Loaded startup usage snapshots for ${known}/${candidates.length} provider/account candidate(s)`);
    }
  }

  getUsageSnapshot(providerName: string, accountName?: string): UsageSnapshot | undefined {
    return this.usageSnapshots.get(accountName ? `${providerName}#${accountName}` : providerName);
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

  /** Get context window size (tokens) for a model spec or provider-independent model id. */
  getMaxContextTokens(modelSpec: string): number {
    const parsed = tryParseModelId(modelSpec);
    let providerName: string;
    let model: string;
    let candidateAccount: string | undefined;
    if (parsed) {
      providerName = parsed.provider;
      model = parsed.model;
    } else {
      const candidate = this.buildCandidateChain(modelSpec)[0];
      if (!candidate) {
        throw new Error(`router: cannot resolve modelSpec "${modelSpec}"`);
      }
      const parts = parseModelId(candidate.spec);
      providerName = parts.provider;
      model = parts.model;
      candidateAccount = candidate.accountRef;
    }
    const provider = this.getProviderForRequest(
      providerName,
      candidateAccount ? { accountRef: candidateAccount } : undefined,
    );
    const caps = provider?.modelCapabilities(model);
    if (!caps) {
      throw new Error(
        `router: no context window for "${modelSpec}" (provider ${providerName}) — ` +
        `add an entry to MODEL_CAPABILITIES in src/providers/${providerName}.ts or set ` +
        `providers.${providerName}.defaultContextWindow in the runtime config.`,
      );
    }
    return caps.contextWindow;
  }

  /** F07 — accurate token count for a model spec. */
  countTokens(
    modelSpec: string,
    messages: Message[],
    system?: string,
    tools?: ToolSchema[],
  ): number {
    const parsed = tryParseModelId(modelSpec);
    if (!parsed) {
      const candidate = this.buildCandidateChain(modelSpec)[0];
      if (!candidate) return 0;
      const { provider: providerName, model } = parseModelId(candidate.spec);
      const provider = this.getProviderForRequest(providerName, { accountRef: candidate.accountRef });
      return provider?.countTokens(model, messages, system, tools) ?? 0;
    }
    const { provider: providerName, model } = parsed;
    const provider = this.getProviderForRequest(providerName);
    return provider?.countTokens(model, messages, system, tools) ?? 0;
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
    const chain = this.buildCandidateChain(request.modelSpec, request);
    let lastError: Error | undefined;
    let attemptedPrimary = false;

    for (const candidate of chain) {
      const spec = candidate.spec;
      const health = this.getHealth(candidate.healthKey);

      // Skip models still in cooldown
      const now = Date.now();
      if (health.disabledUntil > now) {
        const remainSec = Math.round((health.disabledUntil - now) / 1000);
        log.info(`[router] Skipping ${candidate.healthKey} (disabled for ${remainSec}s more)`);
        continue;
      }

      // Resolve provider
      const { provider: providerName, model } = parseModelId(spec);
      const candidateRequest = { ...request, accountRef: candidate.accountRef ?? request.accountRef };
      const provider = this.getProviderForRequest(providerName, candidateRequest);
      if (!provider) {
        log.warn(`Provider "${providerName}" not registered, skipping ${candidate.healthKey}`);
        continue;
      }
      if (provider.setApiKey) {
        const oauthKey = await this.resolveApiKey(providerName, candidateRequest);
        if (oauthKey) provider.setApiKey(oauthKey);
      }
      if (provider.getRateLimitStatus().limited) {
        log.warn(`Provider "${providerName}" rate-limited, skipping ${candidate.healthKey}`);
        continue;
      }

      if (spec === request.modelSpec) attemptedPrimary = true;

      // Attempt the call
      const result = await this.callProvider(spec, provider, model, candidateRequest);

      if (result.ok) {
        const sticky = this.stickyFailovers.get(request.modelSpec);
        if (spec === request.modelSpec && sticky) {
          this.stickyFailovers.delete(request.modelSpec);
          log.info(`Model switch: ${sticky.spec} -> ${request.modelSpec} (primary recovered after cooldown)`);
        }

        // If we failed over after actually trying the primary, stick to the failover
        // until the next primary retry window. Successful sticky calls before the
        // window expires must not push the retry window forward indefinitely.
        if (spec !== request.modelSpec && request.modelSpec.includes("/")) {
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
          log.info(`[router] ${candidate.healthKey} recovered after ${health.consecutiveFailures} failure(s)`);
        }
        this.resetHealth(candidate.healthKey);
        return result.response;
      }

      // Non-retryable → propagate immediately (context overflow, etc.)
      if (result.nonRetryable) throw result.error;

      // Record failure, apply exponential cooldown
      lastError = result.error;
      this.recordFailure(candidate.healthKey, health);
    }

    const summary = `All providers failed for ${describeRequestedModel(request.modelSpec)}`;
    if (lastError) {
      const kind = lastError instanceof ProviderError ? lastError.kind : "transient";
      throw new ProviderError({
        kind,
        message: `${summary}: ${lastError.message}`,
        cause: lastError,
      });
    }
    throw new ProviderError({ kind: "transient", message: summary });
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
      const errorRaw = err instanceof Error ? err : new Error(String(err));
      const errMsg = errorRaw.message;
      recordLlmCall(spec, { error: true, timeout: errMsg.includes("timed out") });
      log.warn(`[router] ${spec} failed: ${errMsg}`);

      const classified = errorRaw instanceof ProviderError
        ? errorRaw
        : classifyProviderError(errorRaw, provider.name);

      const nonRetryable =
        classified.kind === "non_retryable" || classified.kind === "context_overflow";

      return { ok: false, error: classified, nonRetryable };
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
    const chain = this.buildCandidateChain(modelSpec);
    for (const candidate of chain) {
      if (this.modelHealth.has(candidate.healthKey)) {
        log.info(`[router] Resetting health for ${candidate.healthKey}`);
        this.modelHealth.delete(candidate.healthKey);
      }
    }
  }

  private buildChain(modelSpec: string): string[] {
    return unique(this.buildCandidateChain(modelSpec).map((candidate) => candidate.spec));
  }

  private buildCandidateChain(
    modelSpec: string,
    request?: { authProfileKey?: string; accountRef?: string },
  ): ChatCandidate[] {
    const sticky = this.stickyFailovers.get(modelSpec);
    const chain: ChatCandidate[] = [];

    if (sticky && sticky.spec !== modelSpec) {
      if (Date.now() < sticky.nextPrimaryRetryAt) {
        this.appendCandidatesForModelSpec(sticky.spec, chain, request);
      } else {
        log.info(`Model switch: ${sticky.spec} -> ${modelSpec} (retrying primary after cooldown)`);
      }
    }

    this.appendFailoverChain(modelSpec, chain, new Set<string>(), request);
    return chain;
  }

  private appendFailoverChain(
    modelSpec: string,
    chain: ChatCandidate[],
    expanded: Set<string>,
    request?: { authProfileKey?: string; accountRef?: string },
  ): void {
    this.appendCandidatesForModelSpec(modelSpec, chain, request);
    if (expanded.has(modelSpec)) return;
    expanded.add(modelSpec);

    for (const equivalent of this.modelEquivalents.get(modelSpec) ?? []) {
      this.appendFailoverChain(equivalent, chain, expanded, request);
    }

    const parsed = tryParseModelId(modelSpec);
    const providerName = parsed?.provider;
    const model = parsed?.model ?? modelSpec;
    // Look up failover by full spec first, provider-independent model next,
    // then by provider-only key for legacy provider failover chains.
    const failovers = this.failoverChains[modelSpec] ?? this.failoverChains[model] ?? (providerName ? this.failoverChains[providerName] : undefined);
    if (!failovers) return;

    // Expand provider-only failover entries to full specs using the same model.
    for (const fallback of failovers) {
      if (parsed && !fallback.includes("/") && this.modelEquivalents.has(modelSpec)) {
        continue;
      }
      const next = parsed && isProviderName(fallback, this.providerConfigs) ? `${fallback}/${model}` : fallback;
      this.appendFailoverChain(next, chain, expanded, request);
    }
  }

  private appendCandidatesForModelSpec(
    modelSpec: string,
    chain: ChatCandidate[],
    request?: { authProfileKey?: string; accountRef?: string },
  ): void {
    const parsed = tryParseModelId(modelSpec);
    const candidates = parsed
      ? this.expandProviderModelCandidates(parsed.provider, parsed.model, request)
      : this.expandProviderIndependentCandidates(modelSpec, request);

    for (const candidate of candidates) {
      if (chain.some((item) => item.healthKey === candidate.healthKey)) continue;
      chain.push(candidate);
    }
  }

  private expandProviderIndependentCandidates(
    model: string,
    request?: { authProfileKey?: string; accountRef?: string },
  ): ChatCandidate[] {
    return [...this.providers.keys()]
      .filter((providerName) => this.providerCanServeModel(providerName, model))
      .sort((a, b) => this.compareProviderOrder(a, b))
      .flatMap((providerName) => this.expandProviderModelCandidates(providerName, model, request));
  }

  private expandProviderModelCandidates(
    providerName: string,
    model: string,
    request?: { authProfileKey?: string; accountRef?: string },
  ): ChatCandidate[] {
    const requestedAccount = request?.accountRef ? this.parseMatchingAccountRef(providerName, request.accountRef) : undefined;
    const accounts = this.orderedAccountsForModel(providerName, model, requestedAccount);
    const spec = `${providerName}/${model}`;

    if (accounts.length === 0) {
      return [{ spec, healthKey: spec }];
    }

    return accounts.map((accountName) => {
      const accountRef = `${providerName}.${accountName}`;
      return { spec, accountRef, healthKey: `${spec}#${accountName}` };
    });
  }

  private orderedAccountsForModel(providerName: string, model: string, requestedAccount?: string): string[] {
    const accounts = this.providerConfigs[providerName]?.accounts ?? {};
    const accountNames = Object.keys(accounts).filter((accountName) => this.accountCanServeModel(providerName, accountName, model));
    if (requestedAccount) {
      return accountNames.includes(requestedAccount) ? [requestedAccount] : [];
    }

    return accountNames.sort((a, b) => this.compareAccountOrder(providerName, a, b));
  }

  private providerCanServeModel(providerName: string, model: string): boolean {
    const configuredModels = this.providerConfigs[providerName]?.models;
    if (configuredModels?.length) return configuredModels.includes(model);

    const provider = this.providers.get(providerName);
    if (provider?.listModels) {
      try {
        const models = provider.listModels();
        if (Array.isArray(models)) return models.includes(model);
      } catch {
        // Provider list unavailable — fall through to account metadata.
      }
    }

    const accounts = this.providerConfigs[providerName]?.accounts ?? {};
    return Object.keys(accounts).some((accountName) => this.accountCanServeModel(providerName, accountName, model));
  }

  private accountCanServeModel(providerName: string, accountName: string, model: string): boolean {
    const accountModels = this.providerConfigs[providerName]?.accounts?.[accountName]?.models;
    if (accountModels?.length) return accountModels.includes(model);
    const providerModels = this.providerConfigs[providerName]?.models;
    return !providerModels?.length || providerModels.includes(model);
  }

  private providerPriority(providerName: string): number {
    return this.providerConfigs[providerName]?.priority ?? 100;
  }

  private accountPriority(providerName: string, accountName: string): number {
    return this.providerConfigs[providerName]?.accounts?.[accountName]?.priority ?? 100;
  }

  private compareProviderOrder(a: string, b: string): number {
    return compareUsageSnapshots(this.usageSnapshots.get(a), this.usageSnapshots.get(b)) ||
      this.providerPriority(a) - this.providerPriority(b) ||
      a.localeCompare(b);
  }

  private compareAccountOrder(providerName: string, a: string, b: string): number {
    return compareUsageSnapshots(this.usageSnapshots.get(`${providerName}#${a}`), this.usageSnapshots.get(`${providerName}#${b}`)) ||
      this.accountPriority(providerName, a) - this.accountPriority(providerName, b) ||
      a.localeCompare(b);
  }

  private listUsageCandidateKeys(): { providerName: string; accountName?: string; key: string }[] {
    const candidates: { providerName: string; accountName?: string; key: string }[] = [];
    for (const providerName of this.providers.keys()) {
      if (providerName.includes("#")) continue;
      const accounts = Object.keys(this.providerConfigs[providerName]?.accounts ?? {});
      if (accounts.length === 0) {
        candidates.push({ providerName, key: providerName });
        continue;
      }
      for (const accountName of accounts) {
        candidates.push({ providerName, accountName, key: `${providerName}#${accountName}` });
      }
    }
    return candidates;
  }

  private async inspectUsageCandidate(candidate: { providerName: string; accountName?: string; key: string }): Promise<void> {
    const provider = this.getProviderForRequest(candidate.providerName, candidate.accountName ? { accountRef: `${candidate.providerName}.${candidate.accountName}` } : undefined);
    const configured = this.usageFromConfig(candidate.providerName, candidate.accountName);
    if (configured.source !== "unknown") {
      this.usageSnapshots.set(candidate.key, configured);
    }

    if (provider?.setApiKey) {
      const apiKey = await this.resolveApiKey(candidate.providerName, candidate.accountName ? { accountRef: `${candidate.providerName}.${candidate.accountName}` } : undefined);
      if (apiKey) provider.setApiKey(apiKey);
    }

    if (provider?.getUsageStatus) {
      try {
        const inspected = normalizeUsageSnapshot(await provider.getUsageStatus(), "provider");
        if (inspected.source !== "unknown") {
          this.usageSnapshots.set(candidate.key, inspected);
          return;
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.warn(`[router] Could not inspect usage for ${candidate.key}: ${message}`);
      }
    }

    if (configured.source !== "unknown") return;

    const rateLimit = provider?.getRateLimitStatus();
    const fromRateLimit = normalizeUsageSnapshot(rateLimit ? {
      usedTokens: null,
      totalTokens: null,
      remainingTokens: rateLimit.remaining,
      remainingRatio: null,
      resetAt: rateLimit.resetAt,
    } : null, "rate-limit");
    this.usageSnapshots.set(candidate.key, fromRateLimit);
  }

  private usageFromConfig(providerName: string, accountName?: string): UsageSnapshot {
    const config = accountName ? this.providerConfigs[providerName]?.accounts?.[accountName] : this.providerConfigs[providerName];
    return normalizeUsageSnapshot({
      usedTokens: config?.quota?.usedTokens ?? null,
      totalTokens: config?.quota?.totalTokens ?? null,
      remainingTokens: config?.quota?.remainingTokens ?? null,
      remainingRatio: config?.quota?.remainingRatio ?? null,
      resetAt: null,
    }, "config");
  }

  private parseMatchingAccountRef(providerName: string, accountRef: string): string | undefined {
    const parsed = parseAccountRef(accountRef.includes(".") ? accountRef : `${providerName}.${accountRef}`);
    return parsed.provider === providerName ? parsed.account : undefined;
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

  private createProvider(providerName: string, accountName?: string): ModelProvider | undefined {
    const accountConfig = accountName ? this.getAccountConfig(providerName, accountName) : undefined;
    const providerConfig = this.providerConfigs[providerName];
    const apiKey = accountConfig?.apiKey ?? providerConfig?.apiKey;
    const baseUrl = accountConfig?.baseUrl ?? providerConfig?.baseUrl;

    switch (providerName) {
      case "github-copilot": {
        const mergedHeaders = { ...(providerConfig?.headers ?? {}), ...(accountConfig?.headers ?? {}) };
        const override = Object.keys(mergedHeaders).length > 0 ? mergedHeaders : undefined;
        return new CopilotProvider(apiKey, override);
      }
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
        return new OllamaProvider(baseUrl, providerConfig?.defaultContextWindow);
      case "llamacpp":
        return new LlamaCppProvider(
          baseUrl ?? process.env["LLAMACPP_BASE_URL"],
          providerConfig?.defaultContextWindow,
        );
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
  const parsed = tryParseModelId(modelSpec);
  if (!parsed) return `model "${modelSpec}"`;
  const { provider, model } = parsed;
  return `model "${model}" via provider "${provider}"`;
}

function tryParseModelId(modelSpec: string): { provider: string; model: string } | undefined {
  return modelSpec.includes("/") ? parseModelId(modelSpec) : undefined;
}

function isProviderName(value: string, providerConfigs: Record<string, RuntimeProviderConfigLike>): boolean {
  return Object.prototype.hasOwnProperty.call(providerConfigs, value) || [
    "github-copilot",
    "anthropic",
    "openai",
    "openai-codex",
    "opencode",
    "opencode-go",
    "ollama",
    "llamacpp",
  ].includes(value);
}

function firstModel(value: string | string[] | undefined): string | undefined {
  if (!value) return undefined;
  return Array.isArray(value) ? value[0] : value;
}

function compareUsageSnapshots(a: UsageSnapshot | undefined, b: UsageSnapshot | undefined): number {
  const remainingTokens = compareNullableNumbersDesc(a?.remainingTokens, b?.remainingTokens);
  if (remainingTokens !== 0) return remainingTokens;
  return compareNullableNumbersDesc(a?.remainingRatio, b?.remainingRatio);
}

function compareNullableNumbersDesc(a: number | null | undefined, b: number | null | undefined): number {
  const aKnown = typeof a === "number" && Number.isFinite(a);
  const bKnown = typeof b === "number" && Number.isFinite(b);
  if (aKnown && bKnown) return b - a;
  if (aKnown) return -1;
  if (bKnown) return 1;
  return 0;
}

function normalizeUsageSnapshot(status: UsageStatus | null, source: UsageSnapshot["source"]): UsageSnapshot {
  if (!status) return unknownUsageSnapshot();
  const usedTokens = finiteOrNull(status.usedTokens);
  const totalTokens = finiteOrNull(status.totalTokens);
  const explicitRemainingTokens = finiteOrNull(status.remainingTokens);
  const remainingTokens = explicitRemainingTokens ??
    (totalTokens !== null && usedTokens !== null ? Math.max(totalTokens - usedTokens, 0) : null);
  const explicitRemainingRatio = finiteOrNull(status.remainingRatio);
  const remainingRatio = explicitRemainingRatio ??
    (totalTokens && remainingTokens !== null ? clamp01(remainingTokens / totalTokens) : null);

  if (usedTokens === null && totalTokens === null && remainingTokens === null && remainingRatio === null) {
    return unknownUsageSnapshot();
  }

  return {
    usedTokens,
    totalTokens,
    remainingTokens,
    remainingRatio,
    resetAt: status.resetAt ?? null,
    source,
  };
}

function unknownUsageSnapshot(): UsageSnapshot {
  return {
    usedTokens: null,
    totalTokens: null,
    remainingTokens: null,
    remainingRatio: null,
    resetAt: null,
    source: "unknown",
  };
}

function finiteOrNull(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
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

/** Merge two equivalence indexes, combining entries for the same spec. */
function mergeEquivalenceIndexes(a: Map<string, string[]>, b: Map<string, string[]>): Map<string, string[]> {
  const merged = new Map(a);
  for (const [spec, equivalents] of b) {
    const existing = merged.get(spec) ?? [];
    merged.set(spec, unique([...existing, ...equivalents]));
  }
  return merged;
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}
