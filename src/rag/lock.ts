// F01 B07 — Per-dataset cross-process ingest lock.
//
// Thin wrapper over `proper-lockfile`. Throws `IngestLockedError` when the
// lock is held by another process. A stale lock (no activity for `stale` ms)
// is retried once after a 50 ms pause; the second failure is reported.
//
// The lock file lives under `<dataset>/.ingest.lock`. The caller owns the
// directory; we expect it to exist by the time `acquireIngestLock` is called.

import { lock as plLock, unlock as plUnlock } from "proper-lockfile";
import { IngestLockedError } from "./errors.js";

export interface IngestLockOptions {
  datasetId: string;
  lockfilePath: string;
  /** stale lock threshold in ms; default 60_000. */
  stale?: number;
  /** lock file update interval in ms; default 10_000. */
  update?: number;
}

export interface IngestLockHandle {
  release(): Promise<void>;
}

const DEFAULT_STALE_MS = 60_000;
const DEFAULT_UPDATE_MS = 10_000;
const STALE_RETRY_PAUSE_MS = 50;

export async function acquireIngestLock(opts: IngestLockOptions): Promise<IngestLockHandle> {
  const stale = opts.stale ?? DEFAULT_STALE_MS;
  const update = opts.update ?? DEFAULT_UPDATE_MS;
  const tryAcquire = async (): Promise<() => Promise<void>> => {
    return await plLock(opts.lockfilePath, {
      stale,
      update,
      retries: 0,
      realpath: false,
    });
  };
  let release: () => Promise<void>;
  try {
    release = await tryAcquire();
  } catch {
    // One retry after the stale window; proper-lockfile auto-recycles stale
    // locks on a fresh `lock()` call, so this second attempt succeeds if the
    // previous owner is genuinely gone.
    await new Promise<void>((r) => setTimeout(r, STALE_RETRY_PAUSE_MS));
    try {
      release = await tryAcquire();
    } catch {
      throw new IngestLockedError({
        datasetId: opts.datasetId,
        lockPath: opts.lockfilePath,
      });
    }
  }
  return {
    async release() {
      try {
        await release();
      } catch {
        // Fallback: explicit unlock for races; ignore further errors.
        try {
          await plUnlock(opts.lockfilePath, { realpath: false });
        } catch {
          /* swallow */
        }
      }
    },
  };
}
