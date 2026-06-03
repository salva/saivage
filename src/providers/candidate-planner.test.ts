import { describe, expect, it, vi } from "vitest";
import { buildCandidateChain, type CandidatePlanRequest, type ChatCandidate } from "./candidate-planner.js";

describe("buildCandidateChain", () => {
  it("expands equivalents before failovers without calling providers", () => {
    const providerCall = vi.fn();
    const chain = plan({
      modelSpec: "github-copilot/gpt-5.4",
      modelEquivalents: new Map([
        ["github-copilot/gpt-5.4", ["openai-codex/gpt-5.4"]],
        ["openai-codex/gpt-5.4", ["github-copilot/gpt-5.4"]],
      ]),
      failoverChains: {
        "github-copilot/gpt-5.4": ["github-copilot/claude-sonnet-4.6"],
      },
      providerCanServeModel: () => {
        providerCall();
        return true;
      },
    });

    expect(chain.map((candidate) => candidate.spec)).toEqual([
      "github-copilot/gpt-5.4",
      "openai-codex/gpt-5.4",
      "github-copilot/claude-sonnet-4.6",
    ]);
    expect(providerCall).not.toHaveBeenCalled();
  });

  it("orders provider-independent candidates by supplied provider order", () => {
    const chain = plan({
      modelSpec: "shared-model",
      providerNames: ["alpha", "beta", "gamma"],
      providerCanServeModel: (providerName) => providerName !== "gamma",
      compareProviderOrder: (a, b) => providerOrder(a) - providerOrder(b),
    });

    expect(chain.map((candidate) => candidate.spec)).toEqual([
      "beta/shared-model",
      "alpha/shared-model",
    ]);
  });

  it("puts sticky failover first until the primary retry window", () => {
    const chain = plan({
      modelSpec: "primary/model-a",
      sticky: { spec: "fallback/model-b", nextPrimaryRetryAt: 2_000 },
      now: 1_000,
      failoverChains: { "primary/model-a": ["fallback/model-b"] },
    });

    expect(chain.map((candidate) => candidate.spec)).toEqual([
      "fallback/model-b",
      "primary/model-a",
    ]);
  });

  it("logs sticky primary retry and starts with primary after cooldown", () => {
    const onPrimaryRetryAfterStickyCooldown = vi.fn();
    const chain = plan({
      modelSpec: "primary/model-a",
      sticky: { spec: "fallback/model-b", nextPrimaryRetryAt: 2_000 },
      now: 2_000,
      failoverChains: { "primary/model-a": ["fallback/model-b"] },
      onPrimaryRetryAfterStickyCooldown,
    });

    expect(chain.map((candidate) => candidate.spec)).toEqual([
      "primary/model-a",
      "fallback/model-b",
    ]);
    expect(onPrimaryRetryAfterStickyCooldown).toHaveBeenCalledWith("fallback/model-b", "primary/model-a");
  });

  it("expands provider-only failovers only for known providers", () => {
    const chain = plan({
      modelSpec: "github-copilot/claude-sonnet-4.6",
      failoverChains: {
        "github-copilot": ["openai-codex", "not-a-provider"],
      },
      isProviderName: (value) => value === "github-copilot" || value === "openai-codex",
    });

    expect(chain.map((candidate) => candidate.spec)).toEqual([
      "github-copilot/claude-sonnet-4.6",
      "openai-codex/claude-sonnet-4.6",
    ]);
  });
});

function plan(overrides: Partial<Parameters<typeof buildCandidateChain>[0]>): ChatCandidate[] {
  return buildCandidateChain({
    modelSpec: "primary/model-a",
    now: 0,
    failoverChains: {},
    modelEquivalents: new Map(),
    providerNames: [],
    providerCanServeModel: () => true,
    compareProviderOrder: (a, b) => a.localeCompare(b),
    expandProviderModelCandidates: defaultExpandProviderModelCandidates,
    isProviderName: () => false,
    ...overrides,
  });
}

function providerOrder(providerName: string): number {
  return { beta: 1, alpha: 2, gamma: 3 }[providerName] ?? Number.MAX_SAFE_INTEGER;
}

function defaultExpandProviderModelCandidates(
  providerName: string,
  model: string,
  request?: CandidatePlanRequest,
): ChatCandidate[] {
  const account = request?.accountRef;
  if (!account) return [{ spec: `${providerName}/${model}`, healthKey: `${providerName}/${model}` }];
  return [{ spec: `${providerName}/${model}`, accountRef: account, healthKey: `${providerName}/${model}#${account}` }];
}
