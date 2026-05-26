import { describe, it, expect, vi } from "vitest";
import { ModelRouter } from "./router.js";
import { OpenAIProvider } from "./openai.js";
import { OllamaProvider } from "./ollama.js";
import { LlamaCppProvider } from "./llamacpp.js";
import { PiAiProvider } from "./pi-ai.js";
import * as tokenCounting from "../runtime/token-counting.js";
import type { ChatRequest, ModelProvider, Message } from "./types.js";
import type { SaivageConfig } from "../config.js";

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

const msgs: Message[] = [{ role: "user", content: "hi" }];

describe("ModelCapabilities — per-provider direct-class tables", () => {
  it("OpenAIProvider table", async () => {
    const p = new OpenAIProvider("k");
    expect(p.modelCapabilities("gpt-5")).toEqual({ contextWindow: 400_000, tokenEncoding: "o200k_base" });
    expect(p.modelCapabilities("o3-mini")).toEqual({ contextWindow: 200_000, tokenEncoding: "o200k_base" });
    expect(p.modelCapabilities("gpt-4o-mini")).toEqual({ contextWindow: 128_000, tokenEncoding: "o200k_base" });
    expect(p.modelCapabilities("gpt-4")).toEqual({ contextWindow: 128_000, tokenEncoding: "cl100k_base" });
    expect(p.modelCapabilities("gpt-3.5-turbo")).toEqual({ contextWindow: 16_385, tokenEncoding: "cl100k_base" });
    expect(p.modelCapabilities("unknown")).toBeUndefined();
  });

  it("OllamaProvider — defaultContextWindow injection", async () => {
    const sized = new OllamaProvider(undefined, 32_768);
    expect(sized.modelCapabilities("unknown-local-weight")).toEqual({
      contextWindow: 32_768,
      tokenEncoding: "cl100k_base",
    });
    const unsized = new OllamaProvider(undefined);
    expect(unsized.modelCapabilities("unknown-local-weight")).toBeUndefined();
  });

  it("LlamaCppProvider — defaultContextWindow injection", async () => {
    const sized = new LlamaCppProvider(undefined, 16_384);
    expect(sized.modelCapabilities("unknown")).toEqual({
      contextWindow: 16_384,
      tokenEncoding: "cl100k_base",
    });
    const unsized = new LlamaCppProvider(undefined);
    expect(unsized.modelCapabilities("unknown")).toBeUndefined();
  });
});

describe("PiAiProvider — live-registry modelCapabilities", () => {
  function expectEncoding(piProvider: string, model: string, expected: "cl100k_base" | "o200k_base") {
    const p = new PiAiProvider(piProvider as never);
    const spy = vi.spyOn(tokenCounting, "countWithTiktoken").mockReturnValue(0);
    p.countTokens(model, msgs);
    for (const call of spy.mock.calls) expect(call[3]).toBe(expected);
    spy.mockRestore();
  }

  it("openai gpt-5 → o200k_base, gpt-4o → cl100k via openai-registry token encoding mapping", async () => {
    // PiAi openai branch maps gpt-5|o1|o3|o4 to o200k, everything else to cl100k.
    expectEncoding("openai", "gpt-5", "o200k_base");
    expectEncoding("openai", "gpt-4o", "cl100k_base");
  });

  it("openai-codex registry models pick correct encoding", async () => {
    expectEncoding("openai-codex", "gpt-5.3-codex", "o200k_base");
    expectEncoding("openai-codex", "gpt-5.1-codex-mini", "o200k_base");
  });

  it("anthropic / opencode / opencode-go always cl100k_base", async () => {
    expectEncoding("anthropic", "claude-haiku-4-5", "cl100k_base");
    expectEncoding("opencode", "claude-opus-4-5", "cl100k_base");
    expectEncoding("opencode-go", "kimi-k2.5", "cl100k_base");
  });

  it("modelCapabilities returns contextWindow from pi-ai registry for known models", async () => {
    const p = new PiAiProvider("openai");
    const caps = p.modelCapabilities("gpt-5");
    expect(caps).toBeDefined();
    expect(caps?.contextWindow).toBeGreaterThan(0);
    expect(caps?.tokenEncoding).toBe("o200k_base");
  });

  it("modelCapabilities returns undefined for models not in the registry", async () => {
    const p = new PiAiProvider("openai");
    expect(p.modelCapabilities("totally-unknown-model")).toBeUndefined();
  });
});

describe("ModelRouter.getMaxContextTokens — throws on missing caps", () => {
  function makeProvider(name: string, caps: ((m: string) => unknown) | undefined): ModelProvider {
    return {
      name,
      modelCapabilities: caps ?? (() => undefined),
      countTokens: () => 0,
      isAvailable: async () => true,
      chat: vi.fn() as unknown as (req: ChatRequest) => Promise<ReturnType<ModelProvider["chat"]>>,
    } as unknown as ModelProvider;
  }

  it("throws with a helpful message referencing MODEL_CAPABILITIES and defaultContextWindow", async () => {
    const router = new ModelRouter(makeConfig({
      providers: {
        myprov: { priority: 10, models: ["unknown-model"] },
      },
    }));
    await router.init();
    const providers = (router as unknown as { providers: Map<string, ModelProvider> }).providers;
    providers.clear();
    providers.set("myprov", makeProvider("myprov", undefined));

    expect(() => router.getMaxContextTokens("myprov/unknown-model")).toThrow(
      /unknown-model[\s\S]*MODEL_CAPABILITIES[\s\S]*defaultContextWindow/,
    );
  });

  it("router.countTokens falls back to cl100k_base when caps are missing (no throw)", async () => {
    const router = new ModelRouter(makeConfig({
      providers: {
        myprov: { priority: 10, models: ["unknown-model"] },
      },
    }));
    await router.init();
    const providers = (router as unknown as { providers: Map<string, ModelProvider> }).providers;
    providers.clear();
    const provider = {
      name: "myprov",
      modelCapabilities: () => undefined,
      countTokens: (_m: string, msgs2: Message[], system?: string, tools?: unknown) => {
        // Mirror BaseProvider.countTokens fallback path.
        return tokenCounting.countWithTiktoken(msgs2, system, tools as never, "cl100k_base");
      },
      isAvailable: async () => true,
      chat: vi.fn(),
    } as unknown as ModelProvider;
    providers.set("myprov", provider);

    const spy = vi.spyOn(tokenCounting, "countWithTiktoken").mockReturnValue(0);
    expect(() => router.countTokens("myprov/unknown-model", msgs)).not.toThrow();
    for (const call of spy.mock.calls) expect(call[3]).toBe("cl100k_base");
    spy.mockRestore();
  });
});

describe("ModelRouter — defaultContextWindow propagation for ollama / llamacpp", () => {
  it("ollama defaultContextWindow surfaces through router.getMaxContextTokens", async () => {
    const router = new ModelRouter(makeConfig({
      providers: {
        ollama: { priority: 10, models: ["unknown-local-weight"], defaultContextWindow: 32_768 },
      },
    }));
    await router.init();
    expect(router.getMaxContextTokens("ollama/unknown-local-weight")).toBe(32_768);
  });

  it("llamacpp defaultContextWindow surfaces through router.getMaxContextTokens", async () => {
    const router = new ModelRouter(makeConfig({
      providers: {
        llamacpp: { priority: 10, models: ["unknown"], defaultContextWindow: 16_384 },
      },
    }));
    await router.init();
    expect(router.getMaxContextTokens("llamacpp/unknown")).toBe(16_384);
  });
});
