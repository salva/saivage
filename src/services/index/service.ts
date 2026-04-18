#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import Database from "better-sqlite3";
import { existsSync, mkdirSync } from "node:fs";

const DB_PATH = process.env["SAIVAGE_INDEX_DB"] ?? (() => {
  const dir = process.env["HOME"] + "/.saivage/data";
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir + "/index.db";
})();

const db = new Database(DB_PATH);
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
  CREATE TRIGGER IF NOT EXISTS docs_au AFTER UPDATE ON documents BEGIN
    INSERT INTO documents_fts(documents_fts, rowid, id, title, content, type)
    VALUES ('delete', old.rowid, old.id, old.title, old.content, old.type);
    INSERT INTO documents_fts(rowid, id, title, content, type)
    VALUES (new.rowid, new.id, new.title, new.content, new.type);
  END;
`);

const server = new McpServer({ name: "index", version: "0.1.0" });

server.tool(
  "ingest",
  "Index a document for full-text search",
  {
    id: z.string().describe("Unique document ID"),
    type: z.enum(["conversation", "work", "file", "note"]).describe("Document type"),
    title: z.string().default("").describe("Document title"),
    content: z.string().describe("Document content to index"),
    metadata: z.record(z.string(), z.unknown()).default({}).describe("Additional metadata"),
  },
  async ({ id, type, title, content, metadata }) => {
    db.prepare(
      `INSERT INTO documents (id, type, title, content, metadata)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         type=excluded.type, title=excluded.title,
         content=excluded.content, metadata=excluded.metadata`,
    ).run(id, type, title, content, JSON.stringify(metadata));

    return {
      content: [{ type: "text" as const, text: JSON.stringify({ indexed: true, id }) }],
    };
  },
);

server.tool(
  "search",
  "Full-text search across all indexed documents",
  {
    query: z.string().describe("Search query"),
    type: z.enum(["conversation", "work", "file", "note"]).optional().describe("Filter by type"),
    limit: z.number().default(10).describe("Max results"),
  },
  async ({ query, type, limit }) => {
    let sql = `
      SELECT d.*, rank FROM documents d
      JOIN documents_fts fts ON d.rowid = fts.rowid
      WHERE documents_fts MATCH ?
    `;
    const params: unknown[] = [query];

    if (type) {
      sql += " AND d.type = ?";
      params.push(type);
    }
    sql += " ORDER BY rank LIMIT ?";
    params.push(limit);

    const rows = db.prepare(sql).all(...params) as Array<{
      id: string;
      type: string;
      title: string;
      content: string;
      metadata: string;
      created_at: string;
    }>;

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(
            rows.map((r) => ({
              id: r.id,
              type: r.type,
              title: r.title,
              snippet: r.content.slice(0, 200),
              metadata: JSON.parse(r.metadata),
              createdAt: r.created_at,
            })),
          ),
        },
      ],
    };
  },
);

server.tool(
  "search_conversations",
  "Search only conversation documents",
  {
    query: z.string().describe("Search query"),
    limit: z.number().default(10),
  },
  async ({ query, limit }) => {
    const rows = db
      .prepare(
        `SELECT d.* FROM documents d
         JOIN documents_fts fts ON d.rowid = fts.rowid
         WHERE documents_fts MATCH ? AND d.type = 'conversation'
         ORDER BY rank LIMIT ?`,
      )
      .all(query, limit) as Array<{
      id: string;
      title: string;
      content: string;
      metadata: string;
      created_at: string;
    }>;

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(
            rows.map((r) => ({
              id: r.id,
              title: r.title,
              snippet: r.content.slice(0, 200),
              createdAt: r.created_at,
            })),
          ),
        },
      ],
    };
  },
);

server.tool(
  "search_work",
  "Search only work-item documents",
  {
    query: z.string().describe("Search query"),
    limit: z.number().default(10),
  },
  async ({ query, limit }) => {
    const rows = db
      .prepare(
        `SELECT d.* FROM documents d
         JOIN documents_fts fts ON d.rowid = fts.rowid
         WHERE documents_fts MATCH ? AND d.type = 'work'
         ORDER BY rank LIMIT ?`,
      )
      .all(query, limit) as Array<{
      id: string;
      title: string;
      content: string;
      metadata: string;
      created_at: string;
    }>;

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(
            rows.map((r) => ({
              id: r.id,
              title: r.title,
              snippet: r.content.slice(0, 200),
              metadata: JSON.parse(r.metadata),
              createdAt: r.created_at,
            })),
          ),
        },
      ],
    };
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
