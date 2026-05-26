import { afterEach, describe, expect, it, vi } from "vitest";
import { entriesToTimeline } from "./timeline";
import type { ConversationEntry } from "./types";

function entry(overrides: Partial<ConversationEntry> = {}): ConversationEntry {
  return {
    role: "assistant",
    kind: "text",
    content: "content",
    timestamp: "2026-05-01T00:00:00.000Z",
    roundId: "r1",
    messageIndex: 0,
    blockIndex: 0,
    ...overrides,
  };
}

describe("entriesToTimeline", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns an empty timeline for empty input", () => {
    expect(entriesToTimeline([], null)).toEqual([]);
  });

  it("builds a round item for assistant text", () => {
    const items = entriesToTimeline([entry({ content: "thinking" })], null);

    expect(items).toHaveLength(1);
    expect(items[0]?.kind).toBe("round");
    if (items[0]?.kind === "round") {
      expect(items[0].round.hasAssistant).toBe(true);
      expect(items[0].round.reasoning).toHaveLength(1);
    }
  });

  it("pairs matched tool calls and tool results", () => {
    const call = entry({
      kind: "tool_call",
      content: "call",
      toolUseId: "tool-1",
      toolName: "Read",
    });
    const result = entry({
      kind: "tool_result",
      content: "result",
      toolUseId: "tool-1",
      toolName: "Read",
      blockIndex: 1,
    });

    const items = entriesToTimeline([call, result], null);

    expect(items).toHaveLength(1);
    expect(items[0]?.kind).toBe("context");
    if (items[0]?.kind === "context") {
      const pair = items[0].context.toolPairs[0];
      expect(pair?.status).toBe("ok");
      expect(pair?.call).toBe(call);
      expect(pair?.result).toBe(result);
    }
  });

  it("marks an unreturned call in the pending round as pending", () => {
    const items = entriesToTimeline([
      entry({ roundId: "r1", kind: "tool_call", toolUseId: "old", toolName: "Read" }),
      entry({ roundId: "r2", kind: "tool_call", toolUseId: "current", toolName: "Write" }),
    ], "r2");

    const r1 = items.find((item) => item.id === "r1");
    const r2 = items.find((item) => item.id === "r2");
    expect(r1?.kind).toBe("context");
    expect(r2?.kind).toBe("context");
    if (r1?.kind === "context" && r2?.kind === "context") {
      expect(r1.context.toolPairs[0]?.status).toBe("missing");
      expect(r2.context.toolPairs[0]?.status).toBe("pending");
    }
  });

  it("keeps orphan tool results", () => {
    const result = entry({
      kind: "tool_result",
      content: "result",
      toolUseId: "tool-1",
      toolName: "Read",
    });

    const items = entriesToTimeline([result], null);

    expect(items[0]?.kind).toBe("context");
    if (items[0]?.kind === "context") {
      const pair = items[0].context.toolPairs[0];
      expect(pair?.status).toBe("orphan");
      expect(pair?.call).toBeUndefined();
      expect(pair?.result).toBe(result);
    }
  });

  it("marks tool errors as error", () => {
    const items = entriesToTimeline([
      entry({ kind: "tool_error", content: "failed", toolUseId: "tool-1", toolName: "Read" }),
    ], null);

    expect(items[0]?.kind).toBe("context");
    if (items[0]?.kind === "context") {
      expect(items[0].context.toolPairs[0]?.status).toBe("error");
    }

    const paired = entriesToTimeline([
      entry({ kind: "tool_call", content: "call", toolUseId: "tool-2", toolName: "Read" }),
      entry({ kind: "tool_error", content: "failed", toolUseId: "tool-2", toolName: "Read", blockIndex: 1 }),
    ], null);
    expect(paired[0]?.kind).toBe("context");
    if (paired[0]?.kind === "context") {
      expect(paired[0].context.toolPairs[0]?.status).toBe("error");
    }
  });

  it("drops tool entries missing toolUseId and warns once per dropped entry", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const items = entriesToTimeline([
      entry({ kind: "tool_call", content: "call", toolName: "Read" }),
    ], null);

    expect(warn).toHaveBeenCalledTimes(1);
    expect(items[0]?.kind).toBe("context");
    if (items[0]?.kind === "context") {
      expect(items[0].context.toolPairs).toEqual([]);
    }
  });

  it("renders a standalone diagnostic item for model issues", () => {
    const issue = entry({ kind: "model_issue", content: "bad model output" });
    const items = entriesToTimeline([issue], null);

    expect(items).toHaveLength(1);
    expect(items[0]?.kind).toBe("diagnostic");
    if (items[0]?.kind === "diagnostic") {
      expect(items[0].diagnostic).toBe(issue);
    }
  });

  it("sorts pre, round, and compacted buckets by round-id tier for equal timestamps", () => {
    const items = entriesToTimeline([
      entry({ roundId: "r2", role: "assistant", kind: "text", content: "round" }),
      entry({ roundId: "r-compacted-3", role: "assistant", kind: "text", content: "compact" }),
      entry({ roundId: "r-pre", role: "assistant", kind: "text", content: "pre" }),
    ], null);

    expect(items.map((item) => item.id)).toEqual(["r-pre", "r2", "r-compacted-3"]);
    expect(items.map((item) => item.kind)).toEqual(["compacted", "round", "compacted"]);
  });

  it("sorts r-pre before r1 when timestamps match", () => {
    const items = entriesToTimeline([
      entry({ roundId: "r1", content: "round" }),
      entry({ roundId: "r-pre", content: "pre" }),
    ], null);

    expect(items.map((item) => item.id)).toEqual(["r-pre", "r1"]);
  });

  it("drops buckets whose round id is malformed", () => {
    const items = entriesToTimeline([
      entry({ roundId: "r-compacted-3x", content: "x" }),
    ], null);

    expect(items).toEqual([]);
  });
});
