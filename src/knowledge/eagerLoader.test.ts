import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initProjectTree } from "../store/project.js";
import { acquireRuntimeLock, type RuntimeLock } from "../runtime/recovery.js";
import { createSkill, createMemory } from "./lifecycle.js";
import {
  defaultBuiltinSkillsRoot,
  loadAllCandidates,
  formatEagerBlock,
  buildEagerBlock,
} from "./eagerLoader.js";
import { resolveEagerRecords } from "./loader.js";
import type { SkillRecord } from "./types.js";
import { makeTestStore } from "./_testfixtures/store.js";
import type { KnowledgeStore } from "./init.js";

function makeFixtureBuiltinSkill(root: string, name: string, frontmatter: string, body: string): void {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), `---\n${frontmatter}\n---\n${body}`, "utf-8");
}

function skillNames(candidates: Awaited<ReturnType<typeof loadAllCandidates>>): string[] {
  return candidates
    .filter((candidate) => candidate.origin === "builtin" && candidate.record.kind === "skill")
    .map((candidate) => (candidate.record as SkillRecord).name)
    .sort();
}

describe("eagerLoader (WI-13)", () => {
  let projectRoot: string;
  let runtimeLock: RuntimeLock | null;
  let store: KnowledgeStore;

  beforeEach(async () => {
    projectRoot = mkdtempSync(join(tmpdir(), "wi13-"));
    await initProjectTree(projectRoot);
    runtimeLock = await acquireRuntimeLock(join(projectRoot, ".saivage"));
    store = await makeTestStore(projectRoot);
  });
  afterEach(() => {
    store?.sidecar.close();
    runtimeLock?.release();
    runtimeLock = null;
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it("loads project-scope skills and memories as candidates", async () => {
    await createSkill(
      store,
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
    await createMemory(
      store,
      {
        topic: { domain: "build", subject: "web", aspect: "command" },
        body: "Memory body for coder",
        target_agents: ["coder"],
        scope: "project",
        reason: "wi-13 test memory",
      },
      { role: "manager", agent_id: "test" },
    );

    const cands = await loadAllCandidates(projectRoot, "/nonexistent-builtin-dir");
    expect(cands.some((c) => c.record.kind === "skill")).toBe(true);
    expect(cands.some((c) => c.record.kind === "memory")).toBe(true);
  });

  it("formatEagerBlock emits the §D.6 header and END marker", async () => {
    await createSkill(
      store,
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
    const block = await buildEagerBlock(projectRoot, "coder", "context", ["foo"]);
    expect(block).toContain("--- SAIVAGE KNOWLEDGE");
    expect(block).toContain("--- END SAIVAGE KNOWLEDGE ---");
    expect(block).toContain("--- SKILL: always-on (project) ---");
  });

  it("walkBuiltinSkills parses strict builtin frontmatter and strips it from body", async () => {
    const builtin = join(projectRoot, "fake-builtin");
    makeFixtureBuiltinSkill(
      builtin,
      "alpha",
      [
        "name: alpha-skill",
        "description: first skill",
        "triggers:",
        "  - agent:coder",
        "  - keyword:build",
        "target_agents: [coder, reviewer]",
        "survive_compaction: true",
      ].join("\n"),
      "Alpha body.",
    );
    const cands = await loadAllCandidates(projectRoot, builtin);
    const builtinCand = cands.find((c) => c.origin === "builtin");
    expect(builtinCand).toBeDefined();
    expect(builtinCand?.body).toBe("Alpha body.");
    expect(builtinCand?.body.startsWith("---")).toBe(false);
    expect(builtinCand?.record).toMatchObject({
      kind: "skill",
      origin: "builtin",
      name: "alpha-skill",
      description: "first skill",
      triggers: ["agent:coder", "keyword:build"],
      target_agents: ["coder", "reviewer"],
      survive_compaction: true,
    });
  });

  it("rejects builtin skills that omit required target_agents", async () => {
    const builtin = join(projectRoot, "missing-target-agents");
    makeFixtureBuiltinSkill(
      builtin,
      "alpha",
      [
        "name: alpha",
        "description: missing target_agents",
        "triggers: [agent:coder]",
        "survive_compaction: false",
      ].join("\n"),
      "Alpha body.",
    );

    await expect(loadAllCandidates(projectRoot, builtin)).rejects.toThrow(/alpha\/SKILL\.md.*target_agents/s);
  });

  it("rejects unknown builtin skill frontmatter keys", async () => {
    const builtin = join(projectRoot, "unknown-frontmatter-key");
    makeFixtureBuiltinSkill(
      builtin,
      "alpha",
      [
        "name: alpha",
        "description: unknown key",
        "agentTypes: [coder]",
        "triggers: [agent:coder]",
        "target_agents: [coder]",
        "survive_compaction: false",
      ].join("\n"),
      "Alpha body.",
    );

    await expect(loadAllCandidates(projectRoot, builtin)).rejects.toThrow(/alpha\/SKILL\.md.*agentTypes/s);
  });

  it("walkBuiltinSkills picks up bundled SKILL.md", async () => {
    const cands = await loadAllCandidates(projectRoot, defaultBuiltinSkillsRoot());
    expect(skillNames(cands)).toEqual(["coding", "mcp-authoring", "research"]);

    for (const candidate of cands.filter((c) => c.origin === "builtin")) {
      expect(candidate.body.startsWith("---")).toBe(false);
      if (candidate.record.kind === "skill") {
        expect(candidate.record.target_agents.length).toBeGreaterThan(0);
        expect(candidate.record.triggers.every((trigger) => trigger.includes(":"))).toBe(true);
      }
    }
  });

  it("targets shipped builtin skills by role", async () => {
    const cands = await loadAllCandidates(projectRoot, defaultBuiltinSkillsRoot());
    const researcher = resolveEagerRecords({ agentRole: "researcher" }, cands);
    expect(researcher.ordinary.map((candidate) => (candidate.record as SkillRecord).name)).toEqual(["research"]);

    const coder = resolveEagerRecords({ agentRole: "coder" }, cands);
    expect(coder.ordinary.map((candidate) => (candidate.record as SkillRecord).name).sort()).toEqual([
      "coding",
      "mcp-authoring",
    ]);

    const planner = resolveEagerRecords({ agentRole: "planner" }, cands);
    expect(planner.ordinary).toHaveLength(0);
  });

  it("formatEagerBlock returns empty string when nothing resolves", () => {
    const res = resolveEagerRecords({ agentRole: "coder" }, []);
    expect(formatEagerBlock(res)).toBe("");
  });
});
