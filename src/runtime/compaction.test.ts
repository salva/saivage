import { describe, expect, it } from "vitest";
import { shouldCompact, type CompactionConfig } from "./compaction.js";
import { countWithTiktoken } from "./token-counting.js";
import type { Message } from "../providers/types.js";

const baseConfig: CompactionConfig = {
  contextWindow: 100_000,
  thresholdPct: 80,
  maxCompactions: 3,
  summaryModelSpec: "test/model",
};

describe("shouldCompact", () => {
  it("returns false below threshold", () => {
    expect(shouldCompact(0, baseConfig)).toBe(false);
    expect(shouldCompact(50_000, baseConfig)).toBe(false);
    expect(shouldCompact(80_000, baseConfig)).toBe(false);
  });

  it("returns true once running tokens cross the threshold", () => {
    expect(shouldCompact(80_001, baseConfig)).toBe(true);
    expect(shouldCompact(99_999, baseConfig)).toBe(true);
  });

  it("thinking-block conversations trigger under accurate counting", () => {
    // A large thinking transcript: with the legacy chars/4 estimator this
    // would still cross the threshold, but the new accurate counter is what
    // we now compare against. The regression check is that thinking text
    // *contributes* to the count at all (legacy estimator dropped it).
    const longThinking = "step ".repeat(200_000); // very long thinking transcript
    const msgs: Message[] = [
      { role: "assistant", content: [{ type: "thinking", thinking: longThinking }] },
    ];
    const tokens = countWithTiktoken(msgs, undefined, undefined, "cl100k_base");
    expect(tokens).toBeGreaterThan(80_000);
    expect(shouldCompact(tokens, baseConfig)).toBe(true);
  });
});
