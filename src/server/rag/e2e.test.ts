/**
 * F02 B08 — end-to-end via `makeRagHandler` exercising the real
 * `RagManager` (fake embeddings) against a temp project. Verifies the
 * full rag_register → rag_ingest → rag_query → rag_stats → rag_drop
 * loop under both `operatorContext` and admin-role contexts.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRagManager } from "../../rag/index.js";
import type { OpenAIProviderOptions, EmbeddingsClient } from "../../rag/provider/index.js";
import { makeRagHandler } from "./handler.js";
import type { RagService } from "./service.js";
import type { ToolCallContext } from "../../mcp/toolContext.js";

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

async function buildService(projectRoot: string): Promise<RagService> {
  mkdirSync(path.join(projectRoot, ".saivage"), { recursive: true });
  writeFileSync(
    path.join(projectRoot, ".saivage", "saivage.json"),
    JSON.stringify({ rag: { enabled: true, datasets: [] } }),
  );
  const datasets: RagService["datasets"] = [];
  const manager = await createRagManager({
    projectRoot,
    projectId: "e2e",
    enabled: true,
    datasets,
    providerOptions: providerOptions(1536),
  });
  return {
    manager,
    datasets,
    watchStatus: new Map(),
    adminRoles: new Set(["planner"]),
    control: { busy: false },
    enabled: true,
    projectRoot,
  };
}

const operatorCtx: ToolCallContext = {
  role: "coder",
  agentId: "op",
  projectRoot: "/will-be-overwritten",
  operatorContext: true,
};

const plannerCtx: ToolCallContext = {
  role: "planner",
  agentId: "p1",
  projectRoot: "/will-be-overwritten",
};

function asOk<T>(c: unknown): T {
  expect(c).toMatchObject({ ok: true });
  return (c as { ok: true; content: T }).content;
}

describe("rag handler — e2e", () => {
  let projectRoot: string;
  let service: RagService;
  beforeEach(async () => {
    projectRoot = mkdtempSync(path.join(tmpdir(), "rag-e2e-"));
    mkdirSync(path.join(projectRoot, "data"));
    writeFileSync(path.join(projectRoot, "data", "cats.md"), "# Cats\n\nfluffy cats love to nap");
    writeFileSync(path.join(projectRoot, "data", "dogs.md"), "# Dogs\n\nbarking dogs chase tails");
    service = await buildService(projectRoot);
  });
  afterEach(async () => {
    await service.manager.close();
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it("register → ingest → query → stats → drop under operatorContext", async () => {
    const h = makeRagHandler(service);

    const reg = await h(
      "rag_register",
      {
        collection_id: "docs",
        source: "doc",
        chunker: { kind: "markdown" },
        sources: [{ root: "data" }],
      },
      operatorCtx,
    );
    if (reg.isError) throw new Error("register failed: " + JSON.stringify(reg.content));
    expect(reg.isError).toBe(false);

    const list = asOk<{ collections: { id: string }[] }>(
      (await h("rag_list", {}, plannerCtx)).content,
    );
    expect(list.collections.map((c) => c.id)).toEqual(["docs"]);

    // Initial ingest happened during register; an explicit ingest is idempotent.
    const ing = await h("rag_ingest", { collection_id: "docs" }, operatorCtx);
    expect(ing.isError).toBe(false);

    const q = asOk<{ hits: { text: string }[] }>(
      (await h("rag_query", { collection_id: "docs", text: "cats", topK: 5 }, plannerCtx)).content,
    );
    expect(q.hits.length).toBeGreaterThan(0);

    const stats = asOk<{ chunks: number; protected: boolean }>(
      (await h("rag_stats", { collection_id: "docs" }, plannerCtx)).content,
    );
    expect(stats.chunks).toBeGreaterThan(0);
    expect(stats.protected).toBe(false);

    const drop = await h("rag_drop", { collection_id: "docs" }, operatorCtx);
    expect(drop.isError).toBe(false);
    const listAfter = asOk<{ collections: unknown[] }>(
      (await h("rag_list", {}, plannerCtx)).content,
    );
    expect(listAfter.collections).toEqual([]);
  });

  it("non-admin role is rejected from rag_register", async () => {
    const h = makeRagHandler(service);
    const r = await h(
      "rag_register",
      {
        collection_id: "docs",
        source: "doc",
        chunker: { kind: "markdown" },
        sources: [{ root: "data" }],
      },
      { role: "coder", agentId: "c1", projectRoot },
    );
    expect(r.content).toMatchObject({ ok: false, code: "RAG_UNAUTHORIZED_ROLE" });
  });

  it("project layout files exist after register", async () => {
    const h = makeRagHandler(service);
    await h(
      "rag_register",
      {
        collection_id: "docs",
        source: "doc",
        chunker: { kind: "markdown" },
        sources: [{ root: "data" }],
      },
      operatorCtx,
    );
    expect(existsSync(path.join(projectRoot, ".saivage", "rag"))).toBe(true);
  });
});
