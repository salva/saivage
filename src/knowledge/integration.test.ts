/**
 * Saivage — Knowledge MCP integration tests (M5 / WI-18, F01 B04 variant).
 *
 * Exercises tool round-trips through the real `McpRuntime.callTool(...)`
 * entry path. Asserts §C.3 error taxonomy and §F permission matrix at
 * the runtime boundary, not the handler boundary.
 *
 * Post-F01 B04: the error taxonomy lost BODY_PATH_BROKEN /
 * MALFORMED_AUDIT_LINE / INDEX_REBUILD_FAILED (all rooted in the old
 * on-disk JSON tree). `body_path` is no longer a field on any record.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { McpRuntime } from "../mcp/runtime.js";
import { knowledgeSkillsTools, makeKnowledgeSkillsHandler } from "../mcp/knowledgeSkills.js";
import { knowledgeMemoryTools, makeKnowledgeMemoryHandler } from "../mcp/knowledgeMemory.js";
import type { ToolCallContext } from "../mcp/toolContext.js";
import { initProjectTree } from "../store/project.js";
import { acquireRuntimeLock, type RuntimeLock } from "../runtime/recovery.js";
import { makeTestStore } from "./_testfixtures/store.js";
import type { KnowledgeStore } from "./init.js";
import type { KnowledgeAgentRole } from "./types.js";

function makeRuntime(store: KnowledgeStore): McpRuntime {
  const rt = new McpRuntime({
    runtime: {
      maxServices: 10,
      restartOnCrash: false,
      continuousImprovement: false,
      healthCheckIntervalMs: 0,
      idleShutdownMs: 0,
    },
    mcp: {
      shellTimeoutMs: 4 * 60 * 60 * 1000,
      shellTimeoutFloorMs: 10 * 60 * 1000,
      inProcessTimeoutMs: 300_000,
      maxOutputBytes: 100 * 1024,
      maxFetchChars: 200_000,
      maxDownloadBytes: 250 * 1024 * 1024,
      maxFileReadBytes: 200_000,
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any);
  rt.registerInProcess("skills", knowledgeSkillsTools, makeKnowledgeSkillsHandler(store));
  rt.registerInProcess("memory", knowledgeMemoryTools, makeKnowledgeMemoryHandler(store));
  return rt;
}

function ctxFor(role: KnowledgeAgentRole, projectRoot: string, stageId?: string): ToolCallContext {
  return {
    role,
    agentId: "agent-" + role,
    projectRoot,
    ...(stageId ? { stageId } : {}),
  };
}

function errorCodeOf(err: unknown): string | null {
  if (!(err instanceof Error)) return null;
  const m = /returned error:\s+(.+)$/.exec(err.message);
  if (!m) return null;
  try {
    const obj = JSON.parse(m[1]) as { error?: { code?: string } };
    return obj.error?.code ?? null;
  } catch {
    return null;
  }
}

async function callExpectingError(
  rt: McpRuntime,
  service: "skills" | "memory",
  tool: string,
  args: Record<string, unknown>,
  ctx: ToolCallContext | undefined,
): Promise<string | null> {
  try {
    await rt.callTool(service, tool, args, ctx);
    return null;
  } catch (err) {
    return errorCodeOf(err);
  }
}

let projectRoot: string;
let rt: McpRuntime;
let runtimeLock: RuntimeLock | null;
let store: KnowledgeStore;

beforeEach(async () => {
  projectRoot = mkdtempSync(join(tmpdir(), "saivage-int-"));
  await initProjectTree(projectRoot);
  runtimeLock = await acquireRuntimeLock(join(projectRoot, ".saivage"));
  store = await makeTestStore(projectRoot);
  rt = makeRuntime(store);
});
afterEach(() => {
  store?.sidecar.close();
  runtimeLock?.release();
  runtimeLock = null;
  rmSync(projectRoot, { recursive: true, force: true });
});

describe("MCP integration — runtime gates UNAUTHORIZED_ROLE per denied cell (§F)", () => {
  type Cell = { role: KnowledgeAgentRole; service: "skills" | "memory"; tool: string; args: Record<string, unknown> };

  const DENIED: Cell[] = [
    { role: "planner", service: "skills", tool: "create_skill", args: { name: "x", description: "d", body: "b", scope: "project", reason: "r" } },
    { role: "coder", service: "skills", tool: "create_skill", args: { name: "x", description: "d", body: "b", scope: "project", reason: "r" } },
    { role: "researcher", service: "skills", tool: "create_skill", args: { name: "x", description: "d", body: "b", scope: "project", reason: "r" } },
    { role: "designer", service: "skills", tool: "create_skill", args: { name: "x", description: "d", body: "b", scope: "project", reason: "r" } },
    { role: "reviewer", service: "memory", tool: "create_memory", args: { topic: { domain: "d", subject: "s" }, body: "b", scope: "project", reason: "r" } },
    { role: "chat", service: "memory", tool: "create_memory", args: { topic: { domain: "d", subject: "s" }, body: "b", scope: "project", reason: "r" } },
    { role: "data_agent", service: "memory", tool: "list_memories", args: {} },
    { role: "coder", service: "skills", tool: "supersede_skill", args: { old_id: "x", new_record: {}, reason: "r" } },
    { role: "researcher", service: "memory", tool: "archive_memory", args: { id: "x", reason: "r" } },
  ];

  for (const cell of DENIED) {
    it("denies " + cell.role + " → " + cell.service + "/" + cell.tool, async () => {
      const code = await callExpectingError(rt, cell.service, cell.tool, cell.args, ctxFor(cell.role, projectRoot, "stg-1"));
      expect(code).toBe("UNAUTHORIZED_ROLE");
    });
  }

  it("requires a ToolCallContext (no ctx → UNAUTHORIZED_ROLE)", async () => {
    const code = await callExpectingError(rt, "skills", "list_skills", {}, undefined);
    expect(code).toBe("UNAUTHORIZED_ROLE");
  });
});

describe("MCP integration — all 16 tools round-trip through runtime", () => {
  it("Manager + Inspector cover skill+memory CRUDS plus reads", async () => {
    const mgr = ctxFor("manager", projectRoot);
    const insp = ctxFor("inspector", projectRoot);

    const s1 = (await rt.callTool("skills", "create_skill", {
      name: "deploy-web", description: "deploy", body: "kubectl apply", scope: "project", reason: "init",
    }, mgr)) as { id: string };
    expect(s1.id).toBeTruthy();

    const s1u = (await rt.callTool("skills", "update_skill", {
      id: s1.id, description: "updated", reason: "doc",
    }, mgr)) as { updated_at: string };
    expect(s1u.updated_at).toBeTruthy();

    const s2 = (await rt.callTool("skills", "supersede_skill", {
      old_id: s1.id,
      new_record: { name: "deploy-web", description: "v2", body: "kubectl rollout", scope: "project" },
      reason: "v2",
    }, mgr)) as { new_id: string; old_id: string };
    expect(s2.new_id).toBeTruthy();
    expect(s2.old_id).toBe(s1.id);

    const s3 = (await rt.callTool("skills", "create_skill", {
      name: "to-archive", description: "x", body: "b", scope: "project", reason: "init",
    }, mgr)) as { id: string };
    await rt.callTool("skills", "archive_skill", { id: s3.id, reason: "obsolete" }, mgr);

    await rt.callTool("skills", "delete_skill", { id: s3.id, reason: "purge" }, insp);

    const sl = (await rt.callTool("skills", "list_skills", {}, mgr)) as { skills: unknown[] };
    expect(Array.isArray(sl.skills)).toBe(true);

    const sr = (await rt.callTool("skills", "read_skill", { id: s2.new_id }, mgr)) as { body: string };
    expect(sr.body).toContain("rollout");

    const ss = (await rt.callTool("skills", "search_skills", { query: "deploy" }, mgr)) as { hits: unknown[] };
    expect(Array.isArray(ss.hits)).toBe(true);

    const m1 = (await rt.callTool("memory", "create_memory", {
      topic: { domain: "build", subject: "web" }, body: "build memo", scope: "project", reason: "init",
    }, mgr)) as { id: string };
    expect(m1.id).toBeTruthy();

    const m1u = (await rt.callTool("memory", "update_memory", {
      id: m1.id, body: "updated memo", reason: "amend",
    }, mgr)) as { updated_at: string };
    expect(m1u.updated_at).toBeTruthy();

    const m2 = (await rt.callTool("memory", "supersede_memory", {
      old_id: m1.id,
      new_record: { topic: { domain: "build", subject: "web" }, body: "v2 memo", scope: "project" },
      reason: "v2",
    }, mgr)) as { new_id: string };
    expect(m2.new_id).toBeTruthy();

    const m3 = (await rt.callTool("memory", "create_memory", {
      topic: { domain: "ops", subject: "alert" }, body: "ops memo", scope: "project", reason: "seed",
    }, mgr)) as { id: string };
    await rt.callTool("memory", "archive_memory", { id: m3.id, reason: "stale" }, insp);

    const m4 = (await rt.callTool("memory", "create_memory", {
      topic: { domain: "ops", subject: "metric" }, body: "metric memo", scope: "project", reason: "seed",
    }, mgr)) as { id: string };
    await rt.callTool("memory", "delete_memory", { id: m4.id, reason: "purge" }, insp);

    const ml = (await rt.callTool("memory", "list_memories", {}, mgr)) as { memories: unknown[] };
    expect(Array.isArray(ml.memories)).toBe(true);

    const mg = (await rt.callTool("memory", "get_memory", { id: m2.new_id }, mgr)) as { body: string };
    expect(mg.body).toContain("v2");

    const msr = (await rt.callTool("memory", "search_memories", { query: "memo" }, mgr)) as { hits: unknown[] };
    expect(Array.isArray(msr.hits)).toBe(true);
  });
});

describe("MCP integration — §C.3 error taxonomy", () => {
  it("UNAUTHORIZED_ROLE — denied via runtime", async () => {
    const code = await callExpectingError(rt, "skills", "create_skill", {
      name: "x", description: "d", body: "b", scope: "project", reason: "r",
    }, ctxFor("coder", projectRoot, "stg-1"));
    expect(code).toBe("UNAUTHORIZED_ROLE");
  });

  it("UNAUTHORIZED_SCOPE — worker writes project scope", async () => {
    const code = await callExpectingError(rt, "memory", "create_memory", {
      topic: { domain: "d", subject: "s" }, body: "b", scope: "project", reason: "r",
    }, ctxFor("coder", projectRoot, "stg-1"));
    expect(code).toBe("UNAUTHORIZED_SCOPE");
  });

  it("NOT_FOUND — get_memory unknown id", async () => {
    const code = await callExpectingError(rt, "memory", "get_memory", {
      id: "00000000-0000-4000-8000-000000000000",
    }, ctxFor("planner", projectRoot));
    expect(code).toBe("NOT_FOUND");
  });

  it("EMPTY_REASON — create_skill whitespace reason", async () => {
    const code = await callExpectingError(rt, "skills", "create_skill", {
      name: "x", description: "d", body: "b", scope: "project", reason: "   ",
    }, ctxFor("manager", projectRoot));
    expect(code).toBe("EMPTY_REASON");
  });

  it("NO_RUNTIME_LOCK — writer called without runtime ownership", async () => {
    runtimeLock?.release();
    runtimeLock = null;
    const code = await callExpectingError(rt, "memory", "create_memory", {
      topic: { domain: "d", subject: "s" }, body: "b", scope: "project", reason: "r",
    }, ctxFor("manager", projectRoot));
    expect(code).toBe("NO_RUNTIME_LOCK");
  });

  it("INVALID_SCOPE_REF — scope=stage without scope_ref", async () => {
    const code = await callExpectingError(rt, "memory", "create_memory", {
      topic: { domain: "d", subject: "s" }, body: "b", scope: "stage", reason: "r",
    }, ctxFor("manager", projectRoot));
    expect(code).toBe("INVALID_SCOPE_REF");
  });

  it("INVALID_SUPERSEDE_TARGET — supersede a non-active record", async () => {
    const mgr = ctxFor("manager", projectRoot);
    const c1 = (await rt.callTool("memory", "create_memory", {
      topic: { domain: "a", subject: "b" }, body: "v1", scope: "project", reason: "r",
    }, mgr)) as { id: string };
    await rt.callTool("memory", "supersede_memory", {
      old_id: c1.id,
      new_record: { topic: { domain: "a", subject: "b" }, body: "v2", scope: "project" },
      reason: "r2",
    }, mgr);
    const code = await callExpectingError(rt, "memory", "supersede_memory", {
      old_id: c1.id,
      new_record: { topic: { domain: "a", subject: "b" }, body: "v3", scope: "project" },
      reason: "r3",
    }, mgr);
    expect(code).toBe("INVALID_SUPERSEDE_TARGET");
  });

  it("TOPIC_COLLISION — duplicate active memory topic", async () => {
    const mgr = ctxFor("manager", projectRoot);
    await rt.callTool("memory", "create_memory", {
      topic: { domain: "d", subject: "s" }, body: "b1", scope: "project", reason: "r",
    }, mgr);
    const code = await callExpectingError(rt, "memory", "create_memory", {
      topic: { domain: "d", subject: "s" }, body: "b2", scope: "project", reason: "r",
    }, mgr);
    expect(code).toBe("TOPIC_COLLISION");
  });

  it("NAME_COLLISION — duplicate active skill name", async () => {
    const mgr = ctxFor("manager", projectRoot);
    await rt.callTool("skills", "create_skill", {
      name: "dup", description: "d", body: "b1", scope: "project", reason: "r",
    }, mgr);
    const code = await callExpectingError(rt, "skills", "create_skill", {
      name: "dup", description: "d", body: "b2", scope: "project", reason: "r",
    }, mgr);
    expect(code).toBe("NAME_COLLISION");
  });

  it("INVALID_SUPERSEDE_SCOPE — project → stage forbidden", async () => {
    const mgr = ctxFor("manager", projectRoot);
    const c = (await rt.callTool("skills", "create_skill", {
      name: "scope-test", description: "d", body: "b", scope: "project", reason: "r",
    }, mgr)) as { id: string };
    const code = await callExpectingError(rt, "skills", "supersede_skill", {
      old_id: c.id,
      new_record: { name: "scope-test", description: "d", body: "b2", scope: "stage", scope_ref: "stg-1" },
      reason: "r2",
    }, mgr);
    expect(code).toBe("INVALID_SUPERSEDE_SCOPE");
  });

  it("SECRET_DETECTED — write body contains an API-key shape", async () => {
    const code = await callExpectingError(rt, "skills", "create_skill", {
      name: "leaky", description: "d",
      body: "secret token sk-AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHHIIIIJJJJKKKKLLLL",
      scope: "project", reason: "r",
    }, ctxFor("manager", projectRoot));
    expect(code).toBe("SECRET_DETECTED");
  });
});

describe("MCP integration — legacy memory/index stub names are unreachable", () => {
  it("memory.memory_create — no such tool on memory service", async () => {
    const code = await callExpectingError(rt, "memory", "memory_create", {}, ctxFor("manager", projectRoot));
    expect(code).toBe("UNKNOWN_TOOL");
  });

  it("memory.memory_get — no such tool on memory service", async () => {
    const code = await callExpectingError(rt, "memory", "memory_get", {}, ctxFor("manager", projectRoot));
    expect(code).toBe("UNKNOWN_TOOL");
  });

  it("memory.memory_search — no such tool on memory service", async () => {
    const code = await callExpectingError(rt, "memory", "memory_search", {}, ctxFor("manager", projectRoot));
    expect(code).toBe("UNKNOWN_TOOL");
  });
});
