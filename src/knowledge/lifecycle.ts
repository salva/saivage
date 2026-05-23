/**
 * Saivage — Knowledge lifecycle helpers (M2).
 *
 * Composite operations on top of `store.ts` primitives. The MCP handler
 * adapters in `src/mcp/knowledgeSkills.ts` and `knowledgeMemory.ts`
 * remain thin per-tool dispatchers; this module owns the shared
 * lifecycle mechanics so both kinds share one engine.
 *
 * Source: SPEC/v2/skills-memory/01-DESIGN.md §C.3 (transaction order),
 * §B.4 (on-disk layout), §B.5 (supersession scope-pair table), §D.3
 * (search scoring).
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";

import {
  KnowledgeStoreError,
  appendAuditEntry,
  assertNotBlockedPath,
  assertReason,
  detectSecrets,
  rebuildIndex,
  unlinkRecordIfExists,
  writeRecordAtomic,
  type IndexSummary,
} from "./store.js";
import {
  AuditEntrySchema,
  MemoryRecordSchema,
  SkillRecordSchema,
  type AuditEntry,
  type AuditOp,
  type KnowledgeAgentRole,
  type KnowledgeRecord,
  type KnowledgeScope,
  type MemoryRecord,
  type SkillRecord,
} from "./types.js";
import {
  canonicalizeTokens,
  redactForRead,
  scoreMemoryForSearch,
  scoreSkillForSearch,
} from "./loader.js";
import { isBlockedPath } from "../security/secrets.js";

const IndexFileSchema = z.object({ entries: z.array(z.any()) }) as z.ZodType<{
  entries: IndexSummary[];
}>;
const BODY_SNIPPET_MAX = 500;
const SEARCH_SNIPPET_WINDOW = 200;
const SENTINEL_ID = "00000000-0000-4000-8000-000000000000";

export interface AuthorAgent {
  role: KnowledgeAgentRole;
  agent_id: string;
}

export function scopeDir(
  saivageRoot: string,
  kind: "skill" | "memory",
  scope: KnowledgeScope,
  scope_ref?: string,
): string {
  const kindDir = kind === "skill" ? "skills" : "memory";
  if (scope === "project") return join(saivageRoot, kindDir, "project");
  if (scope === "stage") {
    if (!scope_ref) throw new KnowledgeStoreError("INVALID_SCOPE_REF", "scope=stage requires scope_ref");
    return join(saivageRoot, kindDir, "stages", scope_ref);
  }
  if (!scope_ref) throw new KnowledgeStoreError("INVALID_SCOPE_REF", "scope=session requires scope_ref");
  return join(saivageRoot, kindDir, "sessions", scope_ref);
}

const auditPath = (dir: string): string => join(dir, "audit.jsonl");

function ensureDir(p: string): void {
  if (!existsSync(p)) mkdirSync(p, { recursive: true });
}

function buildAudit(
  recordId: string,
  op: AuditOp,
  outcome: "ok" | "rejected",
  author: AuthorAgent,
  reason: string,
  extra: Partial<AuditEntry> = {},
): AuditEntry {
  return AuditEntrySchema.parse({
    ts: new Date().toISOString(),
    record_id: recordId,
    op,
    outcome,
    author_agent: author,
    reason,
    ...extra,
  });
}

function writeAuditSafe(dir: string, entry: AuditEntry): void {
  ensureDir(dir);
  appendAuditEntry(auditPath(dir), entry);
}

function safeRebuild<S extends z.ZodTypeAny>(dir: string, schema: S): void {
  try { rebuildIndex(dir, schema, IndexFileSchema); } catch { /* design §C.3 step-4: next loader rebuilds */ }
}

type ParseFn<T> = (data: unknown) => T;

function collectRecords<T extends KnowledgeRecord>(
  dir: string,
  parse: ParseFn<T>,
  out: T[],
): void {
  const recordsDir = join(dir, "records");
  if (!existsSync(recordsDir)) return;
  for (const name of readdirSync(recordsDir).sort()) {
    if (!name.endsWith(".json")) continue;
    try {
      const parsed = JSON.parse(readFileSync(join(recordsDir, name), "utf-8"));
      out.push(parse(parsed));
    } catch { /* skip malformed */ }
  }
}

function collectScopeActiveRecords<T extends KnowledgeRecord>(dir: string, parse: ParseFn<T>): T[] {
  const out: T[] = [];
  collectRecords(dir, parse, out);
  return out.filter((r) => r.status === "active");
}

export function listAllRecords<T extends KnowledgeRecord>(
  saivageRoot: string,
  kind: "skill" | "memory",
  parse: ParseFn<T>,
): T[] {
  const out: T[] = [];
  const kindDir = kind === "skill" ? "skills" : "memory";
  const roots = [
    join(saivageRoot, kindDir, "project"),
    join(saivageRoot, kindDir, "stages"),
    join(saivageRoot, kindDir, "sessions"),
  ];
  for (const root of roots) {
    if (!existsSync(root)) continue;
    if (root.endsWith("/project")) {
      collectRecords(root, parse, out);
      continue;
    }
    for (const sub of readdirSync(root)) {
      collectRecords(join(root, sub), parse, out);
    }
  }
  return out;
}

const parseSkill: ParseFn<SkillRecord> = (d) => SkillRecordSchema.parse(d);
const parseMemory: ParseFn<MemoryRecord> = (d) => MemoryRecordSchema.parse(d);

export function walkSupersedeChain<T extends KnowledgeRecord>(
  records: ReadonlyArray<T>,
  start: T,
): T {
  const byId = new Map(records.map((r) => [r.id, r]));
  let cur: T = start;
  const seen = new Set<string>([cur.id]);
  while (cur.superseded_by) {
    const next = byId.get(cur.superseded_by);
    if (!next || seen.has(next.id)) return cur;
    seen.add(next.id);
    cur = next;
  }
  return cur;
}

function isAllowedSupersedeScopePair(oldScope: KnowledgeScope, newScope: KnowledgeScope): boolean {
  if (oldScope === "project") return newScope === "project";
  if (oldScope === "stage") return newScope === "project" || newScope === "stage";
  if (oldScope === "session") return newScope === "project" || newScope === "session";
  return false;
}

function assertBodyHasNoBlockedPath(body: string, field = "body"): void {
  for (const tokenRaw of body.split(/\s+/)) {
    const token = tokenRaw.replace(/^[\[\(<"'`]+|[\]\)>"'`,;:.]+$/g, "");
    if (token.length === 0) continue;
    if (!token.includes("/") && !token.startsWith(".env")) continue;
    if (isBlockedPath(token)) {
      throw new KnowledgeStoreError("BLOCKED_PATH", `${field} contains blocked path: ${token}`);
    }
  }
}

// ─── Skill lifecycle ──────────────────────────────────────────────────────

export interface CreateSkillInput {
  name: string;
  description: string;
  body: string;
  triggers?: string[];
  target_agents?: KnowledgeAgentRole[];
  scope: KnowledgeScope;
  scope_ref?: string;
  expires_at?: string;
  ttl_ms?: number;
  survive_compaction?: boolean;
  reason: string;
}

export function createSkill(
  saivageRoot: string,
  input: CreateSkillInput,
  author: AuthorAgent,
): { id: string; status: "active" } {
  const reason = assertReason(input.reason);
  const dir = scopeDir(saivageRoot, "skill", input.scope, input.scope_ref);
  ensureDir(join(dir, "records"));
  const existing = collectScopeActiveRecords(dir, parseSkill);
  if (existing.some((r) => r.name === input.name)) {
    writeAuditSafe(dir, buildAudit(SENTINEL_ID, "create", "rejected", author, reason, { error_code: "NAME_COLLISION" }));
    throw new KnowledgeStoreError("NAME_COLLISION", `skill name '${input.name}' already active in scope`);
  }
  const bodyScan = detectSecrets({ body: input.body, reason });
  if (bodyScan.matches.length > 0) {
    writeAuditSafe(dir, buildAudit(SENTINEL_ID, "create", "rejected", author, reason, { error_code: "SECRET_DETECTED" }));
    throw new KnowledgeStoreError("SECRET_DETECTED", `secret in: ${[...new Set(bodyScan.matches.map((m) => m.field))].join(", ")}`);
  }
  assertBodyHasNoBlockedPath(input.body, "body");
  const id = randomUUID();
  const now = new Date().toISOString();
  const bodyPath = `records/${id}.md`;
  const record: SkillRecord = SkillRecordSchema.parse({
    id,
    kind: "skill",
    scope: input.scope,
    status: "active",
    created_at: now,
    updated_at: now,
    author_agent: author,
    name: input.name,
    description: input.description,
    triggers: input.triggers ?? [],
    target_agents: input.target_agents ?? [],
    origin: "project",
    body_path: bodyPath,
    relates_to: [],
    survive_compaction: input.survive_compaction ?? false,
    ...(input.scope_ref ? { scope_ref: input.scope_ref } : {}),
    ...(input.expires_at ? { expires_at: input.expires_at } : {}),
    ...(input.ttl_ms ? { ttl_ms: input.ttl_ms } : {}),
  });
  writeFileSync(join(dir, bodyPath), input.body, "utf-8");
  writeRecordAtomic(dir, id, SkillRecordSchema, record);
  writeAuditSafe(dir, buildAudit(id, "create", "ok", author, reason, { next_status: "active" }));
  safeRebuild(dir, SkillRecordSchema);
  return { id, status: "active" };
}

export interface UpdateSkillInput {
  id: string;
  body?: string;
  description?: string;
  triggers?: string[];
  target_agents?: KnowledgeAgentRole[];
  expires_at?: string;
  ttl_ms?: number;
  reason: string;
}

export function updateSkill(
  saivageRoot: string,
  input: UpdateSkillInput,
  author: AuthorAgent,
): { id: string; updated_at: string } {
  const reason = assertReason(input.reason);
  const existing = findSkillById(saivageRoot, input.id);
  if (!existing) throw new KnowledgeStoreError("NOT_FOUND", `skill ${input.id} not found`);
  const { dir, record } = existing;
  if (input.body !== undefined) {
    const scan = detectSecrets({ body: input.body });
    if (scan.matches.length > 0) {
      writeAuditSafe(dir, buildAudit(input.id, "update", "rejected", author, reason, { error_code: "SECRET_DETECTED" }));
      throw new KnowledgeStoreError("SECRET_DETECTED", "secret in: body");
    }
    assertBodyHasNoBlockedPath(input.body, "body");
  }
  const now = new Date().toISOString();
  const updated: SkillRecord = SkillRecordSchema.parse({
    ...record,
    description: input.description ?? record.description,
    triggers: input.triggers ?? record.triggers,
    target_agents: input.target_agents ?? record.target_agents,
    ...(input.expires_at !== undefined ? { expires_at: input.expires_at } : {}),
    ...(input.ttl_ms !== undefined ? { ttl_ms: input.ttl_ms } : {}),
    updated_at: now,
  });
  if (input.body !== undefined) writeFileSync(join(dir, updated.body_path), input.body, "utf-8");
  writeRecordAtomic(dir, updated.id, SkillRecordSchema, updated);
  writeAuditSafe(dir, buildAudit(updated.id, "update", "ok", author, reason));
  safeRebuild(dir, SkillRecordSchema);
  return { id: updated.id, updated_at: now };
}

export function archiveSkill(
  saivageRoot: string,
  id: string,
  reasonRaw: string,
  author: AuthorAgent,
): { id: string; status: "archived" } {
  const reason = assertReason(reasonRaw);
  const found = findSkillById(saivageRoot, id);
  if (!found) throw new KnowledgeStoreError("NOT_FOUND", `skill ${id} not found`);
  const { dir, record } = found;
  const updated = SkillRecordSchema.parse({ ...record, status: "archived", updated_at: new Date().toISOString() });
  writeRecordAtomic(dir, updated.id, SkillRecordSchema, updated);
  writeAuditSafe(dir, buildAudit(updated.id, "archive", "ok", author, reason, { prev_status: record.status, next_status: "archived" }));
  safeRebuild(dir, SkillRecordSchema);
  return { id, status: "archived" };
}

export function deleteSkill(
  saivageRoot: string,
  id: string,
  reasonRaw: string,
  author: AuthorAgent,
): { id: string } {
  const reason = assertReason(reasonRaw);
  const found = findSkillById(saivageRoot, id);
  if (!found) throw new KnowledgeStoreError("NOT_FOUND", `skill ${id} not found`);
  const { dir, record } = found;
  unlinkRecordIfExists(dir, id);
  const bodyAbs = join(dir, record.body_path);
  if (existsSync(bodyAbs)) { try { unlinkSync(bodyAbs); } catch { /* */ } }
  writeAuditSafe(dir, buildAudit(id, "delete", "ok", author, reason, { prev_status: record.status }));
  safeRebuild(dir, SkillRecordSchema);
  return { id };
}

export interface SupersedeSkillInput {
  old_id: string;
  new_record: CreateSkillInput;
  reason: string;
}

export function supersedeSkill(
  saivageRoot: string,
  input: SupersedeSkillInput,
  author: AuthorAgent,
): { new_id: string; old_id: string } {
  const reason = assertReason(input.reason);
  const oldFound = findSkillById(saivageRoot, input.old_id);
  if (!oldFound) throw new KnowledgeStoreError("NOT_FOUND", `skill ${input.old_id} not found`);
  if (!isAllowedSupersedeScopePair(oldFound.record.scope, input.new_record.scope)) {
    writeAuditSafe(oldFound.dir, buildAudit(input.old_id, "supersede", "rejected", author, reason, { error_code: "INVALID_SUPERSEDE_SCOPE" }));
    throw new KnowledgeStoreError("INVALID_SUPERSEDE_SCOPE", `supersede ${oldFound.record.scope}→${input.new_record.scope} not allowed`);
  }
  if (oldFound.record.status !== "active") {
    writeAuditSafe(oldFound.dir, buildAudit(input.old_id, "supersede", "rejected", author, reason, { error_code: "INVALID_SUPERSEDE_TARGET" }));
    throw new KnowledgeStoreError("INVALID_SUPERSEDE_TARGET", `target ${input.old_id} is not active (status=${oldFound.record.status})`);
  }
  const bodyScan = detectSecrets({ body: input.new_record.body, reason });
  if (bodyScan.matches.length > 0) {
    writeAuditSafe(oldFound.dir, buildAudit(SENTINEL_ID, "supersede", "rejected", author, reason, { error_code: "SECRET_DETECTED" }));
    throw new KnowledgeStoreError("SECRET_DETECTED", `secret in: ${[...new Set(bodyScan.matches.map((m) => m.field))].join(", ")}`);
  }
  assertBodyHasNoBlockedPath(input.new_record.body, "body");
  const newId = randomUUID();
  const now = new Date().toISOString();
  const newDir = scopeDir(saivageRoot, "skill", input.new_record.scope, input.new_record.scope_ref);
  ensureDir(join(newDir, "records"));
  const newBodyPath = `records/${newId}.md`;
  const newRecord: SkillRecord = SkillRecordSchema.parse({
    id: newId,
    kind: "skill",
    scope: input.new_record.scope,
    status: "active",
    created_at: now,
    updated_at: now,
    author_agent: author,
    name: input.new_record.name,
    description: input.new_record.description,
    triggers: input.new_record.triggers ?? [],
    target_agents: input.new_record.target_agents ?? [],
    origin: "project",
    body_path: newBodyPath,
    relates_to: [],
    survive_compaction: input.new_record.survive_compaction ?? false,
    supersedes: input.old_id,
    ...(input.new_record.scope_ref ? { scope_ref: input.new_record.scope_ref } : {}),
    ...(input.new_record.expires_at ? { expires_at: input.new_record.expires_at } : {}),
    ...(input.new_record.ttl_ms ? { ttl_ms: input.new_record.ttl_ms } : {}),
  });
  writeFileSync(join(newDir, newBodyPath), input.new_record.body, "utf-8");
  writeRecordAtomic(newDir, newId, SkillRecordSchema, newRecord);
  try {
    const updatedOld = SkillRecordSchema.parse({
      ...oldFound.record,
      status: "superseded",
      superseded_by: newId,
      updated_at: now,
    });
    writeRecordAtomic(oldFound.dir, oldFound.record.id, SkillRecordSchema, updatedOld);
  } catch (err) {
    unlinkRecordIfExists(newDir, newId);
    try { unlinkSync(join(newDir, newBodyPath)); } catch { /* */ }
    writeAuditSafe(newDir, buildAudit(newId, "supersede", "rejected", author, reason, { error_code: "INVALID_SUPERSEDE_TARGET" }));
    throw err;
  }
  writeAuditSafe(newDir, buildAudit(newId, "supersede", "ok", author, `${reason} (old_id=${input.old_id})`, { next_status: "active" }));
  safeRebuild(newDir, SkillRecordSchema);
  if (oldFound.dir !== newDir) safeRebuild(oldFound.dir, SkillRecordSchema);
  return { new_id: newId, old_id: input.old_id };
}

function findSkillById(saivageRoot: string, id: string): { dir: string; record: SkillRecord } | null {
  const all = listAllRecords(saivageRoot, "skill", parseSkill);
  for (const r of all) {
    if (r.id === id) return { dir: scopeDir(saivageRoot, "skill", r.scope, r.scope_ref), record: r };
  }
  return null;
}

// ─── Memory lifecycle ─────────────────────────────────────────────────────

export interface CreateMemoryInput {
  topic: { domain: string; subject: string; aspect?: string };
  keys?: string[];
  body: string;
  target_agents?: KnowledgeAgentRole[];
  scope: KnowledgeScope;
  scope_ref?: string;
  expires_at?: string;
  ttl_ms?: number;
  survive_compaction?: boolean;
  source_ref?: { kind: "inspection" | "task_report" | "stage_summary"; id: string };
  reason: string;
  body_path?: string;
}

function topicKey(t: { domain: string; subject: string; aspect?: string }): string {
  return `${t.domain}/${t.subject}/${t.aspect ?? ""}`;
}

export function createMemory(
  saivageRoot: string,
  input: CreateMemoryInput,
  author: AuthorAgent,
): { id: string; status: "active" } {
  const reason = assertReason(input.reason);
  const dir = scopeDir(saivageRoot, "memory", input.scope, input.scope_ref);
  ensureDir(join(dir, "records"));
  if (input.body_path !== undefined) assertNotBlockedPath(input.body_path, "body_path");
  assertBodyHasNoBlockedPath(input.body, "body");
  const existing = collectScopeActiveRecords(dir, parseMemory);
  const key = topicKey(input.topic);
  if (existing.some((r) => topicKey(r.topic) === key)) {
    writeAuditSafe(dir, buildAudit(SENTINEL_ID, "create", "rejected", author, reason, { error_code: "TOPIC_COLLISION" }));
    throw new KnowledgeStoreError("TOPIC_COLLISION", `topic ${key} already active in scope`);
  }
  const reasonScan = detectSecrets({ reason });
  if (reasonScan.matches.length > 0) {
    writeAuditSafe(dir, buildAudit(SENTINEL_ID, "create", "rejected", author, reason, { error_code: "SECRET_DETECTED" }));
    throw new KnowledgeStoreError("SECRET_DETECTED", "secret in: reason");
  }
  const id = randomUUID();
  const now = new Date().toISOString();
  const record: MemoryRecord = MemoryRecordSchema.parse({
    id,
    kind: "memory",
    scope: input.scope,
    status: "active",
    created_at: now,
    updated_at: now,
    author_agent: author,
    topic: input.topic,
    keys: input.keys ?? [],
    target_agents: input.target_agents ?? [],
    body: input.body,
    relates_to: [],
    survive_compaction: input.survive_compaction ?? false,
    ...(input.source_ref ? { source_ref: input.source_ref } : {}),
    ...(input.scope_ref ? { scope_ref: input.scope_ref } : {}),
    ...(input.expires_at ? { expires_at: input.expires_at } : {}),
    ...(input.ttl_ms ? { ttl_ms: input.ttl_ms } : {}),
  });
  writeRecordAtomic(dir, id, MemoryRecordSchema, record);
  writeAuditSafe(dir, buildAudit(id, "create", "ok", author, reason, { next_status: "active" }));
  safeRebuild(dir, MemoryRecordSchema);
  return { id, status: "active" };
}

export interface UpdateMemoryInput {
  id: string;
  body?: string;
  keys?: string[];
  target_agents?: KnowledgeAgentRole[];
  expires_at?: string;
  ttl_ms?: number;
  reason: string;
}

export function updateMemory(
  saivageRoot: string,
  input: UpdateMemoryInput,
  author: AuthorAgent,
): { id: string; updated_at: string } {
  const reason = assertReason(input.reason);
  const existing = findMemoryById(saivageRoot, input.id);
  if (!existing) throw new KnowledgeStoreError("NOT_FOUND", `memory ${input.id} not found`);
  const { dir, record } = existing;
  if (input.body !== undefined) assertBodyHasNoBlockedPath(input.body, "body");
  const now = new Date().toISOString();
  const updated: MemoryRecord = MemoryRecordSchema.parse({
    ...record,
    body: input.body ?? record.body,
    keys: input.keys ?? record.keys,
    target_agents: input.target_agents ?? record.target_agents,
    ...(input.expires_at !== undefined ? { expires_at: input.expires_at } : {}),
    ...(input.ttl_ms !== undefined ? { ttl_ms: input.ttl_ms } : {}),
    updated_at: now,
  });
  writeRecordAtomic(dir, updated.id, MemoryRecordSchema, updated);
  writeAuditSafe(dir, buildAudit(updated.id, "update", "ok", author, reason));
  safeRebuild(dir, MemoryRecordSchema);
  return { id: updated.id, updated_at: now };
}

export function archiveMemory(
  saivageRoot: string,
  id: string,
  reasonRaw: string,
  author: AuthorAgent,
): { id: string; status: "archived" } {
  const reason = assertReason(reasonRaw);
  const found = findMemoryById(saivageRoot, id);
  if (!found) throw new KnowledgeStoreError("NOT_FOUND", `memory ${id} not found`);
  const { dir, record } = found;
  const updated = MemoryRecordSchema.parse({ ...record, status: "archived", updated_at: new Date().toISOString() });
  writeRecordAtomic(dir, updated.id, MemoryRecordSchema, updated);
  writeAuditSafe(dir, buildAudit(updated.id, "archive", "ok", author, reason, { prev_status: record.status, next_status: "archived" }));
  safeRebuild(dir, MemoryRecordSchema);
  return { id, status: "archived" };
}

export function deleteMemory(
  saivageRoot: string,
  id: string,
  reasonRaw: string,
  author: AuthorAgent,
): { id: string } {
  const reason = assertReason(reasonRaw);
  const found = findMemoryById(saivageRoot, id);
  if (!found) throw new KnowledgeStoreError("NOT_FOUND", `memory ${id} not found`);
  const { dir, record } = found;
  unlinkRecordIfExists(dir, id);
  writeAuditSafe(dir, buildAudit(id, "delete", "ok", author, reason, { prev_status: record.status }));
  safeRebuild(dir, MemoryRecordSchema);
  return { id };
}

export interface SupersedeMemoryInput {
  old_id: string;
  new_record: CreateMemoryInput;
  reason: string;
}

export function supersedeMemory(
  saivageRoot: string,
  input: SupersedeMemoryInput,
  author: AuthorAgent,
): { new_id: string; old_id: string } {
  const reason = assertReason(input.reason);
  const oldFound = findMemoryById(saivageRoot, input.old_id);
  if (!oldFound) throw new KnowledgeStoreError("NOT_FOUND", `memory ${input.old_id} not found`);
  if (!isAllowedSupersedeScopePair(oldFound.record.scope, input.new_record.scope)) {
    writeAuditSafe(oldFound.dir, buildAudit(input.old_id, "supersede", "rejected", author, reason, { error_code: "INVALID_SUPERSEDE_SCOPE" }));
    throw new KnowledgeStoreError("INVALID_SUPERSEDE_SCOPE", `supersede ${oldFound.record.scope}→${input.new_record.scope} not allowed`);
  }
  if (oldFound.record.status !== "active") {
    writeAuditSafe(oldFound.dir, buildAudit(input.old_id, "supersede", "rejected", author, reason, { error_code: "INVALID_SUPERSEDE_TARGET" }));
    throw new KnowledgeStoreError("INVALID_SUPERSEDE_TARGET", `target ${input.old_id} is not active (status=${oldFound.record.status})`);
  }
  assertBodyHasNoBlockedPath(input.new_record.body, "body");
  const newId = randomUUID();
  const now = new Date().toISOString();
  const newDir = scopeDir(saivageRoot, "memory", input.new_record.scope, input.new_record.scope_ref);
  ensureDir(join(newDir, "records"));
  const newRecord: MemoryRecord = MemoryRecordSchema.parse({
    id: newId,
    kind: "memory",
    scope: input.new_record.scope,
    status: "active",
    created_at: now,
    updated_at: now,
    author_agent: author,
    topic: input.new_record.topic,
    keys: input.new_record.keys ?? [],
    target_agents: input.new_record.target_agents ?? [],
    body: input.new_record.body,
    relates_to: [],
    survive_compaction: input.new_record.survive_compaction ?? false,
    supersedes: input.old_id,
    ...(input.new_record.source_ref ? { source_ref: input.new_record.source_ref } : {}),
    ...(input.new_record.scope_ref ? { scope_ref: input.new_record.scope_ref } : {}),
    ...(input.new_record.expires_at ? { expires_at: input.new_record.expires_at } : {}),
    ...(input.new_record.ttl_ms ? { ttl_ms: input.new_record.ttl_ms } : {}),
  });
  writeRecordAtomic(newDir, newId, MemoryRecordSchema, newRecord);
  try {
    const updatedOld = MemoryRecordSchema.parse({
      ...oldFound.record,
      status: "superseded",
      superseded_by: newId,
      updated_at: now,
    });
    writeRecordAtomic(oldFound.dir, oldFound.record.id, MemoryRecordSchema, updatedOld);
  } catch (err) {
    unlinkRecordIfExists(newDir, newId);
    writeAuditSafe(newDir, buildAudit(newId, "supersede", "rejected", author, reason, { error_code: "INVALID_SUPERSEDE_TARGET" }));
    throw err;
  }
  writeAuditSafe(newDir, buildAudit(newId, "supersede", "ok", author, `${reason} (old_id=${input.old_id})`, { next_status: "active" }));
  safeRebuild(newDir, MemoryRecordSchema);
  if (oldFound.dir !== newDir) safeRebuild(oldFound.dir, MemoryRecordSchema);
  return { new_id: newId, old_id: input.old_id };
}

function findMemoryById(saivageRoot: string, id: string): { dir: string; record: MemoryRecord } | null {
  const all = listAllRecords(saivageRoot, "memory", parseMemory);
  for (const r of all) {
    if (r.id === id) return { dir: scopeDir(saivageRoot, "memory", r.scope, r.scope_ref), record: r };
  }
  return null;
}

// ─── Read / list / search ─────────────────────────────────────────────────

export function readSkillById(
  saivageRoot: string,
  id: string,
): { record: SkillRecord; body: string; redacted_spans: number } {
  const found = findSkillById(saivageRoot, id);
  if (!found) throw new KnowledgeStoreError("NOT_FOUND", `skill ${id} not found`);
  const bodyAbs = join(found.dir, found.record.body_path);
  if (!existsSync(bodyAbs)) throw new KnowledgeStoreError("BODY_PATH_BROKEN", `body file missing for ${id}`);
  const raw = readFileSync(bodyAbs, "utf-8");
  const redacted = redactForRead(raw);
  return {
    record: { ...found.record, description: redactForRead(found.record.description).text },
    body: redacted.text,
    redacted_spans: redacted.redacted_spans,
  };
}

export function getMemory(
  saivageRoot: string,
  query: { id?: string; topic?: { domain: string; subject: string; aspect?: string } },
): (MemoryRecord & { redacted_spans: number }) | null {
  const all = listAllRecords(saivageRoot, "memory", parseMemory);
  let start: MemoryRecord | undefined;
  if (query.id) {
    start = all.find((r) => r.id === query.id);
  } else if (query.topic) {
    const key = topicKey(query.topic);
    const order: KnowledgeScope[] = ["session", "stage", "project"];
    for (const scope of order) {
      const cand = all.filter((r) => r.scope === scope && topicKey(r.topic) === key);
      if (cand.length > 0) {
        start = cand.find((r) => r.status === "active") ?? cand[0];
        break;
      }
    }
  }
  if (!start) return null;
  const head = walkSupersedeChain(all, start);
  if (head.status !== "active") return null;
  const redacted = redactForRead(head.body);
  return { ...head, body: redacted.text, redacted_spans: redacted.redacted_spans };
}

export interface ListSkillsFilter {
  scope?: KnowledgeScope;
  target_agent?: KnowledgeAgentRole;
  include_archived?: boolean;
  include_superseded?: boolean;
}

export function listSkills(saivageRoot: string, filter: ListSkillsFilter = {}): Array<{
  id: string; name: string; scope: KnowledgeScope; scope_ref?: string; status: string; updated_at: string;
  triggers: string[]; target_agents: KnowledgeAgentRole[]; survive_compaction: boolean; description: string;
}> {
  const all = listAllRecords(saivageRoot, "skill", parseSkill);
  return all
    .filter((r) => {
      if (filter.scope && r.scope !== filter.scope) return false;
      if (filter.target_agent && r.target_agents.length > 0 && !r.target_agents.includes(filter.target_agent)) return false;
      if (r.status === "archived" && !filter.include_archived) return false;
      if (r.status === "superseded" && !filter.include_superseded) return false;
      return true;
    })
    .map((r) => ({
      id: r.id,
      name: r.name,
      scope: r.scope,
      ...(r.scope_ref ? { scope_ref: r.scope_ref } : {}),
      status: r.status,
      updated_at: r.updated_at,
      triggers: r.triggers,
      target_agents: r.target_agents,
      survive_compaction: r.survive_compaction,
      description: redactForRead(r.description).text,
    }))
    .sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1));
}

export interface ListMemoriesFilter {
  scope?: KnowledgeScope;
  topic_domain?: string;
  include_archived?: boolean;
  older_than_days?: number;
}

export function listMemories(saivageRoot: string, filter: ListMemoriesFilter = {}): Array<{
  id: string; topic: MemoryRecord["topic"]; scope: KnowledgeScope; scope_ref?: string; status: string; updated_at: string;
  keys: string[]; target_agents: KnowledgeAgentRole[]; source_ref?: MemoryRecord["source_ref"];
}> {
  const all = listAllRecords(saivageRoot, "memory", parseMemory);
  const olderCutoff = filter.older_than_days !== undefined
    ? Date.now() - filter.older_than_days * 86400_000
    : undefined;
  return all
    .filter((r) => {
      if (filter.scope && r.scope !== filter.scope) return false;
      if (filter.topic_domain && r.topic.domain !== filter.topic_domain) return false;
      if (r.status === "archived" && !filter.include_archived) return false;
      if (r.status === "superseded") return false;
      if (olderCutoff !== undefined && new Date(r.updated_at).getTime() > olderCutoff) return false;
      return true;
    })
    .map((r) => ({
      id: r.id,
      topic: r.topic,
      scope: r.scope,
      ...(r.scope_ref ? { scope_ref: r.scope_ref } : {}),
      status: r.status,
      updated_at: r.updated_at,
      keys: r.keys,
      target_agents: r.target_agents,
      ...(r.source_ref ? { source_ref: r.source_ref } : {}),
    }))
    .sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1));
}

export interface SearchHit {
  id: string;
  score: number;
  snippet: string;
}

export function searchSkills(
  saivageRoot: string,
  query: string,
  opts: { scope?: KnowledgeScope; limit?: number } = {},
): SearchHit[] {
  const tokens = canonicalizeTokens(query);
  if (tokens.length === 0) return [];
  const all = listAllRecords(saivageRoot, "skill", parseSkill)
    .filter((r) => r.status === "active")
    .filter((r) => !opts.scope || r.scope === opts.scope);
  const hits: Array<{ r: SkillRecord; score: number; snippet: string }> = [];
  for (const r of all) {
    const dir = scopeDir(saivageRoot, "skill", r.scope, r.scope_ref);
    const bodyAbs = join(dir, r.body_path);
    let body = "";
    if (existsSync(bodyAbs)) body = readFileSync(bodyAbs, "utf-8");
    const snippet = body.slice(0, BODY_SNIPPET_MAX);
    const score = scoreSkillForSearch(tokens, {
      id: r.id, name: r.name, description: r.description, triggers: r.triggers,
      body_snippet: snippet, updated_at: r.updated_at,
    });
    if (score === 0) continue;
    hits.push({ r, score, snippet: buildSearchSnippet(snippet, tokens) });
  }
  hits.sort((a, b) => b.score - a.score || (a.r.updated_at < b.r.updated_at ? 1 : -1) || a.r.id.localeCompare(b.r.id));
  const limit = opts.limit ?? 10;
  return hits.slice(0, limit).map((h) => ({
    id: h.r.id,
    score: h.score,
    snippet: redactForRead(h.snippet).text,
  }));
}

export function searchMemories(
  saivageRoot: string,
  query: string,
  opts: { scope?: KnowledgeScope; limit?: number } = {},
): SearchHit[] {
  const tokens = canonicalizeTokens(query);
  if (tokens.length === 0) return [];
  const all = listAllRecords(saivageRoot, "memory", parseMemory)
    .filter((r) => r.status === "active")
    .filter((r) => !opts.scope || r.scope === opts.scope);
  const hits: Array<{ r: MemoryRecord; score: number; snippet: string }> = [];
  for (const r of all) {
    const snippet = r.body.slice(0, BODY_SNIPPET_MAX);
    const score = scoreMemoryForSearch(tokens, {
      id: r.id, topic: r.topic, keys: r.keys, body_snippet: snippet, updated_at: r.updated_at,
    });
    if (score === 0) continue;
    hits.push({ r, score, snippet: buildSearchSnippet(snippet, tokens) });
  }
  hits.sort((a, b) => b.score - a.score || (a.r.updated_at < b.r.updated_at ? 1 : -1) || a.r.id.localeCompare(b.r.id));
  const limit = opts.limit ?? 10;
  return hits.slice(0, limit).map((h) => ({
    id: h.r.id,
    score: h.score,
    snippet: redactForRead(h.snippet).text,
  }));
}

function buildSearchSnippet(text: string, tokens: readonly string[]): string {
  const lower = text.toLowerCase();
  for (const t of tokens) {
    const idx = lower.indexOf(t);
    if (idx >= 0) {
      const half = Math.floor(SEARCH_SNIPPET_WINDOW / 2);
      const start = Math.max(0, idx - half);
      const end = Math.min(text.length, idx + half);
      return text.slice(start, end);
    }
  }
  return text.slice(0, SEARCH_SNIPPET_WINDOW);
}

// ─── Stage / Session archival hooks (WI-11, design §B.4 + §F) ──────────────

/** Synthetic author used when the runtime auto-archives at lifecycle events. */
const SYSTEM_AUTHOR: AuthorAgent = { role: "manager", agent_id: "system" };

interface ScopeArchiveResult {
  archivedSkills: string[];
  archivedMemories: string[];
}

function archiveScope(
  projectRoot: string,
  scope: Exclude<KnowledgeScope, "project">,
  scopeRef: string,
): ScopeArchiveResult {
  const saivageRoot = join(projectRoot, ".saivage");
  const result: ScopeArchiveResult = { archivedSkills: [], archivedMemories: [] };

  archiveOneKind(saivageRoot, "skill", SkillRecordSchema, parseSkill, scope, scopeRef, result.archivedSkills);
  archiveOneKind(saivageRoot, "memory", MemoryRecordSchema, parseMemory, scope, scopeRef, result.archivedMemories);

  return result;
}

function archiveOneKind<T extends KnowledgeRecord>(
  saivageRoot: string,
  kind: "skill" | "memory",
  schema: z.ZodTypeAny,
  parse: ParseFn<T>,
  scope: Exclude<KnowledgeScope, "project">,
  scopeRef: string,
  bucket: string[],
): void {
  const dir = scopeDir(saivageRoot, kind, scope, scopeRef);
  if (!existsSync(dir)) return;
  const records = collectScopeActiveRecords(dir, parse);
  if (records.length === 0) return;

  const recordsDir = join(dir, "records");
  const archiveRecordsDir = join(dir, "archive", "records");
  ensureDir(archiveRecordsDir);

  const now = new Date().toISOString();
  for (const rec of records) {
    const archived = schema.parse({
      ...rec,
      status: "archived",
      updated_at: now,
    }) as T;
    writeFileSync(
      join(archiveRecordsDir, `${archived.id}.json`),
      JSON.stringify(archived, null, 2),
      "utf-8",
    );
    const bodyRel = (archived as { body_path?: string }).body_path;
    if (bodyRel && typeof bodyRel === "string") {
      const liveBody = join(dir, bodyRel);
      const archivedBody = join(dir, "archive", bodyRel);
      if (existsSync(liveBody)) {
        ensureDir(join(archivedBody, ".."));
        try { renameSync(liveBody, archivedBody); } catch { /* best-effort */ }
      }
    }
    const liveRecord = join(recordsDir, `${archived.id}.json`);
    if (existsSync(liveRecord)) {
      try { unlinkSync(liveRecord); } catch { /* best-effort */ }
    }
    writeAuditSafe(
      dir,
      buildAudit(archived.id, "archive", "ok", SYSTEM_AUTHOR, `${scope} ${scopeRef} archived`, {
        prev_status: rec.status,
        next_status: "archived",
      }),
    );
    bucket.push(archived.id);
  }

  safeRebuild(dir, schema);
}

/**
 * Archive every active skill + memory under
 * `<projectRoot>/.saivage/{skills,memory}/stages/<stageId>/`. Idempotent:
 * a second call when no active records remain is a no-op. Records are
 * moved into a sibling `archive/` subtree so subsequent
 * `resolveEagerRecords` calls for the next stage do not see them
 * (FR-9).
 */
export function archiveStage(projectRoot: string, stageId: string): ScopeArchiveResult {
  return archiveScope(projectRoot, "stage", stageId);
}

/**
 * Same as {@link archiveStage} but for session-scoped knowledge under
 * `<projectRoot>/.saivage/{skills,memory}/sessions/<channelId>/`.
 * Called from `ChatAgent` at the channel-close log point.
 */
export function archiveSession(projectRoot: string, channelId: string): ScopeArchiveResult {
  return archiveScope(projectRoot, "session", channelId);
}

