// F01 B10 — End-to-end ingest + query test against the real OpenAI embeddings
// API. Gated on `OPENAI_API_KEY`; skipped on machines without the secret.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRagManager, type RagManager } from "../../src/rag/index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(here, "fixtures", "docs");
const KEY = process.env.OPENAI_API_KEY;
const describeIf = KEY && KEY.length > 0 ? describe : describe.skip;

describeIf("F01 B10 — e2e ingest + query (OpenAI live)", () => {
  let root: string;
  let m: RagManager;

  beforeAll(async () => {
    root = mkdtempSync(path.join(tmpdir(), "rag-e2e-"));
    mkdirSync(path.join(root, "docs"));
    cpSync(FIXTURES, path.join(root, "docs"), { recursive: true });

    m = await createRagManager({
      projectRoot: root,
      projectId: "p-e2e",
      enabled: true,
      datasets: [
        {
          id: "docs",
          source: "doc",
          provider: { kind: "openai", model: "text-embedding-3-small", dim: 256 },
          store: { kind: "sqlite-vec" },
          chunker: { kind: "markdown" },
        },
      ],
      providerOptions: { apiKey: KEY },
    });
    await m.register({
      id: "docs",
      source: "doc",
      provider: { kind: "openai", model: "text-embedding-3-small", dim: 256 },
      store: { kind: "sqlite-vec" },
      chunker: { kind: "markdown" },
    });
    await m.ingest("docs", { kind: "fs", root, include: ["docs/**/*.md"] });
  }, 120_000);

  afterAll(async () => {
    if (m) await m.close();
    if (root) rmSync(root, { recursive: true, force: true });
  });

  it("returns relevant hits for the 'cats' topic", async () => {
    const hits = await m.query("docs", "fluffy cats and purring", { topK: 5 });
    expect(hits.length).toBeGreaterThan(0);
    const titles = hits.map((h) => h.text.toLowerCase());
    expect(titles.some((t) => t.includes("cats"))).toBe(true);
  });

  it("returns relevant hits for the 'astronomy' topic", async () => {
    const hits = await m.query("docs", "constellations and the milky way", { topK: 5 });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.some((h) => h.text.toLowerCase().includes("astronomy"))).toBe(true);
  });

  it("second ingest is a no-op (file_state unchanged)", async () => {
    const report = await m.ingest("docs", { kind: "fs", root, include: ["docs/**/*.md"] });
    expect(report.filesChanged).toBe(0);
    expect(report.chunksUpserted).toBe(0);
  });
});
