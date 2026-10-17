import { describe, expect, it } from "vitest";
import { groupToolPairs, isToolGroup } from "./toolGrouping";
import type { ToolPair } from "./types";

function pair(toolName: string, id: string, args: unknown = {}, result: unknown = {}, status: ToolPair["status"] = "ok"): ToolPair {
  return {
    toolUseId: id,
    toolName,
    call: {
      role: "assistant",
      kind: "tool_call",
      content: JSON.stringify(args),
      timestamp: "2026-01-01T00:00:00.000Z",
      roundId: "r1",
      messageIndex: 0,
      blockIndex: 0,
      toolUseId: id,
      toolName,
    },
    result: {
      role: "assistant",
      kind: status === "error" ? "tool_error" : "tool_result",
      content: JSON.stringify({ content: result }),
      timestamp: "2026-01-01T00:00:01.000Z",
      roundId: "r1",
      messageIndex: 0,
      blockIndex: 1,
      toolUseId: id,
      toolName,
    },
    status,
  };
}

describe("groupToolPairs", () => {
  it("groups adjacent successful read-only context tools", () => {
    const grouped = groupToolPairs("r1", [
      pair("read", "read-1", { path: "a.ts" }, { content: "x", lines_read: 1 }),
      pair("grep", "grep-1", { pattern: "x" }, { matches: [] }),
    ]);

    expect(grouped).toHaveLength(1);
    expect(isToolGroup(grouped[0]!)).toBe(true);
    if (isToolGroup(grouped[0]!)) {
      expect(grouped[0].label).toBe("Gathered context");
      expect(grouped[0].pairs.map((p) => p.toolUseId)).toEqual(["read-1", "grep-1"]);
    }
  });

  it("does not group mutations, dispatches, shell commands, or errors", () => {
    const items = [
      pair("write", "write-1", { path: "a.ts", content: "x" }, { written: true }),
      pair("run_coder", "coder-1", { task: { id: "t1", objective: "x" }, stageId: "s1" }, { status: "completed" }),
      pair("run_command", "cmd-1", { command: "pwd" }, { exitCode: 0 }),
      pair("read", "read-err", { path: "missing" }, { error: "missing" }, "error"),
    ];

    expect(groupToolPairs("r1", items)).toHaveLength(items.length);
  });

  it("does not group webfetch calls that save files", () => {
    const grouped = groupToolPairs("r1", [
      pair("websearch", "search-1", { query: "data" }, { results: [] }),
      pair("webfetch", "fetch-1", { url: "https://example.test/file", save_as: "data/file.txt" }, { saved_path: "data/file.txt" }),
    ]);

    expect(grouped).toHaveLength(2);
    expect(grouped.some(isToolGroup)).toBe(false);
  });
});
