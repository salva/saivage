/**
 * F01 B06 — RAG-backed `searchSkills` tests.
 *
 * Verifies:
 *   1. Empty-id guard skips `ragManager.query`.
 *   2. Active+visibility post-filter drops archived / out-of-scope hits.
 *   3. RAG failure is mapped to `KNOWLEDGE_RAG_UNAVAILABLE`.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { initProjectTree } from "../store/project.js";
import { makeTestStore } from "./_testfixtures/store.js";
import { searchSkills, type SearchKnowledgeCtx } from "./lifecycle.js";
import type { KnowledgeStore } from "./init.js";
import { KnowledgeStoreError } from "./store.js";
import type { QueryHit } from "../rag/types.js";

const NOW = "2026-05-28T12:00:00.000Z";

function insertSkill(
  store: KnowledgeStore,
  args: {
    id: string;
    name: string;
    scope: "project" | "stage" | "session";
    scope_ref?: string | null;
    status?: "active" | "archived";
    body?: string;
  },
): void {
  const scope_ref = args.scope_ref ?? null;
  const status = args.status ?? "active";
  const body = args.body ?? `body for ${args.name}`;
  const record = {
    id: args.id,
    kind: "skill",
    scope: args.scope,
    ...(scope_ref ? { scope_ref } : {}),
    status,
    created_at: NOW,
    updated_at: NOW,
    author_agent: { role: "manager", agent_id: "test" },
    name: args.name,
    description: `desc ${args.name}`,
    triggers: [],
    target_agents: [],
    origin: "project",
    relates_to: [],
    survive_compaction: false,
  };
  store.sidecar.db.prepare(
    `INSERT INTO record
       (id, kind, scope, scope_ref, status, origin, record_json, body,
        created_at, updated_at, supersedes, superseded_by, pending_reingest)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(args.id, "skill", args.scope, scope_ref, status, "project",
    JSON.stringify(record), body, NOW, NOW, null, null, 0);
  store.sidecar.db.prepare("INSERT INTO record_skill (id, name) VALUES (?, ?)")
    .run(args.id, args.name);
}

function ragHit(recordId: string, score: number, text = "snippet"): QueryHit {
  return {
    chunkId: `${recordId}:0`,
    score,
    text,
    metadata: {
      path: `skill:${recordId}.md`,
      source: "skill",
      chunkIndex: 0,
      contentHash: "h",
      sourceHash: "h",
      mtimeMs: 0,
    },
  };
}

let projectRoot: string;
let store: KnowledgeStore;
let querySpy: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  projectRoot = mkdtempSync(join(tmpdir(), "saivage-search-skills-"));
  await initProjectTree(projectRoot);
  store = await makeTestStore(projectRoot);
  querySpy = vi.fn();
  (store.ragManager as unknown as { query: typeof querySpy }).query = querySpy;
});

afterEach(() => {
  store.sidecar.close();
  rmSync(projectRoot, { recursive: true, force: true });
});

describe("searchSkills — RAG-backed", () => {
  it("empty-id guard: no active records → { hits: [] } and ragManager.query not called", async () => {
    querySpy.mockResolvedValue([]);
    const result = await searchSkills(store, { q: "anything" }, {});
    expect(result).toEqual({ hits: [] });
    expect(querySpy).not.toHaveBeenCalled();
  });

  it("filters hits by active status (archived dropped) and active scope visibility", async () => {
    const A = randomUUID(), B = randomUUID(), C = randomUUID(), D = randomUUID();
    insertSkill(store, { id: A, name: "alpha", scope: "project" });
    insertSkill(store, { id: B, name: "bravo", scope: "stage", scope_ref: "s1" });
    insertSkill(store, { id: C, name: "charlie", scope: "project", status: "archived" });
    // D is in a stage other than s1 — not visible
    insertSkill(store, { id: D, name: "delta", scope: "stage", scope_ref: "other" });

    querySpy.mockResolvedValue([
      ragHit(A, 0.9, "a body"),
      ragHit(B, 0.8, "b body"),
      ragHit(C, 0.7, "c body"),
      ragHit(D, 0.6, "d body"),
    ]);

    const ctx: SearchKnowledgeCtx = { stageId: "s1" };
    const result = await searchSkills(store, { q: "x" }, ctx);
    const ids = result.hits.map((h) => h.id);
    expect(ids).toEqual([A, B]);
    expect(result.hits[0]).toMatchObject({ kind: "skill", scope: "project", title: "alpha" });
    expect(result.hits[1]).toMatchObject({ kind: "skill", scope: "stage", scope_ref: "s1", title: "bravo" });
  });

  it("passes filter.in.path containing only visible record paths", async () => {
    const A = randomUUID(), B = randomUUID(), D = randomUUID();
    insertSkill(store, { id: A, name: "alpha", scope: "project" });
    insertSkill(store, { id: B, name: "bravo", scope: "stage", scope_ref: "s1" });
    insertSkill(store, { id: D, name: "delta", scope: "stage", scope_ref: "other" });

    querySpy.mockResolvedValue([]);
    await searchSkills(store, { q: "x" }, { stageId: "s1" });

    expect(querySpy).toHaveBeenCalledTimes(1);
    const [datasetId, q, opts] = querySpy.mock.calls[0] as [
      string, string, { topK: number; filter: { in: { path: string[] } } },
    ];
    expect(datasetId).toBe("knowledge.skills");
    expect(q).toBe("x");
    expect(new Set(opts.filter.in.path)).toEqual(
      new Set([`skill:${A}.md`, `skill:${B}.md`]),
    );
  });

  it("clamps topK into [1, 50]", async () => {
    insertSkill(store, { id: randomUUID(), name: "alpha", scope: "project" });
    querySpy.mockResolvedValue([]);

    await searchSkills(store, { q: "x", topK: 1000 }, {});
    expect((querySpy.mock.calls[0] as [string, string, { topK: number }])[2].topK).toBe(50);

    await searchSkills(store, { q: "x", topK: 0 }, {});
    expect((querySpy.mock.calls[1] as [string, string, { topK: number }])[2].topK).toBe(1);

    await searchSkills(store, { q: "x" }, {});
    expect((querySpy.mock.calls[2] as [string, string, { topK: number }])[2].topK).toBe(8);
  });

  it("maps a ragManager.query rejection to KNOWLEDGE_RAG_UNAVAILABLE", async () => {
    insertSkill(store, { id: randomUUID(), name: "alpha", scope: "project" });
    querySpy.mockRejectedValue(new Error("vec store down"));
    await expect(searchSkills(store, { q: "x" }, {})).rejects.toMatchObject({
      code: "KNOWLEDGE_RAG_UNAVAILABLE",
    });
  });

  it("KnowledgeStoreError carries the underlying message", async () => {
    insertSkill(store, { id: randomUUID(), name: "alpha", scope: "project" });
    querySpy.mockRejectedValue(new Error("oops"));
    try {
      await searchSkills(store, { q: "x" }, {});
      throw new Error("expected throw");
    } catch (e) {
      expect(e).toBeInstanceOf(KnowledgeStoreError);
      expect((e as KnowledgeStoreError).message).toContain("oops");
    }
  });
});
