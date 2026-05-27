// F01 B03 — VectorStore seam and factory.
// See 02-design-r2 §3.1.2.

import type {
  ChunkMetadata,
  ProviderStamp,
  QueryFilter,
  StoredChunk,
  StoredHit,
  VectorStoreRef,
} from "../types.js";

export interface VectorStore {
  readonly path: string;
  open(stamp: ProviderStamp): Promise<void>;
  upsert(rows: StoredChunk[]): Promise<void>;
  deleteByFilter(filter: QueryFilter): Promise<number>;
  deleteByIds(ids: string[]): Promise<number>;
  query(
    vector: Float32Array,
    topK: number,
    filter?: QueryFilter,
  ): Promise<StoredHit[]>;
  stats(): Promise<{
    chunks: number;
    files: number;
    bytesOnDisk: number;
    lastIngestAt: string | null;
  }>;
  close(): Promise<void>;
  drop(): Promise<void>;
  // Embedding-cache surface, owned by the store because it lives in the same
  // sqlite file (02-design-r2 §3.1.6 `embedding_cache` table). The seam stays
  // here so callers do not couple to better-sqlite3 directly.
  getCachedEmbedding(key: string): Promise<Float32Array | null>;
  putCachedEmbedding(key: string, vector: Float32Array): Promise<void>;
  // File-state surface for the ingest pipeline diff (02-design-r2 §3.1.6
  // `file_state` table).
  getFileState(): Promise<Map<string, { sourceHash: string; mtimeMs: number; lastIngestAt: number }>>;
  putFileState(rows: Array<{ path: string; sourceHash: string; mtimeMs: number; lastIngestAt: number }>): Promise<void>;
  deleteFileState(paths: string[]): Promise<number>;
  // Stamp + secrets counters
  readonly stamp: ProviderStamp;
  bumpSecretsDropped(n: number): Promise<void>;
  setLastIngestAt(at: number): Promise<void>;
}

// Re-export the row shapes the store consumes so consumers do not need to
// reach into ../types.js.
export type { StoredChunk, StoredHit, ChunkMetadata, ProviderStamp, VectorStoreRef };

export async function createVectorStore(
  ref: VectorStoreRef,
  path: string,
): Promise<VectorStore> {
  switch (ref.kind) {
    case "sqlite-vec": {
      const { SqliteVecStore } = await import("./sqlite-vec.js");
      return new SqliteVecStore(path);
    }
    default: {
      const exhaustive: never = ref.kind;
      throw new Error(`unknown vector store kind: ${exhaustive as string}`);
    }
  }
}
