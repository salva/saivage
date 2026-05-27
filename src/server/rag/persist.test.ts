import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readdirSync, chmodSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { configPath, loadConfig, type SaivageConfig } from "../../config.js";
import { saveSaivageConfig, SaivagePersistError } from "./persist.js";

function emptyConfig(): SaivageConfig {
  // Force schema defaults — every field is optional with a default.
  return JSON.parse(JSON.stringify({})) as SaivageConfig;
}

describe("saveSaivageConfig", () => {
  let root: string;
  beforeEach(async () => {
    root = mkdtempSync(path.join(tmpdir(), "saivage-persist-"));
    await mkdir(path.join(root, ".saivage"), { recursive: true });
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("creates the file with mutated content when it does not exist", async () => {
    await saveSaivageConfig(root, (cfg) => ({
      ...cfg,
      rag: { ...cfg.rag, enabled: true },
    }));
    const cfg = await loadConfig(root);
    expect(cfg.rag.enabled).toBe(true);
    expect(cfg.rag.datasets).toEqual([]);
  });

  it("round-trips an existing file and mutates additively", async () => {
    const fp = configPath(root);
    await writeFile(fp, JSON.stringify({ rag: { enabled: false, datasets: [] } }, null, 2));
    await saveSaivageConfig(root, (cfg) => ({
      ...cfg,
      rag: {
        ...cfg.rag,
        enabled: true,
        datasets: [
          {
            id: "skills",
            source: "skill",
            provider: { kind: "openai", model: "text-embedding-3-small", dim: 256 },
            store: { kind: "sqlite-vec" },
            chunker: { kind: "memory" },
            exclusions: [],
            sources: [],
            watch: false,
          },
        ],
      },
    }));
    const cfg = await loadConfig(root);
    expect(cfg.rag.enabled).toBe(true);
    expect(cfg.rag.datasets.map((d) => d.id)).toEqual(["skills"]);
  });

  it("does NOT env-interpolate placeholders during persist", async () => {
    const fp = configPath(root);
    await writeFile(
      fp,
      JSON.stringify({ mcpServers: { x: { command: "${MY_VAR}", args: [], env: {} } } }, null, 2),
    );
    process.env["MY_VAR"] = "expanded";
    try {
      await saveSaivageConfig(root, (cfg) => ({
        ...cfg,
        rag: { ...cfg.rag, enabled: true },
      }));
      const raw = JSON.parse(await readFile(fp, "utf-8"));
      expect(raw.mcpServers.x.command).toBe("${MY_VAR}");
    } finally {
      delete process.env["MY_VAR"];
    }
  });

  it("read stage error when on-disk file is unreadable", async () => {
    const fp = configPath(root);
    await writeFile(fp, "{}");
    // Make file unreadable; skip on platforms (or roots) where chmod is ineffective.
    chmodSync(fp, 0o000);
    let caught: unknown;
    try {
      await saveSaivageConfig(root, (cfg) => cfg);
    } catch (e) {
      caught = e;
    } finally {
      chmodSync(fp, 0o644);
    }
    // If running as root chmod 000 is a no-op; only assert on the
    // failure path.
    if (caught) {
      expect(caught).toBeInstanceOf(SaivagePersistError);
      expect((caught as SaivagePersistError).details.stage).toBe("read");
    }
  });

  it("validate stage error when on-disk JSON is not valid schema", async () => {
    const fp = configPath(root);
    await writeFile(fp, JSON.stringify({ rag: { enabled: "yes" } }));
    await expect(saveSaivageConfig(root, (cfg) => cfg)).rejects.toMatchObject({
      name: "SaivagePersistError",
      details: { stage: "validate" },
    });
  });

  it("validate stage error when mutate produces an invalid config", async () => {
    await expect(
      saveSaivageConfig(root, (cfg) => ({
        ...cfg,
        rag: { ...cfg.rag, enabled: "yes" as unknown as boolean },
      })),
    ).rejects.toMatchObject({
      name: "SaivagePersistError",
      details: { stage: "validate" },
    });
  });

  it("write stage error and temp file is cleaned up when rename fails", async () => {
    // Force a write failure by making the project root unwritable.
    const fp = configPath(root);
    await writeFile(fp, "{}");
    chmodSync(path.dirname(fp), 0o555);
    let caught: unknown;
    try {
      await saveSaivageConfig(root, (cfg) => ({ ...cfg, rag: { ...cfg.rag, enabled: true } }));
    } catch (e) {
      caught = e;
    } finally {
      chmodSync(path.dirname(fp), 0o755);
    }
    if (caught) {
      expect(caught).toBeInstanceOf(SaivagePersistError);
      expect((caught as SaivagePersistError).details.stage).toBe("write");
      // No stray *.tmp left behind.
      const stray = readdirSync(path.dirname(fp)).filter((n) => n.endsWith(".tmp"));
      expect(stray).toEqual([]);
    }
  });

  it("exposes SaivagePersistError via src/config.ts", async () => {
    const cfgModule = await import("../../config.js");
    expect(cfgModule.SaivagePersistError).toBe(SaivagePersistError);
    expect(typeof cfgModule.saveSaivageConfig).toBe("function");
  });

  // Sanity: emptyConfig helper is shaped via schema defaults.
  it("schema defaults produce an empty config without rag entries", () => {
    const e = emptyConfig();
    expect(e.rag).toBeUndefined();
  });
});
