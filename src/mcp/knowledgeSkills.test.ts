import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { acquireRuntimeLock, type RuntimeLock } from "../runtime/recovery.js";
import { makeKnowledgeSkillsHandler } from "./knowledgeSkills.js";
import { makeTestStore } from "../knowledge/_testfixtures/store.js";
import { initProjectTree } from "../store/project.js";
import type { KnowledgeStore } from "../knowledge/init.js";
import type { InProcessToolHandler } from "./toolRuntime.js";
import type { ToolCallContext } from "./toolContext.js";

const roots: string[] = [];
const locks: RuntimeLock[] = [];
const stores: KnowledgeStore[] = [];

async function tmpProject(): Promise<{ root: string; handler: InProcessToolHandler }> {
  const root = mkdtempSync(join(tmpdir(), "saivage-mcp-skills-"));
  roots.push(root);
  await initProjectTree(root);
  locks.push(await acquireRuntimeLock(join(root, ".saivage")));
  const store = await makeTestStore(root);
  stores.push(store);
  return { root, handler: makeKnowledgeSkillsHandler(store) };
}

function ctxFor(role: ToolCallContext["role"], projectRoot: string): ToolCallContext {
  return { role, agentId: "agent-" + role, projectRoot };
}

afterEach(() => {
  for (const store of stores.splice(0)) store.sidecar.close();
  for (const lock of locks.splice(0)) lock.release();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("MCP knowledgeSkills handler — permissions (§F)", () => {
  it("requires a ToolCallContext", async () => {
    const { handler } = await tmpProject();
    const r = await handler("list_skills", {}, undefined);
    expect(r.isError).toBe(true);
    expect((r.content as { error: { code: string } }).error.code).toBe("UNAUTHORIZED_ROLE");
  });

  it("rejects worker create_skill (coder)", async () => {
    const { root, handler } = await tmpProject();
    const r = await handler("create_skill", {
      name: "x", description: "d", body: "b", scope: "project", reason: "test",
    }, ctxFor("coder", root));
    expect(r.isError).toBe(true);
    expect((r.content as { error: { code: string } }).error.code).toBe("UNAUTHORIZED_ROLE");
  });

  it("rejects data_agent any write", async () => {
    const { root, handler } = await tmpProject();
    const r = await handler("create_skill", {
      name: "x", description: "d", body: "b", scope: "project", reason: "test",
    }, ctxFor("data_agent", root));
    expect(r.isError).toBe(true);
  });

  it("allows manager create_skill", async () => {
    const { root, handler } = await tmpProject();
    const r = await handler("create_skill", {
      name: "build-web", description: "How to build", body: "Run npm build",
      scope: "project", reason: "initial",
    }, ctxFor("manager", root));
    expect(r.isError).toBe(false);
  });
});

describe("MCP knowledgeSkills handler — lifecycle + redaction", () => {
  it("create + search round-trip with triggerless skill", async () => {
    const { root, handler } = await tmpProject();
    const created = await handler("create_skill", {
      name: "deploy-prod", description: "deploy steps", body: "kubectl apply",
      scope: "project", reason: "doc",
    }, ctxFor("manager", root));
    expect(created.isError).toBe(false);

    const search = await handler("search_skills", { query: "deploy" }, ctxFor("planner", root));
    expect(search.isError).toBe(false);
    const hits = (search.content as { hits: Array<unknown> }).hits;
    expect(hits.length).toBeGreaterThanOrEqual(1);
  });

  it("rejects empty reason (EMPTY_REASON)", async () => {
    const { root, handler } = await tmpProject();
    const r = await handler("create_skill", {
      name: "x", description: "d", body: "b", scope: "project", reason: "   ",
    }, ctxFor("manager", root));
    expect(r.isError).toBe(true);
    expect((r.content as { error: { code: string } }).error.code).toBe("EMPTY_REASON");
  });

  it("rejects active name collision (NAME_COLLISION)", async () => {
    const { root, handler } = await tmpProject();
    const ctx = ctxFor("manager", root);
    await handler("create_skill", { name: "dup", description: "a", body: "b1", scope: "project", reason: "r" }, ctx);
    const r = await handler("create_skill", { name: "dup", description: "a", body: "b2", scope: "project", reason: "r" }, ctx);
    expect(r.isError).toBe(true);
    expect((r.content as { error: { code: string } }).error.code).toBe("NAME_COLLISION");
  });

  it("rejects invalid supersede scope (project→stage)", async () => {
    const { root, handler } = await tmpProject();
    const ctx = ctxFor("manager", root);
    const created = await handler("create_skill", {
      name: "s1", description: "d", body: "b", scope: "project", reason: "r",
    }, ctx);
    const oldId = (created.content as { id: string }).id;

    const r = await handler("supersede_skill", {
      old_id: oldId,
      new_record: { name: "s1", description: "d", body: "b2", scope: "stage", scope_ref: "stage-x" },
      reason: "r2",
    }, ctx);
    expect(r.isError).toBe(true);
    expect((r.content as { error: { code: string } }).error.code).toBe("INVALID_SUPERSEDE_SCOPE");
  });

  it("redacts on read (round-trip)", async () => {
    const { root, handler } = await tmpProject();
    const ctx = ctxFor("manager", root);
    const created = await handler("create_skill", {
      name: "redact-test", description: "d", body: "Plain body, no secrets.",
      scope: "project", reason: "r",
    }, ctx);
    expect(created.isError).toBe(false);
    const id = (created.content as { id: string }).id;
    const read = await handler("read_skill", { id }, ctx);
    expect(read.isError).toBe(false);
    const c = read.content as { body: string; redacted_spans: number };
    expect(c.body).toBe("Plain body, no secrets.");
    expect(c.redacted_spans).toBe(0);
  });
});
