/**
 * F01 B03 — per-kind reingest helper.
 *
 * Reads all active records from the sidecar and publishes them as a
 * `records` ingest to the protected RAG dataset. On success clears the
 * `pending_reingest` flag in the same transaction.
 */
import type { KnowledgeStore, RecordKind } from "./init.js";
import { listActiveItems, clearPendingReingest } from "./sidecar-queries.js";

export async function reingestKind(
  store: KnowledgeStore,
  kind: RecordKind,
): Promise<void> {
  const datasetId =
    kind === "skill" ? "knowledge.skills" : "knowledge.memory";
  const items = listActiveItems(store.sidecar, kind);
  await store.ragManager.ingest(datasetId, { kind: "records", items });
  store.sidecar.inTransaction(() => clearPendingReingest(store.sidecar, kind));
}
