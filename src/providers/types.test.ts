import { describe, it, expect } from "vitest";
import { parseModelId } from "./types.js";

describe("parseModelId", () => {
  it("parses provider/model", () => {
    const result = parseModelId("anthropic/claude-sonnet-4-20250514");
    expect(result.provider).toBe("anthropic");
    expect(result.model).toBe("claude-sonnet-4-20250514");
  });

  it("handles nested model IDs", () => {
    const result = parseModelId("ollama/library/llama3.3:70b");
    expect(result.provider).toBe("ollama");
    expect(result.model).toBe("library/llama3.3:70b");
  });

  it("throws on missing slash", () => {
    expect(() => parseModelId("justmodel")).toThrow("Invalid model spec");
  });
});
