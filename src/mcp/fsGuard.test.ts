/**
 * WI-15 — write_file BLOCKED_PATH guard for .saivage/skills/ and .saivage/memory/.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initProjectTree } from "../store/project.js";
import { registerBuiltinServices } from "./builtins.js";
import { McpRuntime } from "./runtime.js";
import { loadConfig } from "../config.js";

let tmpDir: string;
let prevCwd: string;
let runtime: McpRuntime;

beforeEach(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "wi15-"));
  await initProjectTree(tmpDir);
  prevCwd = process.cwd();
  process.chdir(tmpDir);
  const cfg = await loadConfig(tmpDir);
  runtime = new McpRuntime(cfg);
  registerBuiltinServices(runtime, cfg.mcp, cfg.security);
});
afterEach(() => {
  process.chdir(prevCwd);
  rmSync(tmpDir, { recursive: true, force: true });
});

async function writeFileTool(path: string, content: string): Promise<unknown> {
  return runtime.callTool("filesystem", "write_file", { path, content });
}

describe("write_file BLOCKED_PATH guard (WI-15)", () => {
  it("blocks writes under .saivage/skills/", async () => {
    await expect(writeFileTool(".saivage/skills/project/foo.md", "x")).rejects.toThrow(
      /BLOCKED_PATH/,
    );
  });

  it("blocks writes under .saivage/memory/", async () => {
    await expect(writeFileTool(".saivage/memory/project/audit.jsonl", "x")).rejects.toThrow(
      /BLOCKED_PATH/,
    );
  });

  it("permits writes outside the knowledge store", async () => {
    await writeFileTool("notes/free.md", "hello");
    expect(existsSync(join(tmpDir, "notes/free.md"))).toBe(true);
    expect(readFileSync(join(tmpDir, "notes/free.md"), "utf-8")).toBe("hello");
  });

  it("permits writes inside .saivage/ but outside skills/ and memory/", async () => {
    await writeFileTool(".saivage/notes/free.md", "ok");
    expect(existsSync(join(tmpDir, ".saivage/notes/free.md"))).toBe(true);
  });
});
