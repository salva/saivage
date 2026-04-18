#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import Database from "better-sqlite3";
import { existsSync, mkdirSync } from "node:fs";

const DB_PATH = process.env["SAIVAGE_MEMORY_DB"] ?? (() => {
  const dir = process.env["HOME"] + "/.saivage/data";
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir + "/memory.db";
})();

const db = new Database(DB_PATH);
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
  CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
    INSERT INTO memories_fts(memories_fts, rowid, key, value, tags)
    VALUES ('delete', old.rowid, old.key, old.value, old.tags);
    INSERT INTO memories_fts(rowid, key, value, tags)
    VALUES (new.rowid, new.key, new.value, new.tags);
  END;
`);

const server = new McpServer({ name: "memory", version: "0.1.0" });

server.tool(
  "store",
  "Store a key-value pair in long-term memory",
  {
    key: z.string().describe("Unique key for the memory"),
    value: z.string().describe("Content to store"),
    tags: z.array(z.string()).default([]).describe("Tags for categorization"),
  },
  async ({ key, value, tags }) => {
    const tagsJson = JSON.stringify(tags);
    db.prepare(
      `INSERT INTO memories (key, value, tags, updated_at)
       VALUES (?, ?, ?, datetime('now'))
       ON CONFLICT(key) DO UPDATE SET value=excluded.value, tags=excluded.tags, updated_at=datetime('now')`,
    ).run(key, value, tagsJson);

    return {
      content: [{ type: "text" as const, text: JSON.stringify({ stored: true, key }) }],
    };
  },
);

server.tool(
  "recall",
  "Recall a memory by exact key or search by text",
  {
    key: z.string().optional().describe("Exact key to recall"),
    query: z.string().optional().describe("Full-text search query"),
    limit: z.number().default(10).describe("Max results for search"),
  },
  async ({ key, query, limit }) => {
    if (key) {
      const row = db.prepare("SELECT * FROM memories WHERE key = ?").get(key) as
        | { key: string; value: string; tags: string; created_at: string; updated_at: string }
        | undefined;
      if (!row) {
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ found: false }) }],
        };
      }
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              found: true,
              key: row.key,
              value: row.value,
              tags: JSON.parse(row.tags),
              createdAt: row.created_at,
              updatedAt: row.updated_at,
            }),
          },
        ],
      };
    }

    if (query) {
      const rows = db
        .prepare(
          `SELECT m.* FROM memories m
           JOIN memories_fts fts ON m.rowid = fts.rowid
           WHERE memories_fts MATCH ?
           ORDER BY rank LIMIT ?`,
        )
        .all(query, limit) as Array<{
        key: string;
        value: string;
        tags: string;
        created_at: string;
      }>;

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              rows.map((r) => ({
                key: r.key,
                value: r.value,
                tags: JSON.parse(r.tags),
                createdAt: r.created_at,
              })),
            ),
          },
        ],
      };
    }

    return {
      content: [
        { type: "text" as const, text: JSON.stringify({ error: "Provide key or query" }) },
      ],
      isError: true,
    };
  },
);

server.tool(
  "list",
  "List all memory keys, optionally filtered by tag",
  {
    tag: z.string().optional().describe("Filter by tag"),
    limit: z.number().default(50).describe("Max results"),
  },
  async ({ tag, limit }) => {
    let rows;
    if (tag) {
      rows = db
        .prepare(
          `SELECT key, tags, updated_at FROM memories
           WHERE tags LIKE ? ORDER BY updated_at DESC LIMIT ?`,
        )
        .all(`%"${tag}"%`, limit) as Array<{ key: string; tags: string; updated_at: string }>;
    } else {
      rows = db
        .prepare("SELECT key, tags, updated_at FROM memories ORDER BY updated_at DESC LIMIT ?")
        .all(limit) as Array<{ key: string; tags: string; updated_at: string }>;
    }

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(
            rows.map((r) => ({
              key: r.key,
              tags: JSON.parse(r.tags),
              updatedAt: r.updated_at,
            })),
          ),
        },
      ],
    };
  },
);

server.tool(
  "delete",
  "Delete a memory by key",
  {
    key: z.string().describe("Key to delete"),
  },
  async ({ key }) => {
    const result = db.prepare("DELETE FROM memories WHERE key = ?").run(key);
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({ deleted: result.changes > 0 }),
        },
      ],
    };
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
