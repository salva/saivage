import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createMemory } from "../knowledge/lifecycle.js";
import type { AuthorAgent } from "../knowledge/lifecycle.js";
import { initProjectTree } from "../store/project.js";
import {
  acquireRuntimeLock,
  assertRuntimeLockHeld,
  readRuntimeLockOwner,
  type RuntimeLock,
} from "./recovery.js";

const AUTHOR: AuthorAgent = { role: "manager", agent_id: "runtime-lock-test" };

let projectRoot: string;
let saivageDir: string;
let lock: RuntimeLock | null;

function lockPath(): string {
  return join(saivageDir, "tmp", "state", "runtime.lock");
}

beforeEach(async () => {
  projectRoot = mkdtempSync(join(tmpdir(), "saivage-runtime-lock-"));
  await initProjectTree(projectRoot);
  saivageDir = join(projectRoot, ".saivage");
  lock = null;
});

afterEach(() => {
  lock?.release();
  rmSync(projectRoot, { recursive: true, force: true });
});

describe("runtime.lock ownership", () => {
  it("reads and asserts the current process-owned runtime lock", async () => {
    lock = await acquireRuntimeLock(saivageDir);

    expect(readRuntimeLockOwner(saivageDir)).toMatchObject({ pid: process.pid });
    expect(() => assertRuntimeLockHeld(saivageDir)).not.toThrow();
  });

  it("rejects a second acquisition while this process holds the lock", async () => {
    lock = await acquireRuntimeLock(saivageDir);

    await expect(acquireRuntimeLock(saivageDir)).rejects.toThrow("runtime.lock held");
  });

  it("replaces malformed lock files as stale during acquisition", async () => {
    mkdirSync(join(saivageDir, "tmp", "state"), { recursive: true });
    writeFileSync(lockPath(), "not-json", "utf-8");

    expect(readRuntimeLockOwner(saivageDir)).toBeNull();
    lock = await acquireRuntimeLock(saivageDir);
    expect(readRuntimeLockOwner(saivageDir)).toMatchObject({ pid: process.pid });
  });

  it("replaces dead-pid lock files as stale during acquisition", async () => {
    mkdirSync(join(saivageDir, "tmp", "state"), { recursive: true });
    writeFileSync(
      lockPath(),
      JSON.stringify({ pid: 999999999, started_at: new Date().toISOString() }),
      "utf-8",
    );

    lock = await acquireRuntimeLock(saivageDir);
    const raw = JSON.parse(readFileSync(lockPath(), "utf-8")) as { pid: number };
    expect(raw.pid).toBe(process.pid);
  });

  it("assertRuntimeLockHeld rejects when another pid owns the lock", () => {
    mkdirSync(join(saivageDir, "tmp", "state"), { recursive: true });
    writeFileSync(
      lockPath(),
      JSON.stringify({ pid: process.pid + 1, started_at: new Date().toISOString() }),
      "utf-8",
    );

    expect(() => assertRuntimeLockHeld(saivageDir)).toThrow("does not hold runtime.lock");
  });

  it("release removes the runtime lock file", async () => {
    lock = await acquireRuntimeLock(saivageDir);
    lock.release();
    lock = null;

    expect(existsSync(lockPath())).toBe(false);
  });

  it("knowledge lifecycle writers fail without a runtime lock", async () => {
    await expect(
      createMemory(
        saivageDir,
        { topic: { domain: "runtime", subject: "lock" }, body: "body", scope: "project", reason: "seed" },
        AUTHOR,
      ),
    ).rejects.toMatchObject({ code: "NO_RUNTIME_LOCK" });
  });
});
