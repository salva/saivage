// F01 B12 — Controller tests (mocked chokidar).

import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { WatcherController } from "./controller.js";
import type { VectorStore } from "../store/index.js";
import type { IngestInput, IngestReport } from "../types.js";

function emptyStore(): VectorStore {
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
      return new Map();
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

function fakeChokidar() {
  const handlers = new Map<string, (...a: unknown[]) => void>();
  const watcher = {
    on(event: string, fn: (...a: unknown[]) => void) {
      handlers.set(event, fn);
      return watcher;
    },
    async close() {},
    getWatched() {
      return {};
    },
  };
  return {
    module: {
      watch: vi.fn(() => watcher),
    },
    fire(event: string, ...args: unknown[]) {
      const h = handlers.get(event);
      if (h) h(...args);
    },
  };
}

const noopIngest = async (_: IngestInput): Promise<IngestReport> => ({
  chunksUpserted: 0,
  chunksDeleted: 0,
  chunksDroppedSecrets: 0,
  filesScanned: 0,
  filesChanged: 0,
  filesRemoved: 0,
  embeddingsRequested: 0,
  embeddingsCacheHits: 0,
  durationMs: 0,
});

describe("WatcherController", () => {
  it("arm() runs reconcile, attaches handlers, and routes flushed events through ingest", async () => {
    vi.useFakeTimers();
    const root = mkdtempSync(path.join(tmpdir(), "rag-watcher-"));
    try {
      const ck = fakeChokidar();
      const ingest = vi.fn(noopIngest);
      const ctrl = new WatcherController({
        datasetId: "d1",
        sources: [{ root }],
        watch: true,
        store: emptyStore(),
        ingest,
        chokidarOverride: ck.module,
      });
      await ctrl.arm();
      expect(ctrl.isArmed()).toBe(true);
      expect(ck.module.watch).toHaveBeenCalledTimes(1);
      ck.fire("add", path.join(root, "a.md"));
      ck.fire("change", path.join(root, "b.md"));
      // No flush yet.
      expect(ingest).toHaveBeenCalledTimes(0);
      vi.advanceTimersByTime(2000);
      // The debounce flush is sync; ingest is invoked once for the source root.
      await Promise.resolve();
      await Promise.resolve();
      expect(ingest).toHaveBeenCalledTimes(1);
      const arg = ingest.mock.calls[0][0];
      expect(arg.kind).toBe("fs");
      await ctrl.disarm();
      expect(ctrl.isArmed()).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
      vi.useRealTimers();
    }
  });

  it("drops a batch when path count exceeds the flood threshold", async () => {
    vi.useFakeTimers();
    const root = mkdtempSync(path.join(tmpdir(), "rag-watcher-"));
    try {
      const ck = fakeChokidar();
      const ingest = vi.fn(noopIngest);
      const logged: Array<{ level: string; msg: string }> = [];
      const ctrl = new WatcherController({
        datasetId: "d-flood",
        sources: [{ root }],
        watch: true,
        store: emptyStore(),
        ingest,
        chokidarOverride: ck.module,
        floodThreshold: 5,
        log: (level, msg) => logged.push({ level, msg }),
      });
      await ctrl.arm();
      for (let i = 0; i < 20; i += 1) {
        ck.fire("add", path.join(root, `f${i}.md`));
      }
      vi.advanceTimersByTime(2000);
      await Promise.resolve();
      expect(ingest).toHaveBeenCalledTimes(0);
      expect(logged.some((l) => l.level === "warn" && l.msg.includes("flood"))).toBe(true);
      await ctrl.disarm();
    } finally {
      rmSync(root, { recursive: true, force: true });
      vi.useRealTimers();
    }
  });

  it("disarm() is idempotent and arm() throws when watch===false", async () => {
    const ctrl = new WatcherController({
      datasetId: "d-off",
      sources: [],
      watch: false,
      store: emptyStore(),
      ingest: noopIngest,
    });
    await ctrl.disarm();
    await expect(ctrl.arm()).rejects.toThrow(/watch is disabled/);
  });
});
