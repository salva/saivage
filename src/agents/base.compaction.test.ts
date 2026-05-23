/**
 * WI-14 — Tests for §E.1 survivor reinjection and §E.2 Planner
 * pre-compaction memory-write hook wired into BaseAgent.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { BaseAgent } from "./base.js";
import type { AgentContext, AgentRole } from "./types.js";
import type { ChatRequest, ChatResponse, Message } from "../providers/types.js";
import { initProjectTree } from "../store/project.js";
import { createSkill } from "../knowledge/lifecycle.js";

class TestAgent extends BaseAgent {
  public getMessages(): Message[] {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (this as any).messages;
  }
  public async runCompaction(): Promise<void> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (this as any).compactWithReinjection();
  }
  public seedMessage(msg: Message): void {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (this as any).pushMessage(msg);
  }
}

let tmpDir: string;
beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "wi14-"));
  initProjectTree(tmpDir);
});
afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function makeContext(
  role: AgentRole,
  chat: (req: ChatRequest) => Promise<ChatResponse>,
): AgentContext {
  const saivageDir = join(tmpDir, ".saivage");
  return {
    project: {
      projectRoot: tmpDir,
      saivageDir,
      config: {
        project_name: "wi14",
        objectives: ["test"],
        provider: "test",
        notifications: { channels: [], filters: { min_severity: "info", categories: [] } },
        skills: { max_per_agent: 5 },
      },
      paths: {
        plan: join(saivageDir, "plan.json"),
        planHistory: join(saivageDir, "plan-history.json"),
        stages: join(saivageDir, "stages"),
        notes: join(saivageDir, "notes"),
        inspections: join(saivageDir, "inspections"),
        skills: join(saivageDir, "skills"),
        memory: join(saivageDir, "memory"),
        tools: join(saivageDir, "tools"),
        research: join(tmpDir, "research"),
        tmp: join(saivageDir, "tmp"),
        runtimeState: join(saivageDir, "tmp", "state", "runtime.json"),
        chats: join(saivageDir, "tmp", "chats"),
        inspectorWorkspace: join(saivageDir, "tmp", "inspector-workspace"),
        work: join(saivageDir, "tmp", "work"),
      },
    },
    router: {
      chat,
      getMaxContextTokens: () => 100_000,
      resetModelHealth: () => undefined,
    } as unknown as AgentContext["router"],
    mcpRuntime: {
      getAllTools: () => [],
      callTool: async () => ({ ok: true }),
    } as unknown as AgentContext["mcpRuntime"],
    agentId: "wi14-1",
    role,
    stageId: "stage-wi14",
    modelSpec: "test/model",
  };
}

describe("BaseAgent compaction integration (WI-14)", () => {
  it("§E.1 — appends survivor reinjection block after compaction", async () => {
    createSkill(
      join(tmpDir, ".saivage"),
      {
        name: "always-on-survivor",
        description: "must survive compaction",
        body: "Always-on body",
        scope: "project",
        triggers: ["coding"],
        target_agents: ["coder"],
        survive_compaction: true,
        reason: "wi-14 survivor seed",
      },
      { role: "manager", agent_id: "test" },
    );

    const agent = new TestAgent(
      makeContext("coder", async () => ({
        content: "summary text",
        toolCalls: [],
        finishReason: "end_turn",
        usage: { inputTokens: 0, outputTokens: 0 },
      })),
      { systemPrompt: "sys" },
    );
    agent.seedMessage({ role: "user", content: "long history" });
    await agent.runCompaction();

    const msgs = agent.getMessages();
    const survivor = msgs.find(
      (m) =>
        typeof m.content === "string" &&
        m.content.includes("SURVIVING KNOWLEDGE") &&
        m.content.includes("always-on-survivor"),
    );
    expect(survivor).toBeDefined();
  });

  it("§E.2 — Planner pre-compaction hook fires onCompactionHookComplete with writeCount=0 when no tool calls", async () => {
    let captured: number | "unset" = "unset";
    const agent = new TestAgent(
      makeContext("planner", async () => ({
        content: "no writes needed",
        toolCalls: [],
        finishReason: "end_turn",
        usage: { inputTokens: 0, outputTokens: 0 },
      })),
      {
        systemPrompt: "sys",
        onCompactionHookComplete: (n) => {
          captured = n;
        },
      },
    );
    agent.seedMessage({ role: "user", content: "long history" });
    await agent.runCompaction();
    expect(captured).toBe(0);
  });

  it("§E.2 — Hook is skipped for non-planner roles", async () => {
    let called = false;
    const agent = new TestAgent(
      makeContext("coder", async () => ({
        content: "summary",
        toolCalls: [],
        finishReason: "end_turn",
        usage: { inputTokens: 0, outputTokens: 0 },
      })),
      {
        systemPrompt: "sys",
        onCompactionHookComplete: () => {
          called = true;
        },
      },
    );
    agent.seedMessage({ role: "user", content: "history" });
    await agent.runCompaction();
    expect(called).toBe(false);
  });
});
