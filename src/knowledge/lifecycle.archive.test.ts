import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createSkill,
  createMemory,
  archiveStage,
  archiveSession,
} from "./lifecycle.js";
import { initProjectTree } from "../store/project.js";
import type { AuthorAgent } from "./lifecycle.js";

const AUTHOR: AuthorAgent = { role: "coder", agent_id: "agent-test" };

describe("archiveStage / archiveSession (WI-11)", () => {
  let projectRoot: string;
  let saivage: string;

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), "wi11-"));
    initProjectTree(projectRoot);
    saivage = join(projectRoot, ".saivage");
  });
  afterEach(() => rmSync(projectRoot, { recursive: true, force: true }));

  it("moves active stage-scoped skill+memory into archive/ and updates status", () => {
    const skill = createSkill(
      saivage,
      {
        name: "stage-skill",
        description: "d",
        body: "# body",
        scope: "stage",
        scope_ref: "stage-1",
        reason: "test creating stage skill",
      },
      AUTHOR,
    );
    const mem = createMemory(
      saivage,
      {
        body: "stage memory body",
        topic: { domain: "d", subject: "s" },
        scope: "stage",
        scope_ref: "stage-1",
        reason: "test creating stage memory",
      },
      AUTHOR,
    );

    const res = archiveStage(projectRoot, "stage-1");
    expect(res.archivedSkills).toContain(skill.id);
    expect(res.archivedMemories).toContain(mem.id);

    // Records moved out of live records dir.
    const liveSkillRecords = join(saivage, "skills", "stages", "stage-1", "records");
    const liveMemRecords = join(saivage, "memory", "stages", "stage-1", "records");
    expect(existsSync(liveSkillRecords) ? readdirSync(liveSkillRecords) : []).toEqual([]);
    expect(existsSync(liveMemRecords) ? readdirSync(liveMemRecords) : []).toEqual([]);

    // Archived copy exists with status archived.
    const archivedJson = JSON.parse(
      readFileSync(
        join(saivage, "skills", "stages", "stage-1", "archive", "records", `${skill.id}.json`),
        "utf-8",
      ),
    );
    expect(archivedJson.status).toBe("archived");

    // Audit appended.
    const audit = readFileSync(
      join(saivage, "skills", "stages", "stage-1", "audit.jsonl"),
      "utf-8",
    );
    expect(audit).toContain('"op":"archive"');
    expect(audit).toContain(skill.id);
  });

  it("is idempotent: second invocation is a no-op", () => {
    createSkill(
      saivage,
      {
        name: "s2",
        description: "d",
        body: "b",
        scope: "stage",
        scope_ref: "s2",
        reason: "first create",
      },
      AUTHOR,
    );
    const first = archiveStage(projectRoot, "s2");
    expect(first.archivedSkills.length).toBe(1);
    const second = archiveStage(projectRoot, "s2");
    expect(second.archivedSkills).toEqual([]);
    expect(second.archivedMemories).toEqual([]);
  });

  it("archiveSession archives session-scoped records", () => {
    const skill = createSkill(
      saivage,
      {
        name: "sess-skill",
        description: "d",
        body: "b",
        scope: "session",
        scope_ref: "chan-1",
        reason: "create session skill",
      },
      AUTHOR,
    );
    const res = archiveSession(projectRoot, "chan-1");
    expect(res.archivedSkills).toContain(skill.id);
    const live = join(saivage, "skills", "sessions", "chan-1", "records");
    expect(existsSync(live) ? readdirSync(live) : []).toEqual([]);
  });

  it("non-existent scope dir is a clean no-op", () => {
    const res = archiveStage(projectRoot, "never-existed");
    expect(res).toEqual({ archivedSkills: [], archivedMemories: [] });
  });
});
