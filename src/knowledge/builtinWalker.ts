/**
 * Saivage — Built-in skill walker.
 *
 * Reads `saivage/skills/builtin/<name>/SKILL.md` files (one per skill),
 * parses the YAML frontmatter, and projects to in-memory `SkillRecord`
 * shape with `origin="builtin"` and `scope="project"`. No `.saivage/`
 * I/O — these skills are bundled with the runtime (FR-24).
 *
 * M1 scaffold: this helper is exercised by tests with a fixture dir;
 * runtime wiring (BaseAgent ctor) happens in M3.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";

import type { SkillRecord } from "./types.js";

export interface BuiltinFrontmatter {
  name?: string;
  description?: string;
  triggers?: string[];
  target_agents?: string[];
  survive_compaction?: boolean;
}

export interface BuiltinSkillRaw {
  name: string;
  description: string;
  body: string;
  bodyPath: string;
  frontmatter: BuiltinFrontmatter;
}

/**
 * Parse a *very* small YAML subset: top-level scalars + flow-style
 * arrays (`triggers: [a, b]`) + block-style arrays (`- a` lines under
 * a key). Sufficient for SKILL.md frontmatter; full YAML is OOS.
 *
 * Throws on duplicate keys or unrecognised structure so corrupted
 * fixtures fail loudly.
 */
export function parseSkillFrontmatter(text: string): { frontmatter: BuiltinFrontmatter; body: string } {
  const fmMatch = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!fmMatch) {
    return { frontmatter: {}, body: text };
  }
  const [, yamlBlock, body] = fmMatch;
  const fm: BuiltinFrontmatter = {};
  const lines = yamlBlock.split(/\r?\n/);
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim().length === 0) {
      i++;
      continue;
    }
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.*)$/);
    if (!m) {
      throw new Error(`unparseable frontmatter line: ${line}`);
    }
    const [, key, rawValue] = m;
    if (Object.prototype.hasOwnProperty.call(fm, key)) {
      throw new Error(`duplicate frontmatter key: ${key}`);
    }
    if (rawValue.length === 0) {
      // block-style list follows
      const items: string[] = [];
      i++;
      while (i < lines.length) {
        const inner = lines[i];
        const blockMatch = inner.match(/^\s+-\s+(.*)$/);
        if (!blockMatch) break;
        items.push(blockMatch[1].trim());
        i++;
      }
      assignFrontmatterKey(fm, key, items);
      continue;
    }
    if (rawValue.startsWith("[") && rawValue.endsWith("]")) {
      const inside = rawValue.slice(1, -1).trim();
      const arr =
        inside.length === 0
          ? []
          : inside.split(",").map((s) => s.trim().replace(/^['"]|['"]$/g, ""));
      assignFrontmatterKey(fm, key, arr);
    } else if (rawValue === "true" || rawValue === "false") {
      assignFrontmatterKey(fm, key, rawValue === "true");
    } else {
      assignFrontmatterKey(fm, key, rawValue.replace(/^['"]|['"]$/g, ""));
    }
    i++;
  }
  return { frontmatter: fm, body: body.replace(/^\r?\n/, "") };
}

function assignFrontmatterKey(fm: BuiltinFrontmatter, key: string, value: unknown): void {
  switch (key) {
    case "name":
    case "description":
      if (typeof value !== "string") throw new Error(`${key} must be a string`);
      fm[key] = value;
      return;
    case "triggers":
    case "target_agents":
      if (!Array.isArray(value) || !value.every((v) => typeof v === "string")) {
        throw new Error(`${key} must be a string array`);
      }
      fm[key] = value;
      return;
    case "survive_compaction":
      if (typeof value !== "boolean") throw new Error(`${key} must be a boolean`);
      fm[key] = value;
      return;
    default:
      // Unknown keys are silently ignored — forward compatibility.
      return;
  }
}

/**
 * Walk `<dir>/<name>/SKILL.md` entries and return their parsed
 * frontmatter + body. Directories without a SKILL.md are skipped.
 * Throws on malformed YAML so packagers notice broken built-ins.
 */
export function walkBuiltinSkills(dir: string): BuiltinSkillRaw[] {
  if (!existsSync(dir)) return [];
  const out: BuiltinSkillRaw[] = [];
  for (const name of readdirSync(dir).sort()) {
    const sub = join(dir, name);
    let s;
    try {
      s = statSync(sub);
    } catch {
      continue;
    }
    if (!s.isDirectory()) continue;
    const skillFile = join(sub, "SKILL.md");
    if (!existsSync(skillFile)) continue;
    const raw = readFileSync(skillFile, "utf-8");
    const { frontmatter, body } = parseSkillFrontmatter(raw);
    out.push({
      name: frontmatter.name ?? basename(sub),
      description: frontmatter.description ?? "",
      body,
      bodyPath: skillFile,
      frontmatter,
    });
  }
  return out;
}

/**
 * Project a parsed built-in skill into a SkillRecord-shaped object.
 * `id` is supplied by the caller (typically a stable UUIDv5 derived
 * from the skill name); M1 leaves derivation to the caller for clean
 * separation of concerns.
 */
export function builtinAsSkillRecord(
  raw: BuiltinSkillRaw,
  id: string,
  now: string,
): SkillRecord {
  return {
    id,
    kind: "skill",
    scope: "project",
    status: "active",
    created_at: now,
    updated_at: now,
    author_agent: { role: "manager", agent_id: "builtin" },
    origin: "builtin",
    name: raw.name,
    description: raw.description,
    body_path: raw.bodyPath,
    triggers: raw.frontmatter.triggers ?? [],
    target_agents: (raw.frontmatter.target_agents ?? []) as SkillRecord["target_agents"],
    relates_to: [],
    survive_compaction: raw.frontmatter.survive_compaction ?? false,
  };
}
