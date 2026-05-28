/**
 * F01 B01 — Knowledge SQLite sidecar.
 *
 * `.saivage/knowledge/store.sqlite` is the canonical home for skill /
 * memory records. RAG datasets (`knowledge.skills`, `knowledge.memory`)
 * index this data for semantic search; the sidecar is the source of
 * truth.
 *
 * Migrations are guarded by `PRAGMA user_version`. v1 establishes the
 * schema specified in F01 design §A.3 / analysis §3.1, with one key
 * adjustment: collision rules remain scope-local (no global UNIQUE on
 * `record_skill.name` or `record_memory.topic`), enforced by the
 * lifecycle layer.
 */
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import DatabaseConstructor, { type Database } from "better-sqlite3";

import type { LifecycleStatus } from "./types.js";

export type RecordKind = "skill" | "memory";
export type RecordOrigin = "builtin" | "project";

export interface RecordRow {
  id: string;
  kind: RecordKind;
  scope: string;
  scope_ref: string | null;
  status: LifecycleStatus;
  origin: RecordOrigin;
  record_json: string;
  body: string;
  created_at: string;
  updated_at: string;
  supersedes: string | null;
  superseded_by: string | null;
  pending_reingest: 0 | 1;
}

export interface AuditEntry {
  record_id: string;
  ts: string;
  op: string;
  actor_role: string;
  actor_agent_id: string;
  before_json: string | null;
  after_json: string | null;
}

export interface RagSyncEntry {
  record_id: string;
  kind: RecordKind;
  content_hash: string;
  last_synced_at: string;
}

export interface IngestItem {
  id: string;
  text: string;
  metadata: import("../rag/types.js").ChunkMetadataInput;
}

export interface EagerRow {
  record_json: string;
  body: string;
  origin: RecordOrigin;
}

export interface SidecarHandle {
  readonly db: Database;
  readonly path: string;
  close(): void;
  inTransaction<T>(fn: () => T): T;
}

const SCHEMA_V1 = `
  CREATE TABLE record (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('skill','memory')),
    scope TEXT NOT NULL,
    scope_ref TEXT,
    status TEXT NOT NULL,
    origin TEXT NOT NULL CHECK (origin IN ('builtin','project')),
    record_json TEXT NOT NULL,
    body TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    supersedes TEXT,
    superseded_by TEXT,
    pending_reingest INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX record_kind_scope_idx ON record(kind, scope, scope_ref);
  CREATE INDEX record_kind_status_idx ON record(kind, status);
  CREATE INDEX record_pending_reingest_idx ON record(kind) WHERE pending_reingest = 1;

  CREATE TABLE record_skill (
    id TEXT PRIMARY KEY REFERENCES record(id) ON DELETE CASCADE,
    name TEXT NOT NULL
  );
  CREATE INDEX record_skill_name_idx ON record_skill(name);

  CREATE TABLE record_memory (
    id TEXT PRIMARY KEY REFERENCES record(id) ON DELETE CASCADE,
    topic TEXT NOT NULL
  );
  CREATE INDEX record_memory_topic_idx ON record_memory(topic);

  CREATE TABLE audit (
    rowid INTEGER PRIMARY KEY AUTOINCREMENT,
    record_id TEXT NOT NULL,
    ts TEXT NOT NULL,
    op TEXT NOT NULL,
    actor_role TEXT NOT NULL,
    actor_agent_id TEXT NOT NULL,
    before_json TEXT,
    after_json TEXT
  );
  CREATE INDEX audit_record_idx ON audit(record_id);
  CREATE INDEX audit_ts_idx ON audit(ts);

  CREATE TABLE rag_sync (
    record_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('skill','memory')),
    content_hash TEXT NOT NULL,
    last_synced_at TEXT NOT NULL,
    PRIMARY KEY (record_id, kind)
  );
  CREATE INDEX rag_sync_kind_idx ON rag_sync(kind);
`;

const CURRENT_USER_VERSION = 1;

/**
 * Open (or create) the sidecar database at the canonical project path
 * `<projectRoot>/.saivage/knowledge/store.sqlite`. Applies migrations
 * up to {@link CURRENT_USER_VERSION}.
 */
export async function openSidecar(projectRoot: string): Promise<SidecarHandle> {
  const path = sidecarPath(projectRoot);
  await mkdir(dirname(path), { recursive: true });
  const db = new DatabaseConstructor(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  migrate(db);
  return {
    db,
    path,
    close() {
      db.close();
    },
    inTransaction<T>(fn: () => T): T {
      return db.transaction(fn)();
    },
  };
}

/**
 * Compute the on-disk path for the sidecar. Exposed so tests and
 * boot-time legacy-tree checks can co-locate state.
 */
export function sidecarPath(projectRoot: string): string {
  return `${projectRoot}/.saivage/knowledge/store.sqlite`;
}

/** Whether the sidecar file already exists on disk. */
export function sidecarExists(projectRoot: string): boolean {
  return existsSync(sidecarPath(projectRoot));
}

function migrate(db: Database): void {
  const current = (db.pragma("user_version", { simple: true }) as number) ?? 0;
  if (current >= CURRENT_USER_VERSION) return;
  db.exec("BEGIN");
  try {
    if (current < 1) {
      db.exec(SCHEMA_V1);
    }
    db.pragma(`user_version = ${CURRENT_USER_VERSION}`);
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}
