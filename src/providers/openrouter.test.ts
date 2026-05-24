import { describe, expect, it, vi } from "vitest";
import { OpenRouterProvider } from "./openrouter.js";
import * as tc from "../runtime/token-counting.js";
import type { Message } from "./types.js";

describe("OpenRouterProvider.countTokens (inherited)", () => {
  const p = new OpenRouterProvider("test-key");
  const msgs: Message[] = [{ role: "user", content: "hi" }];

  it("anthropic and meta-llama vendor-prefixed strings select cl100k_base", () => {
    const spy = vi.spyOn(tc, "countWithTiktoken").mockReturnValue(0);
    p.countTokens("anthropic/claude-3.5-sonnet", msgs);
    p.countTokens("meta-llama/llama-3.1-70b", msgs);
    for (const call of spy.mock.calls) expect(call[3]).toBe("cl100k_base");
    spy.mockRestore();
  });

  it("openai/gpt-4o selects o200k_base", () => {
    const spy = vi.spyOn(tc, "countWithTiktoken").mockReturnValue(0);
    p.countTokens("openai/gpt-4o", msgs);
    for (const call of spy.mock.calls) expect(call[3]).toBe("o200k_base");
    spy.mockRestore();
  });

  it("vendor-prefixed openai gpt-5 selects o200k_base via own table", () => {
    const spy = vi.spyOn(tc, "countWithTiktoken").mockReturnValue(0);
    p.countTokens("openai/gpt-5-2025-09-01", msgs);
    for (const call of spy.mock.calls) expect(call[3]).toBe("o200k_base");
    spy.mockRestore();
  });

  it("unknown model strings fall back to cl100k_base (no entry in table)", () => {
    const spy = vi.spyOn(tc, "countWithTiktoken").mockReturnValue(0);
    p.countTokens("acme/unknown-model", msgs);
    for (const call of spy.mock.calls) expect(call[3]).toBe("cl100k_base");
    spy.mockRestore();
  });
});
