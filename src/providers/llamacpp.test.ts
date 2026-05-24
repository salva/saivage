import { describe, expect, it, vi } from "vitest";
import { LlamaCppProvider } from "./llamacpp.js";
import * as tc from "../runtime/token-counting.js";
import type { Message } from "./types.js";

describe("LlamaCppProvider.countTokens", () => {
  it("pins cl100k_base even for gpt-5-* model names", () => {
    const p = new LlamaCppProvider("http://localhost:8080");
    const spy = vi.spyOn(tc, "countWithTiktoken").mockReturnValue(0);
    const msgs: Message[] = [{ role: "user", content: "hi" }];
    p.countTokens("gpt-5-foo", msgs);
    p.countTokens("mistral-7b", msgs);
    for (const call of spy.mock.calls) expect(call[3]).toBe("cl100k_base");
    spy.mockRestore();
  });
});
