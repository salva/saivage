/**
 * Saivage — Agent Conventions
 * Per-agent territory definitions and enforceable path decisions.
 */

import { relative, resolve } from "node:path";
import type { AgentRole } from "./types.js";
import { ROSTER } from "./roster.js";
import { log } from "../log.js";
import type { ToolCallContext } from "../mcp/toolContext.js";

/** Territory conventions per agent role. */
export interface ConventionRule {
  /** Directories the agent should write to. */
  writeTerritory: string[];
  /** Directories the agent should NOT write to. */
  excludeTerritory: string[];
  /** Description for logging. */
  description: string;
}

/** Convention rules by role. */
const CONVENTIONS: Partial<Record<AgentRole, ConventionRule>> = Object.fromEntries(
  ROSTER
    .filter((entry) => entry.convention !== null)
    .map((entry) => [entry.role, entry.convention as ConventionRule]),
) as Partial<Record<AgentRole, ConventionRule>>;

export type PathMutationDecision =
  | { ok: true; path: string; relativePath: string }
  | { ok: false; path: string; relativePath: string; reason: string };

function normalizeProjectRelative(projectRoot: string, filePath: string): { path: string; relativePath: string } {
  const root = resolve(projectRoot);
  const target = resolve(root, filePath);
  const rel = relative(root, target).replace(/\\/g, "/");
  if (rel === "" || rel === ".." || rel.startsWith("../") || rel.startsWith("/")) {
    throw new Error(`Path must stay inside ${root}`);
  }
  return { path: target, relativePath: rel };
}

function isInside(relPath: string, territory: string): boolean {
  const normalized = territory.replace(/\\/g, "/").replace(/^\.\//, "");
  const trimmed = normalized.endsWith("/") ? normalized.slice(0, -1) : normalized;
  return relPath === trimmed || relPath.startsWith(`${trimmed}/`);
}

export function decidePathMutation(
  ctx: ToolCallContext | undefined,
  filePath: string,
): PathMutationDecision {
  const projectRoot = ctx?.projectRoot ?? process.env["PROJECT_ROOT"] ?? process.cwd();
  const resolved = normalizeProjectRelative(projectRoot, filePath);

  if (!ctx || ctx.operatorContext === true) return { ok: true, ...resolved };

  if (
    isInside(resolved.relativePath, ".saivage/skills/") ||
    isInside(resolved.relativePath, ".saivage/memory/")
  ) {
    return {
      ok: false,
      ...resolved,
      reason:
        `BLOCKED_PATH: ${resolved.relativePath} is a knowledge-store path. ` +
        `Use knowledge MCP tools to mutate skills or memories.`,
    };
  }

  return decideRolePathMutation(ctx.role, resolved.relativePath, resolved.path);
}

export function decideRolePathMutation(
  role: AgentRole,
  projectRelativePath: string,
  absolutePath = projectRelativePath,
): PathMutationDecision {
  const rule = CONVENTIONS[role];
  const normalized = projectRelativePath.replace(/\\/g, "/").replace(/^\.\//, "");
  if (!rule) return { ok: true, path: absolutePath, relativePath: normalized };

  for (const excluded of rule.excludeTerritory) {
    if (isInside(normalized, excluded)) {
      const reason = `Convention violation: ${role} cannot write ${normalized} (${rule.description})`;
      log.warn(`[conventions] ${reason}`);
      return { ok: false, path: absolutePath, relativePath: normalized, reason };
    }
  }

  if (!rule.writeTerritory.some((territory) => isInside(normalized, territory))) {
    const reason = `Convention violation: ${role} cannot write ${normalized}; outside write territory (${rule.description})`;
    log.warn(`[conventions] ${reason}`);
    return { ok: false, path: absolutePath, relativePath: normalized, reason };
  }

  return { ok: true, path: absolutePath, relativePath: normalized };
}

/**
 * Compatibility wrapper for older convention tests/callers.
 * Returns a violation message if denied, null if OK.
 */
export function checkConvention(
  role: AgentRole,
  filePath: string,
): string | null {
  const decision = decideRolePathMutation(role, filePath);
  return decision.ok ? null : decision.reason;
}

/**
 * Get the convention rule for a role (if any).
 */
export function getConvention(role: AgentRole): ConventionRule | null {
  return CONVENTIONS[role] ?? null;
}
