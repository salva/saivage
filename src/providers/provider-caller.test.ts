import { describe, expect, it, vi } from "vitest";
import { ProviderError } from "./error.js";
import { ProviderCaller } from "./provider-caller.js";
import type { ChatResponse, ModelProvider } from "./types.js";

const response: ChatResponse = {
  content: "ok",
  toolCalls: [],
  finishReason: "end_turn",
  usage: { inputTokens: 1, outputTokens: 2 },
};

function makeProvider(chat: ModelProvider["chat"]): ModelProvider {
  return {
    name: "primary",
    chat,
    supportsTools: () => true,
    supportsImages: () => false,
    supportsStreaming: () => false,
    modelCapabilities: () => undefined,
    countTokens: () => 0,
    isAvailable: async () => true,
    getRateLimitStatus: () => ({ limited: false, remaining: null, resetAt: null }),
  };
}

describe("ProviderCaller", () => {
  it("adds provider/model metadata and records usage metrics on success", async () => {
    const recordMetrics = vi.fn();
    const caller = new ProviderCaller(1_000, recordMetrics);
    const provider = makeProvider(vi.fn(async () => response));

    const result = await caller.call("primary/model-a", provider, "model-a", {
      model: "ignored",
      modelSpec: "primary/model-a",
      system: "",
      messages: [],
    });

    expect(result).toMatchObject({
      ok: true,
      response: {
        provider: "primary",
        model: "model-a",
        modelSpec: "primary/model-a",
        requestedModelSpec: "primary/model-a",
      },
    });
    expect(recordMetrics).toHaveBeenCalledWith("primary/model-a", expect.objectContaining({
      inputTokens: 1,
      outputTokens: 2,
    }));
  });

  it("returns nonRetryable for classified non-retryable provider errors", async () => {
    const caller = new ProviderCaller(1_000, vi.fn());
    const provider = makeProvider(vi.fn(async () => {
      throw new ProviderError({ kind: "non_retryable", message: "bad request" });
    }));

    const result = await caller.call("primary/model-a", provider, "model-a", {
      model: "ignored",
      modelSpec: "primary/model-a",
      system: "",
      messages: [],
    });

    expect(result).toMatchObject({ ok: false, nonRetryable: true });
  });
});
