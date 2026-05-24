import { describe, expect, it, vi } from "vitest";
import { AnthropicProvider } from "./anthropic.js";
import * as tc from "../runtime/token-counting.js";
import type { Message } from "./types.js";

describe("AnthropicProvider.countTokens", () => {
  const p = new AnthropicProvider("test-key");

  it("counts thinking blocks", () => {
    const a = p.countTokens("claude-3.5-sonnet", [
      { role: "assistant", content: [{ type: "thinking", thinking: "long reasoning trail" }] },
    ]);
    const b = p.countTokens("claude-3.5-sonnet", [
      { role: "assistant", content: [{ type: "text", text: "" }] },
    ]);
    expect(a).toBeGreaterThan(b);
  });

  it("counts image blocks at >=1568 tokens", () => {
    const a = p.countTokens("claude-3.5-sonnet", [
      { role: "user", content: [{ type: "image" }] },
    ]);
    const b = p.countTokens("claude-3.5-sonnet", [
      { role: "user", content: [{ type: "text", text: "" }] },
    ]);
    expect(a - b).toBeGreaterThanOrEqual(1568);
  });

  it("uses cl100k_base regardless of model", () => {
    const spy = vi.spyOn(tc, "countWithTiktoken").mockReturnValue(0);
    const msgs: Message[] = [{ role: "user", content: "hi" }];
    p.countTokens("claude-3.5-sonnet", msgs);
    p.countTokens("claude-4-opus", msgs);
    for (const call of spy.mock.calls) expect(call[3]).toBe("cl100k_base");
    spy.mockRestore();
  });
});
