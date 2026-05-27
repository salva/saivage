import { describe, it, expect } from "vitest";
import { MemoryChunker } from "./memory.js";
import type { ChunkerInput, RawChunk } from "../types.js";

async function collect(it: AsyncIterable<RawChunk>): Promise<RawChunk[]> {
  const out: RawChunk[] = [];
  for await (const c of it) out.push(c);
  return out;
}

function inp(text: string, over: Partial<ChunkerInput> = {}): ChunkerInput {
  return { text, path: "mem.md", source: "memory", sourceHash: "h", mtimeMs: 1, ...over };
}

describe("MemoryChunker", () => {
  it("emits a single atomic chunk for short notes", async () => {
    const out = await collect(new MemoryChunker().chunk(inp("short note about a thing")));
    expect(out.length).toBe(1);
    expect(out[0]?.metadata.scope).toBe("memory");
    expect(out[0]?.metadata.chunkIndex).toBe(0);
  });

  it("delegates to markdown when over the atomic threshold and propagates scopeRef as recordId", async () => {
    const big = "alpha beta gamma delta epsilon ".repeat(500);
    const out = await collect(new MemoryChunker().chunk(inp(big, {
      chunkSize: 200,
      metadataOverlay: { scopeRef: "rec-42" },
    })));
    expect(out.length).toBeGreaterThan(1);
    for (const c of out) {
      expect(c.metadata.scope).toBe("memory");
      expect(c.metadata.scopeRef).toBe("rec-42");
    }
    const idx = out.map((c) => c.metadata.chunkIndex);
    expect(idx[0]).toBe(0);
    expect(idx).toEqual(idx.slice().sort((a, b) => a - b));
  });

  it("returns no chunks for empty text", async () => {
    const out = await collect(new MemoryChunker().chunk(inp("")));
    expect(out).toEqual([]);
  });

  it("respects custom chunkSize on the delegated path", async () => {
    const big = "wordone ".repeat(800);
    const out = await collect(new MemoryChunker().chunk(inp(big, { chunkSize: 50 })));
    expect(out.length).toBeGreaterThan(2);
  });
});
