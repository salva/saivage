import { parseModelId } from "./types.js";

export interface ChatCandidate {
  spec: string;
  accountRef?: string;
  healthKey: string;
}

export interface StickyFailoverPlan {
  spec: string;
  nextPrimaryRetryAt: number;
}

export interface CandidatePlanRequest {
  authProfileKey?: string;
  accountRef?: string;
}

interface BuildCandidateChainOptions {
  modelSpec: string;
  request?: CandidatePlanRequest;
  sticky?: StickyFailoverPlan;
  now: number;
  failoverChains: Record<string, string[]>;
  modelEquivalents: Map<string, string[]>;
  providerNames: string[];
  providerCanServeModel(providerName: string, model: string): boolean;
  compareProviderOrder(a: string, b: string): number;
  expandProviderModelCandidates(providerName: string, model: string, request?: CandidatePlanRequest): ChatCandidate[];
  isProviderName(value: string): boolean;
  onPrimaryRetryAfterStickyCooldown?(stickySpec: string, primarySpec: string): void;
}

export function buildCandidateChain(options: BuildCandidateChainOptions): ChatCandidate[] {
  const chain: ChatCandidate[] = [];
  const { modelSpec, sticky } = options;

  if (sticky && sticky.spec !== modelSpec) {
    if (options.now < sticky.nextPrimaryRetryAt) {
      appendCandidatesForModelSpec(sticky.spec, chain, options);
    } else {
      options.onPrimaryRetryAfterStickyCooldown?.(sticky.spec, modelSpec);
    }
  }

  appendFailoverChain(modelSpec, chain, new Set<string>(), options);
  return chain;
}

function appendFailoverChain(
  modelSpec: string,
  chain: ChatCandidate[],
  expanded: Set<string>,
  options: BuildCandidateChainOptions,
): void {
  appendCandidatesForModelSpec(modelSpec, chain, options);
  if (expanded.has(modelSpec)) return;
  expanded.add(modelSpec);

  for (const equivalent of options.modelEquivalents.get(modelSpec) ?? []) {
    appendFailoverChain(equivalent, chain, expanded, options);
  }

  const parsed = tryParseModelId(modelSpec);
  const providerName = parsed?.provider;
  const model = parsed?.model ?? modelSpec;
  // Look up failover by full spec first, provider-independent model next,
  // then by provider-only key for legacy provider failover chains.
  const failovers = options.failoverChains[modelSpec]
    ?? options.failoverChains[model]
    ?? (providerName ? options.failoverChains[providerName] : undefined);
  if (!failovers) return;

  // Expand provider-only failover entries to full specs using the same model.
  for (const fallback of failovers) {
    if (parsed && !fallback.includes("/") && options.modelEquivalents.has(modelSpec)) {
      continue;
    }
    const next = parsed && options.isProviderName(fallback) ? `${fallback}/${model}` : fallback;
    appendFailoverChain(next, chain, expanded, options);
  }
}

function appendCandidatesForModelSpec(
  modelSpec: string,
  chain: ChatCandidate[],
  options: BuildCandidateChainOptions,
): void {
  const parsed = tryParseModelId(modelSpec);
  const candidates = parsed
    ? options.expandProviderModelCandidates(parsed.provider, parsed.model, options.request)
    : expandProviderIndependentCandidates(modelSpec, options);

  for (const candidate of candidates) {
    if (chain.some((item) => item.healthKey === candidate.healthKey)) continue;
    chain.push(candidate);
  }
}

function expandProviderIndependentCandidates(
  model: string,
  options: BuildCandidateChainOptions,
): ChatCandidate[] {
  return options.providerNames
    .filter((providerName) => options.providerCanServeModel(providerName, model))
    .sort((a, b) => options.compareProviderOrder(a, b))
    .flatMap((providerName) => options.expandProviderModelCandidates(providerName, model, options.request));
}

function tryParseModelId(modelSpec: string): { provider: string; model: string } | undefined {
  return modelSpec.includes("/") ? parseModelId(modelSpec) : undefined;
}
