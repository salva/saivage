/**
 * Archive lifecycle on the SQLite sidecar (F01 B04 variant of WI-11).
 *
 * `archiveStage` / `archiveSession` open the sidecar themselves (they
 * are invoked from the chat/plan layer with just the projectRoot) and
 * still gate on the runtime lock. After they run, the affected
 * `(scope, scope_ref)` records should be flipped to `status='archived'`
 * with a matching audit entry; idempotent re-invocations should be a
 * no-op.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createSkill,
  createMemory,
  archiveStage,
  archiveSession,
  type AuthorAgent,
} from "./lifecycle.js";
import { initProjectTree } from "../store/project.js";
import { acquireRuntimeLock, type RuntimeLock } from "../runtime/recovery.js";
import { makeTestStore } from "./_testfixtures/store.js";
import type { KnowledgeStore } from "./init.js";
import { getRecord, activeRecordsByScope } from "./sidecar-queries.js";

const AUTHOR: AuthorAgent = { role: "coder", agent_id: "agent-test" };

describe("archiveStage / archiveSession (WI-11, sidecar)", () => {
  let projectRoot: string;
  let saivage: string;
  let runtimeLock: RuntimeLock | null;
  let store: KnowledgeStore;

  beforeEach(async () => {
    projectRoot = mkdtempSync(join(tmpdir(), "wi11-"));
    await initProjectTree(projectRoot);
    saivage = join(projectRoot, ".saivage");
    runtimeLock = await acquireRuntimeLock(saivage);
    store = await makeTestStore(projectRoot);
  });
  afterEach(() => {
    store?.sidecar.close();
    runtimeLock?.release();
    runtimeLock = null;
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it("archiveStage requires the runtime lock", async () => {
    runtimeLock?.release();
    runtimeLock = null;
    await expect(archiveStage(projectRoot, "stage-1")).rejects.toMatchObject({ code: "NO_RUNTIME_LOCK" });
  });

  it("archiveSession requires the runtime lock", async () => {
    runtimeLock?.release();
    runtimeLock = null;
    await expect(archiveSession(projectRoot, "chan-1")).rejects.toMatchObject({ code: "NO_RUNTIME_LOCK" });
  });

  it("flips active stage-scoped skill+memory to archived in the sidecar", async () => {
    const skill = await createSkill(
      store,
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
    const mem = await createMemory(
      store,
      {
        body: "stage memory body",
        topic: { domain: "d", subject: "s" },
        scope: "stage",
        scope_ref: "stage-1",
        reason: "test creating stage memory",
      },
      AUTHOR,
    );

    // archiveStage opens its own sidecar; close ours first so SQLite
    // doesn't trip the WAL writer.
    store.sidecar.close();
    const res = await archiveStage(projectRoot, "stage-1");
    store = await makeTestStore(projectRoot);

    expect(res.archivedSkills).toContain(skill.id);
    expect(res.archivedMemories).toContain(mem.id);

    expect(activeRecordsByScope(store.sidecar, "skill", "stage", "stage-1")).toEqual([]);
    expect(activeRecordsByScope(store.sidecar, "memory", "stage", "stage-1")).toEqual([]);
    expect(getRecord(store.sidecar, skill.id)?.status).toBe("archived");
    expect(getRecord(store.sidecar, mem.id)?.status).toBe("archived");

    const auditOps = store.sidecar.db
      .prepare("SELECT op FROM audit WHERE record_id = ? ORDER BY ts ASC")
      .all(skill.id) as { op: string }[];
    expect(auditOps.map((r) => r.op)).toContain("archive");
  });

  it("is idempotent: second invocation is a no-op", async () => {
    await createSkill(
      store,
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
    store.sidecar.close();
    const first = await archiveStage(projectRoot, "s2");
    expect(first.archivedSkills.length).toBe(1);
    const second = await archiveStage(projectRoot, "s2");
    expect(second.archivedSkills).toEqual([]);
    expect(second.archivedMemories).toEqual([]);
    store = await makeTestStore(projectRoot);
  });

  it("archiveSession archives session-scoped records", async () => {
    const skill = await createSkill(
      store,
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
    store.sidecar.close();
    const res = await archiveSession(projectRoot, "chan-1");
    store = await makeTestStore(projectRoot);
    expect(res.archivedSkills).toContain(skill.id);
    expect(activeRecordsByScope(store.sidecar, "skill", "session", "chan-1")).toEqual([]);
  });

  it("non-existent scope dir is a clean no-op", async () => {
    const res = await archiveStage(projectRoot, "never-existed");
    expect(res).toEqual({ archivedSkills: [], archivedMemories: [] });
  });
});
