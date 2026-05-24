import { describe, expect, it, vi } from "vitest";
import { OpenAIProvider } from "./openai.js";
import * as tc from "../runtime/token-counting.js";
import type { Message } from "./types.js";

describe("OpenAIProvider.countTokens", () => {
  const p = new OpenAIProvider("test-key");
  const msgs: Message[] = [{ role: "user", content: "hi" }];

  it("selects o200k_base for new-gen models", () => {
    const spy = vi.spyOn(tc, "countWithTiktoken").mockReturnValue(0);
    p.countTokens("gpt-5-foo", msgs);
    p.countTokens("o1-preview", msgs);
    p.countTokens("o3-mini", msgs);
    p.countTokens("o4-something", msgs);
    for (const call of spy.mock.calls) expect(call[3]).toBe("o200k_base");
    spy.mockRestore();
  });

  it("selects o200k_base for gpt-4o family", () => {
    const spy = vi.spyOn(tc, "countWithTiktoken").mockReturnValue(0);
    p.countTokens("gpt-4o", msgs);
    p.countTokens("gpt-4o-mini", msgs);
    for (const call of spy.mock.calls) expect(call[3]).toBe("o200k_base");
    spy.mockRestore();
  });

  it("selects cl100k_base for legacy gpt-4 / gpt-3.5; falls back to cl100k for unknown", () => {
    const spy = vi.spyOn(tc, "countWithTiktoken").mockReturnValue(0);
    p.countTokens("gpt-4", msgs);
    p.countTokens("gpt-3.5-turbo", msgs);
    p.countTokens("acme/llama-3", msgs);
    for (const call of spy.mock.calls) expect(call[3]).toBe("cl100k_base");
    spy.mockRestore();
  });
});
