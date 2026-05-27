// F01 B02 — public RAG types fixed by the design surface (02-design-r2 §3.1.2 + §3.1.6).

export type RagSource = "skill" | "memory" | "doc" | "code";

export interface ProviderStamp {
  provider: string;
  model: string;
  dim: number;
  releaseFingerprint: string;
}

export interface EmbeddingProviderRef {
  kind: "openai";
  model: "text-embedding-3-small";
  dim: 256 | 512 | 1024 | 1536;
}

export interface VectorStoreRef {
  kind: "sqlite-vec";
}

export interface ChunkerRef {
  kind: "markdown" | "code" | "memory";
  chunkSize?: number;
  overlap?: number;
}

export interface DatasetConfig {
  id: string;
  projectId: string;
  source: RagSource;
  provider: EmbeddingProviderRef;
  store: VectorStoreRef;
  chunker: ChunkerRef;
  exclusions?: string[];
}

// ChunkMetadata mirrors the indexable columns of `chunk` in the store schema
// (02-design-r2 §3.1.6). All optional fields may be absent depending on
// chunker kind and source kind.
export interface ChunkMetadata {
  path: string;
  source: RagSource;
  chunkIndex: number;
  startLine?: number;
  endLine?: number;
  contentHash: string;
  sourceHash: string;
  mtimeMs: number;
  language?: string;
  headingPath?: string;
  symbolName?: string;
  symbolKind?: string;
  scope?: string;
  scopeRef?: string;
  role?: string;
  lifecycleStatus?: string;
  createdAt?: number;
  supersedes?: string;
}

// Subset accepted on `IngestInput.records`. The pipeline fills in chunkIndex,
// contentHash, sourceHash, mtimeMs from runtime; callers supply identity +
// classification metadata only.
export type ChunkMetadataInput = Omit<
  ChunkMetadata,
  "chunkIndex" | "contentHash" | "sourceHash" | "mtimeMs"
> & {
  mtimeMs?: number;
};

// Raw output from a Chunker before embeddings are computed.
export interface RawChunk {
  text: string;
  metadata: ChunkMetadata;
}

// Persisted row including computed identity and embedding vector.
export interface StoredChunk {
  id: string;
  text: string;
  metadata: ChunkMetadata;
  embedding: Float32Array;
}

// Hit returned from the store before text/metadata hydration by the query
// pipeline.
export interface StoredHit {
  id: string;
  score: number;
  metadata: ChunkMetadata;
  text: string;
}

export type QueryFilter =
  | { eq: Record<string, string | number | null> }
  | { and: QueryFilter[] }
  | { or: QueryFilter[] }
  | { gt: Record<string, number>; lt?: Record<string, number> }
  | { pathGlob: string }
  | { in: Record<string, Array<string | number>> };

export interface QueryOptions {
  topK?: number;
  filter?: QueryFilter;
}

export interface QueryHit {
  chunkId: string;
  score: number;
  text: string;
  metadata: ChunkMetadata;
}

export interface DatasetStats {
  chunks: number;
  files: number;
  bytesOnDisk: number;
  provider: ProviderStamp;
  lastIngestAt: string | null;
  secretsDropped: number;
}

export type IngestInput =
  | { kind: "fs"; root: string; include: string[]; exclude?: string[] }
  | {
      kind: "records";
      items: Array<{ id: string; text: string; metadata: ChunkMetadataInput }>;
    };

export interface IngestReport {
  filesScanned: number;
  filesChanged: number;
  chunksUpserted: number;
  chunksDeleted: number;
  chunksDroppedSecrets: number;
  tokensEmbedded: number;
  embeddingMs: number;
  storeMs: number;
}

// ChunkerInput is the per-call payload handed to a Chunker. The chunker reads
// the text and emits RawChunks. Path, source, mtimeMs and sourceHash are
// already known by the ingest pipeline at this point.
export interface ChunkerInput {
  text: string;
  path: string;
  source: RagSource;
  sourceHash: string;
  mtimeMs: number;
  language?: string;
  metadataOverlay?: Partial<ChunkMetadataInput>;
  chunkSize?: number;
  overlap?: number;
}

// Operator-facing view returned by RagManager.list().
export interface RegisteredDataset {
  id: string;
  source: RagSource;
  providerStamp: ProviderStamp;
  createdAt: string;
}
