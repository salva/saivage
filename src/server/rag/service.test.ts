import { describe, it, expect } from "vitest";
import {
  RAG_TOOLS,
  requiresAdminRole,
  requiresControlMutex,
  isRuntimeOperatorContext,
} from "./service.js";
import type { ToolCallContext } from "../../mcp/toolContext.js";

describe("RagService scope predicates", () => {
  it("RAG_TOOLS lists exactly the seven canonical tools", () => {
    expect([...RAG_TOOLS]).toEqual([
      "rag_list",
      "rag_stats",
      "rag_query",
      "rag_register",
      "rag_ingest",
      "rag_drop",
      "rag_admin",
    ]);
  });

  it("requiresAdminRole covers admin-scope tools only", () => {
    expect(requiresAdminRole("rag_register")).toBe(true);
    expect(requiresAdminRole("rag_ingest")).toBe(true);
    expect(requiresAdminRole("rag_drop")).toBe(true);
    expect(requiresAdminRole("rag_admin")).toBe(true);
    for (const t of ["rag_list", "rag_stats", "rag_query"]) {
      expect(requiresAdminRole(t)).toBe(false);
    }
  });

  it("requiresControlMutex EXCLUDES rag_ingest (per-dataset lock handles it)", () => {
    expect(requiresControlMutex("rag_register")).toBe(true);
    expect(requiresControlMutex("rag_drop")).toBe(true);
    expect(requiresControlMutex("rag_admin")).toBe(true);
    expect(requiresControlMutex("rag_ingest")).toBe(false);
    expect(requiresControlMutex("rag_list")).toBe(false);
  });

  it("isRuntimeOperatorContext reads only the flag", () => {
    const base: ToolCallContext = { role: "planner", agentId: "x", projectRoot: "/p" };
    expect(isRuntimeOperatorContext(base)).toBe(false);
    expect(isRuntimeOperatorContext({ ...base, operatorContext: false })).toBe(false);
    expect(isRuntimeOperatorContext({ ...base, operatorContext: true })).toBe(true);
  });
});
