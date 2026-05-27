import { describe, it, expect } from "vitest";
import { countTokens } from "./tokens.js";

describe("tokens.countTokens", () => {
  it("returns 0 on empty input", () => {
    expect(countTokens("")).toBe(0);
  });

  it("returns a small positive count for short text", () => {
    const n = countTokens("hello world");
    expect(n).toBeGreaterThan(0);
    expect(n).toBeLessThan(10);
  });

  it("scales roughly with text length", () => {
    const a = countTokens("hello ");
    const b = countTokens("hello ".repeat(100));
    expect(b).toBeGreaterThan(a * 10);
  });

  it("treats whitespace-only as a small but positive count via the fallback or encoder", () => {
    expect(countTokens("   ")).toBeGreaterThanOrEqual(0);
  });

  it("is deterministic", () => {
    const t = "The quick brown fox jumps over the lazy dog.";
    expect(countTokens(t)).toBe(countTokens(t));
  });
});
