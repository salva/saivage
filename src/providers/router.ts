import type { SaivageConfig } from "../config.js";
import { configPath } from "../config.js";
import { MissingModelForRoleError } from "../config-validation.js";
import type {
  ChatRequest,
  ChatResponse,
  ModelProvider,
  Message,
  ToolSchema,
} from "./types.js";
import { parseModelId } from "./types.js";
import { ProviderError, classifyProviderError } from "./error.js";
import { log } from "../log.js";
import type { RuntimeProviderConfigLike } from "../routing/resolver.js";
import { parseAccountRef } from "../routing/resolver.js";
import { CredentialResolver, type CredentialRequest } from "./credential-resolver.js";
import { ProviderRegistry } from "./provider-registry.js";
import {
  buildCandidateChain,
  buildModelEquivalenceIndex,
  mergeEquivalenceIndexes,
  type CandidatePlanRequest,
  type ChatCandidate,
} from "./candidate-planner.js";
import {
  compareUsageSnapshots,
  describeRequestedModel,
  firstModel,
  normalizeUsageSnapshot,
  tryParseModelId,
  unique,
  type UsageSnapshot,
} from "./router-utils.js";
import { ModelHealthTracker } from "./health-tracker.js";
import { StickyFailoverManager } from "./sticky-failover.js";

const PROVIDER_REQUEST_TIMEOUT_MS = 300_000;
const PRIMARY_RETRY_BASE_DELAY_MS = 30_000;
const PRIMARY_RETRY_BACKOFF_MULT = 1.5;
const PRIMARY_RETRY_MAX_DELAY_MS = 20 * 60_000;

/** Lightweight LLM call metrics (replaces v1 telemetry module). */
function recordLlmCall(_spec: string, _data: Record<string, unknown>): void {
  // Metrics are logged via the log module; no separate telemetry store needed.
}

export class ModelRouter {
  private readonly providers: Map<string, ModelProvider>;
  private readonly config: SaivageConfig;
  private failoverChains: Record<string, string[]>;
  private modelEquivalents: Map<string, string[]>;
  private modelAssignments: Record<string, string | string[] | undefined>;
  private providerConfigs: Record<string, RuntimeProviderConfigLike>;
  private readonly credentialResolver: CredentialResolver;
  private readonly providerRegistry: ProviderRegistry;
  private readonly stickyFailovers = new StickyFailoverManager();
  private usageSnapshots = new Map<string, UsageSnapshot>();
  private readonly healthTracker = new ModelHealthTracker();

  constructor(config: SaivageConfig) {
    this.config = config;
    this.failoverChains = config.failover;
    this.modelAssignments = config.models as Record<string, string | string[] | undefined>;
    this.providerConfigs = config.providers as Record<string, RuntimeProviderConfigLike>;
    this.credentialResolver = new CredentialResolver(this.providerConfigs);
    this.providerRegistry = new ProviderRegistry(this.providerConfigs, this.credentialResolver);
    this.providers = this.providerRegistry.providerMapForTests();
    // Equivalence index defaults to empty; populated by init() once
    // providers are registered (init reads OAuth state, so it must be
    // async).
    this.modelEquivalents = new Map<string, string[]>();
  }

  /**
   * Two-phase construction: the constructor only captures config; this
   * method does the async work (OAuth state probes inside
   * `shouldRegisterProvider`) and the equivalence-index build that
   * depends on the populated provider map.
   */
  async init(): Promise<void> {
    await this.providerRegistry.initBaseProviders();

    // Build equivalence index: manual entries + autodiscovered from providers
    const manualEquivs = buildModelEquivalenceIndex(this.config.modelEquivalents);
    const discovered = this.discoverModelEquivalents();
    this.modelEquivalents = mergeEquivalenceIndexes(manualEquivs, discovered);
  }

  /**
   * Warm provider model caches so synchronous capability lookups
   * (modelCapabilities → getMaxContextTokens) work before the first chat()
   * call. Providers whose listModels() is async (e.g. copilot) only populate
   * their metadata cache on first fetch; without this warmup the planner
   * and chat WS handler throw "no context window" at startup.
   *
   * Must be called AFTER inspectUsageAtStartup() — that method may call
   * setApiKey() on copilot which resets the modelsCache to null.
   */
  async warmupProviderCaches(): Promise<void> {
    // Use the router's own listModels(name) — it resolves OAuth credentials
    // and calls provider.setApiKey() before fetching, so the cache populates
    // on the provider instance that subsequent getProviderForRequest() will
    // return. Calling provider.listModels() directly bypasses OAuth and
    // hits providers with an empty apiKey, returning [] and leaving caches
    // empty (which then causes "no context window" at first chat).
    const providerNames = this.providerRegistry.listBaseProviders();
    for (const name of providerNames) {
      const provider = this.providerRegistry.get(name);
      if (!provider?.listModels) continue;
      try {
        const models = await this.listModels(name);
        log.info(`[router] warmup ${name}: ${models.length} models`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.warn(`[router] warmup: ${name}.listModels() failed: ${msg}`);
      }
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

    for (const [providerName, provider] of this.providerRegistry.entries()) {
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
    options: CredentialRequest = {},
  ): Promise<string | null> {
    return this.credentialResolver.resolveApiKey(providerName, options);
  }

  /** Resolve a role (e.g. "coder") to a model spec string */
  resolveModelForRole(role: string): string {
    return firstModel(this.modelAssignments[role]) ?? firstModel(this.modelAssignments["default"]) ?? (() => { throw new MissingModelForRoleError([role], configPath()); })();
  }

  /** Get provider instance by name */
  getProvider(name: string): ModelProvider | undefined {
    return this.providerRegistry.get(name);
  }

  /** List all registered providers */
  listProviders(): string[] {
    return this.providerRegistry.listProviders();
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
        const sticky = this.stickyFailovers.getSticky(request.modelSpec);
        if (spec === request.modelSpec && sticky) {
          this.stickyFailovers.clearStickyFailover(request.modelSpec);
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
            this.stickyFailovers.setSticky(request.modelSpec, {
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

  private getHealth(spec: string) {
    return this.healthTracker.getHealth(spec);
  }

  private recordFailure(spec: string, health: ReturnType<ModelHealthTracker["getHealth"]>): void {
    this.healthTracker.recordFailure(spec, health);
  }

  private resetHealth(spec: string): void {
    this.healthTracker.resetHealth(spec);
  }

  /** Force-reset health for all models in a failover chain (used by agent retry logic). */
  resetModelHealth(modelSpec: string): void {
    const chain = this.buildCandidateChain(modelSpec);
    this.healthTracker.resetModelHealth(chain);
  }

  private buildChain(modelSpec: string): string[] {
    return unique(this.buildCandidateChain(modelSpec).map((candidate) => candidate.spec));
  }

  private buildCandidateChain(
    modelSpec: string,
    request?: CandidatePlanRequest,
  ): ChatCandidate[] {
    return buildCandidateChain({
      modelSpec,
      request,
      sticky: this.stickyFailovers.getSticky(modelSpec),
      now: Date.now(),
      failoverChains: this.failoverChains,
      modelEquivalents: this.modelEquivalents,
      providerNames: this.providerRegistry.listProviders(),
      providerCanServeModel: (providerName, model) => this.providerCanServeModel(providerName, model),
      compareProviderOrder: (a, b) => this.compareProviderOrder(a, b),
      expandProviderModelCandidates: (providerName, model, candidateRequest) =>
        this.expandProviderModelCandidates(providerName, model, candidateRequest),
      isProviderName: (value) => this.providerRegistry.hasDescriptor(value),
      onPrimaryRetryAfterStickyCooldown: (stickySpec, primarySpec) => {
        log.info(`Model switch: ${stickySpec} -> ${primarySpec} (retrying primary after cooldown)`);
      },
    });
  }

  private expandProviderModelCandidates(
    providerName: string,
    model: string,
    request?: CandidatePlanRequest,
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

    const provider = this.providerRegistry.get(providerName);
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
    for (const providerName of this.providerRegistry.listBaseProviders()) {
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
  /** Reset sticky failover for a model */
  clearStickyFailover(modelSpec: string): void {
    const was = this.stickyFailovers.clearStickyFailover(modelSpec);
    if (was) {
      log.info(`Model switch: ${was.spec} -> ${modelSpec} (retrying primary after cooldown)`);
    }
  }

  private getProviderForRequest(
    providerName: string,
    request?: CredentialRequest,
  ): ModelProvider | undefined {
    return this.providerRegistry.getForRequest(providerName, request);
  }
}
