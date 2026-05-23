/**
 * Saivage — Knowledge store primitives.
 *
 * Source of truth: SPEC/v2/skills-memory/01-DESIGN.md §C.3.
 * Implements writeRecordAtomic, appendJsonlAtomic, rebuildIndex,
 * per-record + per-scope mutexes, and the two-key supersede lock.
 *
 * NOTE: This file contains only the store primitives. The MCP tool
 * facade (`create_skill`, `supersede_memory`, …) is implemented in
 * later milestones (M2/M3) on top of these primitives.
 */

import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { join, dirname } from "node:path";
import type { z, ZodTypeAny } from "zod";

import { writeDoc } from "../store/documents.js";
import { isBlockedPath, redact, scanForSecrets, type SecretMatch } from "../security/secrets.js";
import {
  AuditEntrySchema,
  type AuditEntry,
  type AuditOp,
  type KnowledgeRecord,
  LifecycleStatusSchema,
} from "./types.js";

/** All error codes returned by the store layer (design §C.3 taxonomy). */
export type KnowledgeErrorCode =
  | "UNAUTHORIZED_ROLE"
  | "UNAUTHORIZED_SCOPE"
  | "NOT_FOUND"
  | "EMPTY_REASON"
  | "INVALID_SCOPE_REF"
  | "INVALID_SUPERSEDE_TARGET"
  | "TOPIC_COLLISION"
  | "NAME_COLLISION"
  | "INVALID_SUPERSEDE_SCOPE"
  | "SECRET_DETECTED"
  | "BLOCKED_PATH"
  | "BODY_PATH_BROKEN"
  | "OVERSIZED_SURVIVOR"
  | "MALFORMED_AUDIT_LINE"
  | "INDEX_REBUILD_FAILED";

export class KnowledgeStoreError extends Error {
  constructor(
    public readonly code: KnowledgeErrorCode,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "KnowledgeStoreError";
  }
}

/** Audit-line hard cap per design §C.3 (PIPE_BUF safety margin). */
const AUDIT_LINE_MAX_BYTES = 2048;
const AUDIT_TRUNCATE_SUFFIX = "…[truncated]";

/** Module-scoped per-key mutex chains. */
const recordLocks = new Map<string, Promise<void>>();
const scopeLocks = new Map<string, Promise<void>>();

/** Lock key shape: `<kind>:<scope>:<scope_ref|_>:<id>`. */
export function recordLockKey(record: {
  kind: KnowledgeRecord["kind"];
  scope: KnowledgeRecord["scope"];
  scope_ref?: string;
  id: string;
}): string {
  return `${record.kind}:${record.scope}:${record.scope_ref ?? "_"}:${record.id}`;
}

/** Lock key shape for a scope tree (used by rebuildIndex). */
export function scopeLockKey(kind: KnowledgeRecord["kind"], scope: KnowledgeRecord["scope"], scopeRef?: string): string {
  return `${kind}:${scope}:${scopeRef ?? "_"}`;
}

/** Acquire a single named lock; returns the release function. */
async function acquire(map: Map<string, Promise<void>>, key: string): Promise<() => void> {
  const prev = map.get(key) ?? Promise.resolve();
  let release!: () => void;
  const next = new Promise<void>((res) => {
    release = res;
  });
  map.set(key, prev.then(() => next));
  await prev;
  return () => {
    release();
    // GC entry when nothing is waiting on it (best-effort).
    if (map.get(key) === next) map.delete(key);
  };
}

/** Acquire two locks in deterministic lex order to avoid deadlock. */
export async function acquireTwoRecordLocks(a: string, b: string): Promise<() => Promise<void>> {
  const [first, second] = a < b ? [a, b] : [b, a];
  const release1 = await acquire(recordLocks, first);
  let release2: () => void;
  try {
    release2 = await acquire(recordLocks, second);
  } catch (err) {
    release1();
    throw err;
  }
  return async () => {
    release2();
    release1();
  };
}

/** Public helper for tests — single-key record lock. */
export async function acquireRecordLock(key: string): Promise<() => void> {
  return acquire(recordLocks, key);
}

/** Public helper for tests — per-scope index lock. */
export async function acquireScopeLock(key: string): Promise<() => void> {
  return acquire(scopeLocks, key);
}

function ensureDir(p: string): void {
  if (!existsSync(p)) mkdirSync(p, { recursive: true });
}

/**
 * Verify that `record.(scope, scope_ref)` matches the supplied target dir.
 * `dir` is expected to be the scope subtree, e.g. `…/skills/stages/<id>`.
 */
export function assertScopePathCoherence(
  dir: string,
  record: Pick<KnowledgeRecord, "scope" | "scope_ref">,
): void {
  const normalized = dir.replace(/\\/g, "/").replace(/\/+$/, "");
  if (record.scope === "project") {
    if (!normalized.endsWith("/project")) {
      throw new KnowledgeStoreError(
        "INVALID_SCOPE_REF",
        "scope=project but storage path is not under /project",
        { dir },
      );
    }
    return;
  }
  if (!record.scope_ref) {
    throw new KnowledgeStoreError(
      "INVALID_SCOPE_REF",
      `scope=${record.scope} requires scope_ref`,
    );
  }
  const expectedSeg = record.scope === "stage" ? "stages" : "sessions";
  if (!normalized.endsWith(`/${expectedSeg}/${record.scope_ref}`)) {
    throw new KnowledgeStoreError(
      "INVALID_SCOPE_REF",
      `scope=${record.scope} (ref=${record.scope_ref}) does not match storage path`,
      { dir },
    );
  }
}

/**
 * Scan free-text content fields for secrets. Caller decides which fields
 * to feed (record body, reason, flattened topic/keys for memories).
 */
export function detectSecrets(fields: Record<string, string | undefined | null>): {
  matches: SecretMatch[];
  redacted: Record<string, string>;
} {
  const matches: SecretMatch[] = [];
  const redacted: Record<string, string> = {};
  for (const [name, value] of Object.entries(fields)) {
    if (typeof value !== "string" || value.length === 0) continue;
    const result = scanForSecrets(value, name);
    if (result.matches.length > 0) {
      matches.push(...result.matches);
      redacted[name] = redact(value, result.matches).text;
    }
  }
  return { matches, redacted };
}

export function assertNoSecrets(fields: Record<string, string | undefined | null>): void {
  const { matches } = detectSecrets(fields);
  if (matches.length > 0) {
    throw new KnowledgeStoreError(
      "SECRET_DETECTED",
      `secret detected in: ${[...new Set(matches.map((m) => m.field))].join(", ")}`,
      { kinds: [...new Set(matches.map((m) => m.kind))] },
    );
  }
}

export function assertNotBlockedPath(path: string | undefined | null, field = "body_path"): void {
  if (typeof path !== "string" || path.length === 0) return;
  if (isBlockedPath(path)) {
    throw new KnowledgeStoreError("BLOCKED_PATH", `${field} is blocked: ${path}`);
  }
}

/**
 * Write a single record JSON atomically (tmp + fsync + rename + dir fsync,
 * via writeDoc). Validates against `schema` first; rejects `INVALID_SCOPE_REF`
 * and `SECRET_DETECTED` before any byte hits disk.
 *
 * Caller is responsible for acquiring the per-record mutex (use
 * `acquireRecordLock(recordLockKey(record))`).
 *
 * `secretsScanFields` — extra free-text fields to scan beyond those
 * naturally present in the record. The record-level body/topic/keys
 * (kind-dependent) are always scanned.
 */
export function writeRecordAtomic<S extends ZodTypeAny>(
  dir: string,
  id: string,
  schema: S,
  data: z.input<S>,
  opts: { secretsScanFields?: Record<string, string | undefined | null> } = {},
): z.output<S> {
  const validated = schema.parse(data) as KnowledgeRecord;
  assertScopePathCoherence(dir, validated);

  const fields: Record<string, string | undefined | null> = {
    ...opts.secretsScanFields,
  };
  if (validated.kind === "memory") {
    fields.body = validated.body;
    fields["topic.domain"] = validated.topic.domain;
    fields["topic.subject"] = validated.topic.subject;
    if (validated.topic.aspect) fields["topic.aspect"] = validated.topic.aspect;
    validated.keys.forEach((k, i) => (fields[`keys[${i}]`] = k));
  } else {
    fields.description = validated.description;
    fields.name = validated.name;
  }
  assertNoSecrets(fields);

  const recordsDir = join(dir, "records");
  ensureDir(recordsDir);
  const target = join(recordsDir, `${id}.json`);
  writeDoc(target, validated as unknown as z.input<S>, schema as z.ZodType<unknown>);
  return validated as z.output<S>;
}

/** Roll back a record JSON write (used by supersede's step-3 failure path). */
export function unlinkRecordIfExists(dir: string, id: string): void {
  const p = join(dir, "records", `${id}.json`);
  if (existsSync(p)) {
    try {
      unlinkSync(p);
    } catch {
      /* best-effort */
    }
  }
}

/**
 * Append one JSONL line atomically (POSIX O_APPEND|O_CREAT + fsync).
 * Lines are hard-capped at AUDIT_LINE_MAX_BYTES so the POSIX `PIPE_BUF`
 * (4096) atomicity guarantee holds even under concurrent writers in the
 * same process. Reader tolerates a truncated trailing line.
 */
export function appendJsonlAtomic(path: string, entry: unknown): void {
  ensureDir(dirname(path));
  let json = JSON.stringify(entry);
  if (Buffer.byteLength(json, "utf-8") + 1 > AUDIT_LINE_MAX_BYTES) {
    json = truncateAuditLine(entry, AUDIT_LINE_MAX_BYTES - 1);
  }
  const line = json + "\n";
  // O_APPEND = 1024 on Linux; combined with O_CREAT (64) and O_WRONLY (1).
  // Using "a" flag asks Node for the equivalent open mode.
  const fd = openSync(path, "a");
  try {
    writeSync(fd, line, null, "utf-8");
    try {
      fsyncSync(fd);
    } catch {
      /* fsync may fail on tmpfs */
    }
  } finally {
    closeSync(fd);
  }
}

/**
 * Truncate the `reason` field of an AuditEntry-like object so the
 * resulting JSON line fits within `maxBytes`. Other fields are preserved.
 */
function truncateAuditLine(entry: unknown, maxBytes: number): string {
  if (typeof entry !== "object" || entry === null) {
    return JSON.stringify(String(entry)).slice(0, maxBytes);
  }
  const clone: Record<string, unknown> = { ...(entry as Record<string, unknown>) };
  const original = String(clone.reason ?? "");
  let lo = 0;
  let hi = original.length;
  let best = "";
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const candidate = original.slice(0, mid) + AUDIT_TRUNCATE_SUFFIX;
    clone.reason = candidate;
    const json = JSON.stringify(clone);
    if (Buffer.byteLength(json, "utf-8") <= maxBytes) {
      best = json;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  if (!best) {
    clone.reason = AUDIT_TRUNCATE_SUFFIX;
    best = JSON.stringify(clone);
  }
  return best;
}

/**
 * Write a properly-typed AuditEntry. Validates against AuditEntrySchema
 * before serializing; see design §C.3 transaction order.
 */
export function appendAuditEntry(path: string, entry: AuditEntry): void {
  const validated = AuditEntrySchema.parse(entry);
  appendJsonlAtomic(path, validated);
}

/**
 * Read every JSONL line in `path`, tolerating a truncated trailing line
 * (POSIX append windows). Malformed mid-file lines are returned as
 * `MALFORMED_AUDIT_LINE` markers so the loader can surface a warning.
 */
export function readAuditLines(path: string): Array<{ ok: true; entry: AuditEntry } | { ok: false; line: string }> {
  if (!existsSync(path)) return [];
  const raw = readFileSync(path, "utf-8");
  const lines = raw.split("\n");
  const out: Array<{ ok: true; entry: AuditEntry } | { ok: false; line: string }> = [];
  lines.forEach((line, idx) => {
    if (line.length === 0) return;
    const isLast = idx === lines.length - 1;
    try {
      const parsed = JSON.parse(line);
      const validated = AuditEntrySchema.parse(parsed);
      out.push({ ok: true, entry: validated });
    } catch {
      if (!isLast) out.push({ ok: false, line });
      // truncated trailing line — drop silently
    }
  });
  return out;
}

/**
 * Index projection — minimal summary fields used by `list_*` tools.
 * The full schema for the projection is owned by the per-kind facade
 * (M2); the store layer only needs to know that the index file lives
 * at `<dir>/index.json` and is rewritten in full on every mutation.
 */
export interface IndexSummary {
  id: string;
  kind: KnowledgeRecord["kind"];
  scope: KnowledgeRecord["scope"];
  scope_ref?: string;
  status: KnowledgeRecord["status"];
  updated_at: string;
}

/**
 * Walk `<scopeDir>/records/*.json`, validate each record against `schema`,
 * project to an IndexSummary, and write `<scopeDir>/index.json` via
 * writeDoc. Idempotent; caller holds the per-scope lock.
 *
 * Throws `INDEX_REBUILD_FAILED` if the write step itself fails (callers
 * may catch + log; next loader will retry).
 */
export function rebuildIndex<S extends ZodTypeAny>(
  scopeDir: string,
  schema: S,
  indexSchema: z.ZodType<{ entries: IndexSummary[] }>,
): { entries: IndexSummary[] } {
  const recordsDir = join(scopeDir, "records");
  const entries: IndexSummary[] = [];
  if (existsSync(recordsDir)) {
    for (const name of readdirSync(recordsDir).sort()) {
      if (!name.endsWith(".json")) continue;
      try {
        const raw = readFileSync(join(recordsDir, name), "utf-8");
        const parsed = JSON.parse(raw);
        const validated = schema.parse(parsed) as KnowledgeRecord;
        entries.push({
          id: validated.id,
          kind: validated.kind,
          scope: validated.scope,
          ...(validated.scope_ref ? { scope_ref: validated.scope_ref } : {}),
          status: validated.status,
          updated_at: validated.updated_at,
        });
      } catch {
        // Skip malformed records — they cannot be indexed, but they
        // remain on disk and will surface via direct read attempts.
      }
    }
  }
  entries.sort((a, b) => a.id.localeCompare(b.id));
  const doc = { entries };
  try {
    writeDoc(join(scopeDir, "index.json"), doc, indexSchema);
  } catch (err) {
    throw new KnowledgeStoreError(
      "INDEX_REBUILD_FAILED",
      `failed to write index.json: ${(err as Error).message}`,
    );
  }
  return doc;
}

/** Convenience: validate a `reason` field. */
export function assertReason(reason: unknown): string {
  if (typeof reason !== "string" || reason.trim().length === 0) {
    throw new KnowledgeStoreError("EMPTY_REASON", "reason is required");
  }
  return reason;
}

// Re-exports for callers that want to construct audit entries.
export { LifecycleStatusSchema };
export type { AuditOp };
