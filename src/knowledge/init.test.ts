import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { initKnowledgeStore } from "./init.js";
import { reingestKind } from "./reingest.js";
import { runBootDivergenceSweep } from "./recovery.js";
import type { RagManager } from "../rag/index.js";

function fakeManager(): { mgr: RagManager; calls: Array<{ id: string; n: number }> } {
  const calls: Array<{ id: string; n: number }> = [];
  const mgr = {
    enabled: true,
    async list() { return []; },
    async get() { throw new Error("not used"); },
    async register() { throw new Error("not used"); },
    async ingest(id: string, input: { kind: string; items?: unknown[] }) {
      calls.push({ id, n: input.items?.length ?? 0 });
      return { filesScanned: 0, filesChanged: 0, chunksUpserted: 0, chunksDeleted: 0, chunksDroppedSecrets: 0, tokensEmbedded: 0, embeddingMs: 0, storeMs: 0 };
    },
    async query() { return []; },
    async stats() { throw new Error("nu"); },
    async drop() { /* no-op */ },
    async close() { /* no-op */ },
  } as unknown as RagManager;
  return { mgr, calls };
}

describe("initKnowledgeStore", () => {
  let projectRoot: string;
  beforeEach(() => {
    projectRoot = mkdtempSync(path.join(tmpdir(), "kn-init-"));
  });
  afterEach(() => rmSync(projectRoot, { recursive: true, force: true }));

  it("throws when rag is disabled", async () => {
    const { mgr } = fakeManager();
    await expect(
      initKnowledgeStore({ projectRoot, ragManager: mgr, ragDatasets: [], ragEnabled: false }),
    ).rejects.toThrow(/rag\.enabled/);
  });

  it("opens the sidecar and wires reingestKind", async () => {
    const { mgr } = fakeManager();
    const store = await initKnowledgeStore({
      projectRoot,
      ragManager: mgr,
      ragDatasets: [],
      ragEnabled: true,
    });
    expect(store.sidecar.db.pragma("user_version", { simple: true })).toBe(1);
    expect(store.projectRoot).toBe(projectRoot);
    store.sidecar.close();
  });
});

describe("reingestKind", () => {
  let projectRoot: string;
  beforeEach(() => {
    projectRoot = mkdtempSync(path.join(tmpdir(), "kn-rein-"));
  });
  afterEach(() => rmSync(projectRoot, { recursive: true, force: true }));

  it("publishes active records and clears pending_reingest", async () => {
    const { mgr, calls } = fakeManager();
    const store = await initKnowledgeStore({
      projectRoot,
      ragManager: mgr,
      ragDatasets: [],
      ragEnabled: true,
    });
    // initKnowledgeStore upserts bundled builtin skills and reingests them;
    // clear those calls so the assertion targets just this test's action.
    calls.length = 0;
    store.sidecar.db.prepare(
      "INSERT INTO record (id, kind, scope, status, origin, record_json, body, created_at, updated_at, pending_reingest) VALUES (?,?,?,?,?,?,?,?,?,?)",
    ).run("s1", "skill", "project", "active", "project", "{}", "body", "t", "t", 1);
    await reingestKind(store, "skill");
    // 3 bundled builtin skills + s1 = 4 active rows republished.
    expect(calls).toEqual([{ id: "knowledge.skills", n: 4 }]);
    const row = store.sidecar.db
      .prepare("SELECT pending_reingest FROM record WHERE id = 's1'")
      .get() as { pending_reingest: number };
    expect(row.pending_reingest).toBe(0);
    store.sidecar.close();
  });
});

describe("runBootDivergenceSweep", () => {
  let projectRoot: string;
  beforeEach(() => {
    projectRoot = mkdtempSync(path.join(tmpdir(), "kn-sweep-"));
  });
  afterEach(() => rmSync(projectRoot, { recursive: true, force: true }));

  it("retries pending kinds even when no datasets are registered", async () => {
    const { mgr, calls } = fakeManager();
    const store = await initKnowledgeStore({
      projectRoot,
      ragManager: mgr,
      ragDatasets: [],
      ragEnabled: true,
    });
    calls.length = 0;
    store.sidecar.db.prepare(
      "INSERT INTO record (id, kind, scope, status, origin, record_json, body, created_at, updated_at, pending_reingest) VALUES (?,?,?,?,?,?,?,?,?,?)",
    ).run("m1", "memory", "project", "active", "project", "{}", "b", "t", "t", 1);
    await runBootDivergenceSweep(store);
    expect(calls).toEqual([{ id: "knowledge.memory", n: 1 }]);
    store.sidecar.close();
  });
});
