import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRagManager } from "./manager.js";
import type { OpenAIProviderOptions, EmbeddingsClient } from "./provider/index.js";
import { ConfigDriftError, DatasetNotFoundError } from "./errors.js";

function fakeEmbeddingsClient(dim: number): EmbeddingsClient {
  return {
    async create({ input }) {
      return {
        data: input.map((t, i) => ({
          embedding: Array.from({ length: dim }, (_, k) => ((t.length + i + k) % 7) / 7),
        })),
      };
    },
  };
}

function providerOptions(dim: number): OpenAIProviderOptions {
  return { apiKey: "test", client: fakeEmbeddingsClient(dim) };
}

describe("RagManager", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), "rag-mgr-"));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("returns a no-op manager when enabled=false", async () => {
    const m = await createRagManager({
      projectRoot: root,
      projectId: "p1",
      enabled: false,
      datasets: [],
    });
    expect(m.enabled).toBe(false);
    expect(await m.list()).toEqual([]);
    await expect(m.get("anything")).rejects.toBeInstanceOf(DatasetNotFoundError);
  });

  it("register opens a dataset, writes the registry, and surfaces it via list()", async () => {
    const m = await createRagManager({
      projectRoot: root,
      projectId: "p1",
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
      providerOptions: providerOptions(256),
    });
    const ds = await m.register({
      id: "docs",
      source: "doc",
      provider: { kind: "openai", model: "text-embedding-3-small", dim: 256 },
      store: { kind: "sqlite-vec" },
      chunker: { kind: "markdown" },
    });
    expect(ds.id).toBe("docs");
    const listed = await m.list();
    expect(listed.map((x) => x.id)).toEqual(["docs"]);
    expect(listed[0]?.providerStamp.dim).toBe(256);
    await m.close();
  });

  it("throws ConfigDriftError when provider.dim changes between sessions", async () => {
    const cfg256 = {
      id: "docs",
      source: "doc" as const,
      provider: { kind: "openai" as const, model: "text-embedding-3-small" as const, dim: 256 as const },
      store: { kind: "sqlite-vec" as const },
      chunker: { kind: "markdown" as const },
    };
    const m1 = await createRagManager({
      projectRoot: root,
      projectId: "p1",
      enabled: true,
      datasets: [cfg256],
      providerOptions: providerOptions(256),
    });
    await m1.register(cfg256);
    await m1.close();

    const cfg1024 = { ...cfg256, provider: { ...cfg256.provider, dim: 1024 as const } };
    const m2 = await createRagManager({
      projectRoot: root,
      projectId: "p1",
      enabled: true,
      datasets: [cfg1024],
      providerOptions: providerOptions(1024),
    });
    await expect(m2.register(cfg1024)).rejects.toBeInstanceOf(ConfigDriftError);
    await m2.close();
  });

  it("ingests + queries + drops via the manager surface", async () => {
    mkdirSync(path.join(root, "src"));
    writeFileSync(path.join(root, "src", "a.md"), "# Cats\n\nfluffy cats");
    writeFileSync(path.join(root, "src", "b.md"), "# Dogs\n\nbarking dogs");
    const m = await createRagManager({
      projectRoot: root,
      projectId: "p1",
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
      providerOptions: providerOptions(256),
    });
    await m.register({
      id: "docs",
      source: "doc",
      provider: { kind: "openai", model: "text-embedding-3-small", dim: 256 },
      store: { kind: "sqlite-vec" },
      chunker: { kind: "markdown" },
    });
    const report = await m.ingest("docs", { kind: "fs", root, include: ["src/**/*.md"] });
    expect(report.filesChanged).toBe(2);
    const hits = await m.query("docs", "cats", { topK: 5 });
    expect(hits.length).toBeGreaterThan(0);
    const stats = await m.stats("docs");
    expect(stats.chunks).toBeGreaterThan(0);
    await m.drop("docs");
    expect(await m.list()).toEqual([]);
    await m.close();
  });
});
