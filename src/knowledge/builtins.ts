/**
 * F01 B05 — Bundled built-in skills are upserted into the knowledge
 * sidecar at boot. Once persisted, the eager loader reads them from
 * SQLite just like project-authored records (origin = "builtin").
 *
 * This module owns the SKILL.md parser and the `upsertBuiltinSkills`
 * boot step invoked from {@link initKnowledgeStore}.
 */

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

import { pathExists } from "../store/documents.js";
import { KnowledgeStoreError } from "./store.js";
import type { KnowledgeStore } from "./init.js";
import { insertAudit } from "./sidecar-queries.js";
import {
  BuiltinSkillFrontmatterSchema,
  SkillRecordSchema,
  type SkillRecord,
} from "./types.js";

const BUILTIN_SLUG_RE = /^[a-z0-9][a-z0-9._-]*$/;

/** NFC-normalize then lower-case (design §A.7). */
export function nfcLower(s: string): string {
  return s.normalize("NFC").toLowerCase();
}

/**
 * Default builtin path under the running bundle. At dev time
 * `import.meta.dirname` is `src/knowledge`; at runtime it's
 * `dist/knowledge`. Both resolve to `<bundle>/skills/builtin`.
 */
export function defaultBuiltinSkillsRoot(): string {
  const here = import.meta.dirname ?? __dirname;
  return join(here, "..", "..", "skills", "builtin");
}

interface SplitMarkdown {
  frontmatter: Record<string, unknown>;
  body: string;
}

export function splitBuiltinSkillMarkdown(text: string): SplitMarkdown {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) return { frontmatter: {}, body: text };
  const yamlBlock = match[1] ?? "";
  const body = (match[2] ?? "").replace(/^\r?\n/, "");
  return { frontmatter: parseFrontmatterYaml(yamlBlock), body };
}

function parseFrontmatterYaml(yamlBlock: string): Record<string, unknown> {
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

    frontmatter[key] = parseYamlValue(rawValue);
    i++;
  }
  return frontmatter;
}

function parseYamlValue(rawValue: string): string | string[] | boolean {
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

function describeError(error: unknown): string {
  if (error instanceof z.ZodError) {
    return error.issues
      .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
      .join("; ");
  }
  return error instanceof Error ? error.message : String(error);
}

interface ParsedBuiltin {
  id: string;
  name: string;
  record: SkillRecord;
  body: string;
}

async function readBuiltinSkillFile(skillPath: string): Promise<ParsedBuiltin> {
  let text: string;
  try {
    text = await readFile(skillPath, "utf-8");
  } catch (error) {
    throw new Error(
      `Unable to read builtin skill ${skillPath}: ${describeError(error)}`,
      { cause: error },
    );
  }

  let split: SplitMarkdown;
  let frontmatter: z.infer<typeof BuiltinSkillFrontmatterSchema>;
  try {
    split = splitBuiltinSkillMarkdown(text);
    frontmatter = BuiltinSkillFrontmatterSchema.parse(split.frontmatter);
  } catch (error) {
    throw new Error(
      `Invalid builtin skill frontmatter in ${skillPath}: ${describeError(error)}`,
      { cause: error },
    );
  }

  const slug = nfcLower(frontmatter.name);
  if (!BUILTIN_SLUG_RE.test(slug)) {
    throw new KnowledgeStoreError(
      "INVALID_BUILTIN_NAME",
      `builtin skill name ${JSON.stringify(frontmatter.name)} (NFC-lower: ${JSON.stringify(slug)}) ` +
        `must match ${BUILTIN_SLUG_RE.toString()} (file: ${skillPath})`,
    );
  }

  const id = "builtin:" + slug;
  const now = new Date().toISOString();
  const record: SkillRecord = SkillRecordSchema.parse({
    id,
    kind: "skill",
    scope: "project",
    status: "active",
    origin: "builtin",
    created_at: now,
    updated_at: now,
    author_agent: { role: "manager", agent_id: "system" },
    name: frontmatter.name,
    description: frontmatter.description,
    triggers: frontmatter.triggers,
    target_agents: frontmatter.target_agents,
    survive_compaction: frontmatter.survive_compaction,
    relates_to: [],
  });
  return { id, name: frontmatter.name, record, body: split.body };
}

/**
 * Walk `<builtinRoot>/<topic>/SKILL.md` and upsert each one as an
 * active `origin = "builtin"` skill record. Marks `pending_reingest`
 * so the post-step `reingestKind("skill")` republishes the dataset.
 *
 * Idempotent: re-running with unchanged files produces equivalent rows
 * (timestamps refresh on every call; the eager loader does not key off
 * `created_at`).
 */
export async function upsertBuiltinSkills(
  store: KnowledgeStore,
  builtinRoot: string = defaultBuiltinSkillsRoot(),
): Promise<{ upserted: number }> {
  if (!(await pathExists(builtinRoot))) {
    return { upserted: 0 };
  }

  const topics = (await readdir(builtinRoot)).sort();
  const parsed: ParsedBuiltin[] = [];
  const seenSlugs = new Set<string>();
  for (const topic of topics) {
    const skillPath = join(builtinRoot, topic, "SKILL.md");
    if (!(await pathExists(skillPath))) continue;
    const entry = await readBuiltinSkillFile(skillPath);
    const slug = entry.id.slice("builtin:".length);
    if (seenSlugs.has(slug)) {
      throw new KnowledgeStoreError(
        "INVALID_BUILTIN_NAME",
        `duplicate builtin skill name after NFC-lower normalization: ${JSON.stringify(slug)} ` +
          `(file: ${skillPath})`,
      );
    }
    seenSlugs.add(slug);
    parsed.push(entry);
  }

  if (parsed.length === 0) return { upserted: 0 };

  const { sidecar } = store;
  sidecar.inTransaction(() => {
    const insertRecord = sidecar.db.prepare(
      `INSERT OR REPLACE INTO record
         (id, kind, scope, scope_ref, status, origin, record_json, body,
          created_at, updated_at, supersedes, superseded_by, pending_reingest)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    );
    const insertSkill = sidecar.db.prepare(
      "INSERT OR REPLACE INTO record_skill (id, name) VALUES (?, ?)",
    );
    for (const entry of parsed) {
      insertRecord.run(
        entry.id,
        "skill",
        "project",
        null,
        "active",
        "builtin",
        JSON.stringify(entry.record),
        entry.body,
        entry.record.created_at,
        entry.record.updated_at,
        null,
        null,
        1,
      );
      insertSkill.run(entry.id, entry.name);
      insertAudit(sidecar, {
        record_id: entry.id,
        ts: entry.record.updated_at,
        op: "create",
        actor_role: "manager",
        actor_agent_id: "system",
        before_json: null,
        after_json: JSON.stringify({ id: entry.id, name: entry.name, origin: "builtin" }),
      });
    }
  });

  await store.reingestKind("skill");
  return { upserted: parsed.length };
}
