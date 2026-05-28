import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRagManager } from "../manager.js";
import { getInternalDataset } from "./datasetAccess.js";
import type { OpenAIProviderOptions, EmbeddingsClient } from "../provider/index.js";

function fakeEmbeddings(dim: number): EmbeddingsClient {
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
  return { apiKey: "test", client: fakeEmbeddings(dim) };
}

describe("getInternalDataset", () => {
  let projectRoot: string;
  beforeEach(() => {
    projectRoot = mkdtempSync(path.join(tmpdir(), "internal-ds-"));
  });
  afterEach(() => rmSync(projectRoot, { recursive: true, force: true }));

  it("returns undefined for unknown ids before any register", async () => {
    const m = await createRagManager({
      projectRoot,
      projectId: "p",
      enabled: true,
      datasets: [],
      providerOptions: providerOptions(1536),
    });
    expect(getInternalDataset(m, "anything")).toBeUndefined();
    await m.close();
  });

  it("returns the registered Dataset after register", async () => {
    const cfg = {
      id: "docs",
      source: "doc" as const,
      provider: { kind: "openai" as const, model: "text-embedding-3-small" as const, dim: 1536 as const },
      store: { kind: "sqlite-vec" as const },
      chunker: { kind: "markdown" as const },
    };
    const m = await createRagManager({
      projectRoot,
      projectId: "p",
      enabled: true,
      datasets: [cfg],
      providerOptions: providerOptions(1536),
    });
    await m.register(cfg);
    const ds = getInternalDataset(m, "docs");
    expect(ds).toBeDefined();
    expect(ds?.id).toBe("docs");
    await m.close();
  });

  it("returns undefined for the disabled (no-op) manager", async () => {
    const m = await createRagManager({
      projectRoot,
      projectId: "p",
      enabled: false,
      datasets: [],
    });
    expect(getInternalDataset(m, "anything")).toBeUndefined();
  });
});
