/**
 * Saivage — Roster tests.
 *
 * Verifies the roster is the single source of truth: derived enums, dispatch
 * maps, abort priorities, self-check frequencies, prompt rendering, and SPEC
 * parity all stay aligned with `ROSTER`.
 */

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import {
  ROSTER,
  ALL_ROLES,
  WORKER_ROLES,
  DISPATCHABLE_ROLES,
  getRoster,
  getRosterByDispatchTool,
  getAbortPriority,
  getToolFilter,
  getDispatchToolsFor,
  isConcurrencyLimitedDispatch,
  renderRosterSummary,
  getWorkerInitMeta,
  type AgentRole,
  type DispatchableRole,
} from "./roster.js";
import { DISPATCH_ROLE_MAP, DISPATCH_TOOLS } from "../runtime/dispatcher.js";
import { DEFAULT_SELF_CHECK_FREQUENCY } from "../runtime/self-check.js";
import { getConvention } from "./conventions.js";
import { hasWorkerCtor } from "./worker.js";

describe("ROSTER — declarative source of truth", () => {
  it("contains one entry per known role with no duplicates", () => {
    const roles = ROSTER.map((entry) => entry.role);
    expect(new Set(roles).size).toBe(roles.length);
    expect(roles).toEqual([
      "planner",
      "manager",
      "coder",
      "researcher",
      "data_agent",
      "reviewer",
      "designer",
      "critic",
      "inspector",
      "chat",
      "librarian",
    ]);
  });

  it("derives ALL_ROLES, WORKER_ROLES, and DISPATCHABLE_ROLES correctly", () => {
    expect([...ALL_ROLES]).toEqual([
      "planner",
      "manager",
      "coder",
      "researcher",
      "data_agent",
      "reviewer",
      "designer",
      "critic",
      "inspector",
      "chat",
      "librarian",
    ]);
    expect([...WORKER_ROLES]).toEqual([
      "coder",
      "researcher",
      "data_agent",
      "reviewer",
      "designer",
      "critic",
    ]);
    expect([...DISPATCHABLE_ROLES]).toEqual([
      "manager",
      "coder",
      "researcher",
      "data_agent",
      "reviewer",
      "designer",
      "critic",
      "inspector",
      "librarian",
    ]);
  });

  it("every dispatchable role has a unique dispatch tool", () => {
    const tools = ROSTER.filter((e) => e.dispatchTool !== null).map(
      (e) => e.dispatchTool as string,
    );
    expect(new Set(tools).size).toBe(tools.length);
  });

  it("getRoster and getRosterByDispatchTool round-trip", () => {
    for (const entry of ROSTER) {
      expect(getRoster(entry.role as AgentRole).role).toBe(entry.role);
      if (entry.dispatchTool) {
        expect(getRosterByDispatchTool(entry.dispatchTool)?.role).toBe(
          entry.role,
        );
      }
    }
    expect(getRosterByDispatchTool("nope")).toBeUndefined();
  });
});

describe("ROSTER — runtime/dispatcher parity", () => {
  it("DISPATCH_ROLE_MAP equals every (tool → role) pair in ROSTER", () => {
    const expected = Object.fromEntries(
      ROSTER.filter((e) => e.dispatchTool !== null).map((e) => [
        e.dispatchTool as string,
        e.role,
      ]),
    );
    expect(DISPATCH_ROLE_MAP).toEqual(expected);
  });

  it("DISPATCH_TOOLS lists every dispatch tool", () => {
    const expected = ROSTER.filter((e) => e.dispatchTool !== null)
      .map((e) => e.dispatchTool as string)
      .sort();
    expect([...DISPATCH_TOOLS].sort()).toEqual(expected);
  });
});

describe("ROSTER — self-check frequencies", () => {
  it("DEFAULT_SELF_CHECK_FREQUENCY reflects every roster entry", () => {
    for (const entry of ROSTER) {
      expect(
        DEFAULT_SELF_CHECK_FREQUENCY[entry.role as AgentRole],
      ).toBe(entry.selfCheckFrequency);
    }
  });
});

describe("ROSTER — conventions", () => {
  it("getConvention returns each roster entry's non-null convention", () => {
    for (const entry of ROSTER) {
      const conv = getConvention(entry.role as AgentRole);
      if (entry.convention === null) {
        expect(conv).toBeNull();
        continue;
      }
      expect(conv).not.toBeNull();
      expect(conv?.writeTerritory).toEqual(entry.convention.writeTerritory);
      expect(conv?.excludeTerritory).toEqual(entry.convention.excludeTerritory);
    }
  });
});

describe("renderRosterSummary", () => {
  it("renders one bullet per role and marks the focal role with (you)", () => {
    const text = renderRosterSummary("coder");
    const lines = text.split("\n");
    expect(lines).toHaveLength(ROSTER.length);
    for (const entry of ROSTER) {
      const marker = entry.role === "coder" ? " (you)" : "";
      expect(text).toContain(`**${entry.displayName}**${marker}:`);
    }
  });

  it("places the (you) marker on exactly one bullet", () => {
    for (const entry of ROSTER) {
      const text = renderRosterSummary(entry.role as AgentRole);
      const matches = text.match(/\(you\)/g) ?? [];
      expect(matches).toHaveLength(1);
    }
  });
});

describe("ROSTER ↔ docs parity", () => {
  it("docs/internals/agents/index.md mentions every roster display name", () => {
    const docPath = join(
      __dirname,
      "..",
      "..",
      "docs",
      "internals",
      "agents",
      "index.md",
    );
    if (!existsSync(docPath)) return;
    const doc = readFileSync(docPath, "utf8");
    for (const entry of ROSTER) {
      expect(doc).toContain(entry.displayName);
    }
  });
});

describe("ROSTER — derived accessors", () => {
  it("getAbortPriority matches every roster entry's abortPriority", () => {
    for (const role of ALL_ROLES) {
      expect(getAbortPriority(role)).toBe(getRoster(role).abortPriority);
    }
  });

  it("getToolFilter matches every roster entry's toolFilter", () => {
    for (const role of ALL_ROLES) {
      expect(getToolFilter(role)).toBe(getRoster(role).toolFilter);
    }
  });

  it("getDispatchToolsFor returns the roster's dispatch tools for each parent role", () => {
    expect(getDispatchToolsFor("manager").sort()).toEqual(
      ["run_coder", "run_critic", "run_data_agent", "run_designer", "run_librarian", "run_researcher", "run_reviewer"].sort(),
    );
    expect(getDispatchToolsFor("planner").sort()).toEqual(
      ["run_inspector", "run_librarian", "run_manager"].sort(),
    );
    expect(getDispatchToolsFor("chat")).toEqual([]);
    expect(getDispatchToolsFor("coder")).toEqual([]);
  });

  it("isConcurrencyLimitedDispatch equals roster `worker` for every dispatchable role", () => {
    for (const role of DISPATCHABLE_ROLES) {
      expect(isConcurrencyLimitedDispatch(role as DispatchableRole)).toBe(
        getRoster(role as AgentRole).worker,
      );
    }
  });
});

describe("ROSTER — worker init", () => {
  it("every WorkerRole has a workerInit on ROSTER and a registered ctor", async () => {
    await import("./coder.js");
    await import("./researcher.js");
    await import("./designer.js");
    await import("./critic.js");
    await import("./data-agent.js");
    await import("./reviewer.js");

    for (const role of WORKER_ROLES) {
      const meta = getWorkerInitMeta(role);
      expect(meta.heading).not.toBe("");
      expect(meta.invalidFinalResponseMessage).not.toBe("");
      expect(meta.promptKey).not.toBe("");
      expect(getRoster(role).worker).toBe(true);
      expect(hasWorkerCtor(role)).toBe(true);
    }
  });

  it("non-worker roles have workerInit: null", () => {
    for (const role of ["planner", "manager", "inspector", "chat", "librarian"] as const) {
      expect(getRoster(role).workerInit).toBeNull();
    }
  });
});
