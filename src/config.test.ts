import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { loadConfig, expandHome } from "./config.js";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
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

    it("parses provider accounts and default account routing config", () => {
      const saivageRoot = join(projectRoot, ".saivage");
      mkdirSync(saivageRoot, { recursive: true });
      writeFileSync(join(saivageRoot, "saivage.json"), JSON.stringify({
        providers: {
          "github-copilot": {
            defaultAccount: "main",
            accounts: {
              main: {
                authProfile: "github-copilot-main",
              },
            },
          },
        },
      }, null, 2));

      const config = loadConfig(true, projectRoot);
      expect(config.providers["github-copilot"]?.defaultAccount).toBe("main");
      expect(config.providers["github-copilot"]?.accounts.main?.authProfile).toBe("github-copilot-main");
    });
  });
});
