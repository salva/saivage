/**
 * F02 B05 — rag_admin
 *
 * Multiplexes three control-plane actions: reconcile, watch_arm, watch_disarm.
 * watch_arm flow per design 02-design-r6.md §A.9.
 */
import type { RagService } from "../service.js";
import { DatasetNotFoundError, WatcherUnavailableError } from "../../../rag/errors.js";
import { ragErr, type RagErrEnvelope } from "../envelope.js";
import { isProtected } from "./list.js";

export type RagAdminInput =
  | { collection_id: string; action: "reconcile" }
  | { collection_id: string; action: "watch_arm" }
  | { collection_id: string; action: "watch_disarm" };

export async function ragAdmin(
  service: RagService,
  input: RagAdminInput,
): Promise<
  | { reconciled: true }
  | { armed: true }
  | { disarmed: true }
  | RagErrEnvelope
> {
  if (isProtected(input.collection_id)) {
    return ragErr("RAG_PROTECTED_DATASET", `dataset ${input.collection_id} is protected`);
  }

  if (input.action === "watch_arm") {
    let dataset;
    try {
      dataset = await service.manager.get(input.collection_id);
    } catch (err) {
      if (err instanceof DatasetNotFoundError) {
        return ragErr("RAG_DATASET_NOT_FOUND", input.collection_id);
      }
      throw err;
    }
    if (dataset.config.watch === false) {
      return ragErr("RAG_WATCH_DISABLED", `dataset ${input.collection_id} has watch=false`);
    }
    try {
      await dataset.watch();
    } catch (err) {
      if (err instanceof WatcherUnavailableError) {
        return ragErr("RAG_WATCHER_UNAVAILABLE", err.message);
      }
      throw err;
    }
    service.watchStatus.set(input.collection_id, "armed");
    return { armed: true };
  }

  if (input.action === "watch_disarm") {
    let dataset;
    try {
      dataset = await service.manager.get(input.collection_id);
    } catch (err) {
      if (err instanceof DatasetNotFoundError) {
        return ragErr("RAG_DATASET_NOT_FOUND", input.collection_id);
      }
      throw err;
    }
    await dataset.unwatch();
    service.watchStatus.set(input.collection_id, "off");
    return { disarmed: true };
  }

  // reconcile
  let dataset;
  try {
    dataset = await service.manager.get(input.collection_id);
  } catch (err) {
    if (err instanceof DatasetNotFoundError) {
      return ragErr("RAG_DATASET_NOT_FOUND", input.collection_id);
    }
    throw err;
  }
  await dataset.reconcile();
  return { reconciled: true };
}
