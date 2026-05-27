import { describe, it, expect } from "vitest";
import { CodeChunker } from "./code.js";
import type { ChunkerInput, RawChunk } from "../types.js";

async function collect(it: AsyncIterable<RawChunk>): Promise<RawChunk[]> {
  const out: RawChunk[] = [];
  for await (const c of it) out.push(c);
  return out;
}

function inp(text: string, path: string, language?: string): ChunkerInput {
  return { text, path, source: "code", sourceHash: "h", mtimeMs: 1, language };
}

describe("CodeChunker — typescript", () => {
  it("emits one chunk per top-level function / class with symbolName + symbolKind", async () => {
    const src = `
function alpha(x: number): number {
  return x + 1;
}

class Beta {
  greet(): string { return "hi"; }
}

interface Gamma { ok: boolean; }
`.trim();
    const out = await collect(new CodeChunker().chunk(inp(src, "x.ts")));
    const named = out.filter((c) => c.metadata.symbolName !== undefined);
    expect(named.length).toBeGreaterThanOrEqual(3);
    const names = new Set(named.map((c) => c.metadata.symbolName));
    expect(names.has("alpha")).toBe(true);
    expect(names.has("Beta")).toBe(true);
    expect(names.has("Gamma")).toBe(true);
    expect(out.every((c) => c.metadata.language === "typescript")).toBe(true);
  });

  it("populates startLine + endLine from tree-sitter positions", async () => {
    const src = `\nfunction a(){ return 1; }\nfunction b(){ return 2; }\n`;
    const out = await collect(new CodeChunker().chunk(inp(src, "x.ts")));
    const a = out.find((c) => c.metadata.symbolName === "a");
    expect(a).toBeDefined();
    expect(a?.metadata.startLine).toBe(2);
    expect(a?.metadata.endLine).toBe(2);
  });
});

describe("CodeChunker — python", () => {
  it("emits chunks for python def + class", async () => {
    const src = `
def alpha(x):
    return x + 1

class Beta:
    def greet(self):
        return "hi"
`.trim();
    const out = await collect(new CodeChunker().chunk(inp(src, "x.py")));
    const names = new Set(out.map((c) => c.metadata.symbolName).filter(Boolean));
    expect(names.has("alpha")).toBe(true);
    expect(names.has("Beta")).toBe(true);
    expect(out.every((c) => c.metadata.language === "python")).toBe(true);
  });
});

describe("CodeChunker — fallback", () => {
  it("falls back to blank-line splitter when language is unknown / unsupported", async () => {
    const src = "first paragraph here\n\nsecond paragraph there\n\nthird paragraph too";
    const out = await collect(new CodeChunker().chunk(inp(src, "x.unknown")));
    expect(out.length).toBeGreaterThanOrEqual(1);
    // symbolName must NOT be populated in fallback
    for (const c of out) expect(c.metadata.symbolName).toBeUndefined();
  });

  it("splits oversize symbol into _fragment chunks tagged with the same name", async () => {
    const body = "  const v = 1;\n".repeat(500);
    const src = `function big(): void {\n${body}\n}`;
    const out = await collect(new CodeChunker().chunk({
      text: src, path: "x.ts", source: "code", sourceHash: "h", mtimeMs: 1, language: "typescript", chunkSize: 50,
    }));
    expect(out.length).toBeGreaterThan(1);
    const allBig = out.every((c) => c.metadata.symbolName === "big");
    expect(allBig).toBe(true);
    const anyFragment = out.some((c) => c.metadata.symbolKind?.includes("fragment"));
    expect(anyFragment).toBe(true);
  });
});
