import { describe, it, expect, vi, beforeEach } from "vitest";
import { ModelRouter } from "./router.js";
import type { SaivageConfig } from "../config.js";
import type { ChatRequest, ModelProvider } from "./types.js";

function makeConfig(overrides: Partial<SaivageConfig> = {}): SaivageConfig {
  return {
    models: {
      orchestrator: "anthropic/claude-sonnet-4-20250514",
      coder: "anthropic/claude-sonnet-4-20250514",
      researcher: "openai/gpt-4o",
      executor: "anthropic/claude-haiku-3",
      chat: "anthropic/claude-sonnet-4-20250514",
      default: "anthropic/claude-sonnet-4-20250514",
    },
    providers: {},
    failover: {},
    modelEquivalents: {},
    server: { port: 8080, host: "0.0.0.0" },
    agent: { maxConcurrentAgents: 3 },
    runtime: {
      maxServices: 50,
      restartOnCrash: true,
      healthCheckIntervalMs: 30000,
      idleShutdownMs: 300000,
    },
    project: { root: "", venv: "", description: "" },
    security: { injectionScanner: true, maxScanLengthBytes: 100000 },
    telegram: { botToken: "", allowedUserIds: [] },
    ...overrides,
  };
}

describe("ModelRouter", () => {
  it("resolves model for role", () => {
    const router = new ModelRouter(makeConfig());
    expect(router.resolveModelForRole("coder")).toBe(
      "anthropic/claude-sonnet-4-20250514",
    );
  });

  it("falls back to default for unknown role", () => {
    const router = new ModelRouter(makeConfig());
    expect(router.resolveModelForRole("unknown")).toBe(
      "anthropic/claude-sonnet-4-20250514",
    );
  });

  it("lists registered providers", () => {
    const router = new ModelRouter(makeConfig());
    const providers = router.listProviders();
    // Ollama is always registered
    expect(providers).toContain("ollama");
  });

  it("follows model-specific failover chains recursively", () => {
    const router = new ModelRouter(makeConfig({
      failover: {
        "github-copilot/gpt-5.5": ["github-copilot/gpt-5.4"],
        "github-copilot/gpt-5.4": ["github-copilot/claude-sonnet-4.6"],
      },
    }));

    const chain = (router as unknown as { buildChain(modelSpec: string): string[] }).buildChain("github-copilot/gpt-5.5");

    expect(chain).toEqual([
      "github-copilot/gpt-5.5",
      "github-copilot/gpt-5.4",
      "github-copilot/claude-sonnet-4.6",
    ]);
  });

  it("uses equivalent models interchangeably", () => {
    const router = new ModelRouter(makeConfig({
      modelEquivalents: {
        "github-copilot/gpt-5.4": ["openai-codex/gpt-5.4"],
      },
    }));

    const fromCopilot = (router as unknown as { buildChain(modelSpec: string): string[] }).buildChain("github-copilot/gpt-5.4");
    const fromCodex = (router as unknown as { buildChain(modelSpec: string): string[] }).buildChain("openai-codex/gpt-5.4");

    expect(fromCopilot).toEqual([
      "github-copilot/gpt-5.4",
      "openai-codex/gpt-5.4",
    ]);
    expect(fromCodex).toEqual([
      "openai-codex/gpt-5.4",
      "github-copilot/gpt-5.4",
    ]);
  });

  it("expands equivalent models before lower-tier failover", () => {
    const router = new ModelRouter(makeConfig({
      modelEquivalents: {
        "github-copilot/gpt-5.4": ["openai-codex/gpt-5.4"],
      },
      failover: {
        "github-copilot/gpt-5.4": ["github-copilot/claude-sonnet-4.6"],
      },
    }));

    const chain = (router as unknown as { buildChain(modelSpec: string): string[] }).buildChain("github-copilot/gpt-5.4");

    expect(chain).toEqual([
      "github-copilot/gpt-5.4",
      "openai-codex/gpt-5.4",
      "github-copilot/claude-sonnet-4.6",
    ]);
  });

  it("returns metadata for the actual provider and model used", async () => {
    const router = new ModelRouter(makeConfig({
      failover: {
        "primary/model-a": ["fallback/model-b"],
      },
    }));
    const providers = (router as unknown as { providers: Map<string, ModelProvider> }).providers;
    providers.clear();

    providers.set("primary", makeProvider("primary", vi.fn(async () => {
      throw new Error("primary unavailable");
    })));
    const fallbackChat = vi.fn(async (request: ChatRequest) => ({
      content: `answered by ${request.model}`,
      toolCalls: [],
      finishReason: "end_turn" as const,
      usage: { inputTokens: 1, outputTokens: 2 },
    }));
    providers.set("fallback", makeProvider("fallback", fallbackChat));

    const response = await router.chat({
      modelSpec: "primary/model-a",
      model: "model-a",
      system: "system",
      messages: [],
    });

    expect(fallbackChat).toHaveBeenCalledWith(expect.objectContaining({ model: "model-b" }));
    expect(response.provider).toBe("fallback");
    expect(response.model).toBe("model-b");
    expect(response.modelSpec).toBe("fallback/model-b");
    expect(response.requestedModelSpec).toBe("primary/model-a");
  });

  it("reports provider and model separately when all providers fail", async () => {
    const router = new ModelRouter(makeConfig());
    const providers = (router as unknown as { providers: Map<string, ModelProvider> }).providers;
    providers.clear();

    providers.set("github-copilot", makeProvider("github-copilot", vi.fn(async () => {
      throw new Error("service unavailable");
    })));

    await expect(router.chat({
      modelSpec: "github-copilot/gpt-5.4",
      model: "gpt-5.4",
      system: "system",
      messages: [],
    })).rejects.toThrow('All providers failed for model "gpt-5.4" via provider "github-copilot"');
  });
});

function makeProvider(name: string, chat: ModelProvider["chat"]): ModelProvider {
  return {
    name,
    chat,
    supportsTools: () => true,
    supportsImages: () => false,
    supportsStreaming: () => false,
    maxContextTokens: () => 200_000,
    isAvailable: async () => true,
    getRateLimitStatus: () => ({ remaining: null, resetAt: null, limited: false }),
  };
}
