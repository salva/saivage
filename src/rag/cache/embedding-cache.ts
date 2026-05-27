// F01 B07 — Embedding cache key derivation.
//
// Cache key = sha256(stamp || '\0' || contentHash) where `stamp` is the
// provider stamp formatted as `${provider}:${model}:${dim}:${releaseFingerprint}`
// (matches the format used in `errors.stampToString`). The cache itself
// lives inside the store's sqlite file (table `embedding_cache`), exposed
// through `VectorStore.getCachedEmbedding` / `putCachedEmbedding`. This
// module owns the key derivation only; the persistence seam stays on the
// store.

import { createHash } from "node:crypto";
import type { ProviderStamp } from "../types.js";

export function stampFingerprint(stamp: ProviderStamp): string {
  return `${stamp.provider}:${stamp.model}:${stamp.dim}:${stamp.releaseFingerprint}`;
}

export function embeddingCacheKey(stamp: ProviderStamp, contentHash: string): string {
  return createHash("sha256")
    .update(stampFingerprint(stamp))
    .update("\0")
    .update(contentHash)
    .digest("hex");
}
