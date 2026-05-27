import { describe, it, expect, expectTypeOf } from "vitest";
import type {
  ChunkMetadata,
  ChunkMetadataInput,
  ChunkerInput,
  ChunkerRef,
  DatasetConfig,
  DatasetStats,
  EmbeddingProviderRef,
  IngestInput,
  IngestReport,
  ProviderStamp,
  QueryFilter,
  QueryHit,
  QueryOptions,
  RawChunk,
  RegisteredDataset,
  StoredChunk,
  StoredHit,
  VectorStoreRef,
} from "./types.js";

describe("rag types — compile-time + structural", () => {
  it("ProviderStamp shape", () => {
    const s: ProviderStamp = { provider: "openai", model: "text-embedding-3-small", dim: 1536, releaseFingerprint: "abc" };
    expect(s.dim).toBe(1536);
  });

  it("EmbeddingProviderRef accepts each documented dim and rejects others at the type layer", () => {
    const dims: EmbeddingProviderRef["dim"][] = [256, 512, 1024, 1536];
    expect(dims).toHaveLength(4);
    expectTypeOf<EmbeddingProviderRef["kind"]>().toEqualTypeOf<"openai">();
    expectTypeOf<EmbeddingProviderRef["model"]>().toEqualTypeOf<"text-embedding-3-small">();
  });

  it("VectorStoreRef is single-kind in v1", () => {
    const v: VectorStoreRef = { kind: "sqlite-vec" };
    expect(v.kind).toBe("sqlite-vec");
  });

  it("ChunkerRef enumerates the three chunker kinds", () => {
    const kinds: ChunkerRef["kind"][] = ["markdown", "code", "memory"];
    expect(new Set(kinds).size).toBe(3);
  });

  it("DatasetConfig composes the refs", () => {
    const cfg: DatasetConfig = {
      id: "docs",
      projectId: "saivage-v3",
      source: "doc",
      provider: { kind: "openai", model: "text-embedding-3-small", dim: 1536 },
      store: { kind: "sqlite-vec" },
      chunker: { kind: "markdown" },
    };
    expect(cfg.id).toBe("docs");
  });

  it("QueryFilter union members construct", () => {
    const fs: QueryFilter[] = [
      { eq: { path: "a.md" } },
      { and: [{ eq: { source: "doc" } }, { pathGlob: "docs/**/*.md" }] },
      { or: [{ eq: { source: "skill" } }, { eq: { source: "doc" } }] },
      { gt: { mtimeMs: 0 }, lt: { mtimeMs: 1 } },
      { pathGlob: "**/*.ts" },
      { in: { source: ["doc", "skill"] } },
    ];
    expect(fs).toHaveLength(6);
  });

  it("QueryOptions topK is optional with documented default in pipeline", () => {
    const o: QueryOptions = { topK: 10, filter: { eq: { source: "doc" } } };
    expect(o.topK).toBe(10);
  });

  it("QueryHit and StoredHit carry ChunkMetadata", () => {
    const meta: ChunkMetadata = {
      path: "x.md",
      source: "doc",
      chunkIndex: 0,
      contentHash: "c",
      sourceHash: "s",
      mtimeMs: 1,
    };
    const h: QueryHit = { chunkId: "id", score: 0.9, text: "t", metadata: meta };
    const sh: StoredHit = { id: "id", score: 0.9, text: "t", metadata: meta };
    expect(h.chunkId).toBe(sh.id);
  });

  it("RawChunk and StoredChunk differ on embedding presence", () => {
    const meta: ChunkMetadata = {
      path: "x.md", source: "doc", chunkIndex: 0, contentHash: "c", sourceHash: "s", mtimeMs: 1,
    };
    const r: RawChunk = { text: "t", metadata: meta };
    const sc: StoredChunk = { id: "id", text: "t", metadata: meta, embedding: new Float32Array(4) };
    expect(r.text).toBe(sc.text);
    expect(sc.embedding.length).toBe(4);
  });

  it("ChunkMetadataInput is RawChunk-ready (omits derived fields)", () => {
    const i: ChunkMetadataInput = { path: "x.md", source: "doc", startLine: 1, endLine: 2 };
    expect(i.path).toBe("x.md");
  });

  it("IngestInput discriminates fs vs records", () => {
    const a: IngestInput = { kind: "fs", root: "/tmp", include: ["**/*.md"] };
    const b: IngestInput = { kind: "records", items: [{ id: "1", text: "x", metadata: { path: "p", source: "memory" } }] };
    expect(a.kind).toBe("fs");
    expect(b.kind).toBe("records");
  });

  it("IngestReport / DatasetStats / RegisteredDataset / ChunkerInput compile", () => {
    const rep: IngestReport = {
      filesScanned: 0, filesChanged: 0, chunksUpserted: 0, chunksDeleted: 0,
      chunksDroppedSecrets: 0, tokensEmbedded: 0, embeddingMs: 0, storeMs: 0,
    };
    const stamp: ProviderStamp = { provider: "openai", model: "text-embedding-3-small", dim: 1536, releaseFingerprint: "abc" };
    const stats: DatasetStats = { chunks: 0, files: 0, bytesOnDisk: 0, provider: stamp, lastIngestAt: null, secretsDropped: 0 };
    const reg: RegisteredDataset = { id: "x", source: "doc", providerStamp: stamp, createdAt: new Date().toISOString() };
    const cin: ChunkerInput = { text: "t", path: "x.md", source: "doc", sourceHash: "s", mtimeMs: 1 };
    expect(rep.filesScanned).toBe(0);
    expect(stats.lastIngestAt).toBeNull();
    expect(reg.providerStamp.dim).toBe(1536);
    expect(cin.text).toBe("t");
  });
});
