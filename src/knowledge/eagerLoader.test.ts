import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initProjectTree } from "../store/project.js";
import { createSkill, createMemory } from "./lifecycle.js";
import { loadAllCandidates, formatEagerBlock, buildEagerBlock } from "./eagerLoader.js";
import { resolveEagerRecords } from "./loader.js";

describe("eagerLoader (WI-13)", () => {
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), "wi13-"));
    initProjectTree(projectRoot);
  });
  afterEach(() => rmSync(projectRoot, { recursive: true, force: true }));

  it("loads project-scope skills and memories as candidates", () => {
    const saivage = join(projectRoot, ".saivage");
    createSkill(
      saivage,
      {
        name: "coder-skill",
        description: "trigger-matched skill",
        body: "# Coder skill body",
        scope: "project",
        triggers: ["coding"],
        target_agents: ["coder"],
        reason: "wi-13 test create",
      },
      { role: "manager", agent_id: "test" },
    );
    createMemory(
      saivage,
      {
        topic: { domain: "build", subject: "web", aspect: "command" },
        body: "Memory body for coder",
        target_agents: ["coder"],
        scope: "project",
        reason: "wi-13 test memory",
      },
      { role: "manager", agent_id: "test" },
    );

    const cands = loadAllCandidates(projectRoot, "/nonexistent-builtin-dir");
    expect(cands.some((c) => c.record.kind === "skill")).toBe(true);
    expect(cands.some((c) => c.record.kind === "memory")).toBe(true);
  });

  it("formatEagerBlock emits the §D.6 header and END marker", () => {
    const saivage = join(projectRoot, ".saivage");
    createSkill(
      saivage,
      {
        name: "always-on",
        description: "survivor",
        body: "survivor body",
        scope: "project",
        triggers: ["foo"],
        target_agents: ["coder"],
        survive_compaction: true,
        reason: "wi-13 survivor seed",
      },
      { role: "manager", agent_id: "test" },
    );
    const block = buildEagerBlock(projectRoot, "coder", "context", ["foo"]);
    expect(block).toContain("--- SAIVAGE KNOWLEDGE");
    expect(block).toContain("--- END SAIVAGE KNOWLEDGE ---");
    expect(block).toContain("--- SKILL: always-on (project) ---");
  });

  it("walkBuiltinSkills picks up bundled SKILL.md", () => {
    const builtin = join(projectRoot, "fake-builtin");
    mkdirSync(join(builtin, "planning"), { recursive: true });
    writeFileSync(
      join(builtin, "planning", "SKILL.md"),
      "# planning\nbuiltin body",
      "utf-8",
    );
    const cands = loadAllCandidates(projectRoot, builtin);
    const builtinCand = cands.find((c) => c.origin === "builtin");
    expect(builtinCand).toBeDefined();
    expect(builtinCand?.body).toContain("builtin body");
  });

  it("formatEagerBlock returns empty string when nothing resolves", () => {
    const res = resolveEagerRecords({ agentRole: "coder" }, []);
    expect(formatEagerBlock(res)).toBe("");
  });
});
