import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Test the lock service's SQLite logic directly
describe("lock service (SQLite)", () => {
  let db: InstanceType<typeof Database>;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "saivage-lock-test-"));
    db = new Database(join(tmpDir, "locks.db"));
    db.pragma("journal_mode = WAL");
    db.exec(`
      CREATE TABLE IF NOT EXISTS locks (
        name TEXT NOT NULL,
        namespace TEXT NOT NULL DEFAULT 'target',
        mode TEXT NOT NULL CHECK(mode IN ('exclusive', 'shared')),
        holder TEXT NOT NULL,
        acquired_at TEXT NOT NULL DEFAULT (datetime('now')),
        ttl_ms INTEGER NOT NULL DEFAULT 300000,
        expires_at TEXT NOT NULL,
        PRIMARY KEY (name, namespace, holder)
      );
    `);
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function acquire(name: string, holder: string, mode = "exclusive", ns = "target") {
    const expiresAt = new Date(Date.now() + 300_000).toISOString();
    return db
      .prepare(
        `INSERT OR REPLACE INTO locks (name, namespace, mode, holder, ttl_ms, expires_at)
         VALUES (?, ?, ?, ?, 300000, ?)`,
      )
      .run(name, ns, mode, holder, expiresAt);
  }

  function release(name: string, holder: string, ns = "target") {
    return db
      .prepare("DELETE FROM locks WHERE name = ? AND namespace = ? AND holder = ?")
      .run(name, ns, holder);
  }

  function getLock(name: string, ns = "target") {
    return db
      .prepare("SELECT * FROM locks WHERE name = ? AND namespace = ?")
      .all(name, ns) as Array<{ holder: string; mode: string }>;
  }

  it("acquires and releases exclusive lock", () => {
    acquire("file.ts", "agent-1");
    expect(getLock("file.ts")).toHaveLength(1);

    release("file.ts", "agent-1");
    expect(getLock("file.ts")).toHaveLength(0);
  });

  it("namespace isolation", () => {
    acquire("main", "agent-1", "exclusive", "target");
    acquire("main", "agent-2", "exclusive", "self");

    expect(getLock("main", "target")).toHaveLength(1);
    expect(getLock("main", "self")).toHaveLength(1);
    expect(getLock("main", "target")[0]!.holder).toBe("agent-1");
    expect(getLock("main", "self")[0]!.holder).toBe("agent-2");
  });

  it("lists all locks", () => {
    acquire("a", "agent-1");
    acquire("b", "agent-2");
    const all = db.prepare("SELECT * FROM locks").all();
    expect(all).toHaveLength(2);
  });
});
