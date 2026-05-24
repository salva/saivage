/**
 * Saivage \u2014 F29 regression tests for `PiAiProvider.resolveModel` /
 * `withProviderCompat` after removing fuzzy-prefix and synthesis paths.
 */

import { describe, it, expect } from "vitest";
import { PiAiProvider } from "./pi-ai.js";
import { UnknownModelError } from "./pi-ai-types.js";
import type { Model, Api } from "@mariozechner/pi-ai";
import type { ChatRequest } from "./types.js";

interface ResolveAccessor {
  resolveModel(id: string): Model<Api> | undefined;
}

describe("PiAiProvider.resolveModel", () => {
  it("returns the registry entry on exact id match", () => {
    const provider = new PiAiProvider("anthropic");
    const accessor = provider as unknown as ResolveAccessor;
    const result = accessor.resolveModel("claude-3-5-haiku-20241022");
    expect(result?.id).toBe("claude-3-5-haiku-20241022");
  });

  it("returns undefined for an unknown id (no synthesis)", () => {
    const provider = new PiAiProvider("anthropic");
    const accessor = provider as unknown as ResolveAccessor;
    expect(accessor.resolveModel("definitely-not-a-real-model-xyz")).toBeUndefined();
  });

  it("returns undefined for a typo'd id that used to be synthesised", () => {
    // Under the old code, "kimi-k2.99" would clone the closest sibling
    // (kimi-k2.5 / kimi-k2.6) and pretend it existed. That path is gone.
    const provider = new PiAiProvider("opencode");
    const accessor = provider as unknown as ResolveAccessor;
    expect(accessor.resolveModel("kimi-k2.99")).toBeUndefined();
    // Companion: also no fuzzy-prefix substitution.
    expect(accessor.resolveModel("claude-sonnet-4-typo-9")).toBeUndefined();
  });
});

describe("PiAiProvider.chat \u2014 unknown model surface", () => {
  it("throws UnknownModelError with kind/modelId and available IDs in message", async () => {
    const provider = new PiAiProvider("anthropic");
    const req: ChatRequest = {
      model: "no-such-model",
      system: "",
      messages: [{ role: "user", content: "hi" }],
    };
    let caught: unknown;
    try {
      await provider.chat(req);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(UnknownModelError);
    const err = caught as UnknownModelError;
    expect(err.kind).toBe("unknown_model");
    expect(err.modelId).toBe("no-such-model");
    // Message should advertise at least one real catalogue id.
    expect(err.message).toMatch(/claude-/);
  });
});

describe("PiAiProvider.withProviderCompat", () => {
  it("adds requiresReasoningContentOnAssistantMessages for opencode kimi-k2 (openai-completions api)", () => {
    const provider = new PiAiProvider("opencode");
    const accessor = provider as unknown as ResolveAccessor;
    const kimi = accessor.resolveModel("kimi-k2.5");
    expect(kimi).toBeDefined();
    expect(kimi?.api).toBe("openai-completions");
    const compat = (kimi as Model<"openai-completions">).compat;
    expect(compat?.requiresReasoningContentOnAssistantMessages).toBe(true);
  });

  it("leaves non-kimi opencode models untouched", () => {
    const provider = new PiAiProvider("opencode");
    const accessor = provider as unknown as ResolveAccessor;
    // Pick any non-kimi model from the opencode catalogue.
    const all = (provider as unknown as { listModels(): string[] }).listModels();
    const nonKimi = all.find((id) => !/kimi-k2/i.test(id));
    if (!nonKimi) return; // catalogue contains only kimi entries: skip
    const model = accessor.resolveModel(nonKimi);
    expect(model).toBeDefined();
    // No requiresReasoningContentOnAssistantMessages injection.
    const compat = model && (model as Model<"openai-completions">).compat;
    if (compat && "requiresReasoningContentOnAssistantMessages" in compat) {
      expect(compat.requiresReasoningContentOnAssistantMessages).not.toBe(true);
    }
  });
});

// ─── F07 — countTokens encoding selection ──────────────────────────────────
import { vi } from "vitest";
import * as tc from "../runtime/token-counting.js";

describe("PiAiProvider.countTokens encoding", () => {
  const msgs = [{ role: "user" as const, content: "hi" }];

  function expectEncoding(piProvider: string, model: string, expected: "cl100k_base" | "o200k_base") {
    const p = new PiAiProvider(piProvider);
    const spy = vi.spyOn(tc, "countWithTiktoken").mockReturnValue(0);
    p.countTokens(model, msgs);
    expect(spy.mock.calls[0]?.[3]).toBe(expected);
    spy.mockRestore();
  }

  it("openai gpt-5 → o200k_base", () => expectEncoding("openai", "gpt-5", "o200k_base"));
  it("openai gpt-4o → cl100k_base", () => expectEncoding("openai", "gpt-4o", "cl100k_base"));
  it("openai-codex gpt-5.3-codex → o200k_base", () => expectEncoding("openai-codex", "gpt-5.3-codex", "o200k_base"));
  it("openai-codex gpt-5.1-codex-mini → o200k_base", () => expectEncoding("openai-codex", "gpt-5.1-codex-mini", "o200k_base"));
  it("anthropic claude-haiku-4-5 → cl100k_base", () => expectEncoding("anthropic", "claude-haiku-4-5", "cl100k_base"));
  it("anthropic claude-opus-4-1 → cl100k_base", () => expectEncoding("anthropic", "claude-opus-4-1", "cl100k_base"));
  it("opencode claude-opus-4-5 → cl100k_base", () => expectEncoding("opencode", "claude-opus-4-5", "cl100k_base"));
  it("opencode-go kimi-k2.5 → cl100k_base", () => expectEncoding("opencode-go", "kimi-k2.5", "cl100k_base"));

  it("counts thinking and image blocks via the real path", () => {
    const p = new PiAiProvider("anthropic");
    const withThinking = p.countTokens("claude-3.5-sonnet", [
      { role: "assistant", content: [{ type: "thinking", thinking: "reasoning..." }] },
    ]);
    const withoutThinking = p.countTokens("claude-3.5-sonnet", [
      { role: "assistant", content: [{ type: "text", text: "" }] },
    ]);
    expect(withThinking).toBeGreaterThan(withoutThinking);

    const withImage = p.countTokens("claude-3.5-sonnet", [
      { role: "user", content: [{ type: "image" }] },
    ]);
    expect(withImage - withoutThinking).toBeGreaterThanOrEqual(1568);
  });
});
