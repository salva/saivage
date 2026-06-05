import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { initKnowledgeStore } from "./init.js";
import { runBootDivergenceSweep } from "./recovery.js";
import type { RagManager } from "../rag/index.js";

function fakeManager() {
  const get = vi.fn(async () => {
    throw new Error("recovery must not open datasets");
  });
  const getIfOpen = vi.fn(() => undefined);
  const ingest = vi.fn(async () => ({
    filesScanned: 0,
    filesChanged: 0,
    chunksUpserted: 0,
    chunksDeleted: 0,
    chunksDroppedSecrets: 0,
    tokensEmbedded: 0,
    embeddingMs: 0,
    storeMs: 0,
  }));
  const mgr = {
    enabled: true,
    async list() { return []; },
    get,
    getIfOpen,
    async register() { throw new Error("not used"); },
    ingest,
    async query() { return []; },
    async stats() { throw new Error("not used"); },
    async drop() { /* no-op */ },
    async close() { /* no-op */ },
  } as unknown as RagManager;
  return { mgr, get, getIfOpen, ingest };
}

describe("runBootDivergenceSweep", () => {
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = mkdtempSync(path.join(tmpdir(), "kn-recovery-"));
  });

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it("checks only already-open datasets during divergence recovery", async () => {
    const { mgr, get, getIfOpen, ingest } = fakeManager();
    const store = await initKnowledgeStore({
      projectRoot,
      ragManager: mgr,
      ragEnabled: true,
    });
    try {
      ingest.mockClear();

      await runBootDivergenceSweep(store);

      expect(get).not.toHaveBeenCalled();
      expect(getIfOpen).toHaveBeenCalledWith("knowledge.skills");
      expect(getIfOpen).toHaveBeenCalledWith("knowledge.memory");
      expect(ingest).not.toHaveBeenCalled();
    } finally {
      store.sidecar.close();
    }
  });
});
