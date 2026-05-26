/**
 * Eager-injection candidate loader (design §D.4 + §D.6).
 *
 * Reads every active skill + memory record under `<projectRoot>/.saivage/{skills,memory}/`
 * plus the built-in skills bundled with the saivage package, returning a flat
 * candidate pool ready to feed `resolveEagerRecords`. Pure I/O — no scoring
 * or budgeting decisions live here.
 */

import { readdir, readFile, stat } from "node:fs/promises";
import { pathExists } from "../store/documents.js";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  BuiltinSkillFrontmatterSchema,
  SkillRecordSchema,
  MemoryRecordSchema,
  type SkillRecord,
  type MemoryRecord,
  type KnowledgeAgentRole,
} from "./types.js";
import {
  resolveEagerRecords,
  reinjectSurvivors,
  type EagerCandidate,
  type EagerResolution,
  type ResolveContext,
} from "./loader.js";

export interface RawCandidate {
  record: SkillRecord | MemoryRecord;
  body: string;
  origin?: "builtin" | "project";
}

async function collectRecordsFromDir<T extends SkillRecord | MemoryRecord>(
  dir: string,
  schema: z.ZodTypeAny,
  origin: "builtin" | "project",
  out: RawCandidate[],
): Promise<void> {
  const recordsDir = join(dir, "records");
  if (!(await pathExists(recordsDir))) return;
  const names = (await readdir(recordsDir)).sort();
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    try {
      const raw = JSON.parse(await readFile(join(recordsDir, name), "utf-8"));
      const rec = schema.parse(raw) as T;
      if (rec.status !== "active") continue;
      let body = "";
      if (rec.kind === "skill") {
        const skill = rec as SkillRecord;
        if (skill.body_path) {
          const bodyAbs = join(dir, skill.body_path);
          if (await pathExists(bodyAbs)) body = await readFile(bodyAbs, "utf-8");
        }
      } else {
        body = (rec as MemoryRecord).body;
      }
      out.push({ record: rec, body, origin });
    } catch { /* skip malformed */ }
  }
}

async function walkScopeTree(
  root: string,
  schema: z.ZodTypeAny,
  out: RawCandidate[],
): Promise<void> {
  if (!(await pathExists(root))) return;
  // <root>/{project, stages/<id>, sessions/<id>}
  const projectDir = join(root, "project");
  if (await pathExists(projectDir)) await collectRecordsFromDir(projectDir, schema, "project", out);
  for (const sub of ["stages", "sessions"]) {
    const subRoot = join(root, sub);
    if (!(await pathExists(subRoot))) continue;
    for (const id of await readdir(subRoot)) {
      const dir = join(subRoot, id);
      try {
        if (!(await stat(dir)).isDirectory()) continue;
      } catch { continue; }
      await collectRecordsFromDir(dir, schema, "project", out);
    }
  }
}

function splitBuiltinSkillMarkdown(text: string): { frontmatter: Record<string, unknown>; body: string } {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) return { frontmatter: {}, body: text };
  const yamlBlock = match[1] ?? "";
  const body = (match[2] ?? "").replace(/^\r?\n/, "");
  return { frontmatter: parseBuiltinFrontmatterYaml(yamlBlock), body };
}

function parseBuiltinFrontmatterYaml(yamlBlock: string): Record<string, unknown> {
  const frontmatter: Record<string, unknown> = {};
  const lines = yamlBlock.split(/\r?\n/);
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? "";
    if (line.trim().length === 0) {
      i++;
      continue;
    }
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.*)$/);
    if (!match) {
      throw new Error(`unparseable frontmatter line: ${line}`);
    }

    const key = match[1] ?? "";
    const rawValue = match[2] ?? "";
    if (Object.prototype.hasOwnProperty.call(frontmatter, key)) {
      throw new Error(`duplicate frontmatter key: ${key}`);
    }

    if (rawValue.length === 0) {
      const items: string[] = [];
      i++;
      while (i < lines.length) {
        const inner = lines[i] ?? "";
        const blockMatch = inner.match(/^\s+-\s+(.*)$/);
        if (!blockMatch) break;
        items.push(stripYamlQuotes((blockMatch[1] ?? "").trim()));
        i++;
      }
      frontmatter[key] = items;
      continue;
    }

    frontmatter[key] = parseBuiltinYamlValue(rawValue);
    i++;
  }
  return frontmatter;
}

function parseBuiltinYamlValue(rawValue: string): string | string[] | boolean {
  const value = rawValue.trim();
  if (value.startsWith("[") && value.endsWith("]")) {
    const inside = value.slice(1, -1).trim();
    return inside.length === 0
      ? []
      : inside.split(",").map((item) => stripYamlQuotes(item.trim()));
  }
  if (value === "true") return true;
  if (value === "false") return false;
  return stripYamlQuotes(value);
}

function stripYamlQuotes(value: string): string {
  return value.replace(/^['"]|['"]$/g, "");
}

function describeBuiltinFrontmatterError(error: unknown): string {
  if (error instanceof z.ZodError) {
    return error.issues
      .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
      .join("; ");
  }
  return error instanceof Error ? error.message : String(error);
}

/**
 * Walk the bundled built-in skills tree. Looks for `<builtinRoot>/<topic>/SKILL.md`
 * (post-WI-16 layout). Each file becomes a synthetic active SkillRecord with
 * origin=builtin. Returns empty if the directory does not exist.
 */
export async function walkBuiltinSkills(builtinRoot: string, out: RawCandidate[]): Promise<void> {
  if (!(await pathExists(builtinRoot))) return;
  for (const topic of (await readdir(builtinRoot)).sort()) {
    const skillPath = join(builtinRoot, topic, "SKILL.md");
    if (!(await pathExists(skillPath))) continue;
    let text: string;
    try {
      text = await readFile(skillPath, "utf-8");
    } catch (error) {
      throw new Error(
        `Unable to read builtin skill ${skillPath}: ${describeBuiltinFrontmatterError(error)}`,
        { cause: error },
      );
    }

    let parsed: ReturnType<typeof splitBuiltinSkillMarkdown>;
    let frontmatter: z.infer<typeof BuiltinSkillFrontmatterSchema>;
    try {
      parsed = splitBuiltinSkillMarkdown(text);
      frontmatter = BuiltinSkillFrontmatterSchema.parse(parsed.frontmatter);
    } catch (error) {
      throw new Error(
        `Invalid builtin skill frontmatter in ${skillPath}: ${describeBuiltinFrontmatterError(error)}`,
        { cause: error },
      );
    }

    const now = new Date(0).toISOString();
    const rec: SkillRecord = SkillRecordSchema.parse({
      id: randomUUID(),
      kind: "skill",
      scope: "project",
      status: "active",
      created_at: now,
      updated_at: now,
      author_agent: { role: "manager", agent_id: "builtin" },
      name: frontmatter.name,
      description: frontmatter.description,
      triggers: frontmatter.triggers,
      target_agents: frontmatter.target_agents,
      origin: "builtin",
      body_path: skillPath,
      relates_to: [],
      survive_compaction: frontmatter.survive_compaction,
    });
    out.push({ record: rec, body: parsed.body, origin: "builtin" });
  }
}

/**
 * Default builtin path under the running bundle. At dev time
 * `import.meta.dirname` is `src/knowledge`; at runtime it's `dist/knowledge`.
 * Both resolve to `<bundle>/skills/builtin` after WI-16 moves the legacy
 * `skills/<topic>` tree under `skills/builtin/`.
 */
export function defaultBuiltinSkillsRoot(): string {
  // import.meta.dirname is set in Node ≥ 20.11.
  const here = import.meta.dirname ?? __dirname;
  return join(here, "..", "..", "skills", "builtin");
}

/**
 * Load every candidate (project + builtin) for the eager-injection
 * pipeline. The caller is responsible for invoking
 * {@link resolveEagerRecords} (or {@link reinjectSurvivors}) on the
 * result.
 */
export async function loadAllCandidates(
  projectRoot: string,
  builtinRoot: string = defaultBuiltinSkillsRoot(),
): Promise<RawCandidate[]> {
  const saivage = join(projectRoot, ".saivage");
  const out: RawCandidate[] = [];
  await walkScopeTree(join(saivage, "skills"), SkillRecordSchema, out);
  await walkScopeTree(join(saivage, "memory"), MemoryRecordSchema, out);
  await walkBuiltinSkills(builtinRoot, out);
  return out;
}

/** Format §D.6 — eager block appended to the static system prompt. */
export function formatEagerBlock(resolution: EagerResolution): string {
  const all: EagerCandidate[] = [...resolution.survivors, ...resolution.ordinary];
  if (all.length === 0) return "";

  const skillCount = all.filter((c) => c.kind === "skill").length;
  const memoryCount = all.filter((c) => c.kind === "memory").length;
  const totalTokens = all.reduce((n, c) => n + Math.ceil(c.body.length / 4), 0);
  const header = `--- SAIVAGE KNOWLEDGE (${skillCount} skill${skillCount === 1 ? "" : "s"}, ${memoryCount} memor${memoryCount === 1 ? "y" : "ies"}, ~${totalTokens} tokens) ---`;

  const parts: string[] = [header];
  for (const c of all) {
    const scope = c.record.scope;
    const origin = c.origin === "builtin" ? "builtin" : scope;
    if (c.kind === "skill") {
      const name = (c.record as SkillRecord).name;
      parts.push(`--- SKILL: ${name} (${origin}) ---`);
    } else {
      const t = (c.record as MemoryRecord).topic;
      const topicStr = `${t.domain}/${t.subject}${t.aspect ? `/${t.aspect}` : ""}`;
      parts.push(`--- MEMORY: ${topicStr} (${origin}) ---`);
    }
    parts.push(c.body);
    parts.push("---");
  }
  parts.push("--- END SAIVAGE KNOWLEDGE ---");
  return parts.join("\n");
}

/** Format §E.1 — survivor reinjection block (single user-role message). */
export function formatSurvivorReinjectionBlock(
  survivors: EagerCandidate[],
  compactionN: number,
  oversizedSurvivors: string[] = [],
): string {
  const lines: string[] = [];
  lines.push(`--- SURVIVING KNOWLEDGE (auto-reinjected after compaction #${compactionN}) ---`);
  for (const c of survivors) {
    if (c.kind === "skill") {
      const s = c.record as SkillRecord;
      lines.push(`[SKILL ${s.name}] ${s.description}`);
    } else {
      const m = c.record as MemoryRecord;
      const topicStr = `${m.topic.domain}/${m.topic.subject}${m.topic.aspect ? `/${m.topic.aspect}` : ""}`;
      lines.push(`[MEMORY ${topicStr}] ${c.body.slice(0, 200)}`);
    }
  }
  lines.push(`oversized_survivors: ${JSON.stringify(oversizedSurvivors)}`);
  lines.push("--- END SURVIVING KNOWLEDGE ---");
  return lines.join("\n");
}

/**
 * Convenience wrapper used by `BaseAgent` ctor: load candidates and
 * resolve into a §D.6 block.
 */
export async function buildEagerBlock(
  projectRoot: string,
  agentRole: KnowledgeAgentRole,
  description?: string,
  tags?: string[],
): Promise<string> {
  const candidates = await loadAllCandidates(projectRoot);
  const ctx: ResolveContext = { agentRole, description, tags };
  const resolution = resolveEagerRecords(ctx, candidates);
  return formatEagerBlock(resolution);
}

/**
 * Convenience wrapper used by `BaseAgent` post-compaction: load and
 * return the survivor reinjection block (or empty string if none).
 */
export async function buildSurvivorBlock(
  projectRoot: string,
  agentRole: KnowledgeAgentRole,
  compactionN: number,
): Promise<string> {
  const candidates = await loadAllCandidates(projectRoot);
  const ctx: ResolveContext = { agentRole };
  const survivors = reinjectSurvivors(ctx, candidates);
  if (survivors.length === 0) return "";
  return formatSurvivorReinjectionBlock(survivors, compactionN);
}
