import type { Skill } from "./types.js";

const MAX_SKILL_BUDGET = 16000; // characters

/**
 * Resolve which skills to include for a given task/agent context.
 *
 * Resolution order:
 * 1. Explicitly requested skills (by name)
 * 2. Agent type defaults (skills with matching agentTypes)
 * 3. Trigger matching (skills whose triggers match the goal text)
 * 4. Deduplicate
 * 5. Resolve dependencies
 * 6. Enforce context budget
 */
export function resolveSkills(params: {
  allSkills: Skill[];
  explicit?: string[];
  agentType?: string;
  goalText?: string;
  budget?: number;
}): Skill[] {
  const {
    allSkills,
    explicit = [],
    agentType,
    goalText,
    budget = MAX_SKILL_BUDGET,
  } = params;

  const selected = new Map<string, Skill>();

  // 1. Explicit
  for (const name of explicit) {
    const skill = allSkills.find((s) => s.metadata.name === name);
    if (skill) selected.set(skill.metadata.name, skill);
  }

  // 2. Agent type defaults
  if (agentType) {
    for (const skill of allSkills) {
      if (skill.metadata.agentTypes?.includes(agentType)) {
        selected.set(skill.metadata.name, skill);
      }
    }
  }

  // 3. Trigger matching
  if (goalText) {
    for (const skill of allSkills) {
      if (!skill.metadata.triggers) continue;
      for (const pattern of skill.metadata.triggers) {
        try {
          if (new RegExp(pattern, "i").test(goalText)) {
            selected.set(skill.metadata.name, skill);
            break;
          }
        } catch {
          // Invalid regex pattern, skip
        }
      }
    }
  }

  // 4. Resolve dependencies
  let changed = true;
  while (changed) {
    changed = false;
    for (const skill of selected.values()) {
      for (const dep of skill.metadata.dependencies ?? []) {
        if (!selected.has(dep)) {
          const depSkill = allSkills.find((s) => s.metadata.name === dep);
          if (depSkill) {
            selected.set(dep, depSkill);
            changed = true;
          }
        }
      }
    }
  }

  // 5. Enforce context budget (by content length)
  const result: Skill[] = [];
  let totalLength = 0;
  for (const skill of selected.values()) {
    if (totalLength + skill.content.length > budget) break;
    result.push(skill);
    totalLength += skill.content.length;
  }

  return result;
}

/**
 * Format resolved skills into a string block for the system prompt.
 */
export function formatSkillsForPrompt(skills: Skill[]): string {
  if (skills.length === 0) return "";

  const blocks = skills.map(
    (s) => `<skill name="${s.metadata.name}">\n${s.content}\n</skill>`,
  );
  return `\n## Active Skills\n\n${blocks.join("\n\n")}`;
}
