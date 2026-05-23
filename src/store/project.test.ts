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
import { join } from "node:path";
import { tmpdir } from "node:os";

import { initProject, initProjectTree, loadProject } from "./project.js";
import { ProjectConfigSchema, type ProjectConfig } from "../types.js";

let projectRoot: string;

beforeEach(() => {
  projectRoot = mkdtempSync(join(tmpdir(), "saivage-project-"));
});

afterEach(() => {
  rmSync(projectRoot, { recursive: true, force: true });
});

function defaultConfig(): ProjectConfig {
  return ProjectConfigSchema.parse({
    project_name: "test-project",
    objectives: ["test"],
    notifications: {
      channels: [],
      filters: { min_severity: "info", categories: [] },
    },
    skills: { max_per_agent: 5 },
  });
}

describe("initProject — knowledge tree", () => {
  it("creates skills + memory subtrees with seeded indexes (FR-1)", () => {
    initProject(projectRoot, defaultConfig());
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

  it("writes .gitignore with tmp/ + session subtrees (FR-21)", () => {
    initProject(projectRoot, defaultConfig());
    const gitignore = readFileSync(
      join(projectRoot, ".saivage", ".gitignore"),
      "utf-8",
    );
    const lines = gitignore.split("\n").map((l) => l.trim()).filter(Boolean);
    expect(lines).toContain("tmp/");
    expect(lines).toContain("skills/sessions/");
    expect(lines).toContain("memory/sessions/");
  });

  it("exposes paths.memory on the loaded ProjectContext", () => {
    initProject(projectRoot, defaultConfig());
    const ctx = loadProject(projectRoot);
    expect(ctx.paths.memory).toBe(join(projectRoot, ".saivage", "memory"));
    expect(ctx.paths.skills).toBe(join(projectRoot, ".saivage", "skills"));
  });
});

describe("initProjectTree — idempotence", () => {
  it("is a no-op when the tree already exists", () => {
    initProject(projectRoot, defaultConfig());
    const indexPath = join(
      projectRoot,
      ".saivage",
      "skills",
      "project",
      "index.json",
    );
    // Sentinel content — must not be overwritten on re-run.
    writeFileSync(indexPath, JSON.stringify({ skills: ["sentinel"] }), "utf-8");

    initProjectTree(projectRoot);

    const after = JSON.parse(readFileSync(indexPath, "utf-8"));
    expect(after).toEqual({ skills: ["sentinel"] });
  });

  it("does not duplicate .gitignore lines on re-run", () => {
    initProject(projectRoot, defaultConfig());
    const gitignorePath = join(projectRoot, ".saivage", ".gitignore");
    const before = readFileSync(gitignorePath, "utf-8");
    initProjectTree(projectRoot);
    initProjectTree(projectRoot);
    const after = readFileSync(gitignorePath, "utf-8");
    expect(after).toBe(before);
  });

  it("appends missing lines to a pre-existing .gitignore", () => {
    const saivage = join(projectRoot, ".saivage");
    // Simulate a pre-existing .gitignore without the new lines.
    mkdirSync(saivage, { recursive: true });
    writeFileSync(join(saivage, ".gitignore"), "tmp/\n# user comment\n", "utf-8");

    initProjectTree(projectRoot);

    const content = readFileSync(join(saivage, ".gitignore"), "utf-8");
    const lines = content.split("\n").map((l) => l.trim()).filter(Boolean);
    expect(lines).toContain("tmp/");
    expect(lines).toContain("# user comment");
    expect(lines).toContain("skills/sessions/");
    expect(lines).toContain("memory/sessions/");
  });
});
