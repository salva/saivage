import { afterEach, describe, it, expect, vi } from "vitest";
import { ModelRouter } from "./router.js";
import type { SaivageConfig } from "../config.js";
import type { ChatRequest, ModelProvider } from "./types.js";

function makeConfig(overrides: Partial<SaivageConfig> = {}): SaivageConfig {
  return {
    models: {
      orchestrator: "anthropic/claude-sonnet-4-20250514",
      researcher: "openai/gpt-4o",
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
    security: { envScrubber: { credentialLexemes: ["API_KEY"], configPointerSuffixes: [] } },
    telegram: { botToken: "", allowedUserIds: [] },
    ...overrides,
  };
}

describe("ModelRouter", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("resolves model for role", async () => {
    const router = new ModelRouter(makeConfig());
    await router.init();
    expect(router.resolveModelForRole("coder")).toBe(
      "anthropic/claude-sonnet-4-20250514",
    );
  });

  it("falls back to default for unknown role", async () => {
    const router = new ModelRouter(makeConfig());
    await router.init();
    expect(router.resolveModelForRole("unknown")).toBe(
      "anthropic/claude-sonnet-4-20250514",
    );
  });

  it("uses the first configured model when a role has an ordered model list", async () => {
    const router = new ModelRouter(makeConfig({
      models: {
        coder: ["kimi-k2.6", "deepseek-v4-pro"],
        default: ["deepseek-v4-flash"],
      },
    }));
    await router.init();

    expect(router.resolveModelForRole("coder")).toBe("kimi-k2.6");
    expect(router.resolveModelForRole("unknown")).toBe("deepseek-v4-flash");
  });

  it("lists registered providers", async () => {
    const router = new ModelRouter(makeConfig());
    await router.init();
    const providers = router.listProviders();
    // Ollama is always registered
    expect(providers).toContain("ollama");
  });

  it("follows model-specific failover chains recursively", async () => {
    const router = new ModelRouter(makeConfig({
      failover: {
        "github-copilot/gpt-5.5": ["github-copilot/gpt-5.4"],
        "github-copilot/gpt-5.4": ["github-copilot/claude-sonnet-4.6"],
      },
    }));
    await router.init();

    const chain = (router as unknown as { buildChain(modelSpec: string): string[] }).buildChain("github-copilot/gpt-5.5");

    expect(chain).toEqual([
      "github-copilot/gpt-5.5",
      "github-copilot/gpt-5.4",
      "github-copilot/claude-sonnet-4.6",
    ]);
  });

  it("uses equivalent models interchangeably", async () => {
    const router = new ModelRouter(makeConfig({
      modelEquivalents: {
        "github-copilot/gpt-5.4": ["openai-codex/gpt-5.4"],
      },
    }));
    await router.init();

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

  it("expands equivalent models before lower-tier failover", async () => {
    const router = new ModelRouter(makeConfig({
      modelEquivalents: {
        "github-copilot/gpt-5.4": ["openai-codex/gpt-5.4"],
      },
      failover: {
        "github-copilot/gpt-5.4": ["github-copilot/claude-sonnet-4.6"],
      },
    }));
    await router.init();

    const chain = (router as unknown as { buildChain(modelSpec: string): string[] }).buildChain("github-copilot/gpt-5.4");

    expect(chain).toEqual([
      "github-copilot/gpt-5.4",
      "openai-codex/gpt-5.4",
      "github-copilot/claude-sonnet-4.6",
    ]);
  });

  it("orders provider-independent model candidates by provider priority", async () => {
    const router = new ModelRouter(makeConfig({
      providers: {
        alpha: { priority: 20, models: ["shared-model"] },
        beta: { priority: 10, models: ["shared-model"] },
      },
    }));
    await router.init();
    const providers = (router as unknown as { providers: Map<string, ModelProvider> }).providers;
    providers.clear();
    providers.set("alpha", makeProvider("alpha", vi.fn(async () => successfulResponse("alpha"))));
    providers.set("beta", makeProvider("beta", vi.fn(async () => successfulResponse("beta"))));

    const chain = (router as unknown as { buildChain(modelSpec: string): string[] }).buildChain("shared-model");

    expect(chain).toEqual(["beta/shared-model", "alpha/shared-model"]);
  });

  it("prefers provider with more remaining tokens after startup usage inspection", async () => {
    const router = new ModelRouter(makeConfig({
      providers: {
        alpha: { priority: 10, models: ["shared-model"], quota: { remainingTokens: 100 } },
        beta: { priority: 20, models: ["shared-model"], quota: { remainingTokens: 1000 } },
      },
    }));
    await router.init();
    const providers = (router as unknown as { providers: Map<string, ModelProvider> }).providers;
    providers.clear();
    providers.set("alpha", makeProvider("alpha", vi.fn(async () => successfulResponse("alpha"))));
    providers.set("beta", makeProvider("beta", vi.fn(async () => successfulResponse("beta"))));

    await router.inspectUsageAtStartup();
    const chain = (router as unknown as { buildChain(modelSpec: string): string[] }).buildChain("shared-model");

    expect(chain).toEqual(["beta/shared-model", "alpha/shared-model"]);
  });

  it("resolves context window for provider-independent model candidates", async () => {
    const router = new ModelRouter(makeConfig({
      providers: {
        alpha: { priority: 20, models: ["shared-model"] },
        beta: { priority: 10, models: ["shared-model"] },
      },
    }));
    await router.init();
    const providers = (router as unknown as { providers: Map<string, ModelProvider> }).providers;
    providers.clear();
    providers.set("alpha", { ...makeProvider("alpha", vi.fn(async () => successfulResponse("alpha"))), modelCapabilities: () => ({ contextWindow: 111, tokenEncoding: "cl100k_base" }) });
    providers.set("beta", { ...makeProvider("beta", vi.fn(async () => successfulResponse("beta"))), modelCapabilities: () => ({ contextWindow: 222, tokenEncoding: "cl100k_base" }) });

    expect(router.getMaxContextTokens("shared-model")).toBe(222);
  });

  it("tries the next provider for a model before advancing to the next model", async () => {
    const router = new ModelRouter(makeConfig({
      providers: {
        primary: { priority: 10, models: ["model-a"] },
        secondary: { priority: 20, models: ["model-a"] },
        fallback: { priority: 10, models: ["model-b"] },
      },
      failover: {
        "model-a": ["model-b"],
      },
    }));
    await router.init();
    const providers = (router as unknown as { providers: Map<string, ModelProvider> }).providers;
    providers.clear();

    const primaryChat = vi.fn(async () => {
      throw new Error("primary unavailable");
    });
    const secondaryChat = vi.fn(async () => successfulResponse("secondary"));
    const fallbackChat = vi.fn(async () => successfulResponse("fallback"));
    providers.set("primary", makeProvider("primary", primaryChat));
    providers.set("secondary", makeProvider("secondary", secondaryChat));
    providers.set("fallback", makeProvider("fallback", fallbackChat));

    const response = await router.chat(makeChatRequest("model-a"));

    expect(primaryChat).toHaveBeenCalledTimes(1);
    expect(secondaryChat).toHaveBeenCalledTimes(1);
    expect(fallbackChat).not.toHaveBeenCalled();
    expect(response.modelSpec).toBe("secondary/model-a");
    expect(response.requestedModelSpec).toBe("model-a");
  });

  it("orders accounts by priority within a provider", async () => {
    const router = new ModelRouter(makeConfig({
      providers: {
        gateway: {
          models: ["shared-model"],
          accounts: {
            primary: { priority: 20, apiKey: "primary-key" },
            secondary: { priority: 10, apiKey: "secondary-key" },
          },
        },
      },
    }));
    await router.init();
    const providers = (router as unknown as { providers: Map<string, ModelProvider> }).providers;
    providers.clear();

    const baseChat = vi.fn(async () => successfulResponse("base"));
    const primaryChat = vi.fn(async () => successfulResponse("primary"));
    const secondaryChat = vi.fn(async () => successfulResponse("secondary"));
    providers.set("gateway", makeProvider("gateway", baseChat));
    providers.set("gateway#primary", makeProvider("gateway#primary", primaryChat));
    providers.set("gateway#secondary", makeProvider("gateway#secondary", secondaryChat));

    const response = await router.chat(makeChatRequest("shared-model"));

    expect(secondaryChat).toHaveBeenCalledTimes(1);
    expect(primaryChat).not.toHaveBeenCalled();
    expect(baseChat).not.toHaveBeenCalled();
    expect(response.modelSpec).toBe("gateway/shared-model");
  });

  it("prefers account with more remaining tokens after startup usage inspection", async () => {
    const router = new ModelRouter(makeConfig({
      providers: {
        gateway: {
          models: ["shared-model"],
          accounts: {
            primary: { priority: 10, apiKey: "primary-key", quota: { remainingTokens: 100 } },
            secondary: { priority: 20, apiKey: "secondary-key", quota: { remainingTokens: 1000 } },
          },
        },
      },
    }));
    await router.init();
    const providers = (router as unknown as { providers: Map<string, ModelProvider> }).providers;
    providers.clear();

    const primaryChat = vi.fn(async () => successfulResponse("primary"));
    const secondaryChat = vi.fn(async () => successfulResponse("secondary"));
    providers.set("gateway", makeProvider("gateway", vi.fn(async () => successfulResponse("base"))));
    providers.set("gateway#primary", makeProvider("gateway#primary", primaryChat));
    providers.set("gateway#secondary", makeProvider("gateway#secondary", secondaryChat));

    await router.inspectUsageAtStartup();
    const response = await router.chat(makeChatRequest("shared-model"));

    expect(secondaryChat).toHaveBeenCalledTimes(1);
    expect(primaryChat).not.toHaveBeenCalled();
    expect(response.modelSpec).toBe("gateway/shared-model");
  });

  it("expands built-in provider-only failover into provider/model specs", async () => {
    const router = new ModelRouter(makeConfig({
      failover: {
        "github-copilot": ["openai-codex"],
      },
    }));
    await router.init();

    const chain = (router as unknown as { buildChain(modelSpec: string): string[] }).buildChain("github-copilot/claude-sonnet-4.6");

    expect(chain).toContain("openai-codex/claude-sonnet-4.6");
  });

  it("does not carry provider-only failover onto models with explicit equivalents", async () => {
    const router = new ModelRouter(makeConfig({
      modelEquivalents: {
        "github-copilot/claude-sonnet-4.6": ["openai-codex/gpt-5.3-codex"],
      },
      failover: {
        "github-copilot": ["openai-codex"],
      },
    }));
    await router.init();

    const chain = (router as unknown as { buildChain(modelSpec: string): string[] }).buildChain("github-copilot/claude-sonnet-4.6");

    expect(chain).toEqual([
      "github-copilot/claude-sonnet-4.6",
      "openai-codex/gpt-5.3-codex",
    ]);
    expect(chain).not.toContain("openai-codex/claude-sonnet-4.6");
  });

  it("does not treat arbitrary providerConfigs keys as provider-only failover names", async () => {
    const router = new ModelRouter(makeConfig({
      providers: {
        "not-a-real-provider": { apiKey: "x" },
      },
      failover: {
        "github-copilot/claude-sonnet-4.6": ["not-a-real-provider"],
      },
    }));
    await router.init();

    const chain = (router as unknown as { buildChain(modelSpec: string): string[] }).buildChain("github-copilot/claude-sonnet-4.6");

    expect(chain).not.toContain("not-a-real-provider/claude-sonnet-4.6");
  });

  it("returns metadata for the actual provider and model used", async () => {
    const router = new ModelRouter(makeConfig({
      failover: {
        "primary/model-a": ["fallback/model-b"],
      },
    }));
    await router.init();
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
    await router.init();
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
    await router.init();
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
    await router.init();
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
    await router.init();

    await expect(router.resolveApiKey("github-copilot", { accountRef: "github-copilot.main" })).resolves.toBe("account-key");
    await expect(router.resolveApiKey("github-copilot")).resolves.toBe("account-key");
  });

  it("F15: resolves OAuth credentials lazily without eager startup injection", async () => {
    const { mkdtemp, mkdir, rm } = await import("node:fs/promises");
    const { tmpdir: getTmp } = await import("node:os");
    const { join: joinPath } = await import("node:path");
    const { saveProfile } = await import("../auth/index.js");
    const projectRoot = await mkdtemp(joinPath(getTmp(), "saivage-f15-router-"));
    const saivageDir = joinPath(projectRoot, ".saivage");
    await mkdir(saivageDir, { recursive: true });
    const prevRoot = process.env["SAIVAGE_ROOT"];
    process.env["SAIVAGE_ROOT"] = saivageDir;
    try {
      await saveProfile("anthropic.main", {
        type: "oauth",
        provider: "anthropic",
        access: "lazy-access-token",
        refresh: "refresh",
        expires: Date.now() + 60_000,
      });
      const router = new ModelRouter(makeConfig());
      await router.init();
      // No eager injection step here; first resolveApiKey must still find the token.
      await expect(router.resolveApiKey("anthropic")).resolves.toBe("lazy-access-token");
    } finally {
      if (prevRoot === undefined) delete process.env["SAIVAGE_ROOT"];
      else process.env["SAIVAGE_ROOT"] = prevRoot;
      await rm(projectRoot, { recursive: true, force: true });
    }
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
    modelCapabilities: () => ({ contextWindow: 200_000, tokenEncoding: "cl100k_base" }),
    countTokens: (_m, msgs) => msgs.length * 100,
    isAvailable: async () => true,
    getRateLimitStatus: () => ({ remaining: null, resetAt: null, limited: false }),
  };
}

function successfulResponse(content: string) {
  return {
    content,
    toolCalls: [],
    finishReason: "end_turn" as const,
    usage: { inputTokens: 1, outputTokens: 1 },
  };
}
