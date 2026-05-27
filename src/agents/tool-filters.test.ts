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
