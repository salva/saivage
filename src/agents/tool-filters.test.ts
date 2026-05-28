/**
 * Saivage — Tool-filter dispatch tests.
 *
 * The `applyToolFilter` function is the single owner of the per-role tool
 * allowlist contract declared on the roster. These tests pin one positive
 * and one negative case per `ToolFilterKind`, plus the cross-role regression
 * cases the round-2 reviewer required.
 */

import { describe, it, expect } from "vitest";
import { applyToolFilter } from "./tool-filters.js";

function t(name: string, service = "fs") {
  return { name, service };
}

describe("applyToolFilter — per-kind dispatch", () => {
  it("planner allows plan_get but excludes write_file", () => {
    expect(applyToolFilter("planner", t("plan_get", "plan"))).toBe(true);
    expect(applyToolFilter("planner", t("write_file"))).toBe(false);
  });

  it("worker allows write_file but excludes plan_get", () => {
    expect(applyToolFilter("worker", t("write_file"))).toBe(true);
    expect(applyToolFilter("worker", t("plan_get", "plan"))).toBe(false);
  });

  it("reviewer allows read_file and run_command but excludes write_file", () => {
    expect(applyToolFilter("reviewer", t("read_file"))).toBe(true);
    expect(applyToolFilter("reviewer", t("run_command", "shell"))).toBe(true);
    expect(applyToolFilter("reviewer", t("write_file"))).toBe(false);
  });

  it("inspector allows web_search but excludes write_file", () => {
    expect(applyToolFilter("inspector", t("web_search", "web"))).toBe(true);
    expect(applyToolFilter("inspector", t("write_file"))).toBe(false);
  });

  it("chat allows web_search and read_file but excludes run_command", () => {
    expect(applyToolFilter("chat", t("web_search", "web"))).toBe(true);
    expect(applyToolFilter("chat", t("read_file"))).toBe(true);
    expect(applyToolFilter("chat", t("run_command", "shell"))).toBe(false);
  });

  it("chat allows create_note so it can relay user direction to the Planner", () => {
    expect(applyToolFilter("chat", t("create_note", "notes"))).toBe(true);
  });
});

describe("applyToolFilter — regression cases", () => {
  it("worker excludes plan_get", () => {
    expect(applyToolFilter("worker", t("plan_get", "plan"))).toBe(false);
  });

  it("planner excludes run_command", () => {
    expect(applyToolFilter("planner", t("run_command", "shell"))).toBe(false);
  });

  it("chat excludes run_command", () => {
    expect(applyToolFilter("chat", t("run_command", "shell"))).toBe(false);
  });

  it("chat allows read_file", () => {
    expect(applyToolFilter("chat", t("read_file"))).toBe(true);
  });

  it("inspector excludes write_file", () => {
    expect(applyToolFilter("inspector", t("write_file"))).toBe(false);
  });
});

describe("applyToolFilter — read_stash is allowed for every kind", () => {
  it("planner allows read_stash", () => {
    expect(applyToolFilter("planner", t("read_stash", "stash"))).toBe(true);
  });
  it("worker allows read_stash", () => {
    expect(applyToolFilter("worker", t("read_stash", "stash"))).toBe(true);
  });
  it("reviewer allows read_stash", () => {
    expect(applyToolFilter("reviewer", t("read_stash", "stash"))).toBe(true);
  });
  it("inspector allows read_stash", () => {
    expect(applyToolFilter("inspector", t("read_stash", "stash"))).toBe(true);
  });
  it("chat allows read_stash", () => {
    expect(applyToolFilter("chat", t("read_stash", "stash"))).toBe(true);
  });
  it("librarian allows read_stash", () => {
    expect(applyToolFilter("librarian", t("read_stash", "stash"))).toBe(true);
  });
});

describe("applyToolFilter — librarian allow-list", () => {
  const LIBRARIAN_ALLOWED = [
    "rag_list", "rag_stats", "rag_query",
    "rag_register", "rag_ingest", "rag_drop", "rag_admin",
    "read_file", "list_dir", "search_files",
    "list_skills", "read_skill", "search_skills",
    "list_memories", "get_memory", "search_memories",
    "create_memory", "update_memory",
    "read_stash",
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
    "create_skill",
    "archive_skill",
    "delete_skill",
    "run_command",
    "run_coder",
    "run_manager",
    "run_inspector",
    "web_search",
    "write_file",
  ];

  for (const name of LIBRARIAN_DENIED) {
    it(`librarian excludes ${name}`, () => {
      expect(applyToolFilter("librarian", t(name))).toBe(false);
    });
  }
});
