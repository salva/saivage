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

export interface LocalChatCommand {
  readonly name: string;
  readonly aliases?: readonly string[];
  readonly usage: string;
  readonly help: string;
}

/**
 * Local Chat-handled slash commands. The memory/skill family
 * (`/skills`, `/memories`, `/remember`, `/forget`) is routed through
 * `parseSlashCommand` in `src/chat/slashCommands.ts` and is intentionally
 * NOT listed here — that subsystem is owned separately.
 */
export const LOCAL_CHAT_COMMANDS = [
  { name: "/help",            usage: "/help",                     help: "Show this help message" },
  { name: "/status",          usage: "/status",                   help: "Show runtime status (agents, current stage)" },
  { name: "/plan",            usage: "/plan",                     help: "Show the current plan with all stages" },
  { name: "/history",         usage: "/history [n]",              help: "Show completed stages (last n, default 5)" },
  { name: "/replan",          usage: "/replan [reason]",          help: "Force replanning (urgent note to Planner)" },
  { name: "/restart-planner", aliases: ["/planner-restart"],
                              usage: "/restart-planner [reason]", help: "Restart the Planner from persisted state" },
  { name: "/note",            usage: "/note <msg>",               help: "Create a note for the Planner" },
  { name: "/note!",           usage: "/note! <msg>",              help: "Create an **urgent** high-priority note" },
  { name: "/notep",           usage: "/notep <msg>",              help: "Create a **permanent** note" },
] as const satisfies readonly LocalChatCommand[];

export type LocalChatCommandName = (typeof LOCAL_CHAT_COMMANDS)[number]["name"];

export function renderLocalChatCommandsTable(): string {
  return LOCAL_CHAT_COMMANDS
    .map((c) => `- \`${c.usage}\` — ${c.help}`)
    .join("\n");
}
