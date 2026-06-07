import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { acquireRuntimeLock, type RuntimeLock } from "../runtime/recovery.js";
import { makeKnowledgeSkillsHandler } from "./knowledgeSkills.js";
import { makeTestStore } from "../knowledge/_testfixtures/store.js";
import { initProjectTree } from "../store/project.js";
import type { KnowledgeStore } from "../knowledge/init.js";
import { createSkill } from "../knowledge/lifecycle.js";
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
    const r = await handler("skill", {}, undefined);
    expect(r.isError).toBe(true);
    expect((r.content as { error: { code: string } }).error.code).toBe("UNAUTHORIZED_ROLE");
  });

  it("allows coder read access", async () => {
    const { root, handler } = await tmpProject();
    const r = await handler("skill", {}, ctxFor("coder", root));
    expect(r.isError).toBe(false);
  });

  it("allows data_agent read access", async () => {
    const { root, handler } = await tmpProject();
    const r = await handler("skill", {}, ctxFor("data_agent", root));
    expect(r.isError).toBe(false);
  });

  it("allows manager read access", async () => {
    const { root, handler } = await tmpProject();
    const r = await handler("skill", {}, ctxFor("manager", root));
    expect(r.isError).toBe(false);
  });
});

describe("MCP knowledgeSkills handler — lifecycle + redaction", () => {
  it("lists available skills", async () => {
    const { root, handler } = await tmpProject();
    const store = stores.at(-1)!;
    await createSkill(store, {
      name: "deploy-prod", description: "deploy steps", body: "kubectl apply",
      scope: "project", reason: "doc",
    }, { role: "manager", agent_id: "agent-manager" });

    const r = await handler("skill", {}, ctxFor("planner", root));
    expect(r.isError).toBe(false);
    const skills = (r.content as { skills: Array<{ name: string }> }).skills;
    expect(skills.map((s) => s.name)).toContain("deploy-prod");
  });

  it("reads a skill by name", async () => {
    const { root, handler } = await tmpProject();
    const store = stores.at(-1)!;
    await createSkill(store, {
      name: "redact-test", description: "d", body: "Plain body, no secrets.",
      scope: "project", reason: "r",
    }, { role: "manager", agent_id: "agent-manager" });
    const read = await handler("skill", { name: "redact-test" }, ctxFor("manager", root));
    expect(read.isError).toBe(false);
    const c = read.content as { body: string; redacted_spans: number };
    expect(c.body).toBe("Plain body, no secrets.");
    expect(c.redacted_spans).toBe(0);
  });

  it("returns NOT_FOUND for an unknown skill name", async () => {
    const { root, handler } = await tmpProject();
    const r = await handler("skill", { name: "missing" }, ctxFor("manager", root));
    expect(r.isError).toBe(true);
    expect((r.content as { error: { code: string } }).error.code).toBe("NOT_FOUND");
  });
});
