import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("index service (SQLite FTS5)", () => {
  let db: InstanceType<typeof Database>;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "saivage-idx-test-"));
    db = new Database(join(tmpDir, "index.db"));
    db.pragma("journal_mode = WAL");
    db.exec(`
      CREATE TABLE IF NOT EXISTS documents (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        title TEXT NOT NULL DEFAULT '',
        content TEXT NOT NULL,
        metadata TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS documents_fts USING fts5(
        id, title, content, type,
        content=documents, content_rowid=rowid
      );
      CREATE TRIGGER IF NOT EXISTS docs_ai AFTER INSERT ON documents BEGIN
        INSERT INTO documents_fts(rowid, id, title, content, type)
        VALUES (new.rowid, new.id, new.title, new.content, new.type);
      END;
      CREATE TRIGGER IF NOT EXISTS docs_ad AFTER DELETE ON documents BEGIN
        INSERT INTO documents_fts(documents_fts, rowid, id, title, content, type)
        VALUES ('delete', old.rowid, old.id, old.title, old.content, old.type);
      END;
    `);
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("ingest and search", () => {
    db.prepare(
      "INSERT INTO documents (id, type, title, content) VALUES (?, ?, ?, ?)",
    ).run("doc1", "work", "Fix auth bug", "The login page has a CSRF vulnerability that needs fixing");

    db.prepare(
      "INSERT INTO documents (id, type, title, content) VALUES (?, ?, ?, ?)",
    ).run("doc2", "conversation", "Chat about food", "We discussed favorite restaurants");

    const results = db
      .prepare(
        `SELECT d.* FROM documents d
         JOIN documents_fts fts ON d.rowid = fts.rowid
         WHERE documents_fts MATCH ? LIMIT 10`,
      )
      .all("vulnerability") as Array<{ id: string }>;

    expect(results).toHaveLength(1);
    expect(results[0]!.id).toBe("doc1");
  });

  it("filters by type", () => {
    db.prepare(
      "INSERT INTO documents (id, type, title, content) VALUES (?, ?, ?, ?)",
    ).run("conv1", "conversation", "Session 1", "Talked about TypeScript patterns");

    db.prepare(
      "INSERT INTO documents (id, type, title, content) VALUES (?, ?, ?, ?)",
    ).run("work1", "work", "Refactor", "Refactored TypeScript modules");

    const results = db
      .prepare(
        `SELECT d.* FROM documents d
         JOIN documents_fts fts ON d.rowid = fts.rowid
         WHERE documents_fts MATCH ? AND d.type = ?
         LIMIT 10`,
      )
      .all("typescript", "conversation") as Array<{ id: string }>;

    expect(results).toHaveLength(1);
    expect(results[0]!.id).toBe("conv1");
  });

  it("upsert replaces content", () => {
    db.prepare(
      "INSERT INTO documents (id, type, title, content) VALUES (?, ?, ?, ?)",
    ).run("doc1", "note", "My note", "Original content");

    db.prepare(
      `INSERT INTO documents (id, type, title, content) VALUES (?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET content=excluded.content`,
    ).run("doc1", "note", "My note", "Updated content with new info");

    const row = db.prepare("SELECT content FROM documents WHERE id = ?").get("doc1") as {
      content: string;
    };
    expect(row.content).toContain("Updated");
  });
});
