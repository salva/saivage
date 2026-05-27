// F01 B12 — Reconcile sweep tests.

import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { reconcile } from "./reconcile.js";
import type { VectorStore } from "../store/index.js";

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

function makeFakeStore(
  state: Map<string, { sourceHash: string; mtimeMs: number; lastIngestAt: number }>,
): VectorStore {
  return {
    async open() {},
    async upsert() {},
    async deleteByFilter() {
      return 0;
    },
    async deleteByIds() {
      return 0;
    },
    async query() {
      return [];
    },
    async stats() {
      return { chunks: 0, files: 0, bytesOnDisk: 0, lastIngestAt: 0 };
    },
    async close() {},
    async drop() {},
    async getCachedEmbedding() {
      return null;
    },
    async putCachedEmbedding() {},
    async getFileState() {
      return state;
    },
    async putFileState() {},
    async deleteFileState() {
      return 0;
    },
    stamp() {
      return { provider: "openai", model: "x", dim: 1, releaseFingerprint: "0" };
    },
    async bumpSecretsDropped() {},
    async setLastIngestAt() {},
  } as unknown as VectorStore;
}

describe("reconcile", () => {
  it("detects added, changed, and removed files", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "rag-reconcile-"));
    try {
      mkdirSync(path.join(root, "src"));
      writeFileSync(path.join(root, "src/a.md"), "# A\nhello");
      writeFileSync(path.join(root, "src/b.md"), "# B\nworld");
      const absA = path.join(root, "src/a.md");
      const absB = path.join(root, "src/b.md");
      const absC = path.join(root, "src/c.md");
      // priorState: a is unchanged, b is stale (wrong hash), c was deleted on disk
      const state = new Map<string, { sourceHash: string; mtimeMs: number; lastIngestAt: number }>([
        [absA, { sourceHash: sha256("# A\nhello"), mtimeMs: 0, lastIngestAt: 0 }],
        [absB, { sourceHash: "deadbeef", mtimeMs: 0, lastIngestAt: 0 }],
        [absC, { sourceHash: sha256("gone"), mtimeMs: 0, lastIngestAt: 0 }],
      ]);
      const store = makeFakeStore(state);
      const r = await reconcile([{ root }], store);
      expect(r.scanned).toBe(2);
      expect(r.changedPaths.sort()).toEqual([absB]);
      expect(r.removedPaths.sort()).toEqual([absC]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("honours build/cache exclusions", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "rag-reconcile-"));
    try {
      mkdirSync(path.join(root, "node_modules"));
      writeFileSync(path.join(root, "node_modules/x.md"), "nope");
      writeFileSync(path.join(root, "a.md"), "yes");
      const state = new Map<string, { sourceHash: string; mtimeMs: number; lastIngestAt: number }>();
      const r = await reconcile([{ root }], makeFakeStore(state));
      expect(r.scanned).toBe(1);
      expect(r.changedPaths[0]).toBe(path.join(root, "a.md"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
