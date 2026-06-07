/**
 * Saivage - Tool-filter dispatch tests.
 */

import { describe, expect, it } from "vitest";
import { applyToolFilter } from "./tool-filters.js";

function t(name: string, service = "fs") {
  return { name, service };
}

describe("applyToolFilter - per-kind dispatch", () => {
  it("planner allows plan_get but excludes write", () => {
    expect(applyToolFilter("planner", t("plan_get", "plan"))).toBe(true);
    expect(applyToolFilter("planner", t("write"))).toBe(false);
  });

  it("worker allows write but excludes plan_get", () => {
    expect(applyToolFilter("worker", t("write"))).toBe(true);
    expect(applyToolFilter("worker", t("plan_get", "plan"))).toBe(false);
    expect(applyToolFilter("worker", t("task_write_report", "plan"))).toBe(true);
  });

  it("reviewer allows read and run_command but excludes write", () => {
    expect(applyToolFilter("reviewer", t("read"))).toBe(true);
    expect(applyToolFilter("reviewer", t("run_command", "shell"))).toBe(true);
    expect(applyToolFilter("reviewer", t("task_write_report", "plan"))).toBe(true);
    expect(applyToolFilter("reviewer", t("write"))).toBe(false);
  });

  it("inspector allows websearch/webfetch but excludes write", () => {
    expect(applyToolFilter("inspector", t("websearch", "web"))).toBe(true);
    expect(applyToolFilter("inspector", t("webfetch", "web"))).toBe(true);
    expect(applyToolFilter("inspector", t("write"))).toBe(false);
  });

  it("chat allows websearch/webfetch and read but excludes run_command", () => {
    expect(applyToolFilter("chat", t("websearch", "web"))).toBe(true);
    expect(applyToolFilter("chat", t("webfetch", "web"))).toBe(true);
    expect(applyToolFilter("chat", t("read"))).toBe(true);
    expect(applyToolFilter("chat", t("run_command", "shell"))).toBe(false);
  });

  it("chat allows create_note so it can relay user direction to the Planner", () => {
    expect(applyToolFilter("chat", t("create_note", "notes"))).toBe(true);
  });
});

describe("applyToolFilter - regression cases", () => {
  it("worker excludes plan_get", () => {
    expect(applyToolFilter("worker", t("plan_get", "plan"))).toBe(false);
  });

  it("planner excludes run_command", () => {
    expect(applyToolFilter("planner", t("run_command", "shell"))).toBe(false);
  });

  it("chat excludes run_command", () => {
    expect(applyToolFilter("chat", t("run_command", "shell"))).toBe(false);
  });

  it("chat allows read", () => {
    expect(applyToolFilter("chat", t("read"))).toBe(true);
  });

  it("inspector excludes write", () => {
    expect(applyToolFilter("inspector", t("write"))).toBe(false);
  });
});

describe("applyToolFilter - librarian allow-list", () => {
  const LIBRARIAN_ALLOWED = [
    "rag_list", "rag_stats", "rag_query",
    "rag_register", "rag_ingest", "rag_drop", "rag_admin",
    "read", "glob", "grep", "skill",
    "list_memories", "get_memory", "search_memories",
    "create_memory", "update_memory",
  ];

  for (const name of LIBRARIAN_ALLOWED) {
    it(`librarian allows ${name}`, () => {
      expect(applyToolFilter("librarian", t(name))).toBe(true);
    });
  }

  const LIBRARIAN_DENIED = [
    "create_note",
    "archive_memory",
    "delete_memory",
    "supersede_memory",
    "run_command",
    "run_coder",
    "run_manager",
    "run_inspector",
    "webfetch",
    "websearch",
    "write",
  ];

  for (const name of LIBRARIAN_DENIED) {
    it(`librarian excludes ${name}`, () => {
      expect(applyToolFilter("librarian", t(name))).toBe(false);
    });
  }
});
