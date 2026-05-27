/**
 * Tests for project init / load (WI-10: knowledge tree scaffolding).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { initProjectTree, loadProject, seedProject } from "./project.js";
import { readDoc } from "./documents.js";
import { loadConfig, SaivageConfigSchema, type SaivageConfig } from "../config.js";
import {
  DEFAULT_ANTHROPIC_CLIENT_ID,
  DEFAULT_GITHUB_COPILOT_CLIENT_ID,
  DEFAULT_OPENAI_CODEX_CLIENT_ID,
} from "../auth/defaults.js";
import {
  DEFAULT_CONFIG_POINTER_SUFFIXES,
  DEFAULT_CREDENTIAL_LEXEMES,
} from "../security/secrets.js";

let projectRoot: string;

const EXPECTED_SEED: SaivageConfig = {
  models: {},
  providers: {},
  failover: {},
  modelEquivalents: {},
  server: { port: 8080, host: "0.0.0.0" },
  agent: { maxConcurrentAgents: 3 },
  runtime: {
    maxServices: 50,
    restartOnCrash: true,
    continuousImprovement: true,
    healthCheckIntervalMs: 30_000,
    idleShutdownMs: 300_000,
    recoveryDelayMs: 60_000,
    notes: { volatileTtlMs: 2 * 60 * 60 * 1000 },
  },
  security: {
    envScrubber: {
      credentialLexemes: [...DEFAULT_CREDENTIAL_LEXEMES],
      configPointerSuffixes: [...DEFAULT_CONFIG_POINTER_SUFFIXES],
    },
  },
  supervisor: {
    enabled: true,
    intervalMs: 20 * 60 * 1000,
    consecutiveStuckVerdicts: 3,
    logLines: 400,
    forceCancelDelayMs: 600_000,
  },
  telegram: { botToken: "", allowedUserIds: [] },
  mcp: {
    shellTimeoutMs: 4 * 60 * 60 * 1000,
    shellTimeoutFloorMs: 10 * 60 * 1000,
    inProcessTimeoutMs: 300_000,
    maxOutputBytes: 100 * 1024,
    maxFetchBytes: 200_000,
    maxDownloadBytes: 250 * 1024 * 1024,
    maxFileReadBytes: 200_000,
    maxSearchResults: 1_000,
    maxSearchDepth: 20,
    maxSearchMs: 10_000,
    fetchTimeoutMs: 60_000,
    webSearchMaxBytes: 2 * 1024 * 1024,
    webSearchMaxResults: 20,
    webSearchTimeoutMs: 15_000,
  },
  notifications: {
    channels: ["web"],
    filters: { min_severity: "info", categories: [] },
  },
  oauth: {
    anthropic: { clientId: DEFAULT_ANTHROPIC_CLIENT_ID },
    openaiCodex: { clientId: DEFAULT_OPENAI_CODEX_CLIENT_ID },
    githubCopilot: { clientId: DEFAULT_GITHUB_COPILOT_CLIENT_ID },
  },
  mcpServers: {},
  rag: { enabled: false, datasets: [] },
};

beforeEach(() => {
  projectRoot = mkdtempSync(join(tmpdir(), "saivage-project-"));
});

afterEach(() => {
  rmSync(projectRoot, { recursive: true, force: true });
});

describe("seedProject", () => {
  it("creates skills + memory subtrees with seeded indexes (FR-1)", async () => {
    await seedProject(projectRoot, { name: "test-project", objectives: ["test"] });
    const saivage = join(projectRoot, ".saivage");

    for (const kind of ["skills", "memory"] as const) {
      for (const sub of ["project", "stages", "sessions"] as const) {
        expect(statSync(join(saivage, kind, sub)).isDirectory()).toBe(true);
      }
    }

    const skillsIndex = JSON.parse(
      readFileSync(join(saivage, "skills", "project", "index.json"), "utf-8"),
    );
    expect(skillsIndex).toEqual({ skills: [] });

    const memoryIndex = JSON.parse(
      readFileSync(join(saivage, "memory", "project", "index.json"), "utf-8"),
    );
    expect(memoryIndex).toEqual({ memories: [], topic_map: {} });

    for (const kind of ["skills", "memory"] as const) {
      const auditPath = join(saivage, kind, "project", "audit.jsonl");
      expect(existsSync(auditPath)).toBe(true);
      expect(readFileSync(auditPath, "utf-8")).toBe("");
    }
  });

  it("writes .gitignore with tmp/ + session subtrees (FR-21)", async () => {
    await seedProject(projectRoot, { name: "test-project", objectives: ["test"] });
    const gitignore = readFileSync(
      join(projectRoot, ".saivage", ".gitignore"),
      "utf-8",
    );
    const lines = gitignore.split("\n").map((l) => l.trim()).filter(Boolean);
    expect(lines).toContain("tmp/");
    expect(lines).toContain("skills/sessions/");
    expect(lines).toContain("memory/sessions/");
  });

  it("exposes paths.memory on the loaded ProjectContext", async () => {
    await seedProject(projectRoot, { name: "test-project", objectives: ["test"] });
    const ctx = await loadProject(projectRoot);
    expect(ctx.paths.memory).toBe(join(projectRoot, ".saivage", "memory"));
    expect(ctx.paths.skills).toBe(join(projectRoot, ".saivage", "skills"));
  });
  it("writes saivage.json with web channel and info severity", async () => {
    await seedProject(projectRoot, { name: "p", objectives: [] });
    const cfg = await loadConfig(projectRoot);
    expect(cfg.notifications.channels).toEqual(["web"]);
    expect(cfg.notifications.filters.min_severity).toBe("info");
  });

  it("does not write a default orchestrator model into saivage.json", async () => {
    await seedProject(projectRoot, { name: "p", objectives: [] });
    const cfg = await loadConfig(projectRoot);
    expect(cfg.models.orchestrator).toBeUndefined();
  });

  it("seeded saivage.json equals the committed EXPECTED_SEED literal", async () => {
    await seedProject(projectRoot, { name: "p", objectives: [] });
    const path = join(projectRoot, ".saivage", "saivage.json");
    const raw = JSON.parse(await readFile(path, "utf-8"));
    expect(raw).toEqual(EXPECTED_SEED);
  });

  it("SaivageConfigSchema.parse({}) equals EXPECTED_SEED (review-on-change)", () => {
    expect(SaivageConfigSchema.parse({})).toEqual(EXPECTED_SEED);
  });

  it("seeded saivage.json contains no providers or mcp servers by default", async () => {
    await seedProject(projectRoot, { name: "p", objectives: [] });
    const path = join(projectRoot, ".saivage", "saivage.json");
    const raw = JSON.parse(await readFile(path, "utf-8")) as SaivageConfig;
    expect(raw.providers).toEqual({});
    expect(raw.mcpServers).toEqual({});
  });

  it("seeded saivage.json top-level keys match the schema shape", async () => {
    await seedProject(projectRoot, { name: "p", objectives: [] });
    const path = join(projectRoot, ".saivage", "saivage.json");
    const raw = JSON.parse(await readFile(path, "utf-8")) as Record<string, unknown>;
    expect(Object.keys(raw).sort()).toEqual(Object.keys(SaivageConfigSchema.shape).sort());
  });

  it("seeded saivage.json parses through the loader contract", async () => {
    await seedProject(projectRoot, { name: "p", objectives: [] });
    const path = join(projectRoot, ".saivage", "saivage.json");
    const cfg = await readDoc(path, SaivageConfigSchema);
    expect(cfg).toBeDefined();
  });
});

describe("initProjectTree — idempotence", () => {
  it("is a no-op when the tree already exists", async () => {
    await seedProject(projectRoot, { name: "test-project", objectives: ["test"] });
    const indexPath = join(
      projectRoot,
      ".saivage",
      "skills",
      "project",
      "index.json",
    );
    // Sentinel content — must not be overwritten on re-run.
    writeFileSync(indexPath, JSON.stringify({ skills: ["sentinel"] }), "utf-8");

    await initProjectTree(projectRoot);

    const after = JSON.parse(readFileSync(indexPath, "utf-8"));
    expect(after).toEqual({ skills: ["sentinel"] });
  });

  it("does not duplicate .gitignore lines on re-run", async () => {
    await seedProject(projectRoot, { name: "test-project", objectives: ["test"] });
    const gitignorePath = join(projectRoot, ".saivage", ".gitignore");
    const before = readFileSync(gitignorePath, "utf-8");
    await initProjectTree(projectRoot);
    await initProjectTree(projectRoot);
    const after = readFileSync(gitignorePath, "utf-8");
    expect(after).toBe(before);
  });

  it("appends missing lines to a pre-existing .gitignore", async () => {
    const saivage = join(projectRoot, ".saivage");
    // Simulate a pre-existing .gitignore without the new lines.
    mkdirSync(saivage, { recursive: true });
    writeFileSync(join(saivage, ".gitignore"), "tmp/\n# user comment\n", "utf-8");

    await initProjectTree(projectRoot);

    const content = readFileSync(join(saivage, ".gitignore"), "utf-8");
    const lines = content.split("\n").map((l) => l.trim()).filter(Boolean);
    expect(lines).toContain("tmp/");
    expect(lines).toContain("# user comment");
    expect(lines).toContain("skills/sessions/");
    expect(lines).toContain("memory/sessions/");
  });
});
