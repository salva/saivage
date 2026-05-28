/**
 * F01 B05 — verify that records-mode `runIngest` honours the
 * caller-supplied `metadata.source` (skill / memory / doc / code)
 * instead of re-inferring it from the synthetic path.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { runIngest } from "./pipeline.js";
import { createVectorStore, type VectorStore } from "./store/index.js";
import { MemoryChunker } from "./chunker/memory.js";
import type { EmbeddingProvider } from "./provider/index.js";
import type { ProviderStamp, RagSource } from "./types.js";

const STAMP: ProviderStamp = {
  provider: "openai",
  model: "text-embedding-3-small",
  dim: 8,
  releaseFingerprint: "test",
};

function fakeProvider(): EmbeddingProvider {
  return {
    stamp: STAMP,
    async embedDocuments(texts) {
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
  };
}

describe("runIngest — records mode honours metadata.source", () => {
  let root: string;
  let store: VectorStore;

  beforeEach(async () => {
    root = mkdtempSync(path.join(tmpdir(), "rag-recsrc-"));
    store = await createVectorStore({ kind: "sqlite-vec" }, path.join(root, "store.db"));
  });

  afterEach(async () => {
    await store.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("preserves source=skill and source=memory through a records-mode round trip", async () => {
    const provider = fakeProvider();
    const chunker = new MemoryChunker();
    const report = await runIngest({
      datasetId: "knowledge.records",
      lockfilePath: path.join(root, "ingest.lock"),
      store,
      provider,
      chunker,
      input: {
        kind: "records",
        items: [
          {
            id: "s1",
            text: "Skill body content for embedding.",
            metadata: { path: "skill:s1.md", source: "skill", scope: "project" },
          },
          {
            id: "m1",
            text: "Memory body content for embedding.",
            metadata: { path: "memory:m1.md", source: "memory", scope: "project" },
          },
        ],
      },
    });
    expect(report.filesScanned).toBe(2);
    expect(report.chunksUpserted).toBeGreaterThanOrEqual(2);

    const qvec = await provider.embedQuery("body content");
    const hits = await store.query(qvec, 16);
    const bySource = new Map<RagSource, number>();
    for (const h of hits) {
      bySource.set(h.metadata.source, (bySource.get(h.metadata.source) ?? 0) + 1);
    }
    expect(bySource.get("skill")).toBeGreaterThanOrEqual(1);
    expect(bySource.get("memory")).toBeGreaterThanOrEqual(1);
    expect(bySource.get("doc") ?? 0).toBe(0);
    expect(bySource.get("code") ?? 0).toBe(0);

    // Per-record path must keep its declared source.
    const skillHit = hits.find((h) => h.metadata.path === "skill:s1.md");
    const memHit = hits.find((h) => h.metadata.path === "memory:m1.md");
    expect(skillHit?.metadata.source).toBe("skill");
    expect(memHit?.metadata.source).toBe("memory");
  });
});
