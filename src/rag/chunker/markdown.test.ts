import { describe, it, expect } from "vitest";
import { MarkdownChunker } from "./markdown.js";
import { countTokens } from "./tokens.js";
import type { ChunkerInput, RawChunk } from "../types.js";

async function collect(it: AsyncIterable<RawChunk>): Promise<RawChunk[]> {
  const out: RawChunk[] = [];
  for await (const c of it) out.push(c);
  return out;
}

function input(text: string, over: Partial<ChunkerInput> = {}): ChunkerInput {
  return {
    text,
    path: "x.md",
    source: "doc",
    sourceHash: "h",
    mtimeMs: 1,
    language: "markdown",
    ...over,
  };
}

describe("MarkdownChunker", () => {
  it("emits one chunk per heading section with headingPath populated", async () => {
    const chunker = new MarkdownChunker();
    const md = "# Top\n\nintro\n\n## A\n\nalpha body\n\n## B\n\nbeta body";
    const out = await collect(chunker.chunk(input(md)));
    expect(out.length).toBeGreaterThanOrEqual(2);
    const headings = out.map((c) => c.metadata.headingPath);
    expect(headings.some((h) => h?.includes("A"))).toBe(true);
    expect(headings.some((h) => h?.includes("B"))).toBe(true);
    expect(headings.some((h) => h?.startsWith("Top"))).toBe(true);
  });

  it("splits oversize sections at paragraph boundaries respecting the cap", async () => {
    const chunker = new MarkdownChunker();
    const para = "lorem ipsum dolor sit amet ".repeat(50);
    const md = `# Big\n\n${para}\n\n${para}\n\n${para}\n\n${para}`;
    const out = await collect(chunker.chunk(input(md, { chunkSize: 100 })));
    expect(out.length).toBeGreaterThan(1);
    for (const c of out) {
      expect(countTokens(c.text)).toBeLessThanOrEqual(120); // small overhead allowed for overlap
    }
  });

  it("respects custom chunkSize and overlap", async () => {
    const chunker = new MarkdownChunker();
    const para = "alpha beta gamma delta epsilon zeta eta theta iota kappa ".repeat(20);
    const md = `# Top\n\n${para}\n\n${para}`;
    const out = await collect(chunker.chunk(input(md, { chunkSize: 50, overlap: 0.2 })));
    expect(out.length).toBeGreaterThan(1);
  });

  it("hard-splits when no paragraph or heading boundary exists", async () => {
    const chunker = new MarkdownChunker();
    const md = "wordone ".repeat(500);
    const out = await collect(chunker.chunk(input(md, { chunkSize: 30 })));
    expect(out.length).toBeGreaterThan(1);
  });

  it("propagates metadataOverlay fields onto every chunk", async () => {
    const chunker = new MarkdownChunker();
    const md = "# Top\n\n## A\n\nbody";
    const out = await collect(chunker.chunk(input(md, { metadataOverlay: { role: "policy", scope: "project" } })));
    for (const c of out) {
      expect(c.metadata.role).toBe("policy");
      expect(c.metadata.scope).toBe("project");
    }
  });

  it("returns no chunks for empty text", async () => {
    const out = await collect(new MarkdownChunker().chunk(input("")));
    expect(out).toEqual([]);
  });

  it("assigns sequential chunkIndex starting at 0", async () => {
    const md = "# A\n\nx\n\n## B\n\ny\n\n## C\n\nz";
    const out = await collect(new MarkdownChunker().chunk(input(md)));
    const idx = out.map((c) => c.metadata.chunkIndex);
    expect(idx).toEqual(idx.slice().sort((a, b) => a - b));
    expect(idx[0]).toBe(0);
  });
});
