/**
 * Eager-injection candidate loader (design §D.4 + §D.6).
 *
 * Reads every active skill + memory record under `<projectRoot>/.saivage/{skills,memory}/`
 * plus the built-in skills bundled with the saivage package, returning a flat
 * candidate pool ready to feed `resolveEagerRecords`. Pure I/O — no scoring
 * or budgeting decisions live here.
 */

import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
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

function collectRecordsFromDir<T extends SkillRecord | MemoryRecord>(
  dir: string,
  schema: z.ZodTypeAny,
  origin: "builtin" | "project",
  out: RawCandidate[],
): void {
  const recordsDir = join(dir, "records");
  if (!existsSync(recordsDir)) return;
  for (const name of readdirSync(recordsDir).sort()) {
    if (!name.endsWith(".json")) continue;
    try {
      const raw = JSON.parse(readFileSync(join(recordsDir, name), "utf-8"));
      const rec = schema.parse(raw) as T;
      if (rec.status !== "active") continue;
      let body = "";
      if (rec.kind === "skill") {
        const skill = rec as SkillRecord;
        if (skill.body_path) {
          const bodyAbs = join(dir, skill.body_path);
          if (existsSync(bodyAbs)) body = readFileSync(bodyAbs, "utf-8");
        }
      } else {
        body = (rec as MemoryRecord).body;
      }
      out.push({ record: rec, body, origin });
    } catch { /* skip malformed */ }
  }
}

function walkScopeTree(
  root: string,
  schema: z.ZodTypeAny,
  out: RawCandidate[],
): void {
  if (!existsSync(root)) return;
  // <root>/{project, stages/<id>, sessions/<id>}
  const projectDir = join(root, "project");
  if (existsSync(projectDir)) collectRecordsFromDir(projectDir, schema, "project", out);
  for (const sub of ["stages", "sessions"]) {
    const subRoot = join(root, sub);
    if (!existsSync(subRoot)) continue;
    for (const id of readdirSync(subRoot)) {
      const dir = join(subRoot, id);
      try {
        if (!statSync(dir).isDirectory()) continue;
      } catch { continue; }
      collectRecordsFromDir(dir, schema, "project", out);
    }
  }
}

/**
 * Walk the bundled built-in skills tree. Looks for `<builtinRoot>/<topic>/SKILL.md`
 * (post-WI-16 layout). Each file becomes a synthetic active SkillRecord with
 * origin=builtin. Returns empty if the directory does not exist.
 */
export function walkBuiltinSkills(builtinRoot: string, out: RawCandidate[]): void {
  if (!existsSync(builtinRoot)) return;
  for (const topic of readdirSync(builtinRoot).sort()) {
    const skillPath = join(builtinRoot, topic, "SKILL.md");
    if (!existsSync(skillPath)) continue;
    let body: string;
    try {
      body = readFileSync(skillPath, "utf-8");
    } catch { continue; }
    const now = new Date(0).toISOString();
    const rec: SkillRecord = SkillRecordSchema.parse({
      id: randomUUID(),
      kind: "skill",
      scope: "project",
      status: "active",
      created_at: now,
      updated_at: now,
      author_agent: { role: "manager", agent_id: "builtin" },
      name: topic,
      description: `Built-in skill: ${topic}`,
      triggers: [topic],
      target_agents: [],
      origin: "builtin",
      body_path: "SKILL.md",
      relates_to: [],
      survive_compaction: false,
    });
    out.push({ record: rec, body, origin: "builtin" });
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
export function loadAllCandidates(
  projectRoot: string,
  builtinRoot: string = defaultBuiltinSkillsRoot(),
): RawCandidate[] {
  const saivage = join(projectRoot, ".saivage");
  const out: RawCandidate[] = [];
  walkScopeTree(join(saivage, "skills"), SkillRecordSchema, out);
  walkScopeTree(join(saivage, "memory"), MemoryRecordSchema, out);
  walkBuiltinSkills(builtinRoot, out);
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
export function buildEagerBlock(
  projectRoot: string,
  agentRole: KnowledgeAgentRole,
  description?: string,
  tags?: string[],
): string {
  const candidates = loadAllCandidates(projectRoot);
  const ctx: ResolveContext = { agentRole, description, tags };
  const resolution = resolveEagerRecords(ctx, candidates);
  return formatEagerBlock(resolution);
}

/**
 * Convenience wrapper used by `BaseAgent` post-compaction: load and
 * return the survivor reinjection block (or empty string if none).
 */
export function buildSurvivorBlock(
  projectRoot: string,
  agentRole: KnowledgeAgentRole,
  compactionN: number,
): string {
  const candidates = loadAllCandidates(projectRoot);
  const ctx: ResolveContext = { agentRole };
  const survivors = reinjectSurvivors(ctx, candidates);
  if (survivors.length === 0) return "";
  return formatSurvivorReinjectionBlock(survivors, compactionN);
}
