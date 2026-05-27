// F01 B05 — Chunker seam + factory.
// See 02-design-r2 §3.1.2.

import type { ChunkerInput, ChunkerRef, RawChunk } from "../types.js";

export interface Chunker {
  chunk(input: ChunkerInput): AsyncIterable<RawChunk>;
}

export const DEFAULT_CHUNK_TOKEN_CAP = 7500;
export const DEFAULT_MARKDOWN_OVERLAP_RATIO = 0.15;
export const MEMORY_ATOMIC_TOKEN_THRESHOLD = 1000;

export async function createChunker(ref: ChunkerRef): Promise<Chunker> {
  switch (ref.kind) {
    case "markdown": {
      const { MarkdownChunker } = await import("./markdown.js");
      return new MarkdownChunker();
    }
    case "code": {
      const { CodeChunker } = await import("./code.js");
      return new CodeChunker();
    }
    case "memory": {
      const { MemoryChunker } = await import("./memory.js");
      return new MemoryChunker();
    }
    default: {
      const exhaustive: never = ref.kind;
      throw new Error(`unknown chunker kind: ${exhaustive as string}`);
    }
  }
}
