/**
 * F02 B05 — rag_drop
 *
 * Order under rag.controlMutex: snapshot persisted config, persist write (if
 * persist), manager.drop, clear watch status. On manager failure roll back
 * config best-effort.
 */
import type { RagService } from "../service.js";
import { saveSaivageConfig } from "../persist.js";
import { ragErr, type RagErrEnvelope } from "../envelope.js";
import { log } from "../../../log.js";
import { isProtected } from "./list.js";

export interface RagDropInput {
  collection_id: string;
  persist?: boolean;
}

export async function ragDrop(
  service: RagService,
  input: RagDropInput,
): Promise<{ dropped: true; persisted: boolean } | RagErrEnvelope> {
  if (isProtected(input.collection_id)) {
    return ragErr("RAG_PROTECTED_DATASET", `dataset ${input.collection_id} is protected`);
  }
  const persist = input.persist === true;
  let persistedDatasetSnapshot: unknown[] = [];

  if (persist) {
    await saveSaivageConfig(service.projectRoot, (cfg) => {
      persistedDatasetSnapshot = cfg.rag.datasets;
      return {
        ...cfg,
        rag: {
          ...cfg.rag,
          datasets: cfg.rag.datasets.filter((d) => d.id !== input.collection_id),
        },
      };
    });
  }

  try {
    await service.manager.drop(input.collection_id);
  } catch (err) {
    // Rollback config write (best-effort) so on-disk state matches manager state.
    if (persist) {
      await saveSaivageConfig(service.projectRoot, (cfg) => ({
        ...cfg,
        rag: {
          ...cfg.rag,
          datasets: persistedDatasetSnapshot as (typeof cfg.rag.datasets)[number][],
        },
      })).catch((rb) =>
        log.warn(
          "rag.drop.rollback-failed " +
            JSON.stringify({ id: input.collection_id, err: (rb as Error).message }),
        ),
      );
    }
    throw err;
  }

  service.watchStatus.delete(input.collection_id);
  return { dropped: true, persisted: persist };
}
