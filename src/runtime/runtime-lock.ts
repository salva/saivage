import {
  closeSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { log } from "../log.js";
import { ensureDir } from "../store/documents.js";

export interface RuntimeLock {
  /** Release the lock (delete the lockfile). Idempotent. */
  release: () => void;
}

export interface RuntimeLockOwner {
  pid: number;
  started_at: string;
}

function runtimeLockPath(saivageDir: string): string {
  return join(saivageDir, "tmp", "state", "runtime.lock");
}

export function readRuntimeLockOwner(saivageDir: string): RuntimeLockOwner | null {
  try {
    const parsed = JSON.parse(readFileSync(runtimeLockPath(saivageDir), "utf-8")) as {
      pid?: unknown;
      started_at?: unknown;
    };
    if (typeof parsed.pid !== "number" || typeof parsed.started_at !== "string") {
      return null;
    }
    return { pid: parsed.pid, started_at: parsed.started_at };
  } catch {
    return null;
  }
}

export function assertRuntimeLockHeld(saivageDir: string): void {
  const owner = readRuntimeLockOwner(saivageDir);
  if (!owner || owner.pid !== process.pid) {
    throw new Error(`knowledge-store: this process does not hold runtime.lock for ${saivageDir}`);
  }
}

/**
 * Acquire an exclusive runtime lock for this project. Uses an
 * `O_CREAT|O_EXCL` file create so two concurrent bootstraps cannot both
 * succeed even if their `isAnotherInstanceRunning` checks both returned
 * false. If the lock file exists but its PID is dead (or its recorded boot
 * timestamp is older than the safety horizon), the stale lock is removed
 * and the acquisition is retried once.
 */
export async function acquireRuntimeLock(saivageDir: string): Promise<RuntimeLock> {
  const stateDir = join(saivageDir, "tmp", "state");
  await ensureDir(stateDir);
  const lockPath = runtimeLockPath(saivageDir);

  // Lock primitive stays sync (`openSync(lockPath, 'wx')`) because it must
  // complete before any other code touches `.saivage/`.
  const tryCreate = (): boolean => {
    try {
      const fd = openSync(lockPath, "wx");
      try {
        const payload = JSON.stringify({ pid: process.pid, started_at: new Date().toISOString() }) + "\n";
        writeFileSync(fd, payload, "utf-8");
      } finally {
        closeSync(fd);
      }
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw err;
    }
  };

  if (tryCreate()) return makeReleaser(lockPath);

  // Lock exists. Decide whether it's stale.
  let stale = false;
  try {
    const raw = readFileSync(lockPath, "utf-8");
    const parsed = JSON.parse(raw) as { pid?: number; started_at?: string };
    const pid = typeof parsed.pid === "number" ? parsed.pid : null;
    const startedMs = parsed.started_at ? Date.parse(parsed.started_at) : NaN;

    if (!pid) {
      stale = true;
    } else {
      try {
        process.kill(pid, 0);
        // Process exists; check the age horizon.
        if (Number.isFinite(startedMs)) {
          const ageDays = (Date.now() - startedMs) / (24 * 60 * 60 * 1000);
          if (ageDays > 14) stale = true;
        }
      } catch {
        stale = true; // PID dead → lock is stale.
      }
    }
  } catch {
    // Unreadable lock file — treat as stale rather than refusing forever.
    stale = true;
  }

  if (stale) {
    try { unlinkSync(lockPath); } catch { /* ignore */ }
    if (tryCreate()) {
      log.info("[recovery] Removed stale runtime.lock and re-acquired");
      return makeReleaser(lockPath);
    }
  }

  throw new Error(
    "Another Saivage instance is already running (runtime.lock held). " +
      "Stop it first or delete the stale lock under .saivage/tmp/state/.",
  );
}

function makeReleaser(lockPath: string): RuntimeLock {
  let released = false;
  return {
    release: () => {
      if (released) return;
      released = true;
      try { unlinkSync(lockPath); } catch { /* ignore */ }
    },
  };
}
