/**
 * Saivage — Knowledge lifecycle operations (post F01 B04).
 *
 * The lifecycle layer now sits on top of the SQLite sidecar
 * (`sidecar.ts` + `sidecar-queries.ts`). The legacy JSON-tree layout
 * (`<saivage>/skills/<scope>/records/*.json` + `audit.jsonl`) is gone.
 *
 * Source: SPEC/v2/skills-memory/01-DESIGN.md §A.5 (transaction order),
 * §B.5 (supersession scope-pair table), §D.3 (search scoring).
 *
 * Each mutation follows the §A.5 template:
 *   1. `requireRuntimeLock` (writer-only);
 *   2. validate (`assertReason`, `assertNoSecrets`, `assertNotBlockedPath`);
 *   3. build row + audit row in memory;
 *   4. `store.sidecar.inTransaction(() => { collisionCheck; mutate; })`;
 *   5. best-effort `store.reingestKind(kind)`; on failure log + bail
 *      (the row already carries `pending_reingest = 1` so the next
 *      successful reingest catches up).
 */

import { randomUUID } from "node:crypto";
import { join } from "node:path";

import {
  KnowledgeStoreError,
  assertNoSecrets,
  assertReason,
} from "./store.js";
import {
  MemoryRecordSchema,
  SkillRecordSchema,
  type AuditOp,
  type KnowledgeAgentRole,
  type KnowledgeRecord,
  type KnowledgeScope,
  type MemoryRecord,
  type SkillRecord,
} from "./types.js";
import {
  activeRecordsByScope,
  archiveScope as archiveScopeMut,
  deleteRecord,
  findActiveMemoryIdByTopic,
  findActiveSkillIdByName,
  getRecord,
  insertAudit,
  listRecordsByStatus,
  loadAllActiveRowsForEager,
  markSuperseded,
  putRecord,
  updateRecord,
} from "./sidecar-queries.js";
import type { KnowledgeStore } from "./init.js";
import type { AuditEntry as SidecarAudit, RecordRow, SidecarHandle } from "./sidecar.js";
import { openSidecar } from "./sidecar.js";
import { isBlockedPath } from "../security/secrets.js";
import { assertRuntimeLockHeld } from "../runtime/runtime-lock.js";
import {
  canonicalizeTokens,
  redactForRead,
  scoreMemoryForSearch,
  scoreSkillForSearch,
} from "./loader.js";
import { log } from "../log.js";

const BODY_SNIPPET_MAX = 500;
const SEARCH_SNIPPET_WINDOW = 200;

export interface AuthorAgent {
  role: KnowledgeAgentRole;
  agent_id: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────

function saivageRootOf(store: KnowledgeStore): string {
  return join(store.projectRoot, ".saivage");
}

function requireRuntimeLock(saivageRoot: string): void {
  try {
    assertRuntimeLockHeld(saivageRoot);
  } catch (err) {
    throw new KnowledgeStoreError(
      "NO_RUNTIME_LOCK",
      err instanceof Error ? err.message : String(err),
    );
  }
}

function nowIso(): string {
  return new Date().toISOString();
}

function assertScopeRef(scope: KnowledgeScope, scopeRef: string | undefined): void {
  if (scope === "project") return;
  if (typeof scopeRef !== "string" || scopeRef.length === 0) {
    throw new KnowledgeStoreError(
      "INVALID_SCOPE_REF",
      "scope=" + scope + " requires scope_ref",
    );
  }
}

function topicKey(t: { domain: string; subject: string; aspect?: string }): string {
  return t.domain + "\u0001" + t.subject + "\u0001" + (t.aspect ?? "");
}

function isAllowedSupersedeScopePair(
  oldScope: KnowledgeScope,
  newScope: KnowledgeScope,
): boolean {
  if (oldScope === "project") return newScope === "project";
  if (oldScope === "stage") return newScope === "project" || newScope === "stage";
  if (oldScope === "session") return newScope === "project" || newScope === "session";
  return false;
}

function assertBodyHasNoBlockedPath(body: string, field = "body"): void {
  for (const tokenRaw of body.split(/\s+/)) {
    const token = tokenRaw.replace(/^[[(<"'`]+|[\])>"'`,;:.]+$/g, "");
    if (token.length === 0) continue;
    if (!token.includes("/") && !token.startsWith(".env")) continue;
    if (isBlockedPath(token)) {
      throw new KnowledgeStoreError(
        "BLOCKED_PATH",
        field + " contains blocked path: " + token,
      );
    }
  }
}

function rowToSkill(row: RecordRow): SkillRecord {
  return SkillRecordSchema.parse(JSON.parse(row.record_json));
}

function rowToMemory(row: RecordRow): MemoryRecord {
  return MemoryRecordSchema.parse(JSON.parse(row.record_json));
}

function buildAudit(
  recordId: string,
  op: AuditOp,
  author: AuthorAgent,
  reason: string,
  before: unknown,
  after: unknown,
): SidecarAudit {
  return {
    record_id: recordId,
    ts: nowIso(),
    op,
    actor_role: author.role,
    actor_agent_id: author.agent_id,
    before_json: before === undefined ? null : JSON.stringify(before),
    after_json: after === undefined ? null : JSON.stringify({ ...(after as Record<string, unknown>), reason }),
  };
}

async function reingestBestEffort(store: KnowledgeStore, kind: "skill" | "memory"): Promise<void> {
  try {
    await store.reingestKind(kind);
  } catch (err) {
    log.warn(
      "knowledge.rag-reingest-failed " +
        JSON.stringify({ kind, err: (err as Error).message }),
    );
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

export async function createSkill(
  store: KnowledgeStore,
  input: CreateSkillInput,
  author: AuthorAgent,
): Promise<{ id: string; status: "active" }> {
  requireRuntimeLock(saivageRootOf(store));
  const reason = assertReason(input.reason);
  assertScopeRef(input.scope, input.scope_ref);
  assertNoSecrets({ body: input.body, reason, description: input.description });
  assertBodyHasNoBlockedPath(input.body, "body");

  const id = randomUUID();
  const now = nowIso();
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
    relates_to: [],
    survive_compaction: input.survive_compaction ?? false,
    ...(input.scope_ref ? { scope_ref: input.scope_ref } : {}),
    ...(input.expires_at ? { expires_at: input.expires_at } : {}),
    ...(input.ttl_ms ? { ttl_ms: input.ttl_ms } : {}),
  });
  const row: RecordRow = {
    id,
    kind: "skill",
    scope: input.scope,
    scope_ref: input.scope_ref ?? null,
    status: "active",
    origin: "project",
    record_json: JSON.stringify(record),
    body: input.body,
    created_at: now,
    updated_at: now,
    supersedes: null,
    superseded_by: null,
    pending_reingest: 1,
  };
  const audit = buildAudit(id, "create", author, reason, null, { status: "active" });

  store.sidecar.inTransaction(() => {
    const dup = findActiveSkillIdByName(
      store.sidecar,
      input.scope,
      input.scope_ref ?? null,
      input.name,
    );
    if (dup !== undefined) {
      throw new KnowledgeStoreError(
        "NAME_COLLISION",
        "skill name '" + input.name + "' already active in scope",
      );
    }
    putRecord(store.sidecar, row, { kind: "skill", name: input.name }, audit);
  });
  await reingestBestEffort(store, "skill");
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

export async function updateSkill(
  store: KnowledgeStore,
  input: UpdateSkillInput,
  author: AuthorAgent,
): Promise<{ id: string; updated_at: string }> {
  requireRuntimeLock(saivageRootOf(store));
  const reason = assertReason(input.reason);
  if (input.body !== undefined) {
    assertNoSecrets({ body: input.body });
    assertBodyHasNoBlockedPath(input.body, "body");
  }
  if (input.description !== undefined) {
    assertNoSecrets({ description: input.description });
  }

  const now = nowIso();
  let outId = input.id;
  store.sidecar.inTransaction(() => {
    const existing = getRecord(store.sidecar, input.id);
    if (!existing || existing.kind !== "skill") {
      throw new KnowledgeStoreError("NOT_FOUND", "skill " + input.id + " not found");
    }
    const prior = rowToSkill(existing);
    const updated: SkillRecord = SkillRecordSchema.parse({
      ...prior,
      description: input.description ?? prior.description,
      triggers: input.triggers ?? prior.triggers,
      target_agents: input.target_agents ?? prior.target_agents,
      ...(input.expires_at !== undefined ? { expires_at: input.expires_at } : {}),
      ...(input.ttl_ms !== undefined ? { ttl_ms: input.ttl_ms } : {}),
      updated_at: now,
    });
    const row: RecordRow = {
      ...existing,
      status: existing.status,
      record_json: JSON.stringify(updated),
      body: input.body ?? existing.body,
      updated_at: now,
      pending_reingest: 1,
    };
    const audit = buildAudit(
      input.id,
      "update",
      author,
      reason,
      { record: prior },
      { record: updated },
    );
    updateRecord(store.sidecar, row, audit);
    outId = updated.id;
  });
  await reingestBestEffort(store, "skill");
  return { id: outId, updated_at: now };
}

export async function archiveSkill(
  store: KnowledgeStore,
  id: string,
  reasonRaw: string,
  author: AuthorAgent,
): Promise<{ id: string; status: "archived" }> {
  requireRuntimeLock(saivageRootOf(store));
  const reason = assertReason(reasonRaw);
  const now = nowIso();
  store.sidecar.inTransaction(() => {
    const existing = getRecord(store.sidecar, id);
    if (!existing || existing.kind !== "skill") {
      throw new KnowledgeStoreError("NOT_FOUND", "skill " + id + " not found");
    }
    const prior = rowToSkill(existing);
    const updated = SkillRecordSchema.parse({ ...prior, status: "archived", updated_at: now });
    const row: RecordRow = {
      ...existing,
      status: "archived",
      record_json: JSON.stringify(updated),
      updated_at: now,
      pending_reingest: 1,
    };
    const audit = buildAudit(
      id,
      "archive",
      author,
      reason,
      { status: prior.status },
      { status: "archived" },
    );
    updateRecord(store.sidecar, row, audit);
  });
  await reingestBestEffort(store, "skill");
  return { id, status: "archived" };
}

export async function deleteSkill(
  store: KnowledgeStore,
  id: string,
  reasonRaw: string,
  author: AuthorAgent,
): Promise<{ id: string }> {
  requireRuntimeLock(saivageRootOf(store));
  const reason = assertReason(reasonRaw);
  store.sidecar.inTransaction(() => {
    const existing = getRecord(store.sidecar, id);
    if (!existing || existing.kind !== "skill") {
      throw new KnowledgeStoreError("NOT_FOUND", "skill " + id + " not found");
    }
    const audit = buildAudit(
      id,
      "delete",
      author,
      reason,
      { status: existing.status },
      { status: "deleted" },
    );
    deleteRecord(store.sidecar, id, audit);
  });
  await reingestBestEffort(store, "skill");
  return { id };
}

export interface SupersedeSkillInput {
  old_id: string;
  new_record: CreateSkillInput;
  reason: string;
}

export async function supersedeSkill(
  store: KnowledgeStore,
  input: SupersedeSkillInput,
  author: AuthorAgent,
): Promise<{ new_id: string; old_id: string }> {
  requireRuntimeLock(saivageRootOf(store));
  const reason = assertReason(input.reason);
  assertScopeRef(input.new_record.scope, input.new_record.scope_ref);
  assertNoSecrets({ body: input.new_record.body, reason, description: input.new_record.description });
  assertBodyHasNoBlockedPath(input.new_record.body, "body");

  const newId = randomUUID();
  const now = nowIso();
  store.sidecar.inTransaction(() => {
    const oldRow = getRecord(store.sidecar, input.old_id);
    if (!oldRow || oldRow.kind !== "skill") {
      throw new KnowledgeStoreError("NOT_FOUND", "skill " + input.old_id + " not found");
    }
    if (!isAllowedSupersedeScopePair(oldRow.scope as KnowledgeScope, input.new_record.scope)) {
      throw new KnowledgeStoreError(
        "INVALID_SUPERSEDE_SCOPE",
        "supersede " + oldRow.scope + "\u2192" + input.new_record.scope + " not allowed",
      );
    }
    if (oldRow.status !== "active") {
      throw new KnowledgeStoreError(
        "INVALID_SUPERSEDE_TARGET",
        "target " + input.old_id + " is not active (status=" + oldRow.status + ")",
      );
    }
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
      relates_to: [],
      survive_compaction: input.new_record.survive_compaction ?? false,
      supersedes: input.old_id,
      ...(input.new_record.scope_ref ? { scope_ref: input.new_record.scope_ref } : {}),
      ...(input.new_record.expires_at ? { expires_at: input.new_record.expires_at } : {}),
      ...(input.new_record.ttl_ms ? { ttl_ms: input.new_record.ttl_ms } : {}),
    });
    const newRow: RecordRow = {
      id: newId,
      kind: "skill",
      scope: input.new_record.scope,
      scope_ref: input.new_record.scope_ref ?? null,
      status: "active",
      origin: "project",
      record_json: JSON.stringify(newRecord),
      body: input.new_record.body,
      created_at: now,
      updated_at: now,
      supersedes: input.old_id,
      superseded_by: null,
      pending_reingest: 1,
    };
    putRecord(
      store.sidecar,
      newRow,
      { kind: "skill", name: input.new_record.name },
      buildAudit(
        newId,
        "supersede",
        author,
        reason + " (old_id=" + input.old_id + ")",
        null,
        { status: "active", supersedes: input.old_id },
      ),
    );
    markSuperseded(
      store.sidecar,
      input.old_id,
      newId,
      now,
      buildAudit(
        input.old_id,
        "supersede",
        author,
        reason + " (new_id=" + newId + ")",
        { status: "active" },
        { status: "superseded", superseded_by: newId },
      ),
    );
  });
  await reingestBestEffort(store, "skill");
  return { new_id: newId, old_id: input.old_id };
}

export async function findSkillById(
  store: KnowledgeStore,
  id: string,
): Promise<{ record: SkillRecord; body: string } | null> {
  const row = getRecord(store.sidecar, id);
  if (!row || row.kind !== "skill") return null;
  return { record: rowToSkill(row), body: row.body };
}

export async function readSkillById(
  store: KnowledgeStore,
  id: string,
): Promise<{ record: SkillRecord; body: string; redacted_spans: number }> {
  const found = await findSkillById(store, id);
  if (!found) throw new KnowledgeStoreError("NOT_FOUND", "skill " + id + " not found");
  const redacted = redactForRead(found.body);
  return {
    record: { ...found.record, description: redactForRead(found.record.description).text },
    body: redacted.text,
    redacted_spans: redacted.redacted_spans,
  };
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
}

export async function createMemory(
  store: KnowledgeStore,
  input: CreateMemoryInput,
  author: AuthorAgent,
): Promise<{ id: string; status: "active" }> {
  requireRuntimeLock(saivageRootOf(store));
  const reason = assertReason(input.reason);
  assertScopeRef(input.scope, input.scope_ref);
  assertNoSecrets({ body: input.body, reason });
  assertBodyHasNoBlockedPath(input.body, "body");

  const id = randomUUID();
  const now = nowIso();
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
  const row: RecordRow = {
    id,
    kind: "memory",
    scope: input.scope,
    scope_ref: input.scope_ref ?? null,
    status: "active",
    origin: "project",
    record_json: JSON.stringify(record),
    body: input.body,
    created_at: now,
    updated_at: now,
    supersedes: null,
    superseded_by: null,
    pending_reingest: 1,
  };
  const key = topicKey(input.topic);
  const audit = buildAudit(id, "create", author, reason, null, { status: "active" });

  store.sidecar.inTransaction(() => {
    const dup = findActiveMemoryIdByTopic(
      store.sidecar,
      input.scope,
      input.scope_ref ?? null,
      key,
    );
    if (dup !== undefined) {
      throw new KnowledgeStoreError(
        "TOPIC_COLLISION",
        "topic " + input.topic.domain + "/" + input.topic.subject +
          (input.topic.aspect ? "/" + input.topic.aspect : "") +
          " already active in scope",
      );
    }
    putRecord(store.sidecar, row, { kind: "memory", topic: key }, audit);
  });
  await reingestBestEffort(store, "memory");
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

export async function updateMemory(
  store: KnowledgeStore,
  input: UpdateMemoryInput,
  author: AuthorAgent,
): Promise<{ id: string; updated_at: string }> {
  requireRuntimeLock(saivageRootOf(store));
  const reason = assertReason(input.reason);
  if (input.body !== undefined) {
    assertNoSecrets({ body: input.body });
    assertBodyHasNoBlockedPath(input.body, "body");
  }
  const now = nowIso();
  let outId = input.id;
  store.sidecar.inTransaction(() => {
    const existing = getRecord(store.sidecar, input.id);
    if (!existing || existing.kind !== "memory") {
      throw new KnowledgeStoreError("NOT_FOUND", "memory " + input.id + " not found");
    }
    const prior = rowToMemory(existing);
    const updated: MemoryRecord = MemoryRecordSchema.parse({
      ...prior,
      body: input.body ?? prior.body,
      keys: input.keys ?? prior.keys,
      target_agents: input.target_agents ?? prior.target_agents,
      ...(input.expires_at !== undefined ? { expires_at: input.expires_at } : {}),
      ...(input.ttl_ms !== undefined ? { ttl_ms: input.ttl_ms } : {}),
      updated_at: now,
    });
    const row: RecordRow = {
      ...existing,
      record_json: JSON.stringify(updated),
      body: input.body ?? existing.body,
      updated_at: now,
      pending_reingest: 1,
    };
    const audit = buildAudit(
      input.id,
      "update",
      author,
      reason,
      { record: prior },
      { record: updated },
    );
    updateRecord(store.sidecar, row, audit);
    outId = updated.id;
  });
  await reingestBestEffort(store, "memory");
  return { id: outId, updated_at: now };
}

export async function archiveMemory(
  store: KnowledgeStore,
  id: string,
  reasonRaw: string,
  author: AuthorAgent,
): Promise<{ id: string; status: "archived" }> {
  requireRuntimeLock(saivageRootOf(store));
  const reason = assertReason(reasonRaw);
  const now = nowIso();
  store.sidecar.inTransaction(() => {
    const existing = getRecord(store.sidecar, id);
    if (!existing || existing.kind !== "memory") {
      throw new KnowledgeStoreError("NOT_FOUND", "memory " + id + " not found");
    }
    const prior = rowToMemory(existing);
    const updated = MemoryRecordSchema.parse({ ...prior, status: "archived", updated_at: now });
    const row: RecordRow = {
      ...existing,
      status: "archived",
      record_json: JSON.stringify(updated),
      updated_at: now,
      pending_reingest: 1,
    };
    const audit = buildAudit(
      id,
      "archive",
      author,
      reason,
      { status: prior.status },
      { status: "archived" },
    );
    updateRecord(store.sidecar, row, audit);
  });
  await reingestBestEffort(store, "memory");
  return { id, status: "archived" };
}

export async function deleteMemory(
  store: KnowledgeStore,
  id: string,
  reasonRaw: string,
  author: AuthorAgent,
): Promise<{ id: string }> {
  requireRuntimeLock(saivageRootOf(store));
  const reason = assertReason(reasonRaw);
  store.sidecar.inTransaction(() => {
    const existing = getRecord(store.sidecar, id);
    if (!existing || existing.kind !== "memory") {
      throw new KnowledgeStoreError("NOT_FOUND", "memory " + id + " not found");
    }
    const audit = buildAudit(
      id,
      "delete",
      author,
      reason,
      { status: existing.status },
      { status: "deleted" },
    );
    deleteRecord(store.sidecar, id, audit);
  });
  await reingestBestEffort(store, "memory");
  return { id };
}

export interface SupersedeMemoryInput {
  old_id: string;
  new_record: CreateMemoryInput;
  reason: string;
}

export async function supersedeMemory(
  store: KnowledgeStore,
  input: SupersedeMemoryInput,
  author: AuthorAgent,
): Promise<{ new_id: string; old_id: string }> {
  requireRuntimeLock(saivageRootOf(store));
  const reason = assertReason(input.reason);
  assertScopeRef(input.new_record.scope, input.new_record.scope_ref);
  assertNoSecrets({ body: input.new_record.body, reason });
  assertBodyHasNoBlockedPath(input.new_record.body, "body");

  const newId = randomUUID();
  const now = nowIso();
  store.sidecar.inTransaction(() => {
    const oldRow = getRecord(store.sidecar, input.old_id);
    if (!oldRow || oldRow.kind !== "memory") {
      throw new KnowledgeStoreError("NOT_FOUND", "memory " + input.old_id + " not found");
    }
    if (!isAllowedSupersedeScopePair(oldRow.scope as KnowledgeScope, input.new_record.scope)) {
      throw new KnowledgeStoreError(
        "INVALID_SUPERSEDE_SCOPE",
        "supersede " + oldRow.scope + "\u2192" + input.new_record.scope + " not allowed",
      );
    }
    if (oldRow.status !== "active") {
      throw new KnowledgeStoreError(
        "INVALID_SUPERSEDE_TARGET",
        "target " + input.old_id + " is not active (status=" + oldRow.status + ")",
      );
    }
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
    const newRow: RecordRow = {
      id: newId,
      kind: "memory",
      scope: input.new_record.scope,
      scope_ref: input.new_record.scope_ref ?? null,
      status: "active",
      origin: "project",
      record_json: JSON.stringify(newRecord),
      body: input.new_record.body,
      created_at: now,
      updated_at: now,
      supersedes: input.old_id,
      superseded_by: null,
      pending_reingest: 1,
    };
    putRecord(
      store.sidecar,
      newRow,
      { kind: "memory", topic: topicKey(input.new_record.topic) },
      buildAudit(
        newId,
        "supersede",
        author,
        reason + " (old_id=" + input.old_id + ")",
        null,
        { status: "active", supersedes: input.old_id },
      ),
    );
    markSuperseded(
      store.sidecar,
      input.old_id,
      newId,
      now,
      buildAudit(
        input.old_id,
        "supersede",
        author,
        reason + " (new_id=" + newId + ")",
        { status: "active" },
        { status: "superseded", superseded_by: newId },
      ),
    );
  });
  await reingestBestEffort(store, "memory");
  return { new_id: newId, old_id: input.old_id };
}

export async function findMemoryById(
  store: KnowledgeStore,
  id: string,
): Promise<{ record: MemoryRecord; body: string } | null> {
  const row = getRecord(store.sidecar, id);
  if (!row || row.kind !== "memory") return null;
  return { record: rowToMemory(row), body: row.body };
}

export async function getMemory(
  store: KnowledgeStore,
  query: { id?: string; topic?: { domain: string; subject: string; aspect?: string } },
): Promise<(MemoryRecord & { redacted_spans: number }) | null> {
  let row: RecordRow | undefined;
  if (query.id) {
    row = getRecord(store.sidecar, query.id);
    if (!row || row.kind !== "memory") return null;
  } else if (query.topic) {
    const key = topicKey(query.topic);
    const order: KnowledgeScope[] = ["session", "stage", "project"];
    outer: for (const scope of order) {
      const rows = store.sidecar.db
        .prepare(
          "SELECT r.* FROM record r JOIN record_memory m ON m.id = r.id" +
            " WHERE r.kind = 'memory' AND r.status = 'active' AND r.scope = ? AND m.topic = ?",
        )
        .all(scope, key) as RecordRow[];
      if (rows.length > 0) {
        row = rows[0];
        break outer;
      }
    }
    if (!row) return null;
  } else {
    return null;
  }
  const head = walkSupersedeChainRow(store.sidecar, row);
  if (!head || head.status !== "active") return null;
  const rec = rowToMemory(head);
  const redacted = redactForRead(head.body);
  return { ...rec, body: redacted.text, redacted_spans: redacted.redacted_spans };
}

function walkSupersedeChainRow(sidecar: SidecarHandle, start: RecordRow): RecordRow | null {
  let cur: RecordRow = start;
  const seen = new Set<string>([cur.id]);
  while (cur.superseded_by) {
    const next = getRecord(sidecar, cur.superseded_by);
    if (!next || seen.has(next.id)) return cur;
    seen.add(next.id);
    cur = next;
  }
  return cur;
}

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

// ─── Read / list / search ─────────────────────────────────────────────────

export interface ListSkillsFilter {
  scope?: KnowledgeScope;
  target_agent?: KnowledgeAgentRole;
  include_archived?: boolean;
  include_superseded?: boolean;
}

export async function listSkills(
  store: KnowledgeStore,
  filter: ListSkillsFilter = {},
): Promise<Array<{
  id: string; name: string; scope: KnowledgeScope; scope_ref?: string; status: string; updated_at: string;
  triggers: string[]; target_agents: KnowledgeAgentRole[]; survive_compaction: boolean; description: string;
}>> {
  const rows = allSkillRows(store.sidecar);
  return rows
    .map((r) => rowToSkill(r))
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

export async function listMemories(
  store: KnowledgeStore,
  filter: ListMemoriesFilter = {},
): Promise<Array<{
  id: string; topic: MemoryRecord["topic"]; scope: KnowledgeScope; scope_ref?: string; status: string;
  updated_at: string; keys: string[]; target_agents: KnowledgeAgentRole[]; source_ref?: MemoryRecord["source_ref"];
}>> {
  const rows = allMemoryRows(store.sidecar);
  const olderCutoff = filter.older_than_days !== undefined
    ? Date.now() - filter.older_than_days * 86_400_000
    : undefined;
  return rows
    .map((r) => rowToMemory(r))
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

export async function searchSkills(
  store: KnowledgeStore,
  query: string,
  opts: { scope?: KnowledgeScope; limit?: number } = {},
): Promise<SearchHit[]> {
  const tokens = canonicalizeTokens(query);
  if (tokens.length === 0) return [];
  const rows = allActiveSkillRows(store.sidecar).filter((r) => !opts.scope || r.scope === opts.scope);
  const hits: Array<{ id: string; score: number; updated_at: string; snippet: string }> = [];
  for (const row of rows) {
    const rec = rowToSkill(row);
    const snippet = row.body.slice(0, BODY_SNIPPET_MAX);
    const score = scoreSkillForSearch(tokens, {
      id: rec.id,
      name: rec.name,
      description: rec.description,
      triggers: rec.triggers,
      body_snippet: snippet,
      updated_at: rec.updated_at,
    });
    if (score === 0) continue;
    hits.push({ id: rec.id, score, updated_at: rec.updated_at, snippet: buildSearchSnippet(snippet, tokens) });
  }
  hits.sort((a, b) =>
    b.score - a.score || (a.updated_at < b.updated_at ? 1 : -1) || a.id.localeCompare(b.id),
  );
  const limit = opts.limit ?? 10;
  return hits.slice(0, limit).map((h) => ({
    id: h.id,
    score: h.score,
    snippet: redactForRead(h.snippet).text,
  }));
}

export async function searchMemories(
  store: KnowledgeStore,
  query: string,
  opts: { scope?: KnowledgeScope; limit?: number } = {},
): Promise<SearchHit[]> {
  const tokens = canonicalizeTokens(query);
  if (tokens.length === 0) return [];
  const rows = allActiveMemoryRows(store.sidecar).filter((r) => !opts.scope || r.scope === opts.scope);
  const hits: Array<{ id: string; score: number; updated_at: string; snippet: string }> = [];
  for (const row of rows) {
    const rec = rowToMemory(row);
    const snippet = row.body.slice(0, BODY_SNIPPET_MAX);
    const score = scoreMemoryForSearch(tokens, {
      id: rec.id,
      topic: rec.topic,
      keys: rec.keys,
      body_snippet: snippet,
      updated_at: rec.updated_at,
    });
    if (score === 0) continue;
    hits.push({ id: rec.id, score, updated_at: rec.updated_at, snippet: buildSearchSnippet(snippet, tokens) });
  }
  hits.sort((a, b) =>
    b.score - a.score || (a.updated_at < b.updated_at ? 1 : -1) || a.id.localeCompare(b.id),
  );
  const limit = opts.limit ?? 10;
  return hits.slice(0, limit).map((h) => ({
    id: h.id,
    score: h.score,
    snippet: redactForRead(h.snippet).text,
  }));
}

function allSkillRows(sidecar: SidecarHandle): RecordRow[] {
  return sidecar.db.prepare("SELECT * FROM record WHERE kind = 'skill'").all() as RecordRow[];
}

function allMemoryRows(sidecar: SidecarHandle): RecordRow[] {
  return sidecar.db.prepare("SELECT * FROM record WHERE kind = 'memory'").all() as RecordRow[];
}

function allActiveSkillRows(sidecar: SidecarHandle): RecordRow[] {
  return sidecar.db
    .prepare("SELECT * FROM record WHERE kind = 'skill' AND status = 'active'")
    .all() as RecordRow[];
}

function allActiveMemoryRows(sidecar: SidecarHandle): RecordRow[] {
  return sidecar.db
    .prepare("SELECT * FROM record WHERE kind = 'memory' AND status = 'active'")
    .all() as RecordRow[];
}

export async function listAllRecords<T extends KnowledgeRecord>(
  store: KnowledgeStore,
  kind: "skill" | "memory",
): Promise<T[]> {
  const rows = kind === "skill" ? allSkillRows(store.sidecar) : allMemoryRows(store.sidecar);
  return rows.map((r) => (kind === "skill" ? rowToSkill(r) : rowToMemory(r))) as T[];
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

// ─── Stage / Session archival hooks (design §B.4 + §F) ────────────────────

/** Synthetic author used when the runtime auto-archives at lifecycle events. */
const SYSTEM_AUTHOR: AuthorAgent = { role: "manager", agent_id: "system" };

export interface ScopeArchiveResult {
  archivedSkills: string[];
  archivedMemories: string[];
}

/**
 * Archive every active skill + memory record under
 * `(scope=stage, scope_ref=stageId)`. Opens its own sidecar handle so
 * callers (chat agent, plan-server) need not hold a `KnowledgeStore`
 * reference yet (will be threaded in B07).
 *
 * Idempotent: a second call when no active records remain is a no-op.
 * Reingest is deferred to the next mutation / divergence sweep: the
 * archived rows already carry `pending_reingest = 1`.
 */
export async function archiveStage(
  projectRoot: string,
  stageId: string,
): Promise<ScopeArchiveResult> {
  return archiveScopeForProject(projectRoot, "stage", stageId);
}

/**
 * Same as {@link archiveStage} but for `(scope=session, scope_ref=channelId)`.
 */
export async function archiveSession(
  projectRoot: string,
  channelId: string,
): Promise<ScopeArchiveResult> {
  return archiveScopeForProject(projectRoot, "session", channelId);
}

async function archiveScopeForProject(
  projectRoot: string,
  scope: Exclude<KnowledgeScope, "project">,
  scopeRef: string,
): Promise<ScopeArchiveResult> {
  const saivageRoot = join(projectRoot, ".saivage");
  requireRuntimeLock(saivageRoot);
  const sidecar = await openSidecar(projectRoot);
  const ts = nowIso();
  try {
    let archivedSkills: string[] = [];
    let archivedMemories: string[] = [];
    sidecar.inTransaction(() => {
      archivedSkills = archiveScopeMut(
        sidecar,
        "skill",
        scope,
        scopeRef,
        SYSTEM_AUTHOR.role,
        SYSTEM_AUTHOR.agent_id,
        scope + " " + scopeRef + " archived",
        ts,
      );
      archivedMemories = archiveScopeMut(
        sidecar,
        "memory",
        scope,
        scopeRef,
        SYSTEM_AUTHOR.role,
        SYSTEM_AUTHOR.agent_id,
        scope + " " + scopeRef + " archived",
        ts,
      );
      // Sync record_json.status with the column we just bumped so eager
      // loaders / search reads stay consistent without a reingest.
      for (const id of [...archivedSkills, ...archivedMemories]) {
        const row = getRecord(sidecar, id);
        if (!row) continue;
        try {
          const parsed = JSON.parse(row.record_json) as Record<string, unknown>;
          parsed.status = "archived";
          parsed.updated_at = ts;
          sidecar.db
            .prepare("UPDATE record SET record_json = ? WHERE id = ?")
            .run(JSON.stringify(parsed), id);
        } catch {
          // Leave malformed rows alone; divergence sweep will report.
        }
      }
    });
    return { archivedSkills, archivedMemories };
  } finally {
    sidecar.close();
  }
}

// Re-export sidecar query helpers that tests / callers conveniently want.
export { listRecordsByStatus, activeRecordsByScope, loadAllActiveRowsForEager, insertAudit };
