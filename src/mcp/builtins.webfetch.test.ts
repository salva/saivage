import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { loadConfig } from "../config.js";
import { registerBuiltinServices } from "./builtins.js";
import { McpRuntime } from "./runtime.js";

async function withServer(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
  fn: (url: string) => Promise<void>,
): Promise<void> {
  const server: Server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server did not bind to a TCP port");
  try {
    await fn(`http://127.0.0.1:${address.port}/file.txt`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  }
}

describe("data webfetch/websearch consolidation", () => {
  let projectRoot: string;
  let runtime: McpRuntime;

  beforeEach(async () => {
    projectRoot = mkdtempSync(join(tmpdir(), "saivage-webfetch-"));
    mkdirSync(join(projectRoot, ".saivage"), { recursive: true });
    writeFileSync(
      join(projectRoot, ".saivage", "saivage.json"),
      JSON.stringify({ mcp: { maxFileReadBytes: 8, maxFetchBytes: 1024 } }),
      "utf-8",
    );
    const cfg = await loadConfig(projectRoot);
    runtime = new McpRuntime(cfg);
    registerBuiltinServices(runtime, cfg.mcp, cfg.security, { project: { projectRoot } });
  });

  afterEach(async () => {
    await runtime.shutdown();
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it("advertises only webfetch and websearch for web/data access", () => {
    const toolNames = runtime.getAllTools().map((tool) => tool.name);
    expect(toolNames).toContain("webfetch");
    expect(toolNames).toContain("websearch");
    for (const removed of ["web_search", "fetch_url", "fetch_page_text", "head_url", "download_file", "download_with_fallbacks"]) {
      expect(toolNames).not.toContain(removed);
    }
  });

  it("uses GET with Range for metadata_only and rejects metadata_only plus save_as", async () => {
    let seenMethod = "";
    let seenRange: string | undefined;
    await withServer((req, res) => {
      seenMethod = req.method ?? "";
      seenRange = req.headers.range;
      res.statusCode = 206;
      res.setHeader("content-type", "text/plain");
      res.end("a");
    }, async (url) => {
      const result = await runtime.callTool("data", "webfetch", { url, metadata_only: true }) as { status: number };
      expect(result.status).toBe(206);
      expect(seenMethod).toBe("GET");
      expect(seenRange).toBe("bytes=0-0");

      await expect(runtime.callTool("data", "webfetch", { url, metadata_only: true, save_as: "tmp/a.txt" }))
        .rejects.toThrow("metadata_only cannot be combined with save_as");
    });
  });

  it("spills oversized decoded text to stash and saves explicit raw bytes", async () => {
    await withServer((_req, res) => {
      res.statusCode = 200;
      res.setHeader("content-type", "text/plain; charset=utf-8");
      res.end("hello world");
    }, async (url) => {
      const text = await runtime.callTool("data", "webfetch", {
        url,
        read_mode: "text",
        max_inline_bytes: 4,
      }) as { stash_path: string; content_preview: string };
      expect(text.stash_path).toMatch(/^\.saivage\/tmp\/stash\/webfetch-/);
      expect(text.content_preview).toBe("hell");
      expect(readFileSync(join(projectRoot, text.stash_path), "utf-8")).toBe("hello world");

      const saved = await runtime.callTool("data", "webfetch", { url, save_as: "tmp/saved.txt" }) as { saved_path: string };
      expect(saved.saved_path).toBe("tmp/saved.txt");
      expect(existsSync(join(projectRoot, saved.saved_path))).toBe(true);
    });
  });
});
