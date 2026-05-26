/**
 * Saivage — Knowledge store primitives.
 *
 * Source of truth: SPEC/v2/skills-memory/01-DESIGN.md §C.3.
 * Implements writeRecordAtomic, appendJsonlAtomic, rebuildIndex,
 * secret/path guards, and atomic record/index writes. Single-writer per
 * project is enforced by `runtime.lock`; in-process serialisation of
 * collision-sensitive scope mutations and supersedes is owned privately by
 * `src/knowledge/lifecycle.ts`. The store layer is lock-free at its public surface.
 *
 * NOTE: This file contains only the store primitives. The MCP tool
 * facade (`create_skill`, `supersede_memory`, …) is implemented in
 * later milestones (M2/M3) on top of these primitives.
 */

import {
  closeSync,
  fsyncSync,
  openSync,
  writeSync,
} from "node:fs";
import { mkdir, readdir, readFile, unlink } from "node:fs/promises";
import { join, dirname } from "node:path";
import type { z, ZodTypeAny } from "zod";

import { writeDoc, pathExists } from "../store/documents.js";
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
  | "NO_RUNTIME_LOCK"
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

async function ensureDir(p: string): Promise<void> {
  await mkdir(p, { recursive: true });
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
 * Single-writer is enforced by the lifecycle layer (`assertRuntimeLockHeld`
 * plus in-process queues); this primitive performs only tmp+fsync+rename writes.
 *
 * `secretsScanFields` — extra free-text fields to scan beyond those
 * naturally present in the record. The record-level body/topic/keys
 * (kind-dependent) are always scanned.
 */
export async function writeRecordAtomic<S extends ZodTypeAny>(
  dir: string,
  id: string,
  schema: S,
  data: z.input<S>,
  opts: { secretsScanFields?: Record<string, string | undefined | null> } = {},
): Promise<z.output<S>> {
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
  await ensureDir(recordsDir);
  const target = join(recordsDir, `${id}.json`);
  await writeDoc(target, validated as unknown as z.input<S>, schema as z.ZodType<unknown>);
  return validated as z.output<S>;
}

/** Roll back a record JSON write (used by supersede's step-3 failure path). */
export async function unlinkRecordIfExists(dir: string, id: string): Promise<void> {
  const p = join(dir, "records", `${id}.json`);
  if (await pathExists(p)) {
    try {
      await unlink(p);
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
export async function appendJsonlAtomic(path: string, entry: unknown): Promise<void> {
  await ensureDir(dirname(path));
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
export async function appendAuditEntry(path: string, entry: AuditEntry): Promise<void> {
  const validated = AuditEntrySchema.parse(entry);
  await appendJsonlAtomic(path, validated);
}

/**
 * Read every JSONL line in `path`, tolerating a truncated trailing line
 * (POSIX append windows). Malformed mid-file lines are returned as
 * `MALFORMED_AUDIT_LINE` markers so the loader can surface a warning.
 */
export async function readAuditLines(path: string): Promise<Array<{ ok: true; entry: AuditEntry } | { ok: false; line: string }>> {
  let raw: string;
  try {
    raw = await readFile(path, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
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
 * writeDoc. Idempotent; serialised per scope by the lifecycle layer.
 *
 * Throws `INDEX_REBUILD_FAILED` if the write step itself fails (callers
 * may catch + log; next loader will retry).
 */
export async function rebuildIndex<S extends ZodTypeAny>(
  scopeDir: string,
  schema: S,
  indexSchema: z.ZodType<{ entries: IndexSummary[] }>,
): Promise<{ entries: IndexSummary[] }> {
  const recordsDir = join(scopeDir, "records");
  const entries: IndexSummary[] = [];
  if (await pathExists(recordsDir)) {
    for (const name of (await readdir(recordsDir)).sort()) {
      if (!name.endsWith(".json")) continue;
      try {
        const raw = await readFile(join(recordsDir, name), "utf-8");
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
    await writeDoc(join(scopeDir, "index.json"), doc, indexSchema);
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
