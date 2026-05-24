import { describe, expect, it } from "vitest";
import { countWithTiktoken } from "./token-counting.js";
import type { Message } from "../providers/types.js";

describe("countWithTiktoken", () => {
  it("counts thinking blocks", () => {
    const withThinking: Message[] = [
      { role: "assistant", content: [{ type: "thinking", thinking: "step by step reasoning here" }] },
    ];
    const without: Message[] = [
      { role: "assistant", content: [{ type: "text", text: "" }] },
    ];
    const a = countWithTiktoken(withThinking, undefined, undefined, "cl100k_base");
    const b = countWithTiktoken(without, undefined, undefined, "cl100k_base");
    expect(a).toBeGreaterThan(b);
    expect(a).toBe(countWithTiktoken(withThinking, undefined, undefined, "cl100k_base"));
  });

  it("image blocks add at least 1568 tokens", () => {
    const withImage: Message[] = [
      { role: "user", content: [{ type: "image" }] },
    ];
    const without: Message[] = [
      { role: "user", content: [{ type: "text", text: "" }] },
    ];
    const a = countWithTiktoken(withImage, undefined, undefined, "cl100k_base");
    const b = countWithTiktoken(without, undefined, undefined, "cl100k_base");
    expect(a - b).toBeGreaterThanOrEqual(1568);
  });

  it("returns positive numbers for non-empty text on both encodings", () => {
    const msgs: Message[] = [{ role: "user", content: "hello world" }];
    expect(countWithTiktoken(msgs, undefined, undefined, "cl100k_base")).toBeGreaterThan(0);
    expect(countWithTiktoken(msgs, undefined, undefined, "o200k_base")).toBeGreaterThan(0);
  });

  it("counts tool_use input JSON", () => {
    const msgs: Message[] = [
      { role: "assistant", content: [{ type: "tool_use", id: "x", name: "read", input: { path: "/long/path/to/file" } }] },
    ];
    const empty: Message[] = [
      { role: "assistant", content: [{ type: "tool_use", id: "x", name: "read", input: {} }] },
    ];
    expect(countWithTiktoken(msgs, undefined, undefined, "cl100k_base"))
      .toBeGreaterThan(countWithTiktoken(empty, undefined, undefined, "cl100k_base"));
  });

  it("counts system and tools", () => {
    const noSys = countWithTiktoken([], undefined, undefined, "cl100k_base");
    const withSys = countWithTiktoken([], "you are a helpful assistant", undefined, "cl100k_base");
    expect(withSys).toBeGreaterThan(noSys);
    const withTools = countWithTiktoken([], undefined, [{ name: "t", description: "d", inputSchema: {} }], "cl100k_base");
    expect(withTools).toBeGreaterThan(noSys);
  });
});
