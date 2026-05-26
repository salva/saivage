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
    it("returns defaults when no config file exists", async () => {
      const config = await loadConfig(projectRoot);
      expect(config.server.port).toBe(8080);
      expect(config.agent.maxConcurrentAgents).toBe(3);
      expect(config.models.orchestrator).toBeUndefined();
      expect(config.modelEquivalents).toEqual({});
    });

    it("populates runtime / supervisor / mcp defaults", async () => {
      const config = await loadConfig(projectRoot);
      expect(config.runtime.recoveryDelayMs).toBe(60_000);
      expect(config.runtime.notes.volatileTtlMs).toBe(2 * 60 * 60 * 1000);
      expect(config.supervisor.forceCancelDelayMs).toBe(600_000);
      expect(config.mcp.shellTimeoutMs).toBe(4 * 60 * 60 * 1000);
      expect(config.mcp.shellTimeoutFloorMs).toBe(10 * 60 * 1000);
      expect(config.mcp.inProcessTimeoutMs).toBe(300_000);
      expect(config.mcp.maxOutputBytes).toBe(100 * 1024);
      expect(config.mcp.maxFetchBytes).toBe(200_000);
      expect(config.mcp.maxDownloadBytes).toBe(250 * 1024 * 1024);
      expect(config.mcp.maxFileReadBytes).toBe(200_000);
      expect(config.mcp.fetchTimeoutMs).toBe(60_000);
    });

    it("loads overrides from the on-disk config", async () => {
      const saivageRoot = join(projectRoot, ".saivage");
      mkdirSync(saivageRoot, { recursive: true });
      writeFileSync(join(saivageRoot, "saivage.json"), JSON.stringify({
        runtime: { recoveryDelayMs: 12345, notes: { volatileTtlMs: 99 } },
        supervisor: { forceCancelDelayMs: 7 },
        mcp: { shellTimeoutMs: 1_200_000, maxOutputBytes: 13 },
      }, null, 2));
      const config = await loadConfig(projectRoot);
      expect(config.runtime.recoveryDelayMs).toBe(12345);
      expect(config.runtime.notes.volatileTtlMs).toBe(99);
      expect(config.supervisor.forceCancelDelayMs).toBe(7);
      expect(config.mcp.shellTimeoutMs).toBe(1_200_000);
      expect(config.mcp.maxOutputBytes).toBe(13);
    });

    it("loads maxFileReadBytes overrides from the on-disk config", async () => {
      const saivageRoot = join(projectRoot, ".saivage");
      mkdirSync(saivageRoot, { recursive: true });
      writeFileSync(join(saivageRoot, "saivage.json"), JSON.stringify({
        mcp: { maxFileReadBytes: 4096 },
      }, null, 2));
      expect((await loadConfig(projectRoot)).mcp.maxFileReadBytes).toBe(4096);
    });

    it("parses provider accounts and default account routing config", async () => {
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

      const config = await loadConfig(projectRoot);
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

    it("rejects shellTimeoutMs <= WALL_CLOCK_HEADROOM_MS", async () => {
      writeMcp({ shellTimeoutMs: 25_000 });
      await expect(loadConfig(projectRoot)).rejects.toThrow(/WALL_CLOCK_HEADROOM_MS/);
    });

    it("rejects shellTimeoutMs exactly equal to WALL_CLOCK_HEADROOM_MS", async () => {
      writeMcp({ shellTimeoutMs: 30_000 });
      await expect(loadConfig(projectRoot)).rejects.toThrow(/WALL_CLOCK_HEADROOM_MS/);
    });

    it("rejects shellTimeoutFloorMs > shellTimeoutMs - WALL_CLOCK_HEADROOM_MS", async () => {
      writeMcp({ shellTimeoutMs: 1_200_000, shellTimeoutFloorMs: 1_200_000 });
      await expect(loadConfig(projectRoot)).rejects.toThrow(/inner cap/);
    });

    it("accepts shellTimeoutFloorMs === shellTimeoutMs - WALL_CLOCK_HEADROOM_MS (boundary)", async () => {
      writeMcp({ shellTimeoutMs: 1_200_000, shellTimeoutFloorMs: 1_170_000 });
      const cfg = await loadConfig(projectRoot);
      expect(cfg.mcp.shellTimeoutFloorMs).toBe(1_170_000);
    });

    it("accepts the default config", async () => {
      const cfg = await loadConfig(projectRoot);
      expect(cfg.mcp.shellTimeoutMs).toBe(14_400_000);
      expect(cfg.mcp.shellTimeoutFloorMs).toBe(600_000);
    });
  });

  describe("loadConfig — no cache", () => {
    it("two concurrent loaders see independent snapshots", async () => {
      const saivageRoot = join(projectRoot, ".saivage");
      mkdirSync(saivageRoot, { recursive: true });
      writeFileSync(
        join(saivageRoot, "saivage.json"),
        JSON.stringify({ models: { default: "openai/gpt-5" } }),
      );
      const [a, b] = await Promise.all([
        loadConfig(projectRoot),
        loadConfig(projectRoot),
      ]);
      expect(a).not.toBe(b);
      (a.models as { default?: unknown }).default = "tampered";
      const c = await loadConfig(projectRoot);
      expect(c.models.default).toBe("openai/gpt-5");
    });

    it("reflects edits made between calls", async () => {
      const saivageRoot = join(projectRoot, ".saivage");
      mkdirSync(saivageRoot, { recursive: true });
      const fp = join(saivageRoot, "saivage.json");
      writeFileSync(fp, JSON.stringify({ mcp: { shellTimeoutMs: 11 * 60_000 } }));
      const first = await loadConfig(projectRoot);
      expect(first.mcp.shellTimeoutMs).toBe(11 * 60_000);
      writeFileSync(fp, JSON.stringify({ mcp: { shellTimeoutMs: 12 * 60_000 } }));
      const second = await loadConfig(projectRoot);
      expect(second.mcp.shellTimeoutMs).toBe(12 * 60_000);
    });

    it("rejects on malformed JSON", async () => {
      const saivageRoot = join(projectRoot, ".saivage");
      mkdirSync(saivageRoot, { recursive: true });
      writeFileSync(join(saivageRoot, "saivage.json"), "not json");
      await expect(loadConfig(projectRoot)).rejects.toThrow(SyntaxError);
    });
  });
});
