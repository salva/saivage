/**
 * F02 B05 — rag_ingest
 *
 * Reads dataset.config.sources[0] (no caller globs) and invokes
 * manager.ingest. The hardened internal walker enforces containment.
 */
import type { RagService } from "../service.js";
import type { IngestInput, IngestReport } from "../../../rag/types.js";
import { DatasetNotFoundError } from "../../../rag/errors.js";
import { ragErr, type RagErrEnvelope } from "../envelope.js";
import { isProtected } from "./list.js";

export interface RagIngestInput {
  collection_id: string;
}

export async function ragIngest(
  service: RagService,
  input: RagIngestInput,
): Promise<{ ingestReport: IngestReport } | RagErrEnvelope> {
  if (isProtected(input.collection_id)) {
    return ragErr("RAG_PROTECTED_DATASET", `dataset ${input.collection_id} is protected`);
  }
  let dataset;
  try {
    dataset = await service.manager.get(input.collection_id);
  } catch (err) {
    if (err instanceof DatasetNotFoundError) {
      return ragErr("RAG_DATASET_NOT_FOUND", input.collection_id);
    }
    throw err;
  }
  const src = dataset.config.sources?.[0];
  if (!src) {
    return ragErr("RAG_INVALID_ARGS", `dataset ${input.collection_id} has no sources`);
  }
  const ingestInput: IngestInput = {
    kind: "fs",
    root: src.root,
    include: src.include ?? ["**/*"],
    ...(src.exclude ? { exclude: src.exclude } : {}),
  };
  const ingestReport = await service.manager.ingest(input.collection_id, ingestInput);
  return { ingestReport };
}
