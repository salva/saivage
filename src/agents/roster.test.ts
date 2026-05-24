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
  renderRosterSummary,
  type AgentRole,
} from "./roster.js";
import { DISPATCH_ROLE_MAP, DISPATCH_TOOLS } from "../runtime/dispatcher.js";
import { DEFAULT_SELF_CHECK_FREQUENCY } from "../runtime/self-check.js";
import { ROLE_ABORT_PRIORITY } from "../runtime/supervisor.js";
import { getConvention } from "./conventions.js";

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
      "inspector",
      "chat",
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
      "inspector",
      "chat",
    ]);
    expect([...WORKER_ROLES]).toEqual([
      "coder",
      "researcher",
      "data_agent",
      "reviewer",
    ]);
    expect([...DISPATCHABLE_ROLES]).toEqual([
      "manager",
      "coder",
      "researcher",
      "data_agent",
      "reviewer",
      "inspector",
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

describe("ROSTER — supervisor abort priority", () => {
  it("ROLE_ABORT_PRIORITY is sorted by abortPriority ascending", () => {
    const expected = ROSTER.filter((e) => e.abortPriority !== null)
      .slice()
      .sort(
        (a, b) =>
          (a.abortPriority as number) - (b.abortPriority as number),
      )
      .map((e) => e.role);
    expect(ROLE_ABORT_PRIORITY).toEqual(expected);
    // Sanity: reviewer aborts before data_agent before coder before researcher before manager.
    expect(ROLE_ABORT_PRIORITY).toEqual([
      "reviewer",
      "data_agent",
      "coder",
      "researcher",
      "manager",
    ]);
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

describe("ROSTER ↔ SPEC parity", () => {
  it("SPEC/v2/00-AGENT-SYSTEM.md mentions every roster display name", () => {
    const specPath = join(
      __dirname,
      "..",
      "..",
      "SPEC",
      "v2",
      "00-AGENT-SYSTEM.md",
    );
    if (!existsSync(specPath)) return;
    const spec = readFileSync(specPath, "utf8");
    for (const entry of ROSTER) {
      expect(spec).toContain(entry.displayName);
    }
  });
});
