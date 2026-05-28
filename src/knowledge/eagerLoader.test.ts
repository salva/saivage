import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initProjectTree } from "../store/project.js";
import { acquireRuntimeLock, type RuntimeLock } from "../runtime/recovery.js";
import { createSkill, createMemory } from "./lifecycle.js";
import {
  loadAllCandidates,
  formatEagerBlock,
  buildEagerBlock,
} from "./eagerLoader.js";
import { resolveEagerRecords } from "./loader.js";
import { makeTestStore } from "./_testfixtures/store.js";
import type { KnowledgeStore } from "./init.js";

describe("eagerLoader (sidecar-backed)", () => {
  let projectRoot: string;
  let runtimeLock: RuntimeLock | null;
  let store: KnowledgeStore;

  beforeEach(async () => {
    projectRoot = mkdtempSync(join(tmpdir(), "eager-"));
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

  it("loads project-scope skills and memories from the sidecar", async () => {
    await createSkill(
      store,
      {
        name: "coder-skill",
        description: "trigger-matched skill",
        body: "# Coder skill body",
        scope: "project",
        triggers: ["coding"],
        target_agents: ["coder"],
        reason: "eagerLoader test create",
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
        reason: "eagerLoader test memory",
      },
      { role: "manager", agent_id: "test" },
    );

    const cands = await loadAllCandidates(projectRoot);
    expect(cands.some((c) => c.record.kind === "skill")).toBe(true);
    expect(cands.some((c) => c.record.kind === "memory")).toBe(true);
    for (const c of cands) {
      expect(c.origin).toBe("project");
    }
  });

  it("buildEagerBlock emits the §D.6 header and END marker", async () => {
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
        reason: "eagerLoader survivor seed",
      },
      { role: "manager", agent_id: "test" },
    );
    const block = await buildEagerBlock(projectRoot, "coder", "context", ["foo"]);
    expect(block).toContain("--- SAIVAGE KNOWLEDGE");
    expect(block).toContain("--- END SAIVAGE KNOWLEDGE ---");
    expect(block).toContain("--- SKILL: always-on (project) ---");
  });

  it("surfaces builtin-origin rows from the sidecar (no disk scan)", async () => {
    // Insert a builtin-origin skill row directly (mimics upsertBuiltinSkills).
    const now = new Date().toISOString();
    const id = "builtin:alpha";
    const record = {
      id,
      kind: "skill",
      scope: "project",
      status: "active",
      origin: "builtin",
      created_at: now,
      updated_at: now,
      author_agent: { role: "manager", agent_id: "system" },
      name: "alpha",
      description: "first builtin",
      triggers: ["agent:coder"],
      target_agents: ["coder"],
      survive_compaction: false,
      relates_to: [],
    };
    store.sidecar.db.prepare(
      `INSERT INTO record
         (id, kind, scope, scope_ref, status, origin, record_json, body,
          created_at, updated_at, supersedes, superseded_by, pending_reingest)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(id, "skill", "project", null, "active", "builtin", JSON.stringify(record),
          "Alpha body.", now, now, null, null, 0);
    store.sidecar.db.prepare("INSERT INTO record_skill (id, name) VALUES (?, ?)").run(id, "alpha");

    const cands = await loadAllCandidates(projectRoot);
    const builtin = cands.find((c) => c.origin === "builtin");
    expect(builtin).toBeDefined();
    expect(builtin?.body).toBe("Alpha body.");
    expect(builtin?.record.kind).toBe("skill");
  });

  it("formatEagerBlock returns empty string when nothing resolves", () => {
    const res = resolveEagerRecords({ agentRole: "coder" }, []);
    expect(formatEagerBlock(res)).toBe("");
  });
});
