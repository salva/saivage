import { describe, expect, it } from "vitest";
import { buildToolDetail, buildToolDisplay, CURRENT_TOOL_NAMES } from "./toolDisplay";
import type { ToolPair } from "../components/agents/types";

function pair(toolName: string, args: unknown = {}, result: unknown = { ok: true }, status: ToolPair["status"] = "ok"): ToolPair {
  return {
    toolUseId: `${toolName}-1`,
    toolName,
    call: {
      role: "assistant",
      kind: "tool_call",
      content: typeof args === "string" ? args : JSON.stringify(args),
      timestamp: "2026-01-01T00:00:00.000Z",
      roundId: "r1",
      messageIndex: 0,
      blockIndex: 0,
      toolUseId: `${toolName}-1`,
      toolName,
    },
    result: {
      role: "assistant",
      kind: status === "error" ? "tool_error" : "tool_result",
      content: typeof result === "string" ? result : JSON.stringify({ content: result }),
      timestamp: "2026-01-01T00:00:01.000Z",
      roundId: "r1",
      messageIndex: 0,
      blockIndex: 1,
      toolUseId: `${toolName}-1`,
      toolName,
    },
    status,
  };
}

describe("toolDisplay", () => {
  it("has explicit display coverage for every current canonical tool", () => {
    for (const toolName of CURRENT_TOOL_NAMES) {
      const display = buildToolDisplay(pair(toolName));
      expect(display.category, toolName).not.toBe("external");
      expect(display.category, toolName).not.toBe("unknown");
      expect(display.action, toolName).not.toBe("Tool");
    }
  });

  it("uses a generic external renderer for future MCP tools", () => {
    const display = buildToolDisplay(pair("external-files_read", { path: "a.txt" }, { content: "x" }));
    expect(display.category).toBe("external");
    expect(display.action).toBe("External");
    expect(display.target).toEqual([{ kind: "code", value: "external-files_read" }]);
  });

  it("does not throw for malformed request or response payloads", () => {
    const malformed = pair("read", "{bad json", "not json");
    expect(() => buildToolDisplay(malformed)).not.toThrow();
    expect(() => buildToolDetail(malformed)).not.toThrow();
    const detail = buildToolDetail(malformed);
    expect(detail.facts.some((fact) => fact.label === "Warning")).toBe(true);
  });

  it("marks mutations as non-groupable", () => {
    expect(buildToolDisplay(pair("write", { path: "a.ts", content: "x" })).mutation).toBe(true);
    expect(buildToolDisplay(pair("write", { path: "a.ts", content: "x" })).groupable).toBe(false);
    expect(buildToolDisplay(pair("git_commit", { files: ["a.ts"], message: "m" }, { sha: "abcdef123" })).mutation).toBe(true);
  });
});
