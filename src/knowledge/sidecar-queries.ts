/**
 * F01 B01 — typed query helpers over the knowledge sidecar.
 *
 * Each helper takes a `SidecarHandle` and returns plain values shaped
 * for lifecycle / eager-loader consumers. No `KnowledgeStore` façade
 * dependency: these are pure data-access primitives.
 */
import type {
  AuditEntry,
  EagerRow,
  IngestItem,
  RecordKind,
  RecordRow,
  SidecarHandle,
} from "./sidecar.js";
import type { LifecycleStatus } from "./types.js";

export function getRecord(
  sidecar: SidecarHandle,
  id: string,
): RecordRow | undefined {
  const row = sidecar.db.prepare("SELECT * FROM record WHERE id = ?").get(id);
  return (row as RecordRow | undefined) ?? undefined;
}

export function listRecordsByStatus(
  sidecar: SidecarHandle,
  kind: RecordKind,
  status: LifecycleStatus,
): RecordRow[] {
  return sidecar.db
    .prepare("SELECT * FROM record WHERE kind = ? AND status = ?")
    .all(kind, status) as RecordRow[];
}

export function activeRecordsByScope(
  sidecar: SidecarHandle,
  kind: RecordKind,
  scope: string,
  scopeRef?: string,
): RecordRow[] {
  if (scopeRef === undefined) {
    return sidecar.db
      .prepare(
        "SELECT * FROM record WHERE kind = ? AND scope = ? AND status = 'active'",
      )
      .all(kind, scope) as RecordRow[];
  }
  return sidecar.db
    .prepare(
      "SELECT * FROM record WHERE kind = ? AND scope = ? AND scope_ref = ? AND status = 'active'",
    )
    .all(kind, scope, scopeRef) as RecordRow[];
}

export function activeIdsForScope(
  sidecar: SidecarHandle,
  kind: RecordKind,
  scope: string,
  scopeRef?: string,
): string[] {
  return activeRecordsByScope(sidecar, kind, scope, scopeRef).map((r) => r.id);
}

export function listActiveItems(
  sidecar: SidecarHandle,
  kind: RecordKind,
): IngestItem[] {
  const rows = sidecar.db
    .prepare("SELECT * FROM record WHERE kind = ? AND status = 'active'")
    .all(kind) as RecordRow[];
  return rows.map((row) => toIngestItem(row));
}

export function loadAllActiveRowsForEager(sidecar: SidecarHandle): EagerRow[] {
  return sidecar.db
    .prepare(
      "SELECT record_json, body, origin FROM record WHERE status = 'active'",
    )
    .all() as EagerRow[];
}

export function pendingReingestKinds(sidecar: SidecarHandle): RecordKind[] {
  const rows = sidecar.db
    .prepare("SELECT DISTINCT kind FROM record WHERE pending_reingest = 1")
    .all() as Array<{ kind: RecordKind }>;
  return rows.map((r) => r.kind);
}

export function clearPendingReingest(
  sidecar: SidecarHandle,
  kind: RecordKind,
): void {
  sidecar.db
    .prepare("UPDATE record SET pending_reingest = 0 WHERE kind = ?")
    .run(kind);
}

export function recordCount(sidecar: SidecarHandle): number {
  const row = sidecar.db
    .prepare("SELECT COUNT(*) AS c FROM record")
    .get() as { c: number };
  return row.c;
}

function toIngestItem(row: RecordRow): IngestItem {
  return {
    id: row.id,
    text: row.body,
    metadata: {
      path: `${row.kind}:${row.id}.md`,
      source: row.kind === "skill" ? "skill" : "memory",
      scope: row.scope,
      scopeRef: row.scope_ref ?? undefined,
      lifecycleStatus: row.status,
    },
  };
}

// ─── Mutation primitives (F01 B04) ────────────────────────────────────────

/**
 * Find the active skill id (per scope) whose `name` matches; used by
 * the lifecycle layer to enforce per-scope name uniqueness.
 */
export function findActiveSkillIdByName(
  sidecar: SidecarHandle,
  scope: string,
  scopeRef: string | null,
  name: string,
): string | undefined {
  const sql = scopeRef === null
    ? `SELECT r.id AS id FROM record r
         JOIN record_skill s ON s.id = r.id
        WHERE r.kind = 'skill' AND r.status = 'active'
          AND r.scope = ? AND r.scope_ref IS NULL AND s.name = ?
        LIMIT 1`
    : `SELECT r.id AS id FROM record r
         JOIN record_skill s ON s.id = r.id
        WHERE r.kind = 'skill' AND r.status = 'active'
          AND r.scope = ? AND r.scope_ref = ? AND s.name = ?
        LIMIT 1`;
  const row = scopeRef === null
    ? sidecar.db.prepare(sql).get(scope, name)
    : sidecar.db.prepare(sql).get(scope, scopeRef, name);
  return (row as { id: string } | undefined)?.id;
}

/**
 * Find the active memory id (per scope) whose canonical `topic` key
 * matches; used by the lifecycle layer to enforce per-scope topic
 * uniqueness. The topic key shape is `domain\u0001subject\u0001aspect`
 * with `\u0001` as a delimiter (NUL-adjacent control char that cannot
 * appear in valid topic components).
 */
export function findActiveMemoryIdByTopic(
  sidecar: SidecarHandle,
  scope: string,
  scopeRef: string | null,
  topicKey: string,
): string | undefined {
  const sql = scopeRef === null
    ? `SELECT r.id AS id FROM record r
         JOIN record_memory m ON m.id = r.id
        WHERE r.kind = 'memory' AND r.status = 'active'
          AND r.scope = ? AND r.scope_ref IS NULL AND m.topic = ?
        LIMIT 1`
    : `SELECT r.id AS id FROM record r
         JOIN record_memory m ON m.id = r.id
        WHERE r.kind = 'memory' AND r.status = 'active'
          AND r.scope = ? AND r.scope_ref = ? AND m.topic = ?
        LIMIT 1`;
  const row = scopeRef === null
    ? sidecar.db.prepare(sql).get(scope, topicKey)
    : sidecar.db.prepare(sql).get(scope, scopeRef, topicKey);
  return (row as { id: string } | undefined)?.id;
}

/**
 * Insert a new record + its side-table row (skill or memory) + an
 * audit entry, atomically (caller is expected to wrap the call in
 * `sidecar.inTransaction`).
 *
 * The `secondary` argument carries the per-kind side-table value:
 *   • `{ kind: "skill", name }`  → `record_skill(id, name)`
 *   • `{ kind: "memory", topic }`→ `record_memory(id, topic)`
 */
export function putRecord(
  sidecar: SidecarHandle,
  row: RecordRow,
  secondary: { kind: "skill"; name: string } | { kind: "memory"; topic: string },
  audit: AuditEntry,
): void {
  sidecar.db.prepare(
    `INSERT INTO record
       (id, kind, scope, scope_ref, status, origin, record_json, body,
        created_at, updated_at, supersedes, superseded_by, pending_reingest)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    row.id, row.kind, row.scope, row.scope_ref, row.status, row.origin,
    row.record_json, row.body, row.created_at, row.updated_at,
    row.supersedes, row.superseded_by, row.pending_reingest,
  );
  if (secondary.kind === "skill") {
    sidecar.db.prepare("INSERT INTO record_skill (id, name) VALUES (?, ?)")
      .run(row.id, secondary.name);
  } else {
    sidecar.db.prepare("INSERT INTO record_memory (id, topic) VALUES (?, ?)")
      .run(row.id, secondary.topic);
  }
  insertAudit(sidecar, audit);
}

/**
 * Replace the mutable columns of an existing record row (status,
 * record_json, body, updated_at, supersedes, superseded_by) and append
 * an audit entry. Side-table values are not touched (skill name and
 * memory topic are immutable across update/supersede).
 */
export function updateRecord(
  sidecar: SidecarHandle,
  row: RecordRow,
  audit: AuditEntry,
): void {
  sidecar.db.prepare(
    `UPDATE record SET
        status = ?, record_json = ?, body = ?, updated_at = ?,
        supersedes = ?, superseded_by = ?, pending_reingest = ?
      WHERE id = ?`
  ).run(
    row.status, row.record_json, row.body, row.updated_at,
    row.supersedes, row.superseded_by, row.pending_reingest, row.id,
  );
  insertAudit(sidecar, audit);
}

/**
 * Mark the `superseded_by` pointer (and bump `pending_reingest`) on the
 * predecessor record without rewriting its body. The caller still appends
 * an audit row for the supersede via `audit`.
 */
export function markSuperseded(
  sidecar: SidecarHandle,
  oldId: string,
  newId: string,
  updatedAt: string,
  audit: AuditEntry,
): void {
  sidecar.db.prepare(
    `UPDATE record SET
        status = 'superseded', superseded_by = ?, updated_at = ?,
        pending_reingest = 1
      WHERE id = ?`,
  ).run(newId, updatedAt, oldId);
  insertAudit(sidecar, audit);
}

/**
 * Hard-delete a record. Cascades to its side-table row via
 * `ON DELETE CASCADE`. The audit row is preserved and appended.
 */
export function deleteRecord(
  sidecar: SidecarHandle,
  id: string,
  audit: AuditEntry,
): void {
  sidecar.db.prepare("DELETE FROM record WHERE id = ?").run(id);
  insertAudit(sidecar, audit);
}

/**
 * Mark every active record in `(kind, scope, scopeRef)` as archived
 * and append per-record audit entries. Returns the archived ids.
 *
 * Intended to be called inside `sidecar.inTransaction` so the set of
 * archived ids reflects a single point-in-time snapshot.
 */
export function archiveScope(
  sidecar: SidecarHandle,
  kind: RecordKind,
  scope: string,
  scopeRef: string,
  actorRole: string,
  actorAgentId: string,
  reason: string,
  ts: string,
): string[] {
  const rows = activeRecordsByScope(sidecar, kind, scope, scopeRef);
  for (const r of rows) {
    sidecar.db.prepare(
      `UPDATE record SET status = 'archived', updated_at = ?, pending_reingest = 1
        WHERE id = ?`,
    ).run(ts, r.id);
    insertAudit(sidecar, {
      record_id: r.id,
      ts,
      op: "archive",
      actor_role: actorRole,
      actor_agent_id: actorAgentId,
      before_json: JSON.stringify({ status: "active", reason }),
      after_json: JSON.stringify({ status: "archived" }),
    });
  }
  return rows.map((r) => r.id);
}

/** Insert one audit row. Caller controls transaction scope. */
export function insertAudit(sidecar: SidecarHandle, audit: AuditEntry): void {
  sidecar.db.prepare(
    `INSERT INTO audit
       (record_id, ts, op, actor_role, actor_agent_id, before_json, after_json)
     VALUES (?,?,?,?,?,?,?)`,
  ).run(
    audit.record_id, audit.ts, audit.op,
    audit.actor_role, audit.actor_agent_id,
    audit.before_json, audit.after_json,
  );
}
