/**
 * Saivage — Skill Loader
 * Read skills/index.json, trigger matching, target_agents filtering,
 * ranking, top-N selection.
 */

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { readDocOrNull } from "../store/documents.js";
import { SkillIndexSchema, type SkillEntry, type SkillIndex } from "../types.js";
import type { AgentRole } from "../agents/types.js";
import { log } from "../log.js";

/** A resolved skill with its content loaded. */
export interface LoadedSkill {
  entry: SkillEntry;
  content: string;
  matchScore: number;
}

/** Context for matching skills to an agent invocation. */
export interface SkillMatchContext {
  /** Agent role. */
  agentRole: AgentRole;
  /** Task/stage description text. */
  description?: string;
  /** Tools available to this agent. */
  tools?: string[];
  /** File paths relevant to the task. */
  filePaths?: string[];
  /** Tags from stage or task. */
  tags?: string[];
}

/**
 * Load and resolve skills for an agent invocation.
 *
 * Discovery paths (in precedence order):
 * 1. Built-in: <repo>/skills/
 * 2. Project: <project>/.saivage/skills/
 */
export function resolveSkills(
  context: SkillMatchContext,
  projectSkillsDir: string,
  maxSkills: number = 5,
): LoadedSkill[] {
  // Collect all skill entries from all sources
  const allEntries = collectSkillEntries(projectSkillsDir);

  // Filter by target_agents
  const eligible = allEntries.filter(({ entry }) => {
    if (!entry.target_agents || entry.target_agents.length === 0) return true;
    return entry.target_agents.includes(context.agentRole);
  });

  // Score each skill by trigger matching
  const scored: Array<{ entry: SkillEntry; score: number; dir: string }> = [];

  for (const { entry, dir } of eligible) {
    const score = scoreTriggers(entry.triggers, context);
    if (score > 0) {
      scored.push({ entry, score, dir });
    }
  }

  // Sort by score (descending), then by updated_at (most recent first)
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return b.entry.updated_at.localeCompare(a.entry.updated_at);
  });

  // Take top N
  const selected = scored.slice(0, maxSkills);

  // Load content for selected skills
  const loaded: LoadedSkill[] = [];
  for (const { entry, score, dir } of selected) {
    const content = loadSkillContent(entry.file, dir);
    if (content) {
      loaded.push({ entry, content, matchScore: score });
    }
  }

  return loaded;
}

/** Format loaded skills for injection into the system prompt. */
export function formatSkillsForPrompt(skills: LoadedSkill[]): string {
  if (skills.length === 0) return "";

  const blocks = skills.map(
    (s) =>
      `--- SKILL: ${s.entry.name} ---\n${s.content}\n---`,
  );

  return blocks.join("\n\n");
}

// ─── Internal ─────────────────────────────────────────────────────────────

interface EntryWithDir {
  entry: SkillEntry;
  dir: string;
}

function collectSkillEntries(
  projectSkillsDir: string,
): EntryWithDir[] {
  const results: EntryWithDir[] = [];
  const seen = new Set<string>();
  const thisDir = import.meta.dirname ?? __dirname;

  // Discovery paths (project overrides built-in)
  const dirs = [
    projectSkillsDir,
    join(thisDir, "..", "..", "skills"),
  ];

  for (const dir of dirs) {
    const indexPath = join(dir, "index.json");
    const index = readDocOrNull(indexPath, SkillIndexSchema);
    if (!index) continue;

    for (const entry of index.skills) {
      if (seen.has(entry.name)) continue; // earlier paths take precedence
      seen.add(entry.name);
      results.push({ entry, dir });
    }
  }

  return results;
}

function scoreTriggers(
  triggers: string[],
  context: SkillMatchContext,
): number {
  let score = 0;

  for (const trigger of triggers) {
    const [type, value] = parseTrigger(trigger);

    switch (type) {
      case "keyword":
        if (
          context.description &&
          context.description.toLowerCase().includes(value.toLowerCase())
        ) {
          score++;
        }
        break;

      case "tool":
        if (context.tools && context.tools.includes(value)) {
          score++;
        }
        break;

      case "path":
        if (context.filePaths) {
          for (const fp of context.filePaths) {
            if (matchGlob(value, fp)) {
              score++;
              break;
            }
          }
        }
        break;

      case "tag":
        if (context.tags && context.tags.includes(value)) {
          score++;
        }
        break;

      case "agent":
        if (context.agentRole === value) {
          score++;
        }
        break;
    }
  }

  return score;
}

function parseTrigger(trigger: string): [string, string] {
  const colonIdx = trigger.indexOf(":");
  if (colonIdx === -1) return ["keyword", trigger];
  return [trigger.slice(0, colonIdx), trigger.slice(colonIdx + 1)];
}

/** Simple glob matching (supports * and **). */
function matchGlob(pattern: string, path: string): boolean {
  const regex = pattern
    .replace(/\*\*/g, "§§")
    .replace(/\*/g, "[^/]*")
    .replace(/§§/g, ".*")
    .replace(/\./g, "\\.");
  return new RegExp(`^${regex}$`).test(path);
}

function loadSkillContent(
  relativePath: string,
  skillsDir: string,
): string | null {
  const fullPath = join(skillsDir, relativePath);
  if (!existsSync(fullPath)) {
    log.warn(`[skills] Skill file not found: ${fullPath}`);
    return null;
  }
  try {
    return readFileSync(fullPath, "utf-8");
  } catch {
    return null;
  }
}
