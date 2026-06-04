/**
 * WI-14 — Tests for §E.1 survivor reinjection and BaseAgent's generic
 * before-compaction hook seam.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { BaseAgent } from "./base.js";
import { PlannerAgent } from "./planner.js";
import type { AgentContext, AgentRole, InputChannel } from "./types.js";
import type { ChatRequest, ChatResponse, Message } from "../providers/types.js";
import { initProjectTree } from "../store/project.js";
import { createSkill } from "../knowledge/lifecycle.js";
import { makeTestStore } from "../knowledge/_testfixtures/store.js";
import { readDoc } from "../store/documents.js";
import { RuntimeStateSchema } from "../types.js";
import { RuntimeTracker, acquireRuntimeLock, type RuntimeLock } from "../runtime/recovery.js";
import { NoteManager } from "../runtime/notes.js";

class TestAgent extends BaseAgent {
  public getMessages(): Message[] {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (this as any).messages;
  }
  public async runCompaction(): Promise<void> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (this as any).compactWithReinjection();
  }
  public async runLoopForTest(): Promise<{ text: string; finishReason: string }> {
    return this.runLoop();
  }
  public getCompactionState() {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (this as any).compactionState as {
      compactionCount: number;
      summarizerFallbacks: number;
      consecutiveFallbacks: number;
      oversizedAtomicFallback: boolean;
    };
  }
  public seedMessage(msg: Message): void {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (this as any).pushMessage(msg);
  }
  public seedPendingRepairPrompt(prompt: string): void {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (this as any).conversation.setPendingRepairPrompt(prompt);
  }
}

class TestPlannerAgent extends PlannerAgent {
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
let runtimeLock: RuntimeLock | null;
beforeEach(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "wi14-"));
  await initProjectTree(tmpDir);
  runtimeLock = await acquireRuntimeLock(join(tmpDir, ".saivage"));
});
afterEach(() => {
  runtimeLock?.release();
  runtimeLock = null;
  rmSync(tmpDir, { recursive: true, force: true });
});

function makeContext(
  role: AgentRole,
  chat: (req: ChatRequest) => Promise<ChatResponse>,
  opts: { countTokens?: AgentContext["router"]["countTokens"]; contextWindow?: number } = {},
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
      getMaxContextTokens: () => opts.contextWindow ?? 100_000,
      countTokens: opts.countTokens ?? (() => 0),
      resetModelHealth: () => undefined,
    } as unknown as AgentContext["router"],
    mcpRuntime: {
      getAllTools: () => [],
      callTool: async () => ({ ok: true }),
    } as unknown as AgentContext["mcpRuntime"],
    noteManager: new NoteManager(join(saivageDir, "notes")),
    agentId: "wi14-1",
    role,
    stageId: "stage-wi14",
    modelSpec: "test/model",
  };
}

describe("BaseAgent compaction integration (WI-14)", () => {
  it("§E.1 — appends survivor reinjection block after compaction", async () => {
    const store = await makeTestStore(tmpDir);
    try {
      await createSkill(
        store,
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
    } finally {
      store.sidecar.close();
    }

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

  it("reinjects a pending repair prompt after compaction", async () => {
    const prompt = "Invalid final task response: repair with evidence.";
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
    agent.seedPendingRepairPrompt(prompt);

    await agent.runCompaction();

    expect(agent.getMessages().some((msg) => msg.role === "user" && msg.content === prompt)).toBe(true);
  });

  it("runs the configured before-compaction hook before compacting", async () => {
    let captured: number | "unset" = "unset";
    const agent = new TestAgent(
      makeContext("coder", async () => ({
        content: "no writes needed",
        toolCalls: [],
        finishReason: "end_turn",
        usage: { inputTokens: 0, outputTokens: 0 },
      })),
      {
        systemPrompt: "sys",
        beforeCompaction: async () => {
          captured = 0;
        },
      },
    );
    agent.seedMessage({ role: "user", content: "long history" });
    await agent.runCompaction();
    expect(captured).toBe(0);
  });

  it("PlannerAgent registers the planner pre-compaction memory hook", async () => {
    let captured: number | "unset" = "unset";
    const agent = new TestPlannerAgent(
      makeContext("planner", async () => ({
        content: "no writes needed",
        toolCalls: [],
        finishReason: "end_turn",
        usage: { inputTokens: 0, outputTokens: 0 },
      })),
      async () => ({ kind: "success", data: { ok: true } }),
      "initial planner message",
      "",
      {
        onCompactionHookComplete: (n) => {
          captured = n;
        },
      },
    );
    agent.seedMessage({ role: "user", content: "long history" });

    await agent.runCompaction();

    expect(captured).toBe(0);
  });

  it("skips before-compaction work when no hook is configured", async () => {
    const agent = new TestAgent(
      makeContext("coder", async () => ({
        content: "summary",
        toolCalls: [],
        finishReason: "end_turn",
        usage: { inputTokens: 0, outputTokens: 0 },
      })),
      { systemPrompt: "sys" },
    );
    agent.seedMessage({ role: "user", content: "history" });
    await agent.runCompaction();
    expect(agent.getMessages().some((msg) =>
      typeof msg.content === "string" && msg.content.includes("PRE-COMPACTION MEMORY HOOK"),
    )).toBe(false);
  });

  it("fallback compaction keeps complete tool rounds and records honest counters", async () => {
    const agent = new TestAgent(
      makeContext("coder", async () => {
        throw new Error("summarizer unavailable");
      }),
      { systemPrompt: "sys" },
    );
    agent.seedMessage({ role: "user", content: "older context" });
    agent.seedMessage({
      role: "assistant",
      content: [{ type: "tool_use", id: "tu-1", name: "read_file", input: {} }],
    });
    agent.seedMessage({
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "tu-1", content: "file content" }],
    });

    await agent.runCompaction();

    assertNoOrphans(agent.getMessages());
    expect(agent.getCompactionState()).toMatchObject({
      compactionCount: 0,
      summarizerFallbacks: 1,
      consecutiveFallbacks: 1,
      oversizedAtomicFallback: false,
    });
    expect(
      agent.getConversationSnapshot().some((entry) =>
        entry.kind === "model_repair" &&
        entry.content.includes("Summarizer fallback"),
      ),
    ).toBe(true);
  });

  it("writes compaction counters to runtime state", async () => {
    const statePath = join(tmpDir, ".saivage", "tmp", "state", "runtime.json");
    const tracker = new RuntimeTracker(statePath);
    tracker.agentStarted("wi14-1", "coder");

    const agent = new TestAgent(
      makeContext("coder", async () => {
        throw new Error("summarizer unavailable");
      }),
      {
        systemPrompt: "sys",
        onCompactionUpdate: tracker.agentCompactionUpdate.bind(tracker),
      },
    );
    agent.seedMessage({ role: "user", content: "history" });
    await agent.runCompaction();
    await tracker.waitForIdle();

    const state = await readDoc(statePath, RuntimeStateSchema);
    expect(state.active_agents[0]?.compaction?.summarizer_fallbacks).toBe(1);
  });

  it("returns max_compactions with a fallback-exhausted reason", async () => {
    const agent = new TestAgent(
      makeContext(
        "coder",
        async () => {
          throw new Error("summarizer unavailable");
        },
        {
          contextWindow: 2_000,
          countTokens: (_model, messages) => messages.length === 0 ? 10_000 : 10,
        },
      ),
      { systemPrompt: "sys" },
    );
    agent.seedMessage({ role: "user", content: "history" });

    await agent.runCompaction();
    await agent.runCompaction();
    await agent.runCompaction();

    const result = await agent.runLoopForTest();
    expect(result.finishReason).toBe("max_compactions");
    expect(result.text).toContain("summarizer fallback exhausted");
  });
});

function assertNoOrphans(messages: Message[]): void {
  const seen = new Set<string>();
  for (const message of messages) {
    if (!Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (block.type === "tool_use" && block.id) seen.add(block.id);
      if (block.type === "tool_result") {
        expect(seen.has(block.tool_use_id ?? "")).toBe(true);
      }
    }
  }
}

describe("BaseAgent input channels (F06)", () => {
  function makeChannel(messages: string[]): { channel: InputChannel; resets: number; drains: number } {
    const state = { resets: 0, drains: 0, channel: null as unknown as InputChannel };
    let i = 0;
    state.channel = {
      drain() {
        state.drains++;
        if (i >= messages.length) return null;
        return { message: messages[i++] };
      },
      onContextReset() {
        state.resets++;
        i = 0;
      },
    };
    return state as { channel: InputChannel; resets: number; drains: number };
  }

  it("onContextReset fires once after replaceMessages inside compactWithReinjection", async () => {
    const ch = makeChannel([]);
    const agent = new TestAgent(
      makeContext("coder", async () => ({
        content: "summary",
        toolCalls: [],
        finishReason: "end_turn",
        usage: { inputTokens: 0, outputTokens: 0 },
      })),
      { systemPrompt: "sys", inputChannels: [ch.channel] },
    );
    agent.seedMessage({ role: "user", content: "history" });
    await agent.runCompaction();
    expect(ch.resets).toBe(1);
  });

  it("onContextReset still fires after a before-compaction hook and compactConversation", async () => {
    let hookComplete = false;
    const ch = makeChannel([]);
    const agent = new TestAgent(
      makeContext("coder", async () => ({
        content: "summary",
        toolCalls: [],
        finishReason: "end_turn",
        usage: { inputTokens: 0, outputTokens: 0 },
      })),
      {
        systemPrompt: "sys",
        inputChannels: [ch.channel],
        beforeCompaction: async () => {
          hookComplete = true;
        },
      },
    );
    agent.seedMessage({ role: "user", content: "history" });
    await agent.runCompaction();
    expect(hookComplete).toBe(true);
    expect(ch.resets).toBe(1);
  });
});
