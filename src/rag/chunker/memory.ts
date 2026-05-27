// F01 B05 — Memory chunker.
//
// Atomic for short notes (<= MEMORY_ATOMIC_TOKEN_THRESHOLD tokens). For longer
// notes, delegates to the markdown chunker, propagating `recordId` (via
// metadataOverlay.scopeRef) to every sub-chunk.

import type { ChunkerInput, ChunkMetadata, RawChunk } from "../types.js";
import {
  type Chunker,
  DEFAULT_CHUNK_TOKEN_CAP,
  MEMORY_ATOMIC_TOKEN_THRESHOLD,
} from "./index.js";
import { MarkdownChunker } from "./markdown.js";
import { countTokens } from "./tokens.js";

function baseMetadata(input: ChunkerInput, chunkIndex: number): ChunkMetadata {
  const overlay = input.metadataOverlay ?? {};
  return {
    path: input.path,
    source: input.source,
    chunkIndex,
    startLine: overlay.startLine,
    endLine: overlay.endLine,
    contentHash: "",
    sourceHash: input.sourceHash,
    mtimeMs: input.mtimeMs,
    language: input.language ?? overlay.language,
    headingPath: overlay.headingPath,
    symbolName: overlay.symbolName,
    symbolKind: overlay.symbolKind,
    scope: overlay.scope ?? "memory",
    scopeRef: overlay.scopeRef,
    role: overlay.role,
    lifecycleStatus: overlay.lifecycleStatus,
    createdAt: overlay.createdAt,
    supersedes: overlay.supersedes,
  };
}

export class MemoryChunker implements Chunker {
  private readonly inner = new MarkdownChunker();

  async *chunk(input: ChunkerInput): AsyncIterable<RawChunk> {
    const capTokens = input.chunkSize ?? DEFAULT_CHUNK_TOKEN_CAP;
    if (capTokens <= 0) return;
    const text = input.text.trim();
    if (text.length === 0) return;
    const tok = countTokens(text);
    if (tok <= MEMORY_ATOMIC_TOKEN_THRESHOLD && tok <= capTokens) {
      yield { text, metadata: baseMetadata(input, 0) };
      return;
    }
    // Delegate to the markdown chunker for the actual split, propagating the
    // `scopeRef` (recordId) on every emitted sub-chunk via metadataOverlay.
    const overlay = { ...(input.metadataOverlay ?? {}), scope: "memory" as const };
    let i = 0;
    for await (const ch of this.inner.chunk({ ...input, metadataOverlay: overlay })) {
      yield {
        text: ch.text,
        metadata: {
          ...ch.metadata,
          chunkIndex: i++,
          scope: "memory",
          scopeRef: input.metadataOverlay?.scopeRef ?? ch.metadata.scopeRef,
        },
      };
    }
  }
}
