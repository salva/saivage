/**
 * F02 B05 — per-tool tests. Mocks `RagManager` and (where needed)
 * `Dataset`. The control mutex / role checks live in the handler tests
 * (B06); these focus on each tool's success and error paths.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { RagService } from "./service.js";
import {
  DatasetNotFoundError,
  WatcherUnavailableError,
  IngestLockedError,
} from "../../rag/errors.js";
import { ragList } from "./tools/list.js";
import { ragStats } from "./tools/stats.js";
import { ragQuery } from "./tools/query.js";
import { ragRegister } from "./tools/register.js";
import { ragIngest } from "./tools/ingest.js";
import { ragDrop } from "./tools/drop.js";
import { ragAdmin } from "./tools/admin.js";

function makeService(over: Partial<RagService> = {}): RagService {
  const manager = {
    enabled: true,
    list: vi.fn(),
    get: vi.fn(),
    register: vi.fn(),
    ingest: vi.fn(),
    query: vi.fn(),
    stats: vi.fn(),
    drop: vi.fn(),
  } as unknown as RagService["manager"];
  return {
    manager,
    datasets: [],
    watchStatus: new Map(),
    adminRoles: new Set(),
    control: { busy: false },
    enabled: true,
    projectRoot: "/tmp/project",
    ...over,
  };
}

describe("ragList", () => {
  it("returns collections with protected markers", async () => {
    const svc = makeService();
    (svc.manager.list as ReturnType<typeof vi.fn>).mockResolvedValue([
      {
        id: "docs",
        source: "doc",
        providerStamp: { provider: "openai", model: "m", dim: 256, releaseFingerprint: "x" },
        createdAt: "2026-05-25T00:00:00.000Z",
      },
      {
        id: "knowledge.skills",
        source: "skill",
        providerStamp: { provider: "openai", model: "m", dim: 256, releaseFingerprint: "x" },
        createdAt: "2026-05-25T00:00:00.000Z",
      },
    ]);
    const out = await ragList(svc);
    expect(out.collections.map((c) => [c.id, c.protected])).toEqual([
      ["docs", false],
      ["knowledge.skills", true],
    ]);
  });
});

describe("ragStats", () => {
  it("returns stats with watch + protected fields", async () => {
    const svc = makeService();
    svc.watchStatus.set("docs", "armed");
    (svc.manager.stats as ReturnType<typeof vi.fn>).mockResolvedValue({
      chunks: 1,
      files: 1,
      bytesOnDisk: 100,
      provider: { provider: "openai", model: "m", dim: 256, releaseFingerprint: "x" },
      lastIngestAt: null,
      secretsDropped: 0,
    });
    const out = await ragStats(svc, { collection_id: "docs" });
    expect(out.watch).toBe("armed");
    expect(out.protected).toBe(false);
    expect(out.chunks).toBe(1);
  });
});

describe("ragQuery", () => {
  it("truncates hit text to 2 KiB", async () => {
    const svc = makeService();
    const big = "x".repeat(4096);
    (svc.manager.query as ReturnType<typeof vi.fn>).mockResolvedValue([
      { chunkId: "c1", score: 0.9, text: big, metadata: { path: "a", source: "doc", chunkIndex: 0, contentHash: "h", sourceHash: "s", mtimeMs: 0 } },
    ]);
    const out = await ragQuery(svc, { collection_id: "d", text: "q" });
    expect(out.hits[0]?.text.length).toBe(2048);
  });
});

describe("ragIngest", () => {
  it("rejects protected datasets", async () => {
    const svc = makeService();
    const out = await ragIngest(svc, { collection_id: "knowledge.memory" });
    expect(out).toMatchObject({ ok: false, code: "RAG_PROTECTED_DATASET" });
  });

  it("maps DatasetNotFoundError → RAG_DATASET_NOT_FOUND", async () => {
    const svc = makeService();
    (svc.manager.get as ReturnType<typeof vi.fn>).mockRejectedValue(
      new DatasetNotFoundError({ datasetId: "x" }),
    );
    const out = await ragIngest(svc, { collection_id: "x" });
    expect(out).toMatchObject({ ok: false, code: "RAG_DATASET_NOT_FOUND" });
  });

  it("propagates IngestLockedError", async () => {
    const svc = makeService();
    (svc.manager.get as ReturnType<typeof vi.fn>).mockResolvedValue({
      config: { sources: [{ root: "/tmp/x", include: ["**/*"] }] },
    });
    (svc.manager.ingest as ReturnType<typeof vi.fn>).mockRejectedValue(
      new IngestLockedError({ datasetId: "x", lockPath: "/x" }),
    );
    await expect(ragIngest(svc, { collection_id: "x" })).rejects.toBeInstanceOf(IngestLockedError);
  });
});

describe("ragDrop", () => {
  it("rejects protected datasets", async () => {
    const svc = makeService();
    const out = await ragDrop(svc, { collection_id: "knowledge.skills" });
    expect(out).toMatchObject({ ok: false, code: "RAG_PROTECTED_DATASET" });
  });

  it("splices the dataset and clears watch state on success", async () => {
    const svc = makeService();
    const cfg = {
      id: "d",
      source: "doc" as const,
      provider: { kind: "openai" as const, model: "text-embedding-3-small" as const, dim: 256 as const },
      store: { kind: "sqlite-vec" as const },
      chunker: { kind: "markdown" as const },
      exclusions: [],
      sources: [],
      watch: false as const,
    };
    svc.datasets.push(cfg);
    svc.watchStatus.set("d", "off");
    const out = await ragDrop(svc, { collection_id: "d" });
    expect(out).toEqual({ dropped: true, persisted: false });
    expect(svc.datasets).toHaveLength(0);
    expect(svc.watchStatus.has("d")).toBe(false);
  });
});

describe("ragAdmin", () => {
  it("watch_arm short-circuits to RAG_WATCH_DISABLED when watch=false", async () => {
    const svc = makeService();
    (svc.manager.get as ReturnType<typeof vi.fn>).mockResolvedValue({ config: { watch: false } });
    const out = await ragAdmin(svc, { collection_id: "d", action: "watch_arm" });
    expect(out).toMatchObject({ ok: false, code: "RAG_WATCH_DISABLED" });
  });

  it("watch_arm maps WatcherUnavailableError → RAG_WATCHER_UNAVAILABLE", async () => {
    const svc = makeService();
    (svc.manager.get as ReturnType<typeof vi.fn>).mockResolvedValue({
      config: { watch: true },
      watch: vi.fn().mockRejectedValue(new WatcherUnavailableError("no fs events")),
    });
    const out = await ragAdmin(svc, { collection_id: "d", action: "watch_arm" });
    expect(out).toMatchObject({ ok: false, code: "RAG_WATCHER_UNAVAILABLE" });
  });

  it("watch_arm sets watchStatus to armed on success", async () => {
    const svc = makeService();
    (svc.manager.get as ReturnType<typeof vi.fn>).mockResolvedValue({
      config: { watch: true },
      watch: vi.fn().mockResolvedValue(undefined),
    });
    const out = await ragAdmin(svc, { collection_id: "d", action: "watch_arm" });
    expect(out).toEqual({ armed: true });
    expect(svc.watchStatus.get("d")).toBe("armed");
  });

  it("watch_arm DatasetNotFoundError → RAG_DATASET_NOT_FOUND", async () => {
    const svc = makeService();
    (svc.manager.get as ReturnType<typeof vi.fn>).mockRejectedValue(
      new DatasetNotFoundError({ datasetId: "x" }),
    );
    const out = await ragAdmin(svc, { collection_id: "x", action: "watch_arm" });
    expect(out).toMatchObject({ ok: false, code: "RAG_DATASET_NOT_FOUND" });
  });

  it("reconcile returns {reconciled:true}", async () => {
    const svc = makeService();
    (svc.manager.get as ReturnType<typeof vi.fn>).mockResolvedValue({
      reconcile: vi.fn().mockResolvedValue(undefined),
    });
    const out = await ragAdmin(svc, { collection_id: "d", action: "reconcile" });
    expect(out).toEqual({ reconciled: true });
  });
});

describe("ragRegister", () => {
  let projectRoot: string;
  beforeEach(() => {
    projectRoot = mkdtempSync(path.join(tmpdir(), "rag-reg-tool-"));
    mkdirSync(path.join(projectRoot, ".saivage"), { recursive: true });
    mkdirSync(path.join(projectRoot, "data"));
    writeFileSync(path.join(projectRoot, "data", "a.md"), "x");
  });
  afterEach(() => rmSync(projectRoot, { recursive: true, force: true }));

  it("rejects protected ids", async () => {
    const svc = makeService({ projectRoot });
    const out = await ragRegister(svc, {
      collection_id: "knowledge.memory",
      source: "doc",
      chunker: { kind: "markdown" },
      sources: [{ root: "data" }],
    });
    expect(out).toMatchObject({ ok: false, code: "RAG_PROTECTED_DATASET" });
  });

  it("rejects multi-root sources", async () => {
    const svc = makeService({ projectRoot });
    const out = await ragRegister(svc, {
      collection_id: "d",
      source: "doc",
      chunker: { kind: "markdown" },
      sources: [
        { root: "data" },
        { root: "data" },
      ],
    });
    expect(out).toMatchObject({ ok: false, code: "RAG_INVALID_ARGS" });
  });

  it("rejects root that escapes the project", async () => {
    const svc = makeService({ projectRoot });
    const out = await ragRegister(svc, {
      collection_id: "d",
      source: "doc",
      chunker: { kind: "markdown" },
      sources: [{ root: "/tmp" }],
    });
    expect(out).toMatchObject({ ok: false, code: "RAG_BLOCKED_PATH" });
  });

  it("happy path: ingests and returns initialIngestReport", async () => {
    const svc = makeService({ projectRoot });
    (svc.manager.register as ReturnType<typeof vi.fn>).mockResolvedValue({});
    (svc.manager.ingest as ReturnType<typeof vi.fn>).mockResolvedValue({
      filesScanned: 1,
      filesChanged: 1,
      chunksUpserted: 1,
      chunksDeleted: 0,
      chunksDroppedSecrets: 0,
      tokensEmbedded: 5,
      embeddingMs: 1,
      storeMs: 1,
    });
    const out = await ragRegister(svc, {
      collection_id: "d",
      source: "doc",
      chunker: { kind: "markdown" },
      sources: [{ root: "data" }],
    });
    expect(out).toMatchObject({
      collection: { id: "d", source: "doc" },
      persisted: false,
      watch: "off",
    });
    expect(svc.datasets.map((d) => d.id)).toEqual(["d"]);
  });

  it("rolls back array push on manager.register failure", async () => {
    const svc = makeService({ projectRoot });
    (svc.manager.register as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("boom"));
    await expect(
      ragRegister(svc, {
        collection_id: "d",
        source: "doc",
        chunker: { kind: "markdown" },
        sources: [{ root: "data" }],
      }),
    ).rejects.toThrow("boom");
    expect(svc.datasets).toEqual([]);
  });
});
