/**
 * Eager-injection candidate loader (design §A.7 + §D.4 + §D.6).
 *
 * After F01(B05) the canonical source of candidates is the SQLite
 * sidecar (`<project>/.saivage/knowledge/store.sqlite`). Built-in
 * skills live there too with `origin = "builtin"` — they are upserted
 * at boot by {@link upsertBuiltinSkills}. This module no longer scans
 * any on-disk SKILL.md tree.
 */

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
import { openSidecar } from "./sidecar.js";
import { loadAllActiveRowsForEager } from "./sidecar-queries.js";

export interface RawCandidate {
  record: SkillRecord | MemoryRecord;
  body: string;
  origin?: "builtin" | "project";
}

function assembleRecord(raw: unknown): SkillRecord | MemoryRecord | undefined {
  if (raw === null || typeof raw !== "object") return undefined;
  const kind = (raw as { kind?: string }).kind;
  try {
    if (kind === "skill") return SkillRecordSchema.parse(raw);
    if (kind === "memory") return MemoryRecordSchema.parse(raw);
  } catch {
    return undefined;
  }
  return undefined;
}

/**
 * Load every active candidate (project + builtin) for the
 * eager-injection pipeline. Reads directly from the sidecar; the
 * caller is responsible for invoking {@link resolveEagerRecords}
 * (or {@link reinjectSurvivors}) on the result.
 */
export async function loadAllCandidates(projectRoot: string): Promise<RawCandidate[]> {
  const sidecar = await openSidecar(projectRoot);
  try {
    const out: RawCandidate[] = [];
    for (const row of loadAllActiveRowsForEager(sidecar)) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(row.record_json);
      } catch {
        continue;
      }
      const record = assembleRecord(parsed);
      if (!record) continue;
      if (record.status !== "active") continue;
      out.push({ record, body: row.body, origin: row.origin });
    }
    return out;
  } finally {
    sidecar.close();
  }
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
