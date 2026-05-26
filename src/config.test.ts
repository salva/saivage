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
      expect(config.models.orchestrator).toBeUndefined();
      expect(config.modelEquivalents).toEqual({});
    });

    it("populates runtime / supervisor / mcp defaults", () => {
      const config = loadConfig(true, projectRoot);
      expect(config.runtime.recoveryDelayMs).toBe(60_000);
      expect(config.runtime.notes.volatileTtlMs).toBe(2 * 60 * 60 * 1000);
      expect(config.supervisor.forceCancelDelayMs).toBe(600_000);
      expect(config.mcp.shellTimeoutMs).toBe(4 * 60 * 60 * 1000);
      expect(config.mcp.shellTimeoutFloorMs).toBe(10 * 60 * 1000);
      expect(config.mcp.inProcessTimeoutMs).toBe(300_000);
      expect(config.mcp.maxOutputBytes).toBe(100 * 1024);
      expect(config.mcp.maxFetchChars).toBe(200_000);
      expect(config.mcp.maxDownloadBytes).toBe(250 * 1024 * 1024);
    });

    it("loads overrides from the on-disk config", () => {
      const saivageRoot = join(projectRoot, ".saivage");
      mkdirSync(saivageRoot, { recursive: true });
      writeFileSync(join(saivageRoot, "saivage.json"), JSON.stringify({
        runtime: { recoveryDelayMs: 12345, notes: { volatileTtlMs: 99 } },
        supervisor: { forceCancelDelayMs: 7 },
        mcp: { shellTimeoutMs: 1_200_000, maxOutputBytes: 13 },
      }, null, 2));
      const config = loadConfig(true, projectRoot);
      expect(config.runtime.recoveryDelayMs).toBe(12345);
      expect(config.runtime.notes.volatileTtlMs).toBe(99);
      expect(config.supervisor.forceCancelDelayMs).toBe(7);
      expect(config.mcp.shellTimeoutMs).toBe(1_200_000);
      expect(config.mcp.maxOutputBytes).toBe(13);
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

  describe("mcp timing envelope validation", () => {
    function writeMcp(mcp: Record<string, number>): void {
      const saivageRoot = join(projectRoot, ".saivage");
      mkdirSync(saivageRoot, { recursive: true });
      writeFileSync(join(saivageRoot, "saivage.json"), JSON.stringify({ mcp }, null, 2));
    }

    it("rejects shellTimeoutMs <= WALL_CLOCK_HEADROOM_MS", () => {
      writeMcp({ shellTimeoutMs: 25_000 });
      expect(() => loadConfig(true, projectRoot)).toThrow(/WALL_CLOCK_HEADROOM_MS/);
    });

    it("rejects shellTimeoutMs exactly equal to WALL_CLOCK_HEADROOM_MS", () => {
      writeMcp({ shellTimeoutMs: 30_000 });
      expect(() => loadConfig(true, projectRoot)).toThrow(/WALL_CLOCK_HEADROOM_MS/);
    });

    it("rejects shellTimeoutFloorMs > shellTimeoutMs - WALL_CLOCK_HEADROOM_MS", () => {
      writeMcp({ shellTimeoutMs: 1_200_000, shellTimeoutFloorMs: 1_200_000 });
      expect(() => loadConfig(true, projectRoot)).toThrow(/inner cap/);
    });

    it("accepts shellTimeoutFloorMs === shellTimeoutMs - WALL_CLOCK_HEADROOM_MS (boundary)", () => {
      writeMcp({ shellTimeoutMs: 1_200_000, shellTimeoutFloorMs: 1_170_000 });
      const cfg = loadConfig(true, projectRoot);
      expect(cfg.mcp.shellTimeoutFloorMs).toBe(1_170_000);
    });

    it("accepts the default config", () => {
      const cfg = loadConfig(true, projectRoot);
      expect(cfg.mcp.shellTimeoutMs).toBe(14_400_000);
      expect(cfg.mcp.shellTimeoutFloorMs).toBe(600_000);
    });
  });
});
