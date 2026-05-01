/**
 * Saivage — Agent Conventions
 * Per-agent territory definitions. Violation logging (warnings, not blocks).
 */

import type { AgentRole } from "./types.js";
import { log } from "../log.js";

/** Territory conventions per agent role. */
export interface ConventionRule {
  /** Directories the agent should write to. */
  writeTerritory: string[];
  /** Directories the agent should NOT write to. */
  excludeTerritory: string[];
  /** Description for logging. */
  description: string;
}

/** Convention rules by role. Convention over enforcement — violations are logged as warnings. */
const CONVENTIONS: Partial<Record<AgentRole, ConventionRule>> = {
  coder: {
    writeTerritory: ["src/", "tests/", "test/", "package.json", "tsconfig.json"],
    excludeTerritory: ["research/"],
    description: "Coder should write project source code, not research docs",
  },
  researcher: {
    writeTerritory: ["research/"],
    excludeTerritory: ["src/"],
    description: "Researcher should write under research/, not project source",
  },
  data_agent: {
    writeTerritory: ["data/", "research/data-sources/", ".saivage/stages/"],
    excludeTerritory: ["src/"],
    description: "Data Agent should write data artifacts, provenance notes, and reports, not project source",
  },
  reviewer: {
    writeTerritory: [".saivage/stages/", "reviews/", "reports/"],
    excludeTerritory: ["src/", "data/", "research/"],
    description: "Reviewer should write review findings and reports, not implementation, research, or data artifacts",
  },
  inspector: {
    writeTerritory: [
      ".saivage/inspections/",
      ".saivage/tools/inspector/",
      ".saivage/tmp/inspector-workspace/",
    ],
    excludeTerritory: ["src/"],
    description: "Inspector writes reports and tools, not source code",
  },
  chat: {
    writeTerritory: [".saivage/notes/", ".saivage/tmp/chats/"],
    excludeTerritory: ["src/", "research/"],
    description: "Chat only creates notes and chat logs",
  },
  manager: {
    writeTerritory: [".saivage/stages/"],
    excludeTerritory: ["src/", "research/"],
    description: "Manager writes task lists and summaries under .saivage/stages/",
  },
  planner: {
    writeTerritory: [".saivage/plan.json", ".saivage/plan-history.json"],
    excludeTerritory: ["src/", "research/"],
    description: "Planner manages plan state via Plan MCP only",
  },
};

/**
 * Check if a file write violates the agent's territory convention.
 * Returns a warning message if violated, null if OK.
 * Does NOT block the operation — convention over enforcement.
 */
export function checkConvention(
  role: AgentRole,
  filePath: string,
): string | null {
  const rule = CONVENTIONS[role];
  if (!rule) return null;

  // Normalize path separators
  const normalized = filePath.replace(/\\/g, "/");

  for (const excluded of rule.excludeTerritory) {
    if (normalized.includes(excluded)) {
      const msg = `Convention violation: ${role} writing to ${filePath} (${rule.description})`;
      log.warn(`[conventions] ${msg}`);
      return msg;
    }
  }

  return null;
}

/**
 * Get the convention rule for a role (if any).
 */
export function getConvention(role: AgentRole): ConventionRule | null {
  return CONVENTIONS[role] ?? null;
}
