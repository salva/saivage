#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { execSync } from "node:child_process";

const server = new McpServer({
  name: "shell",
  version: "0.1.0",
});

const MAX_OUTPUT = 100_000; // bytes

server.tool(
  "run_command",
  "Execute a shell command and return stdout/stderr",
  {
    command: z.string().describe("Shell command to execute"),
    cwd: z.string().optional().describe("Working directory"),
    timeout: z
      .number()
      .optional()
      .default(60_000)
      .describe("Timeout in ms (default 60s)"),
  },
  async ({ command, cwd, timeout }) => {
    try {
      const output = execSync(command, {
        cwd: cwd ?? process.cwd(),
        timeout: timeout ?? 60_000,
        maxBuffer: MAX_OUTPUT,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      });
      return {
        content: [{ type: "text" as const, text: output }],
      };
    } catch (err: unknown) {
      const e = err as { stdout?: string; stderr?: string; message?: string };
      const text = [e.stdout, e.stderr, e.message].filter(Boolean).join("\n");
      return {
        content: [{ type: "text" as const, text: text || "Command failed" }],
        isError: true,
      };
    }
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
