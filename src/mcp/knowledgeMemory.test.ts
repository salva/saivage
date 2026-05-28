import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { acquireRuntimeLock, type RuntimeLock } from "../runtime/recovery.js";
import { makeKnowledgeMemoryHandler } from "./knowledgeMemory.js";
import { makeTestStore } from "../knowledge/_testfixtures/store.js";
import { initProjectTree } from "../store/project.js";
import type { KnowledgeStore } from "../knowledge/init.js";
import type { InProcessToolHandler } from "./toolRuntime.js";
import type { ToolCallContext } from "./toolContext.js";

const roots: string[] = [];
const locks: RuntimeLock[] = [];
const stores: KnowledgeStore[] = [];

async function tmpProject(): Promise<{ root: string; handler: InProcessToolHandler }> {
  const root = mkdtempSync(join(tmpdir(), "saivage-mcp-mem-"));
  roots.push(root);
  await initProjectTree(root);
  locks.push(await acquireRuntimeLock(join(root, ".saivage")));
  const store = await makeTestStore(root);
  stores.push(store);
  return { root, handler: makeKnowledgeMemoryHandler(store) };
}

function ctxFor(role: ToolCallContext["role"], projectRoot: string, stageId?: string): ToolCallContext {
  return {
    role,
    agentId: "agent-" + role,
    projectRoot,
    ...(stageId ? { stageId } : {}),
  };
}

afterEach(() => {
  for (const store of stores.splice(0)) store.sidecar.close();
  for (const lock of locks.splice(0)) lock.release();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("MCP knowledgeMemory handler — permissions + scope (§F + Y†)", () => {
  it("rejects coder with scope='project' (UNAUTHORIZED_SCOPE)", async () => {
    const { root, handler } = await tmpProject();
    const r = await handler("create_memory", {
      topic: { domain: "build", subject: "x" }, body: "b",
      scope: "project", reason: "r",
    }, ctxFor("coder", root, "stage-1"));
    expect(r.isError).toBe(true);
    expect((r.content as { error: { code: string } }).error.code).toBe("UNAUTHORIZED_SCOPE");
  });

  it("allows coder with scope='stage' matching ctx.stageId", async () => {
    const { root, handler } = await tmpProject();
    const r = await handler("create_memory", {
      topic: { domain: "build", subject: "x" }, body: "b",
      scope: "stage", scope_ref: "stage-1", reason: "r",
    }, ctxFor("coder", root, "stage-1"));
    expect(r.isError).toBe(false);
  });

  it("rejects coder with mismatched scope_ref (UNAUTHORIZED_SCOPE)", async () => {
    const { root, handler } = await tmpProject();
    const r = await handler("create_memory", {
      topic: { domain: "build", subject: "x" }, body: "b",
      scope: "stage", scope_ref: "stage-2", reason: "r",
    }, ctxFor("coder", root, "stage-1"));
    expect(r.isError).toBe(true);
    expect((r.content as { error: { code: string } }).error.code).toBe("UNAUTHORIZED_SCOPE");
  });

  it("rejects coder supersede (workers cannot supersede)", async () => {
    const { root, handler } = await tmpProject();
    // First, planner writes a memory
    const created = await handler("create_memory", {
      topic: { domain: "x", subject: "y" }, body: "b",
      scope: "project", reason: "r",
    }, ctxFor("planner", root));
    expect(created.isError).toBe(false);
    const oldId = (created.content as { id: string }).id;

    const r = await handler("supersede_memory", {
      old_id: oldId,
      new_record: { topic: { domain: "x", subject: "y" }, body: "b2", scope: "project" },
      reason: "r2",
    }, ctxFor("coder", root, "stage-1"));
    expect(r.isError).toBe(true);
  });
});

describe("MCP knowledgeMemory handler — lifecycle", () => {
  it("rejects topic collision (TOPIC_COLLISION)", async () => {
    const { root, handler } = await tmpProject();
    const ctx = ctxFor("planner", root);
    await handler("create_memory", {
      topic: { domain: "d", subject: "s" }, body: "b1", scope: "project", reason: "r",
    }, ctx);
    const r = await handler("create_memory", {
      topic: { domain: "d", subject: "s" }, body: "b2", scope: "project", reason: "r",
    }, ctx);
    expect(r.isError).toBe(true);
    expect((r.content as { error: { code: string } }).error.code).toBe("TOPIC_COLLISION");
  });

  it("rejects double-supersede (INVALID_SUPERSEDE_TARGET)", async () => {
    const { root, handler } = await tmpProject();
    const ctx = ctxFor("manager", root);
    const c1 = await handler("create_memory", {
      topic: { domain: "a", subject: "b" }, body: "b1", scope: "project", reason: "r",
    }, ctx);
    const id1 = (c1.content as { id: string }).id;
    const s1 = await handler("supersede_memory", {
      old_id: id1,
      new_record: { topic: { domain: "a", subject: "b" }, body: "b2", scope: "project" },
      reason: "r2",
    }, ctx);
    expect(s1.isError).toBe(false);
    const s2 = await handler("supersede_memory", {
      old_id: id1,
      new_record: { topic: { domain: "a", subject: "b" }, body: "b3", scope: "project" },
      reason: "r3",
    }, ctx);
    expect(s2.isError).toBe(true);
    expect((s2.content as { error: { code: string } }).error.code).toBe("INVALID_SUPERSEDE_TARGET");
  });

  it("get_memory walks supersession chain to head", async () => {
    const { root, handler } = await tmpProject();
    const ctx = ctxFor("manager", root);
    const topic = { domain: "chain", subject: "test" };
    const c1 = await handler("create_memory", { topic, body: "v1", scope: "project", reason: "r" }, ctx);
    const id1 = (c1.content as { id: string }).id;
    await handler("supersede_memory", {
      old_id: id1,
      new_record: { topic, body: "v2", scope: "project" },
      reason: "r2",
    }, ctx);
    const got = await handler("get_memory", { topic }, ctx);
    expect(got.isError).toBe(false);
    expect((got.content as { body: string }).body).toBe("v2");
  });

  it("read returns NOT_FOUND for missing memory", async () => {
    const { root, handler } = await tmpProject();
    const r = await handler("get_memory", { id: "00000000-0000-4000-8000-000000000000" }, ctxFor("planner", root));
    expect(r.isError).toBe(true);
    expect((r.content as { error: { code: string } }).error.code).toBe("NOT_FOUND");
  });
});

describe("MCP knowledgeMemory handler — librarian topic guard (F03 B04)", () => {
  it.each(["policy", "secret-incidents", "drift-incidents"] as const)(
    "allows librarian to create_memory with topic rag/%s",
    async (subject) => {
      const { root, handler } = await tmpProject();
      const r = await handler(
        "create_memory",
        { topic: { domain: "rag", subject }, body: "b", scope: "project", reason: "r" },
        ctxFor("librarian", root),
      );
      expect(r.isError).toBe(false);
    },
  );

  it("rejects librarian create_memory with non-rag domain (UNAUTHORIZED_TOPIC)", async () => {
    const { root, handler } = await tmpProject();
    const r = await handler(
      "create_memory",
      { topic: { domain: "general", subject: "policy" }, body: "b", scope: "project", reason: "r" },
      ctxFor("librarian", root),
    );
    expect(r.isError).toBe(true);
    expect((r.content as { error: { code: string } }).error.code).toBe("UNAUTHORIZED_TOPIC");
  });

  it("rejects librarian create_memory with rag/<other> (UNAUTHORIZED_TOPIC)", async () => {
    const { root, handler } = await tmpProject();
    const r = await handler(
      "create_memory",
      { topic: { domain: "rag", subject: "other" }, body: "b", scope: "project", reason: "r" },
      ctxFor("librarian", root),
    );
    expect(r.isError).toBe(true);
    expect((r.content as { error: { code: string } }).error.code).toBe("UNAUTHORIZED_TOPIC");
  });

  it("rejects librarian create_memory at stage scope (UNAUTHORIZED_SCOPE)", async () => {
    const { root, handler } = await tmpProject();
    const r = await handler(
      "create_memory",
      {
        topic: { domain: "rag", subject: "policy" },
        body: "b",
        scope: "stage",
        scope_ref: "stage-1",
        reason: "r",
      },
      ctxFor("librarian", root, "stage-1"),
    );
    expect(r.isError).toBe(true);
    expect((r.content as { error: { code: string } }).error.code).toBe("UNAUTHORIZED_SCOPE");
  });

  it("non-librarian roles are unaffected by topic guard", async () => {
    const { root, handler } = await tmpProject();
    const r = await handler(
      "create_memory",
      { topic: { domain: "general", subject: "anything" }, body: "b", scope: "project", reason: "r" },
      ctxFor("planner", root),
    );
    expect(r.isError).toBe(false);
  });

  it("update_memory: librarian update on rag/policy is allowed", async () => {
    const { root, handler } = await tmpProject();
    const c = await handler(
      "create_memory",
      { topic: { domain: "rag", subject: "policy" }, body: "v1", scope: "project", reason: "r" },
      ctxFor("librarian", root),
    );
    expect(c.isError).toBe(false);
    const id = (c.content as { id: string }).id;
    const u = await handler(
      "update_memory",
      { id, body: "v2", reason: "r2" },
      ctxFor("librarian", root),
    );
    expect(u.isError).toBe(false);
  });

  it("update_memory: librarian update on non-allowed topic (created by planner) is rejected", async () => {
    const { root, handler } = await tmpProject();
    const c = await handler(
      "create_memory",
      { topic: { domain: "general", subject: "x" }, body: "v1", scope: "project", reason: "r" },
      ctxFor("planner", root),
    );
    expect(c.isError).toBe(false);
    const id = (c.content as { id: string }).id;
    const u = await handler(
      "update_memory",
      { id, body: "v2", reason: "r2" },
      ctxFor("librarian", root),
    );
    expect(u.isError).toBe(true);
    expect((u.content as { error: { code: string } }).error.code).toBe("UNAUTHORIZED_TOPIC");
  });
});

describe("MCP knowledgeMemory handler — update_memory worker scope regression (F03 B04)", () => {
  it("coder update_memory fails UNAUTHORIZED_SCOPE when prior.scope_ref != current stage", async () => {
    const { root, handler } = await tmpProject();
    // Coder creates a stage memory under stage-1
    const c = await handler(
      "create_memory",
      {
        topic: { domain: "build", subject: "x" },
        body: "v1",
        scope: "stage",
        scope_ref: "stage-1",
        reason: "r",
      },
      ctxFor("coder", root, "stage-1"),
    );
    expect(c.isError).toBe(false);
    const id = (c.content as { id: string }).id;

    // Switch to stage-2: update must be rejected since prior.scope_ref==stage-1.
    const u = await handler(
      "update_memory",
      { id, body: "v2", reason: "r2" },
      ctxFor("coder", root, "stage-2"),
    );
    expect(u.isError).toBe(true);
    expect((u.content as { error: { code: string } }).error.code).toBe("UNAUTHORIZED_SCOPE");
  });
});
