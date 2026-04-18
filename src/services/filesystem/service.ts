#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  readFileSync,
  writeFileSync,
  readdirSync,
  statSync,
  existsSync,
  mkdirSync,
} from "node:fs";
import { join, resolve, dirname } from "node:path";

const server = new McpServer({
  name: "filesystem",
  version: "0.1.0",
});

// --- read_file ---
server.tool(
  "read_file",
  "Read the contents of a file at the given path",
  { path: z.string().describe("Absolute or relative file path") },
  async ({ path: filePath }) => {
    try {
      const resolved = resolve(filePath);
      const content = readFileSync(resolved, "utf-8");
      return { content: [{ type: "text" as const, text: content }] };
    } catch (err) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Error reading file: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
        isError: true,
      };
    }
  },
);

// --- write_file ---
server.tool(
  "write_file",
  "Write content to a file, creating directories as needed",
  {
    path: z.string().describe("Absolute or relative file path"),
    content: z.string().describe("Content to write"),
  },
  async ({ path: filePath, content }) => {
    try {
      const resolved = resolve(filePath);
      const dir = dirname(resolved);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      writeFileSync(resolved, content, "utf-8");
      return {
        content: [{ type: "text" as const, text: `Wrote ${content.length} bytes to ${resolved}` }],
      };
    } catch (err) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Error writing file: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
        isError: true,
      };
    }
  },
);

// --- list_dir ---
server.tool(
  "list_dir",
  "List contents of a directory",
  { path: z.string().describe("Directory path") },
  async ({ path: dirPath }) => {
    try {
      const resolved = resolve(dirPath);
      const entries = readdirSync(resolved);
      const result = entries.map((name) => {
        const full = join(resolved, name);
        const isDir = statSync(full).isDirectory();
        return `${isDir ? "📁" : "📄"} ${name}`;
      });
      return {
        content: [{ type: "text" as const, text: result.join("\n") || "(empty directory)" }],
      };
    } catch (err) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Error listing directory: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
        isError: true,
      };
    }
  },
);

// --- search_files ---
server.tool(
  "search_files",
  "Search for files matching a glob pattern (recursive)",
  {
    directory: z.string().describe("Base directory to search"),
    pattern: z.string().describe("Substring to match in file names"),
  },
  async ({ directory, pattern }) => {
    try {
      const resolved = resolve(directory);
      const matches: string[] = [];

      function walk(dir: string): void {
        if (matches.length > 200) return;
        const entries = readdirSync(dir);
        for (const name of entries) {
          if (name.startsWith(".") || name === "node_modules") continue;
          const full = join(dir, name);
          const stat = statSync(full);
          if (stat.isDirectory()) {
            walk(full);
          } else if (name.includes(pattern)) {
            matches.push(full);
          }
        }
      }

      walk(resolved);
      return {
        content: [
          {
            type: "text" as const,
            text: matches.length > 0
              ? matches.join("\n")
              : "No matching files found",
          },
        ],
      };
    } catch (err) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Error: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
        isError: true,
      };
    }
  },
);

// --- Start ---
const transport = new StdioServerTransport();
await server.connect(transport);
