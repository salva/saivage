/**
 * F01 B08 — End-to-end knowledge store coverage.
 *
 * Exercises the full skill and memory lifecycles, RAG-backed search
 * round-trip, builtin presence + idempotency, recovery of a
 * `pending_reingest` row via `runBootDivergenceSweep`, and the
 * MCP `update_memory` worker-scope preflight.
 *
 * Stays at the `KnowledgeStore` level: no full server bootstrap. We use
 * `initKnowledgeStore` with a fake `RagManager` for boot-side
 * scenarios, and `makeTestStore` for lifecycle/search/permission
 * scenarios.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { initKnowledgeStore } from "./init.js";
import { makeTestStore } from "./_testfixtures/store.js";
import {
  archiveMemory,
  archiveSkill,
  createMemory,
  createSkill,
  getMemory,
  listSkills,
  readSkillById,
  searchSkills,
  updateMemory,
  updateSkill,
  type AuthorAgent,
} from "./lifecycle.js";
import { upsertBuiltinSkills } from "./builtins.js";
import { runBootDivergenceSweep } from "./recovery.js";
import { initProjectTree } from "../store/project.js";
import { acquireRuntimeLock, type RuntimeLock } from "../runtime/recovery.js";
import { makeKnowledgeMemoryHandler } from "../mcp/knowledgeMemory.js";
import type { ToolCallContext } from "../mcp/toolContext.js";
import type { RagManager } from "../rag/index.js";
import type { QueryHit } from "../rag/types.js";

const MGR_AUTHOR: AuthorAgent = { role: "manager", agent_id: "agent-mgr" };
const CODER_AUTHOR: AuthorAgent = { role: "coder", agent_id: "agent-coder" };

interface IngestCall { id: string; n: number }

function fakeRagWithCalls(): { mgr: RagManager; calls: IngestCall[] } {
  const calls: IngestCall[] = [];
  const mgr = {
    enabled: true,
    async list() { return []; },
    async get() { throw new Error("not used"); },
    async register() { throw new Error("not used"); },
    async ingest(id: string, input: { kind: string; items?: unknown[] }) {
      calls.push({ id, n: input.items?.length ?? 0 });
      return {
        filesScanned: 0, filesChanged: 0, chunksUpserted: 0, chunksDeleted: 0,
        chunksDroppedSecrets: 0, tokensEmbedded: 0, embeddingMs: 0, storeMs: 0,
      };
    },
    async query() { return []; },
    async stats() { throw new Error("not used"); },
    async drop() { /* no-op */ },
    async close() { /* no-op */ },
  } as unknown as RagManager;
  return { mgr, calls };
}

let projectRoot: string;
let runtimeLock: RuntimeLock | null = null;

beforeEach(async () => {
  projectRoot = mkdtempSync(join(tmpdir(), "kn-e2e-"));
  await initProjectTree(projectRoot);
  runtimeLock = await acquireRuntimeLock(join(projectRoot, ".saivage"));
});

afterEach(() => {
  runtimeLock?.release();
  runtimeLock = null;
  rmSync(projectRoot, { recursive: true, force: true });
});

describe("F01 B08 — skill lifecycle (sidecar)", () => {
  it("create → read → update → archive → list filter behaviour", async () => {
    const store = await makeTestStore(projectRoot);
    try {
      const { id } = await createSkill(store, {
        name: "build-web", description: "build", body: "npm build",
        scope: "project", reason: "init",
      }, MGR_AUTHOR);

      const read1 = await readSkillById(store, id);
      expect(read1.record.name).toBe("build-web");
      expect(read1.record.status).toBe("active");

      await updateSkill(store, { id, description: "build v2", reason: "doc" }, MGR_AUTHOR);
      const read2 = await readSkillById(store, id);
      expect(read2.record.description).toBe("build v2");

      await archiveSkill(store, id, "obsolete", MGR_AUTHOR);
      const read3 = await readSkillById(store, id);
      expect(read3.record.status).toBe("archived");

      const listed = await listSkills(store);
      expect(listed.find((s) => s.id === id)).toBeUndefined();

      const listedAll = await listSkills(store, { include_archived: true });
      expect(listedAll.find((s) => s.id === id)?.status).toBe("archived");
    } finally {
      store.sidecar.close();
    }
  });
});

describe("F01 B08 — memory lifecycle (sidecar)", () => {
  it("create → get → update → archive → get returns null", async () => {
    const store = await makeTestStore(projectRoot);
    try {
      const { id } = await createMemory(store, {
        topic: { domain: "build", subject: "web" }, body: "v1 memo",
        scope: "project", reason: "init",
      }, MGR_AUTHOR);

      const got1 = await getMemory(store, { id });
      expect(got1?.body).toBe("v1 memo");

      await updateMemory(store, { id, body: "v2 memo", reason: "amend" }, MGR_AUTHOR);
      const got2 = await getMemory(store, { id });
      expect(got2?.body).toBe("v2 memo");

      await archiveMemory(store, id, "stale", MGR_AUTHOR);
      const got3 = await getMemory(store, { id });
      expect(got3).toBeNull();
    } finally {
      store.sidecar.close();
    }
  });
});

describe("F01 B08 — search round-trip with stubbed RAG hits", () => {
  it("filters [A,B,C] hits down to the project-scoped one when ctx has no stageId/channelId", async () => {
    const store = await makeTestStore(projectRoot);
    try {
      const A = await createSkill(store, {
        name: "alpha", description: "d", body: "alpha body",
        scope: "project", reason: "r",
      }, MGR_AUTHOR);
      const B = await createSkill(store, {
        name: "bravo", description: "d", body: "bravo body",
        scope: "stage", scope_ref: "stg-1", reason: "r",
      }, MGR_AUTHOR);
      const C = await createSkill(store, {
        name: "charlie", description: "d", body: "charlie body",
        scope: "session", scope_ref: "chan-1", reason: "r",
      }, MGR_AUTHOR);

      const hits: QueryHit[] = [A, B, C].map(({ id }, i) => ({
        chunkId: `${id}:0`,
        score: 0.9 - i * 0.1,
        text: `snippet ${id}`,
        metadata: {
          path: `skill:${id}.md`,
          source: "skill",
          chunkIndex: 0,
          contentHash: "h",
          sourceHash: "h",
          mtimeMs: 0,
        },
      }));
      const querySpy = vi.fn().mockResolvedValue(hits);
      (store.ragManager as unknown as { query: typeof querySpy }).query = querySpy;

      const res = await searchSkills(store, { q: "anything" }, {});
      expect(res.hits.map((h) => h.id)).toEqual([A.id]);
      expect(res.hits[0]).toMatchObject({ title: "alpha", scope: "project" });
    } finally {
      store.sidecar.close();
    }
  });
});

describe("F01 B08 — built-in skills", () => {
  it("initKnowledgeStore persists the 3 bundled origin='builtin' skills", async () => {
    const { mgr } = fakeRagWithCalls();
    const store = await initKnowledgeStore({
      projectRoot, ragManager: mgr, ragDatasets: [], ragEnabled: true,
    });
    try {
      const builtinRows = store.sidecar.db
        .prepare("SELECT id FROM record WHERE kind='skill' AND origin='builtin'")
        .all() as Array<{ id: string }>;
      expect(builtinRows.length).toBe(3);
      const listed = await listSkills(store);
      expect(listed.length).toBeGreaterThanOrEqual(3);
    } finally {
      store.sidecar.close();
    }
  });

  it("upsertBuiltinSkills is idempotent (no duplicate records on repeated calls)", async () => {
    const { mgr } = fakeRagWithCalls();
    const store = await initKnowledgeStore({
      projectRoot, ragManager: mgr, ragDatasets: [], ragEnabled: true,
    });
    try {
      const countBuiltins = () => (store.sidecar.db
        .prepare("SELECT COUNT(*) AS c FROM record WHERE kind='skill' AND origin='builtin'")
        .get() as { c: number }).c;
      const before = countBuiltins();
      await upsertBuiltinSkills(store);
      await upsertBuiltinSkills(store);
      expect(countBuiltins()).toBe(before);
    } finally {
      store.sidecar.close();
    }
  });
});

describe("F01 B08 — recovery via runBootDivergenceSweep", () => {
  it("re-ingests skill kind after a simulated pre-reingest crash (pending_reingest=1)", async () => {
    // Phase 1: boot once and exercise createSkill so the projectRoot is a
    // healthy sidecar with builtin + project rows.
    const phase1 = fakeRagWithCalls();
    const store1 = await initKnowledgeStore({
      projectRoot, ragManager: phase1.mgr, ragDatasets: [], ragEnabled: true,
    });
    await createSkill(store1, {
      name: "phase1", description: "d", body: "b",
      scope: "project", reason: "init",
    }, MGR_AUTHOR);
    store1.sidecar.close();

    // Phase 2: reopen, then inject a row with pending_reingest=1 to simulate
    // "row committed, RAG reingest never ran". Sweep must re-publish 'skill'.
    const phase2 = fakeRagWithCalls();
    const store2 = await initKnowledgeStore({
      projectRoot, ragManager: phase2.mgr, ragDatasets: [], ragEnabled: true,
    });
    const now = new Date().toISOString();
    store2.sidecar.db.prepare(
      "INSERT INTO record (id, kind, scope, status, origin, record_json, body, " +
        "created_at, updated_at, pending_reingest) VALUES (?,?,?,?,?,?,?,?,?,?)",
    ).run("crash-row", "skill", "project", "active", "project", "{}", "b", now, now, 1);

    phase2.calls.length = 0;
    await runBootDivergenceSweep(store2);

    const skillIngests = phase2.calls.filter((c) => c.id === "knowledge.skills");
    expect(skillIngests.length).toBeGreaterThanOrEqual(1);
    const row = store2.sidecar.db
      .prepare("SELECT pending_reingest FROM record WHERE id = 'crash-row'")
      .get() as { pending_reingest: number };
    expect(row.pending_reingest).toBe(0);
    store2.sidecar.close();
  });
});

describe("F01 B08 — update_memory scope preflight via MCP handler", () => {
  it("rejects coder update_memory when ctx.stageId differs from the record's scope_ref", async () => {
    const store = await makeTestStore(projectRoot);
    try {
      const { id } = await createMemory(store, {
        topic: { domain: "d", subject: "s" }, body: "stage-A body",
        scope: "stage", scope_ref: "stg-A", reason: "r",
      }, CODER_AUTHOR);

      const handler = makeKnowledgeMemoryHandler(store);
      const ctx: ToolCallContext = {
        role: "coder", agentId: "agent-coder", projectRoot, stageId: "stg-B",
      };
      const res = await handler("update_memory", {
        id, body: "new body", reason: "amend",
      }, ctx);
      expect(res.isError).toBe(true);
      const code = (res.content as { error: { code: string } }).error.code;
      expect(code).toBe("UNAUTHORIZED_SCOPE");
    } finally {
      store.sidecar.close();
    }
  });
});
