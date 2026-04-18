import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, resolve, basename, dirname } from "node:path";
import { homedir } from "node:os";
import type { Skill, SkillMetadata } from "./types.js";
import { log } from "../log.js";

const SKILL_FILENAME = "SKILL.md";

/**
 * Discover and load skills from multiple directories:
 * 1. Built-in: <project>/skills/
 * 2. Global: ~/.saivage/skills/
 * 3. Workspace: ./skills/
 */
export function discoverSkills(
  projectRoot?: string,
  workspaceRoot?: string,
): Skill[] {
  const dirs: string[] = [];

  // Built-in skills (shipped with saivage)
  if (projectRoot) {
    const builtinDir = join(projectRoot, "skills");
    if (existsSync(builtinDir)) dirs.push(builtinDir);
  }

  // Global user skills
  const globalDir = join(homedir(), ".saivage", "skills");
  if (existsSync(globalDir)) dirs.push(globalDir);

  // Workspace-local skills (two locations)
  if (workspaceRoot) {
    const wsDir = join(workspaceRoot, "skills");
    if (existsSync(wsDir)) dirs.push(wsDir);
    const wsSaivageDir = join(workspaceRoot, ".saivage", "skills");
    if (existsSync(wsSaivageDir)) dirs.push(wsSaivageDir);
  }

  const skills: Skill[] = [];
  const seen = new Set<string>();

  for (const dir of dirs) {
    try {
      const entries = readdirSync(dir);
      for (const entry of entries) {
        const skillFile = join(dir, entry, SKILL_FILENAME);
        if (!existsSync(skillFile)) continue;

        const skill = loadSkillFile(skillFile);
        if (skill && !seen.has(skill.metadata.name)) {
          skills.push(skill);
          seen.add(skill.metadata.name);
        }
      }
    } catch (err) {
      log.warn(`Error scanning skills in ${dir}: ${err}`);
    }
  }

  return skills;
}

/**
 * Parse a SKILL.md file.
 * Frontmatter is YAML between --- delimiters at the top of the file.
 */
export function loadSkillFile(filePath: string): Skill | null {
  try {
    const raw = readFileSync(filePath, "utf-8");
    const { metadata, content } = parseFrontmatter(raw);

    if (!metadata.name) {
      // Infer name from directory
      metadata.name = basename(dirname(filePath));
    }

    return {
      metadata: {
        name: metadata.name as string,
        description: (metadata.description as string) ?? "",
        version: (metadata.version as string) ?? "0.1.0",
        triggers: metadata.triggers as string[] | undefined,
        agentTypes: metadata.agentTypes as string[] | undefined,
        dependencies: metadata.dependencies as string[] | undefined,
      },
      content,
      sourcePath: filePath,
    };
  } catch (err) {
    log.warn(`Failed to load skill from ${filePath}: ${err}`);
    return null;
  }
}

function parseFrontmatter(raw: string): {
  metadata: Record<string, unknown>;
  content: string;
} {
  if (!raw.startsWith("---")) {
    return { metadata: {}, content: raw };
  }

  const endIdx = raw.indexOf("---", 3);
  if (endIdx === -1) {
    return { metadata: {}, content: raw };
  }

  const frontmatter = raw.slice(3, endIdx).trim();
  const content = raw.slice(endIdx + 3).trim();

  // Simple YAML-like parsing (key: value, key: [a, b])
  const metadata: Record<string, unknown> = {};
  for (const line of frontmatter.split("\n")) {
    const match = line.match(/^(\w+):\s*(.*)$/);
    if (!match) continue;
    const [, key, value] = match;
    if (!key || value === undefined) continue;

    // Handle arrays: [a, b, c]
    const arrayMatch = value.match(/^\[(.+)\]$/);
    if (arrayMatch) {
      metadata[key] = arrayMatch[1]!
        .split(",")
        .map((s) => s.trim().replace(/^["']|["']$/g, ""));
    } else {
      metadata[key] = value.replace(/^["']|["']$/g, "");
    }
  }

  return { metadata, content };
}
