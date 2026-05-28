/**
 * F01 B06 — RAG-backed `searchMemories` tests.
 *
 * Verifies:
 *   1. Empty-id guard skips `ragManager.query`.
 *   2. Active+visibility post-filter drops archived / out-of-scope hits.
 *   3. Session-scoped records are visible only when `ctx.channelId` matches.
 *   4. RAG failure is mapped to `KNOWLEDGE_RAG_UNAVAILABLE`.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { initProjectTree } from "../store/project.js";
import { makeTestStore } from "./_testfixtures/store.js";
import { searchMemories, type SearchKnowledgeCtx } from "./lifecycle.js";
import type { KnowledgeStore } from "./init.js";
import { KnowledgeStoreError } from "./store.js";
import type { QueryHit } from "../rag/types.js";

const NOW = "2026-05-28T12:00:00.000Z";

function insertMemory(
  store: KnowledgeStore,
  args: {
    id: string;
    topic: { domain: string; subject: string; aspect?: string };
    scope: "project" | "stage" | "session";
    scope_ref?: string | null;
    status?: "active" | "archived";
    body?: string;
  },
): void {
  const scope_ref = args.scope_ref ?? null;
  const status = args.status ?? "active";
  const body = args.body ?? `body for ${args.id}`;
  const record = {
    id: args.id,
    kind: "memory",
    scope: args.scope,
    ...(scope_ref ? { scope_ref } : {}),
    status,
    created_at: NOW,
    updated_at: NOW,
    author_agent: { role: "manager", agent_id: "test" },
    topic: args.topic,
    keys: [],
    target_agents: [],
    origin: "project",
    relates_to: [],
    body,
    survive_compaction: false,
  };
  const topicLabel = args.topic.aspect
    ? `${args.topic.domain}/${args.topic.subject}/${args.topic.aspect}`
    : `${args.topic.domain}/${args.topic.subject}`;
  store.sidecar.db.prepare(
    `INSERT INTO record
       (id, kind, scope, scope_ref, status, origin, record_json, body,
        created_at, updated_at, supersedes, superseded_by, pending_reingest)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(args.id, "memory", args.scope, scope_ref, status, "project",
    JSON.stringify(record), body, NOW, NOW, null, null, 0);
  store.sidecar.db.prepare("INSERT INTO record_memory (id, topic) VALUES (?, ?)")
    .run(args.id, topicLabel);
}

function ragHit(recordId: string, score: number, text = "snippet"): QueryHit {
  return {
    chunkId: `${recordId}:0`,
    score,
    text,
    metadata: {
      path: `memory:${recordId}.md`,
      source: "memory",
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
  projectRoot = mkdtempSync(join(tmpdir(), "saivage-search-memories-"));
  await initProjectTree(projectRoot);
  store = await makeTestStore(projectRoot);
  querySpy = vi.fn();
  (store.ragManager as unknown as { query: typeof querySpy }).query = querySpy;
});

afterEach(() => {
  store.sidecar.close();
  rmSync(projectRoot, { recursive: true, force: true });
});

describe("searchMemories — RAG-backed", () => {
  it("empty-id guard: no active records → { hits: [] } and ragManager.query not called", async () => {
    querySpy.mockResolvedValue([]);
    const result = await searchMemories(store, { q: "anything" }, {});
    expect(result).toEqual({ hits: [] });
    expect(querySpy).not.toHaveBeenCalled();
  });

  it("filters hits by active status and scope visibility (project + matching stage)", async () => {
    const A = randomUUID(), B = randomUUID(), C = randomUUID(), D = randomUUID();
    insertMemory(store, { id: A, topic: { domain: "alpha", subject: "one" }, scope: "project" });
    insertMemory(store, { id: B, topic: { domain: "bravo", subject: "two" }, scope: "stage", scope_ref: "s1" });
    insertMemory(store, { id: C, topic: { domain: "charlie", subject: "three" }, scope: "project", status: "archived" });
    insertMemory(store, { id: D, topic: { domain: "delta", subject: "four" }, scope: "stage", scope_ref: "other" });

    querySpy.mockResolvedValue([
      ragHit(A, 0.9),
      ragHit(B, 0.8),
      ragHit(C, 0.7),
      ragHit(D, 0.6),
    ]);

    const ctx: SearchKnowledgeCtx = { stageId: "s1" };
    const result = await searchMemories(store, { q: "x" }, ctx);
    const ids = result.hits.map((h) => h.id);
    expect(ids).toEqual([A, B]);
    expect(result.hits[0]).toMatchObject({
      kind: "memory", scope: "project", title: "alpha/one",
    });
    expect(result.hits[1]).toMatchObject({
      kind: "memory", scope: "stage", scope_ref: "s1", title: "bravo/two",
    });
  });

  it("session-scoped memory is visible only when ctx.channelId matches", async () => {
    const SESS = randomUUID();
    insertMemory(store, {
      id: SESS,
      topic: { domain: "sess", subject: "scoped" },
      scope: "session",
      scope_ref: "ch1",
    });

    querySpy.mockResolvedValue([ragHit(SESS, 0.9)]);

    // Channel matches → visible
    const matched = await searchMemories(store, { q: "x" }, { channelId: "ch1" });
    expect(matched.hits.map((h) => h.id)).toEqual([SESS]);

    // Channel doesn't match → empty visible set → no ragManager.query call,
    // empty result
    querySpy.mockClear();
    const wrong = await searchMemories(store, { q: "x" }, { channelId: "ch2" });
    expect(wrong).toEqual({ hits: [] });
    expect(querySpy).not.toHaveBeenCalled();

    // No channelId → also empty visible set
    querySpy.mockClear();
    const none = await searchMemories(store, { q: "x" }, {});
    expect(none).toEqual({ hits: [] });
    expect(querySpy).not.toHaveBeenCalled();
  });

  it("emits 3-part title when topic.aspect is present", async () => {
    const A = randomUUID();
    insertMemory(store, {
      id: A,
      topic: { domain: "auth", subject: "login", aspect: "rate-limit" },
      scope: "project",
    });
    querySpy.mockResolvedValue([ragHit(A, 0.5)]);
    const result = await searchMemories(store, { q: "x" }, {});
    expect(result.hits[0]).toMatchObject({ title: "auth/login/rate-limit" });
  });

  it("passes filter.in.path containing only visible record paths", async () => {
    const A = randomUUID(), B = randomUUID(), D = randomUUID();
    insertMemory(store, { id: A, topic: { domain: "a", subject: "x" }, scope: "project" });
    insertMemory(store, { id: B, topic: { domain: "b", subject: "x" }, scope: "stage", scope_ref: "s1" });
    insertMemory(store, { id: D, topic: { domain: "d", subject: "x" }, scope: "stage", scope_ref: "other" });

    querySpy.mockResolvedValue([]);
    await searchMemories(store, { q: "x" }, { stageId: "s1" });

    expect(querySpy).toHaveBeenCalledTimes(1);
    const [datasetId, q, opts] = querySpy.mock.calls[0] as [
      string, string, { topK: number; filter: { in: { path: string[] } } },
    ];
    expect(datasetId).toBe("knowledge.memory");
    expect(q).toBe("x");
    expect(new Set(opts.filter.in.path)).toEqual(
      new Set([`memory:${A}.md`, `memory:${B}.md`]),
    );
  });

  it("maps a ragManager.query rejection to KNOWLEDGE_RAG_UNAVAILABLE", async () => {
    insertMemory(store, { id: randomUUID(), topic: { domain: "a", subject: "x" }, scope: "project" });
    querySpy.mockRejectedValue(new Error("vec store down"));
    try {
      await searchMemories(store, { q: "x" }, {});
      throw new Error("expected throw");
    } catch (e) {
      expect(e).toBeInstanceOf(KnowledgeStoreError);
      expect((e as KnowledgeStoreError).code).toBe("KNOWLEDGE_RAG_UNAVAILABLE");
      expect((e as KnowledgeStoreError).message).toContain("vec store down");
    }
  });
});
