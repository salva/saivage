import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, openSync, ftruncateSync, closeSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { createVectorStore, type VectorStore } from "./index.js";
import { compileFilter, isPreFilterEligible } from "./sql.js";
import {
  CorruptedStoreError,
  EmbeddingDriftError,
  InvalidQueryFilterError,
} from "../errors.js";
import type {
  ChunkMetadata,
  ProviderStamp,
  StoredChunk,
} from "../types.js";

const STAMP_A: ProviderStamp = {
  provider: "openai",
  model: "text-embedding-3-small",
  dim: 4,
  releaseFingerprint: "stampA",
};

const STAMP_B: ProviderStamp = { ...STAMP_A, dim: 8, releaseFingerprint: "stampB" };

function meta(over: Partial<ChunkMetadata> = {}): ChunkMetadata {
  return {
    path: "a.md", source: "doc", chunkIndex: 0,
    contentHash: "ch", sourceHash: "sh", mtimeMs: 1,
    ...over,
  };
}

function chunk(id: string, vec: number[], over: Partial<ChunkMetadata> = {}, text = "t"): StoredChunk {
  return { id, text, metadata: meta({ path: over.path ?? `${id}.md`, ...over }), embedding: new Float32Array(vec) };
}

let dir: string;
let store: VectorStore;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "saivage-rag-store-"));
  store = await createVectorStore({ kind: "sqlite-vec" }, join(dir, "store.db"));
  await store.open(STAMP_A);
});

afterEach(async () => {
  try { await store.close(); } catch { /* ignore */ }
  rmSync(dir, { recursive: true, force: true });
});

describe("sql.compileFilter", () => {
  it("compiles eq with null IS NULL", () => {
    const c = compileFilter({ eq: { path: "a.md", language: null } });
    expect(c.sql).toMatch(/path = \?/);
    expect(c.sql).toMatch(/language IS NULL/);
    expect(c.params).toEqual(["a.md"]);
  });
  it("compiles in", () => {
    const c = compileFilter({ in: { source: ["doc", "skill"] } });
    expect(c.sql).toMatch(/source IN \(\?, \?\)/);
    expect(c.params).toEqual(["doc", "skill"]);
  });
  it("compiles and/or", () => {
    const c = compileFilter({
      or: [{ eq: { path: "a" } }, { and: [{ eq: { source: "doc" } }, { pathGlob: "**/*.md" } ] }],
    });
    expect(c.sql).toMatch(/OR/);
    expect(c.sql).toMatch(/path GLOB \?/);
    expect(c.params).toEqual(["a", "doc", "**/*.md"]);
  });
  it("compiles gt/lt", () => {
    const c = compileFilter({ gt: { mtimeMs: 1 }, lt: { mtimeMs: 10 } });
    expect(c.sql).toMatch(/mtimeMs > \? AND mtimeMs < \?/);
    expect(c.params).toEqual([1, 10]);
  });
  it("rejects unknown column", () => {
    expect(() => compileFilter({ eq: { nope: "x" } })).toThrow(InvalidQueryFilterError);
  });
  it("rejects empty IN list", () => {
    expect(() => compileFilter({ in: { source: [] } })).toThrow(InvalidQueryFilterError);
  });
  it("isPreFilterEligible only on indexed eq/in/and", () => {
    expect(isPreFilterEligible({ eq: { path: "a" } })).toBe(true);
    expect(isPreFilterEligible({ in: { source: ["doc"] } })).toBe(true);
    expect(isPreFilterEligible({ and: [{ eq: { path: "a" } }, { eq: { source: "doc" } }] })).toBe(true);
    expect(isPreFilterEligible({ eq: { startLine: 1 } })).toBe(false);
    expect(isPreFilterEligible({ pathGlob: "**/*.md" })).toBe(false);
    expect(isPreFilterEligible({ or: [{ eq: { path: "a" } }] })).toBe(false);
  });
});

describe("SqliteVecStore — open / drift / corruption", () => {
  it("open creates schema and stamps meta", async () => {
    const path = store.path;
    expect(existsSync(path)).toBe(true);
    expect(store.stamp.dim).toBe(4);
  });

  it("reopen with mismatched stamp throws EmbeddingDriftError", async () => {
    await store.close();
    const s2 = await createVectorStore({ kind: "sqlite-vec" }, store.path);
    await expect(s2.open(STAMP_B)).rejects.toBeInstanceOf(EmbeddingDriftError);
  });

  it("integrity-check failure on a truncated file throws CorruptedStoreError and writes .corrupted", async () => {
    await store.close();
    // Truncate file to a few bytes (still > 0 so open() does not fail with cantopen).
    const fd = openSync(store.path, "r+");
    ftruncateSync(fd, 16);
    closeSync(fd);
    const s2 = await createVectorStore({ kind: "sqlite-vec" }, store.path);
    await expect(s2.open(STAMP_A)).rejects.toBeInstanceOf(CorruptedStoreError);
    expect(existsSync(`${store.path}.corrupted`)).toBe(true);
    // Subsequent open short-circuits on the sentinel.
    const s3 = await createVectorStore({ kind: "sqlite-vec" }, store.path);
    await expect(s3.open(STAMP_A)).rejects.toBeInstanceOf(CorruptedStoreError);
  });
});

describe("SqliteVecStore — upsert / query / delete", () => {
  it("upsert is idempotent on identical id", async () => {
    const c = chunk("a", [1, 0, 0, 0]);
    await store.upsert([c]);
    await store.upsert([c]);
    const stats = await store.stats();
    expect(stats.chunks).toBe(1);
  });

  it("query returns top-K rows in score order (best first)", async () => {
    await store.upsert([
      chunk("a", [1, 0, 0, 0], { path: "a.md" }),
      chunk("b", [0, 1, 0, 0], { path: "b.md" }),
      chunk("c", [0.9, 0.1, 0, 0], { path: "c.md" }),
    ]);
    const hits = await store.query(new Float32Array([1, 0, 0, 0]), 2);
    expect(hits.map((h) => h.id)).toEqual(["a", "c"]);
    expect(hits.length).toBe(2);
    const [h0, h1] = hits;
    if (!h0 || !h1) throw new Error("unreachable");
    expect(h0.score).toBeGreaterThanOrEqual(h1.score);
    expect(h0.text).toBe("t");
  });

  it("query honours pre-filter eligible filter", async () => {
    await store.upsert([
      chunk("a", [1, 0, 0, 0], { path: "x/a.md", source: "doc" }),
      chunk("b", [1, 0, 0, 0], { path: "x/b.md", source: "skill" }),
    ]);
    const hits = await store.query(new Float32Array([1, 0, 0, 0]), 5, { eq: { source: "doc" } });
    expect(hits.map((h) => h.id)).toEqual(["a"]);
  });

  it("query honours post-filter (pathGlob) with overshoot", async () => {
    await store.upsert([
      chunk("a", [1, 0, 0, 0], { path: "docs/a.md" }),
      chunk("b", [0.95, 0.05, 0, 0], { path: "src/b.md" }),
      chunk("c", [0.9, 0.1, 0, 0], { path: "docs/c.md" }),
    ]);
    const hits = await store.query(new Float32Array([1, 0, 0, 0]), 5, { pathGlob: "docs/*" });
    expect(hits.map((h) => h.id)).toEqual(["a", "c"]);
  });

  it("deleteByFilter matches every basic QueryFilter shape", async () => {
    await store.upsert([
      chunk("a", [1, 0, 0, 0], { path: "a.md", source: "doc", language: "md" }),
      chunk("b", [0, 1, 0, 0], { path: "b.md", source: "skill", language: "md" }),
      chunk("c", [0, 0, 1, 0], { path: "src/c.ts", source: "code", language: "ts" }),
    ]);
    expect(await store.deleteByFilter({ eq: { language: "md" } })).toBe(2);
    expect((await store.stats()).chunks).toBe(1);
    await store.upsert([
      chunk("a", [1, 0, 0, 0], { path: "a.md", source: "doc" }),
      chunk("b", [0, 1, 0, 0], { path: "b.md", source: "skill" }),
    ]);
    expect(await store.deleteByFilter({ in: { source: ["doc", "skill"] } })).toBe(2);
    await store.upsert([chunk("d", [0, 0, 0, 1], { path: "d.md" })]);
    expect(await store.deleteByFilter({ pathGlob: "*.md" })).toBe(1);
    await store.upsert([chunk("e", [1, 0, 0, 0], { mtimeMs: 100 })]);
    expect(await store.deleteByFilter({ gt: { mtimeMs: 50 } })).toBe(1);
  });

  it("deleteByIds removes both chunk and vec rows", async () => {
    await store.upsert([chunk("a", [1, 0, 0, 0]), chunk("b", [0, 1, 0, 0])]);
    expect(await store.deleteByIds(["a"])).toBe(1);
    const hits = await store.query(new Float32Array([1, 0, 0, 0]), 5);
    expect(hits.map((h) => h.id)).not.toContain("a");
  });

  it("rejects vectors with wrong dim", async () => {
    await expect(store.upsert([chunk("a", [1, 0, 0])])).rejects.toBeInstanceOf(EmbeddingDriftError);
    await expect(store.query(new Float32Array([1, 0, 0]), 1)).rejects.toBeInstanceOf(EmbeddingDriftError);
  });
});

describe("SqliteVecStore — cache + file_state + stats + drop", () => {
  it("embedding cache round-trips Float32Array", async () => {
    await store.putCachedEmbedding("k1", new Float32Array([0.5, 0.25, -0.125, 0.0625]));
    const v = await store.getCachedEmbedding("k1");
    if (!v) throw new Error("missing cached vector");
    expect(Array.from(v)).toEqual([0.5, 0.25, -0.125, 0.0625]);
    expect(await store.getCachedEmbedding("missing")).toBeNull();
  });

  it("file_state put/get/delete", async () => {
    await store.putFileState([
      { path: "a.md", sourceHash: "h1", mtimeMs: 1, lastIngestAt: 100 },
      { path: "b.md", sourceHash: "h2", mtimeMs: 2, lastIngestAt: 100 },
    ]);
    const m = await store.getFileState();
    expect(m.size).toBe(2);
    expect(m.get("a.md")?.sourceHash).toBe("h1");
    expect(await store.deleteFileState(["a.md"])).toBe(1);
    const m2 = await store.getFileState();
    expect(m2.has("a.md")).toBe(false);
  });

  it("stats reports chunks/files/bytes and lastIngestAt", async () => {
    await store.upsert([chunk("a", [1, 0, 0, 0]), chunk("b", [0, 1, 0, 0], { path: "a.md" })]);
    await store.setLastIngestAt(1717000000000);
    await store.bumpSecretsDropped(3);
    const stats = await store.stats();
    expect(stats.chunks).toBe(2);
    expect(stats.files).toBe(1);
    expect(stats.bytesOnDisk).toBeGreaterThan(0);
    expect(stats.lastIngestAt).toMatch(/^2024-/);
  });

  it("drop removes the file and its WAL siblings", async () => {
    await store.upsert([chunk("a", [1, 0, 0, 0])]);
    const dbPath = store.path;
    // Force WAL/SHM files into existence by reading after the write.
    await store.stats();
    expect(existsSync(dbPath)).toBe(true);
    await store.drop();
    expect(existsSync(dbPath)).toBe(false);
    expect(existsSync(`${dbPath}-wal`)).toBe(false);
    expect(existsSync(`${dbPath}-shm`)).toBe(false);
  });
});
