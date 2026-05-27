// F01 B08 — Query pipeline.
//
// `runQuery` is the single entry point for "embed a string and KNN it against
// a dataset". Drift detection lives on the store seam (`open(stamp)` throws
// `EmbeddingDriftError` if the stamp on disk no longer matches the provider
// the caller wired in); we just propagate. Filter overshoot for post-filter
// queries is owned by the store implementation (sqlite-vec uses 4×); the
// pipeline does not double up.

import type { EmbeddingProvider } from "../provider/index.js";
import type { VectorStore } from "../store/index.js";
import type { QueryFilter, QueryHit, QueryOptions } from "../types.js";

const DEFAULT_TOP_K = 8;

export interface RunQueryArgs {
  store: VectorStore;
  provider: EmbeddingProvider;
  text: string;
  options?: QueryOptions;
}

export async function runQuery(args: RunQueryArgs): Promise<QueryHit[]> {
  const { store, provider, text, options } = args;
  const topK = options?.topK ?? DEFAULT_TOP_K;
  const filter: QueryFilter | undefined = options?.filter;

  await store.open(provider.stamp); // throws EmbeddingDriftError on stamp mismatch
  const vector = await provider.embedQuery(text);
  const hits = await store.query(vector, topK, filter);
  return hits
    .slice(0, topK)
    .map((h) => ({ chunkId: h.id, score: h.score, text: h.text, metadata: h.metadata }))
    .sort((a, b) => b.score - a.score);
}
