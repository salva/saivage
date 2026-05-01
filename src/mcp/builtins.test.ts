import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { registerBuiltinServices } from "./builtins.js";
import { McpRuntime } from "./runtime.js";

describe("built-in MCP services", () => {
  let projectRoot: string;
  let previousProjectRoot: string | undefined;
  let previousSaivageRoot: string | undefined;
  let runtime: McpRuntime;

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), "saivage-builtins-"));
    previousProjectRoot = process.env["PROJECT_ROOT"];
    previousSaivageRoot = process.env["SAIVAGE_ROOT"];
    process.env["PROJECT_ROOT"] = projectRoot;
    process.env["SAIVAGE_ROOT"] = join(projectRoot, ".saivage");
    runtime = new McpRuntime({
      maxServices: 50,
      restartOnCrash: true,
      healthCheckIntervalMs: 0,
      idleShutdownMs: 0,
    });
    registerBuiltinServices(runtime);
  });

  afterEach(async () => {
    await runtime.shutdown();
    if (previousProjectRoot === undefined) delete process.env["PROJECT_ROOT"];
    else process.env["PROJECT_ROOT"] = previousProjectRoot;
    if (previousSaivageRoot === undefined) delete process.env["SAIVAGE_ROOT"];
    else process.env["SAIVAGE_ROOT"] = previousSaivageRoot;
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it("allows filesystem access inside the project root", async () => {
    writeFileSync(join(projectRoot, "README.md"), "hello", "utf-8");

    await expect(runtime.callTool("filesystem", "read_file", { path: "README.md" }))
      .resolves.toEqual({ content: "hello" });
  });

  it("rejects filesystem access outside the project root", async () => {
    await expect(runtime.callTool("filesystem", "read_file", { path: "/etc/passwd" }))
      .rejects.toThrow("Path must stay inside");
  });

  it("rejects skill path traversal names", async () => {
    mkdirSync(join(projectRoot, ".saivage", "skills"), { recursive: true });

    await expect(runtime.callTool("skills", "read_skill", { name: "../outside" }))
      .rejects.toThrow("Skill name may only contain");
  });

  it("hides unavailable stub services from the tool catalog", async () => {
    const toolNames = runtime.getAllTools().map((tool) => tool.name);

    expect(toolNames).toContain("read_file");
    expect(toolNames).toContain("fetch_url");
    expect(toolNames).toContain("download_file");
    expect(toolNames).toContain("download_with_fallbacks");
    expect(toolNames).not.toContain("fetch_page_content");
    await expect(runtime.callTool("web", "fetch_url", { url: "https://example.com" }))
      .rejects.toThrow("registered but unavailable");
  });

  it("rejects unsupported download protocols", async () => {
    await expect(runtime.callTool("data", "download_file", {
      url: "file:///etc/passwd",
      path: "cache/downloads/passwd.txt",
    })).rejects.toThrow("URL must use http or https");
  });

  it("records fallback download failures to an arbitrary project-relative manifest", async () => {
    await expect(runtime.callTool("data", "download_with_fallbacks", {
      urls: ["file:///etc/passwd", "ftp://example.com/data.csv"],
      path: "cache/source-a/out.csv",
      manifest_path: "tmp/acquisition/attempts.json",
    })).rejects.toThrow("All download sources failed");

    const manifestPath = join(projectRoot, "tmp", "acquisition", "attempts.json");
    expect(existsSync(manifestPath)).toBe(true);
    const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
    expect(manifest.attempts).toHaveLength(2);
    expect(manifest.path).toBe("cache/source-a/out.csv");
  });
});