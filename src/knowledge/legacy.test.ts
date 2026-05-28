/**
 * F01 B07 — Legacy knowledge tree refusal / cleanup tests.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { initKnowledgeStore } from "./init.js";
import { openSidecar } from "./sidecar.js";
import { recordCount } from "./sidecar-queries.js";
import { KnowledgeStoreError } from "./store.js";
import type { RagManager } from "../rag/index.js";

function fakeManager(): RagManager {
  return {
    enabled: true,
    async list() { return []; },
    async get() { throw new Error("not used"); },
    async register() { throw new Error("not used"); },
    async ingest() {
      return { filesScanned: 0, filesChanged: 0, chunksUpserted: 0, chunksDeleted: 0, chunksDroppedSecrets: 0, tokensEmbedded: 0, embeddingMs: 0, storeMs: 0 };
    },
    async query() { return []; },
    async stats() { throw new Error("nu"); },
    async drop() { /* no-op */ },
    async close() { /* no-op */ },
  } as unknown as RagManager;
}

function plantLegacyMarkers(projectRoot: string): void {
  const skillsDir = path.join(projectRoot, ".saivage", "skills", "project");
  const memoryDir = path.join(projectRoot, ".saivage", "memory", "project");
  mkdirSync(skillsDir, { recursive: true });
  mkdirSync(memoryDir, { recursive: true });
  writeFileSync(path.join(skillsDir, "index.json"), '{"skills":[]}');
  writeFileSync(path.join(skillsDir, "audit.jsonl"), "");
  writeFileSync(path.join(memoryDir, "index.json"), '{"memories":[],"topic_map":{}}');
  writeFileSync(path.join(memoryDir, "audit.jsonl"), "");
}

describe("refuseOrCleanLegacyTree (via initKnowledgeStore)", () => {
  let projectRoot: string;
  beforeEach(() => {
    projectRoot = mkdtempSync(path.join(tmpdir(), "kn-legacy-"));
  });
  afterEach(() => rmSync(projectRoot, { recursive: true, force: true }));

  it("throws KNOWLEDGE_MIGRATION_REQUIRED when legacy markers exist but sidecar is empty", async () => {
    plantLegacyMarkers(projectRoot);
    const mgr = fakeManager();
    await expect(
      initKnowledgeStore({ projectRoot, ragManager: mgr, ragDatasets: [], ragEnabled: true }),
    ).rejects.toMatchObject({
      name: "KnowledgeStoreError",
      code: "KNOWLEDGE_MIGRATION_REQUIRED",
    });
  });

  it("silently removes legacy markers when the sidecar has records", async () => {
    plantLegacyMarkers(projectRoot);
    // Seed one row into the sidecar so the count is non-zero.
    const sidecar = await openSidecar(projectRoot);
    sidecar.db.prepare(
      "INSERT INTO record (id, kind, scope, status, origin, record_json, body, created_at, updated_at, pending_reingest) VALUES (?,?,?,?,?,?,?,?,?,?)",
    ).run("seed", "skill", "project", "active", "project", "{}", "body", "t", "t", 0);
    sidecar.close();

    const mgr = fakeManager();
    const store = await initKnowledgeStore({
      projectRoot,
      ragManager: mgr,
      ragDatasets: [],
      ragEnabled: true,
    });
    try {
      expect(existsSync(path.join(projectRoot, ".saivage", "skills"))).toBe(false);
      expect(existsSync(path.join(projectRoot, ".saivage", "memory"))).toBe(false);
      // Seeded row plus B05 builtin skills are preserved.
      expect(recordCount(store.sidecar)).toBeGreaterThan(0);
    } finally {
      store.sidecar.close();
    }
  });

  it("no-op when no legacy markers exist", async () => {
    const mgr = fakeManager();
    const store = await initKnowledgeStore({
      projectRoot,
      ragManager: mgr,
      ragDatasets: [],
      ragEnabled: true,
    });
    try {
      expect(existsSync(path.join(projectRoot, ".saivage", "skills"))).toBe(false);
      expect(existsSync(path.join(projectRoot, ".saivage", "memory"))).toBe(false);
    } finally {
      store.sidecar.close();
    }
  });

  it("error code is exported from KnowledgeErrorCode taxonomy", () => {
    const e = new KnowledgeStoreError("KNOWLEDGE_MIGRATION_REQUIRED", "x");
    expect(e.code).toBe("KNOWLEDGE_MIGRATION_REQUIRED");
  });
});
