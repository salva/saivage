import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { runIngest } from "../pipeline.js";
import { runQuery } from "./pipeline.js";
import { createVectorStore, type VectorStore } from "../store/index.js";
import type { EmbeddingProvider } from "../provider/index.js";
import { MarkdownChunker } from "../chunker/markdown.js";
import type { ProviderStamp } from "../types.js";
import { EmbeddingDriftError } from "../errors.js";

const STAMP: ProviderStamp = {
  provider: "openai",
  model: "text-embedding-3-small",
  dim: 8,
  releaseFingerprint: "test",
};

function provider(stamp: ProviderStamp = STAMP): EmbeddingProvider {
  return {
    stamp,
    async embedDocuments(texts) {
      return texts.map((t, i) => {
        const v = new Float32Array(stamp.dim);
        for (let k = 0; k < stamp.dim; k++) v[k] = ((t.length + i + k) % 7) / 7;
        return v;
      });
    },
    async embedQuery(text) {
      const v = new Float32Array(stamp.dim);
      for (let k = 0; k < stamp.dim; k++) v[k] = ((text.length + k) % 7) / 7;
      return v;
    },
  };
}

describe("runQuery", () => {
  let root: string;
  let store: VectorStore;
  beforeEach(async () => {
    root = mkdtempSync(path.join(tmpdir(), "rag-q-"));
    mkdirSync(path.join(root, "docs"));
    writeFileSync(path.join(root, "docs", "a.md"), "# A\n\nalpha body about cats");
    writeFileSync(path.join(root, "docs", "b.md"), "# B\n\nbeta body about dogs");
    store = await createVectorStore({ kind: "sqlite-vec" }, path.join(root, "store.db"));
    await runIngest({
      datasetId: "d1",
      lockfilePath: path.join(root, ".lock"),
      store,
      provider: provider(),
      chunker: new MarkdownChunker(),
      input: { kind: "fs", root, include: ["docs/**/*.md"] },
    });
  });
  afterEach(async () => {
    await store.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("returns hits sorted by score desc, capped at topK", async () => {
    const hits = await runQuery({ store, provider: provider(), text: "cats", options: { topK: 2 } });
    expect(hits.length).toBeLessThanOrEqual(2);
    for (let i = 1; i < hits.length; i++) {
      const prev = hits[i - 1];
      const cur = hits[i];
      if (!prev || !cur) throw new Error("unreachable");
      expect(prev.score).toBeGreaterThanOrEqual(cur.score);
    }
    for (const h of hits) {
      expect(typeof h.chunkId).toBe("string");
      expect(typeof h.text).toBe("string");
      expect(h.metadata.path).toMatch(/docs\//);
    }
  });

  it("applies filter via store.query", async () => {
    const hits = await runQuery({
      store,
      provider: provider(),
      text: "cats",
      options: { topK: 10, filter: { eq: { path: "docs/a.md" } } },
    });
    expect(hits.every((h) => h.metadata.path === "docs/a.md")).toBe(true);
  });

  it("throws EmbeddingDriftError when provider stamp no longer matches the store", async () => {
    const driftedProvider = provider({ ...STAMP, releaseFingerprint: "OTHER" });
    await expect(
      runQuery({ store, provider: driftedProvider, text: "cats" }),
    ).rejects.toBeInstanceOf(EmbeddingDriftError);
  });
});
