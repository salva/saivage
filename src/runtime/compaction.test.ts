import { describe, expect, it, vi } from "vitest";
import {
  compactConversation,
  flatten,
  isMaxCompactionsReached,
  parseRounds,
  selectKeptRounds,
  shouldCompact,
  type CompactionConfig,
  type CompactionState,
  type Round,
} from "./compaction.js";
import { countWithTiktoken } from "./token-counting.js";
import type { Message, ToolSchema } from "../providers/types.js";
import type { ModelRouter } from "../providers/router.js";

const baseConfig: CompactionConfig = {
  contextWindow: 100_000,
  thresholdPct: 80,
  maxCompactions: 3,
  maxConsecutiveFallbacks: 3,
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
    const longThinking = "step ".repeat(200_000);
    const msgs: Message[] = [
      { role: "assistant", content: [{ type: "thinking", thinking: longThinking }] },
    ];
    const tokens = countWithTiktoken(msgs, undefined, undefined, "cl100k_base");
    expect(tokens).toBeGreaterThan(80_000);
    expect(shouldCompact(tokens, baseConfig)).toBe(true);
  });
});

describe("parseRounds", () => {
  it("classifies text-only conversations as text rounds", () => {
    expect(kinds(parseRounds([
      { role: "user", content: "hello" },
      { role: "assistant", content: [{ type: "text", text: "hi" }] },
    ]))).toEqual(["text", "text"]);
  });

  it("keeps a complete adjacent tool round atomic", () => {
    const rounds = parseRounds([toolUse("tu-1"), toolResult("tu-1")]);
    expect(kinds(rounds)).toEqual(["tool"]);
    expect(rounds[0].kind === "tool" && [...rounds[0].toolIds]).toEqual(["tu-1"]);
  });

  it("marks assistant tool_use without a matching next result as dangling", () => {
    expect(kinds(parseRounds([toolUse("tu-1"), { role: "user", content: "plain" }]))).toEqual([
      "dangling",
      "text",
    ]);
  });

  it("marks lone tool_result users as dangling", () => {
    expect(kinds(parseRounds([toolResult("tu-1")]))).toEqual(["dangling"]);
  });

  it("treats partial matches as two dangling halves", () => {
    const rounds = parseRounds([
      toolUse("tu-1", "tu-2"),
      toolResult("tu-1"),
    ]);
    expect(kinds(rounds)).toEqual(["dangling", "dangling"]);
  });

  it("tolerates duplicate tool_use ids via set equality", () => {
    const rounds = parseRounds([
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "tu-1", name: "a", input: {} },
          { type: "tool_use", id: "tu-1", name: "a", input: {} },
        ],
      },
      toolResult("tu-1"),
    ]);
    expect(kinds(rounds)).toEqual(["tool"]);
  });
});

describe("selectKeptRounds", () => {
  it("keeps the newest complete rounds that fit the projected request budget", () => {
    const rounds = parseRounds([
      text("old ".repeat(120)),
      text("middle ".repeat(40)),
      text("new ".repeat(20)),
    ]);
    const kept = selectKeptRounds(rounds, selectOpts({ contextWindow: 2_000 }));
    expect(flatten(kept.kept).map((m) => m.content)).toEqual([
      "middle ".repeat(40),
      "new ".repeat(20),
    ]);
    expect(kept.oversizedAtomic).toBe(false);
  });

  it("force-keeps an oversized atomic tail round and reports it", () => {
    const rounds = parseRounds([text("huge ".repeat(500))]);
    const kept = selectKeptRounds(rounds, selectOpts({ contextWindow: 1_400 }));
    expect(flatten(kept.kept)).toHaveLength(1);
    expect(kept.oversizedAtomic).toBe(true);
  });

  it("drops dangling-only input", () => {
    const kept = selectKeptRounds(parseRounds([toolResult("tu-1")]), selectOpts());
    expect(kept).toEqual({ kept: [], oversizedAtomic: false });
  });

  it("includes system prompt and tool schemas in projected token cost", () => {
    const rounds = parseRounds([
      text("one ".repeat(20)),
      text("two ".repeat(20)),
      text("three ".repeat(20)),
    ]);
    const withoutTools = selectKeptRounds(rounds, selectOpts({ contextWindow: 3_000 })).kept.length;
    const tools: ToolSchema[] = [
      { name: "large", description: "x".repeat(2_000), inputSchema: { type: "object" } },
    ];
    const withTools = selectKeptRounds(rounds, selectOpts({ contextWindow: 3_000, tools })).kept.length;
    expect(withTools).toBeLessThan(withoutTools);
  });
});

describe("compactConversation fallback", () => {
  it("falls back to pair-valid round truncation without incrementing compactionCount", async () => {
    const onFallback = vi.fn();
    const state = makeState();
    const router = makeRouter({
      chat: async () => {
        throw new Error("summarizer down");
      },
      countTokens: () => 10,
    });

    const result = await compactConversation(
      "system",
      [{ role: "user", content: "old" }, toolUse("tu-1"), toolResult("tu-1")],
      router,
      { ...baseConfig, onFallback },
      state,
      "test/model",
      undefined,
    );

    assertNoOrphans(result);
    expect(state.compactionCount).toBe(0);
    expect(state.summarizerFallbacks).toBe(1);
    expect(state.consecutiveFallbacks).toBe(1);
    expect(onFallback).toHaveBeenCalledWith(
      expect.objectContaining({ keptRounds: 2, oversizedAtomic: false }),
    );
  });

  it("caps repeated fallback attempts independently of successful compaction count", async () => {
    const state = makeState();
    const router = makeRouter({
      chat: async () => {
        throw new Error("summarizer down");
      },
      countTokens: () => 10_000,
    });
    const config = { ...baseConfig, contextWindow: 1_400 };

    for (let i = 0; i < 3; i++) {
      await compactConversation("system", [text(`round ${i}`)], router, config, state, "test/model", undefined);
    }

    expect(state.compactionCount).toBe(0);
    expect(state.consecutiveFallbacks).toBe(3);
    expect(isMaxCompactionsReached(state, config)).toBe(true);
  });

  it("flags an oversized atomic tool round as terminal", async () => {
    const state = makeState();
    const router = makeRouter({
      chat: async () => {
        throw new Error("summarizer down");
      },
      countTokens: () => 10_000,
    });
    const config = { ...baseConfig, contextWindow: 1_400 };

    await compactConversation(
      "system",
      [toolUse("tu-1"), toolResult("tu-1")],
      router,
      config,
      state,
      "test/model",
      undefined,
    );

    expect(state.oversizedAtomicFallback).toBe(true);
    expect(isMaxCompactionsReached(state, config)).toBe(true);
  });
});

function text(content: string): Message {
  return { role: "user", content };
}

function toolUse(...ids: string[]): Message {
  return {
    role: "assistant",
    content: ids.map((id) => ({ type: "tool_use", id, name: "tool", input: {} })),
  };
}

function toolResult(...ids: string[]): Message {
  return {
    role: "user",
    content: ids.map((id) => ({ type: "tool_result", tool_use_id: id, content: `result ${id}` })),
  };
}

function kinds(rounds: Round[]): Array<Round["kind"]> {
  return rounds.map((round) => round.kind);
}

function makeState(): CompactionState {
  return {
    compactionCount: 0,
    summarizerFallbacks: 0,
    consecutiveFallbacks: 0,
    oversizedAtomicFallback: false,
  };
}

function selectOpts(opts: {
  contextWindow?: number;
  tools?: ToolSchema[];
} = {}) {
  return {
    config: { ...baseConfig, contextWindow: opts.contextWindow ?? 2_000 },
    router: makeRouter({ countTokens: roughCountTokens }),
    modelSpec: "test/model",
    systemPrompt: "sys ".repeat(10),
    tools: opts.tools,
  };
}

function makeRouter(opts: {
  chat?: ModelRouter["chat"];
  countTokens?: ModelRouter["countTokens"];
}): ModelRouter {
  return {
    chat: opts.chat ?? (async () => ({
      content: "summary",
      toolCalls: [],
      finishReason: "end_turn",
      usage: { inputTokens: 0, outputTokens: 0 },
    })),
    countTokens: opts.countTokens ?? roughCountTokens,
    getMaxContextTokens: () => 100_000,
    resetModelHealth: () => undefined,
    init: async () => undefined,
    inspectUsageAtStartup: async () => undefined,
    listProviders: () => [],
  } as unknown as ModelRouter;
}

function roughCountTokens(
  _modelSpec: string,
  messages: Message[],
  system?: string,
  tools?: ToolSchema[],
): number {
  const messageCost = JSON.stringify(messages).length;
  const systemCost = system?.length ?? 0;
  const toolCost = tools ? JSON.stringify(tools).length : 0;
  return messageCost + systemCost + toolCost;
}

function assertNoOrphans(messages: Message[]): void {
  const seen = new Set<string>();
  for (const message of messages) {
    if (!Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (block.type === "tool_use" && block.id) seen.add(block.id);
      if (block.type === "tool_result") {
        expect(seen.has(block.tool_use_id ?? "")).toBe(true);
      }
    }
  }
}
