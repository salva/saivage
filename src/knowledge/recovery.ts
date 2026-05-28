/**
 * F01 B03 — Boot divergence sweep.
 *
 * For each kind, compares the protected dataset's on-disk file-state
 * map against the active-record set in the sidecar. Mismatch triggers
 * a full per-kind reingest. Pending-reingest flags are honoured even
 * when the file-state map matches.
 */
import type { KnowledgeStore, RecordKind } from "./init.js";
import { getInternalDataset } from "../rag/internal/datasetAccess.js";
import {
  listActiveItems,
  pendingReingestKinds,
} from "./sidecar-queries.js";
import { reingestKind } from "./reingest.js";
import { log } from "../log.js";

const KIND_TO_DATASET: Record<RecordKind, string> = {
  skill: "knowledge.skills",
  memory: "knowledge.memory",
};

export async function runBootDivergenceSweep(
  store: KnowledgeStore,
): Promise<void> {
  // 1. Always retry pending_reingest = 1 kinds.
  for (const kind of pendingReingestKinds(store.sidecar)) {
    try {
      await reingestKind(store, kind);
    } catch (err) {
      log.warn(
        "knowledge.boot-pending-reingest-failed " +
          JSON.stringify({ kind, err: (err as Error).message }),
      );
    }
  }

  // 2. File-state divergence sweep.
  for (const kind of ["skill", "memory"] as RecordKind[]) {
    const dataset = getInternalDataset(store.ragManager, KIND_TO_DATASET[kind]);
    if (!dataset) continue;
    const storedRaw = await dataset.store.getFileState();
    const stored = new Map(
      Array.from(storedRaw, ([k, v]) => [k, v.sourceHash] as const),
    );
    const expected = new Map(
      listActiveItems(store.sidecar, kind).map((i) => [i.metadata.path, hashOf(i)]),
    );
    if (!mapsEqual(stored, expected)) {
      try {
        await reingestKind(store, kind);
      } catch (err) {
        log.warn(
          "knowledge.boot-divergence-reingest-failed " +
            JSON.stringify({ kind, err: (err as Error).message }),
        );
      }
    }
  }
}

function hashOf(item: import("./sidecar.js").IngestItem): string {
  // Quick body-hash placeholder; B05 may upgrade to the same hash the RAG
  // pipeline uses. For divergence detection length+first-bytes suffices.
  return `${item.text.length}:${item.text.slice(0, 32)}`;
}

function mapsEqual(a: Map<string, string>, b: Map<string, string>): boolean {
  if (a.size !== b.size) return false;
  for (const [k, v] of a) if (b.get(k) !== v) return false;
  return true;
}
