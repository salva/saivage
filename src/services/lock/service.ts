#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import Database from "better-sqlite3";
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const DB_PATH = process.env["SAIVAGE_LOCK_DB"] ?? (() => {
  const dir = process.env["HOME"] + "/.saivage/data";
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir + "/locks.db";
})();

const db = new Database(DB_PATH);
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
  CREATE INDEX IF NOT EXISTS idx_locks_ns ON locks(namespace);
  CREATE INDEX IF NOT EXISTS idx_locks_expires ON locks(expires_at);
`);

// Cleanup expired locks before every operation
function cleanExpired(): void {
  db.prepare("DELETE FROM locks WHERE expires_at < datetime('now')").run();
}

const server = new McpServer({ name: "lock", version: "0.1.0" });

server.tool(
  "acquire",
  "Acquire an advisory lock. Returns success or failure.",
  {
    name: z.string().describe("Lock name"),
    namespace: z.enum(["target", "self"]).default("target").describe("Lock namespace"),
    mode: z.enum(["exclusive", "shared"]).default("exclusive").describe("Lock mode"),
    holder: z.string().describe("ID of the lock holder (agent/work ID)"),
    ttlMs: z.number().default(300_000).describe("Time-to-live in ms"),
  },
  async ({ name, namespace, mode, holder, ttlMs }) => {
    cleanExpired();

    const existing = db
      .prepare("SELECT * FROM locks WHERE name = ? AND namespace = ?")
      .all(name, namespace) as Array<{ mode: string; holder: string }>;

    if (existing.length > 0) {
      // Shared locks can coexist with other shared locks
      if (mode === "shared" && existing.every((l) => l.mode === "shared")) {
        // Allow
      } else if (existing.some((l) => l.holder !== holder)) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                acquired: false,
                reason: `Lock "${namespace}:${name}" already held in ${existing[0]?.mode} mode`,
              }),
            },
          ],
        };
      }
    }

    const expiresAt = new Date(Date.now() + ttlMs).toISOString();
    db.prepare(
      `INSERT OR REPLACE INTO locks (name, namespace, mode, holder, ttl_ms, expires_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(name, namespace, mode, holder, ttlMs, expiresAt);

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({ acquired: true, expiresAt }),
        },
      ],
    };
  },
);

server.tool(
  "release",
  "Release a previously acquired lock",
  {
    name: z.string().describe("Lock name"),
    namespace: z.enum(["target", "self"]).default("target"),
    holder: z.string().describe("ID of the lock holder"),
  },
  async ({ name, namespace, holder }) => {
    const result = db
      .prepare("DELETE FROM locks WHERE name = ? AND namespace = ? AND holder = ?")
      .run(name, namespace, holder);

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({ released: result.changes > 0 }),
        },
      ],
    };
  },
);

server.tool(
  "status",
  "Check the status of a lock",
  {
    name: z.string().describe("Lock name"),
    namespace: z.enum(["target", "self"]).default("target"),
  },
  async ({ name, namespace }) => {
    cleanExpired();
    const locks = db
      .prepare("SELECT * FROM locks WHERE name = ? AND namespace = ?")
      .all(name, namespace);

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({ locked: locks.length > 0, holders: locks }),
        },
      ],
    };
  },
);

server.tool(
  "list",
  "List all active locks, optionally filtered by namespace",
  {
    namespace: z.enum(["target", "self"]).optional().describe("Filter by namespace"),
  },
  async ({ namespace }) => {
    cleanExpired();
    const locks = namespace
      ? db.prepare("SELECT * FROM locks WHERE namespace = ?").all(namespace)
      : db.prepare("SELECT * FROM locks").all();

    return {
      content: [{ type: "text" as const, text: JSON.stringify(locks) }],
    };
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
