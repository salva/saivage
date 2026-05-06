import { afterEach, describe, it, expect, vi } from "vitest";
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
  afterEach(() => {
    vi.restoreAllMocks();
  });

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

  it("does not carry provider-only failover onto models with explicit equivalents", () => {
    const router = new ModelRouter(makeConfig({
      modelEquivalents: {
        "github-copilot/claude-sonnet-4.6": ["openai-codex/gpt-5.3-codex"],
      },
      failover: {
        "github-copilot": ["openai-codex"],
      },
    }));

    const chain = (router as unknown as { buildChain(modelSpec: string): string[] }).buildChain("github-copilot/claude-sonnet-4.6");

    expect(chain).toEqual([
      "github-copilot/claude-sonnet-4.6",
      "openai-codex/gpt-5.3-codex",
    ]);
    expect(chain).not.toContain("openai-codex/claude-sonnet-4.6");
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

  it("retries the primary model after sticky failover cooldown", async () => {
    let now = 1_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);

    const router = new ModelRouter(makeConfig({
      failover: {
        "primary/model-a": ["fallback/model-b"],
      },
    }));
    const providers = (router as unknown as { providers: Map<string, ModelProvider> }).providers;
    providers.clear();

    const primaryChat = vi.fn(async () => {
      if (primaryChat.mock.calls.length === 1) {
        throw new Error("primary unavailable");
      }
      return {
        content: "primary recovered",
        toolCalls: [],
        finishReason: "end_turn" as const,
        usage: { inputTokens: 1, outputTokens: 1 },
      };
    });
    const fallbackChat = vi.fn(async () => ({
      content: "fallback answer",
      toolCalls: [],
      finishReason: "end_turn" as const,
      usage: { inputTokens: 1, outputTokens: 1 },
    }));
    providers.set("primary", makeProvider("primary", primaryChat));
    providers.set("fallback", makeProvider("fallback", fallbackChat));

    const first = await router.chat(makeChatRequest("primary/model-a"));
    expect(first.modelSpec).toBe("fallback/model-b");
    expect(primaryChat).toHaveBeenCalledTimes(1);
    expect(fallbackChat).toHaveBeenCalledTimes(1);

    now += 29_000;
    const second = await router.chat(makeChatRequest("primary/model-a"));
    expect(second.modelSpec).toBe("fallback/model-b");
    expect(primaryChat).toHaveBeenCalledTimes(1);
    expect(fallbackChat).toHaveBeenCalledTimes(2);

    now += 1_000;
    const third = await router.chat(makeChatRequest("primary/model-a"));
    expect(third.modelSpec).toBe("primary/model-a");
    expect(primaryChat).toHaveBeenCalledTimes(2);
    expect(fallbackChat).toHaveBeenCalledTimes(2);
  });

  it("backs off primary retry windows after repeated failed switchback attempts", async () => {
    let now = 2_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);

    const router = new ModelRouter(makeConfig({
      failover: {
        "primary/model-a": ["fallback/model-b"],
      },
    }));
    const providers = (router as unknown as { providers: Map<string, ModelProvider> }).providers;
    providers.clear();

    const primaryChat = vi.fn(async () => {
      throw new Error("primary unavailable");
    });
    const fallbackChat = vi.fn(async () => ({
      content: "fallback answer",
      toolCalls: [],
      finishReason: "end_turn" as const,
      usage: { inputTokens: 1, outputTokens: 1 },
    }));
    providers.set("primary", makeProvider("primary", primaryChat));
    providers.set("fallback", makeProvider("fallback", fallbackChat));

    await router.chat(makeChatRequest("primary/model-a"));
    expect(primaryChat).toHaveBeenCalledTimes(1);

    now += 30_000;
    await router.chat(makeChatRequest("primary/model-a"));
    expect(primaryChat).toHaveBeenCalledTimes(2);

    now += 44_000;
    await router.chat(makeChatRequest("primary/model-a"));
    expect(primaryChat).toHaveBeenCalledTimes(2);

    now += 1_000;
    await router.chat(makeChatRequest("primary/model-a"));
    expect(primaryChat).toHaveBeenCalledTimes(3);
    expect(fallbackChat).toHaveBeenCalledTimes(4);
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

  it("prefers account-scoped api keys over provider defaults", async () => {
    const router = new ModelRouter(makeConfig({
      providers: {
        "github-copilot": {
          apiKey: "provider-key",
          defaultAccount: "main",
          accounts: {
            main: { apiKey: "account-key" },
          },
        },
      },
    }));

    await expect(router.resolveApiKey("github-copilot", { accountRef: "github-copilot.main" })).resolves.toBe("account-key");
    await expect(router.resolveApiKey("github-copilot")).resolves.toBe("account-key");
  });
});

function makeChatRequest(modelSpec: string): ChatRequest & { modelSpec: string } {
  return {
    modelSpec,
    model: modelSpec.split("/")[1] ?? modelSpec,
    system: "system",
    messages: [],
  };
}

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
