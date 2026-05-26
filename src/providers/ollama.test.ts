import { describe, expect, it, vi } from "vitest";
import { OllamaProvider } from "./ollama.js";
import * as tc from "../runtime/token-counting.js";
import type { Message } from "./types.js";

describe("OllamaProvider.countTokens", () => {
  it("pins cl100k_base even for gpt-5-* model names", () => {
    const p = new OllamaProvider("http://localhost:11434/v1");
    const spy = vi.spyOn(tc, "countWithTiktoken").mockReturnValue(0);
    const msgs: Message[] = [{ role: "user", content: "hi" }];
    p.countTokens("gpt-5-foo", msgs);
    p.countTokens("llama-3.1-70b", msgs);
    for (const call of spy.mock.calls) expect(call[3]).toBe("cl100k_base");
    spy.mockRestore();
  });
});
