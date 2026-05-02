import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { loadConfig, expandHome } from "./config.js";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir, homedir } from "node:os";

describe("config", () => {
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), "saivage-config-"));
  });

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
  });

  describe("expandHome", () => {
    it("expands ~ to home directory", () => {
      expect(expandHome("~/foo/bar")).toBe(join(homedir(), "foo/bar"));
    });

    it("leaves absolute paths alone", () => {
      expect(expandHome("/foo/bar")).toBe("/foo/bar");
    });
  });

  describe("loadConfig", () => {
    it("returns defaults when no config file exists", () => {
      const config = loadConfig(true, projectRoot);
      expect(config.server.port).toBe(8080);
      expect(config.agent.maxConcurrentAgents).toBe(3);
      expect(config.models.orchestrator).toBe("anthropic/claude-sonnet-4-20250514");
      expect(config.modelEquivalents).toEqual({});
    });
  });
});
