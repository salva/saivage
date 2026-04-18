import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("memory service (SQLite)", () => {
  let db: InstanceType<typeof Database>;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "saivage-mem-test-"));
    db = new Database(join(tmpDir, "memory.db"));
    db.pragma("journal_mode = WAL");
    db.exec(`
      CREATE TABLE IF NOT EXISTS memories (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        tags TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
        key, value, tags, content=memories, content_rowid=rowid
      );
      CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
        INSERT INTO memories_fts(rowid, key, value, tags)
        VALUES (new.rowid, new.key, new.value, new.tags);
      END;
      CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
        INSERT INTO memories_fts(memories_fts, rowid, key, value, tags)
        VALUES ('delete', old.rowid, old.key, old.value, old.tags);
      END;
    `);
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("store and recall by key", () => {
    db.prepare("INSERT INTO memories (key, value, tags) VALUES (?, ?, ?)").run(
      "greeting",
      "Hello world",
      '["test"]',
    );
    const row = db.prepare("SELECT * FROM memories WHERE key = ?").get("greeting") as {
      key: string;
      value: string;
      tags: string;
    };
    expect(row.value).toBe("Hello world");
    expect(JSON.parse(row.tags)).toEqual(["test"]);
  });

  it("full-text search", () => {
    db.prepare("INSERT INTO memories (key, value, tags) VALUES (?, ?, ?)").run(
      "project-notes",
      "The saivage project uses TypeScript and Node.js",
      '["project"]',
    );
    db.prepare("INSERT INTO memories (key, value, tags) VALUES (?, ?, ?)").run(
      "lunch-notes",
      "Had pizza for lunch today",
      '["personal"]',
    );

    const results = db
      .prepare(
        `SELECT m.* FROM memories m
         JOIN memories_fts fts ON m.rowid = fts.rowid
         WHERE memories_fts MATCH ? LIMIT 10`,
      )
      .all("typescript") as Array<{ key: string }>;

    expect(results).toHaveLength(1);
    expect(results[0]!.key).toBe("project-notes");
  });

  it("delete removes from FTS too", () => {
    db.prepare("INSERT INTO memories (key, value, tags) VALUES (?, ?, ?)").run(
      "temp",
      "temporary data for testing deletion",
      "[]",
    );
    db.prepare("DELETE FROM memories WHERE key = ?").run("temp");

    const results = db
      .prepare(
        `SELECT m.* FROM memories m
         JOIN memories_fts fts ON m.rowid = fts.rowid
         WHERE memories_fts MATCH ? LIMIT 10`,
      )
      .all("temporary") as Array<{ key: string }>;

    expect(results).toHaveLength(0);
  });

  it("upsert updates existing", () => {
    db.prepare("INSERT INTO memories (key, value, tags) VALUES (?, ?, ?)").run(
      "counter",
      "1",
      "[]",
    );
    db.prepare(
      `INSERT INTO memories (key, value, tags)
       VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value=excluded.value`,
    ).run("counter", "2", "[]");

    const row = db.prepare("SELECT value FROM memories WHERE key = ?").get("counter") as {
      value: string;
    };
    expect(row.value).toBe("2");
  });
});
