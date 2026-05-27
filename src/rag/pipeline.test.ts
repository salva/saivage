import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { runIngest } from "./pipeline.js";
import { createVectorStore, type VectorStore } from "./store/index.js";
import type { EmbeddingProvider } from "./provider/index.js";
import { MarkdownChunker } from "./chunker/markdown.js";
import type { ProviderStamp } from "./types.js";

const STAMP: ProviderStamp = {
  provider: "openai",
  model: "text-embedding-3-small",
  dim: 8,
  releaseFingerprint: "test",
};

function fakeProvider(): EmbeddingProvider & { calls: number } {
  let calls = 0;
  return {
    stamp: STAMP,
    async embedDocuments(texts) {
      calls += texts.length;
      return texts.map((t, i) => {
        const v = new Float32Array(STAMP.dim);
        for (let k = 0; k < STAMP.dim; k++) v[k] = ((t.length + i + k) % 7) / 7;
        return v;
      });
    },
    async embedQuery(text) {
      const [v] = await this.embedDocuments([text]);
      if (!v) throw new Error("unreachable");
      return v;
    },
    get calls() {
      return calls;
    },
  } as EmbeddingProvider & { calls: number };
}

describe("runIngest — fs mode", () => {
  let root: string;
  let storePath: string;
  let lockfile: string;
  let store: VectorStore;

  beforeEach(async () => {
    root = mkdtempSync(path.join(tmpdir(), "rag-ing-"));
    mkdirSync(path.join(root, "docs"));
    writeFileSync(path.join(root, "docs", "a.md"), "# A\n\nalpha body");
    writeFileSync(path.join(root, "docs", "b.md"), "# B\n\nbeta body");
    storePath = path.join(root, "store.db");
    lockfile = path.join(root, ".ingest.lock");
    store = await createVectorStore({ kind: "sqlite-vec" }, storePath);
  });

  afterEach(async () => {
    await store.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("ingests new files, then no-ops on second run", async () => {
    const provider = fakeProvider();
    const chunker = new MarkdownChunker();
    const r1 = await runIngest({
      datasetId: "d1",
      lockfilePath: lockfile,
      store,
      provider,
      chunker,
      input: { kind: "fs", root, include: ["docs/**/*.md"] },
    });
    expect(r1.filesScanned).toBe(2);
    expect(r1.filesChanged).toBe(2);
    expect(r1.chunksUpserted).toBeGreaterThan(0);
    const callsAfter1 = provider.calls;

    const r2 = await runIngest({
      datasetId: "d1",
      lockfilePath: lockfile,
      store,
      provider,
      chunker,
      input: { kind: "fs", root, include: ["docs/**/*.md"] },
    });
    expect(r2.filesChanged).toBe(0);
    expect(r2.chunksUpserted).toBe(0);
    expect(provider.calls).toBe(callsAfter1);
  });

  it("uses embedding cache for unchanged contentHash across paths", async () => {
    const provider = fakeProvider();
    const chunker = new MarkdownChunker();
    await runIngest({
      datasetId: "d1",
      lockfilePath: lockfile,
      store,
      provider,
      chunker,
      input: { kind: "fs", root, include: ["docs/**/*.md"] },
    });
    const callsAfter1 = provider.calls;
    // Add a duplicate file with the same content as a.md
    writeFileSync(path.join(root, "docs", "a2.md"), "# A\n\nalpha body");
    const r2 = await runIngest({
      datasetId: "d1",
      lockfilePath: lockfile,
      store,
      provider,
      chunker,
      input: { kind: "fs", root, include: ["docs/**/*.md"] },
    });
    expect(r2.filesChanged).toBe(1);
    // Cache should serve the embedding -> no new provider call for the dup.
    expect(provider.calls).toBe(callsAfter1);
  });

  it("deletes chunks for files that disappear", async () => {
    const provider = fakeProvider();
    const chunker = new MarkdownChunker();
    await runIngest({
      datasetId: "d1",
      lockfilePath: lockfile,
      store,
      provider,
      chunker,
      input: { kind: "fs", root, include: ["docs/**/*.md"] },
    });
    rmSync(path.join(root, "docs", "b.md"));
    const r2 = await runIngest({
      datasetId: "d1",
      lockfilePath: lockfile,
      store,
      provider,
      chunker,
      input: { kind: "fs", root, include: ["docs/**/*.md"] },
    });
    expect(r2.chunksDeleted).toBeGreaterThan(0);
  });

  it("re-ingests on content change and replaces old chunks", async () => {
    const provider = fakeProvider();
    const chunker = new MarkdownChunker();
    await runIngest({
      datasetId: "d1",
      lockfilePath: lockfile,
      store,
      provider,
      chunker,
      input: { kind: "fs", root, include: ["docs/**/*.md"] },
    });
    writeFileSync(path.join(root, "docs", "a.md"), "# A\n\nNEW alpha body");
    const r2 = await runIngest({
      datasetId: "d1",
      lockfilePath: lockfile,
      store,
      provider,
      chunker,
      input: { kind: "fs", root, include: ["docs/**/*.md"] },
    });
    expect(r2.filesChanged).toBe(1);
    expect(r2.chunksUpserted).toBeGreaterThan(0);
    expect(r2.chunksDeleted).toBeGreaterThan(0);
  });

  it("drops chunks containing secrets without throwing", async () => {
    writeFileSync(path.join(root, "docs", "leak.md"), "# X\n\ntoken sk-AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHHIIII");
    const provider = fakeProvider();
    const chunker = new MarkdownChunker();
    const r = await runIngest({
      datasetId: "d1",
      lockfilePath: lockfile,
      store,
      provider,
      chunker,
      input: { kind: "fs", root, include: ["docs/**/*.md"] },
    });
    expect(r.chunksDroppedSecrets).toBeGreaterThan(0);
    const stats = await store.stats();
    expect(stats.chunks).toBeGreaterThan(0);
  });
});
