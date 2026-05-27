import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { acquireIngestLock } from "./lock.js";
import { IngestLockedError } from "./errors.js";

describe("acquireIngestLock", () => {
  let dir: string;
  let lockfile: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "rag-lock-"));
    lockfile = path.join(dir, ".ingest.lock");
    writeFileSync(lockfile, "");
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("acquires and releases", async () => {
    const h = await acquireIngestLock({ datasetId: "ds1", lockfilePath: lockfile });
    await h.release();
    const h2 = await acquireIngestLock({ datasetId: "ds1", lockfilePath: lockfile });
    await h2.release();
  });

  it("throws IngestLockedError when held by another holder", async () => {
    const h = await acquireIngestLock({ datasetId: "ds1", lockfilePath: lockfile });
    await expect(
      acquireIngestLock({ datasetId: "ds1", lockfilePath: lockfile, stale: 60_000 }),
    ).rejects.toBeInstanceOf(IngestLockedError);
    await h.release();
  });
});
