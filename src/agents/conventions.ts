/**
 * Saivage — Agent Conventions
 * Per-agent territory definitions. Violation logging (warnings, not blocks).
 */

import type { AgentRole } from "./types.js";
import { ROSTER } from "./roster.js";
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
const CONVENTIONS: Partial<Record<AgentRole, ConventionRule>> = Object.fromEntries(
  ROSTER
    .filter((entry) => entry.convention !== null)
    .map((entry) => [entry.role, entry.convention as ConventionRule]),
) as Partial<Record<AgentRole, ConventionRule>>;

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
