/**
 * F01 B01 — typed query helpers over the knowledge sidecar.
 *
 * Each helper takes a `SidecarHandle` and returns plain values shaped
 * for lifecycle / eager-loader consumers. No `KnowledgeStore` façade
 * dependency: these are pure data-access primitives.
 */
import type {
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
