/**
 * Tests for the round-keyed conversation snapshot and activity status
 * produced by BaseAgent (see AgentsView Redesign Plan v3 §8.1).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { ensureDir } from "../store/documents.js";
import { BaseAgent } from "./base.js";
import type { AgentContext } from "./types.js";
import type { ChatRequest, ChatResponse, Message, ContentBlock } from "../providers/types.js";

class TestAgent extends BaseAgent {
  // Expose protected helpers to drive the snapshot from tests.
  public push(msg: Message, timestamp?: string): void {
    this.pushMessage(msg, timestamp);
  }
  public replace(msgs: Message[], timestamp?: string): void {
    this.replaceMessages(msgs, timestamp);
  }
  public diagnose(kind: Parameters<BaseAgent["addDiagnostic" extends keyof BaseAgent ? never : never]>[0] | string, content: string): void {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (this as any).addDiagnostic(kind, content);
  }
  public async run(): Promise<ChatResponse> {
    return this.callLLM();
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  protected override get transientCap(): number {
    return (this as any)._transientCap ?? 500;
  }
  public setTransientCap(n: number): void {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (this as any)._transientCap = n;
  }
}

let tmpDir: string;
beforeEach(() => { tmpDir = mkdtempSync(join(tmpdir(), "saivage-snap-")); });
afterEach(() => { rmSync(tmpDir, { recursive: true, force: true }); });

function makeContext(router: unknown): AgentContext {
  const saivageDir = join(tmpDir, ".saivage");
  ensureDir(saivageDir);
  ensureDir(join(saivageDir, "skills"));
  return {
    project: {
      projectRoot: tmpDir,
      saivageDir,
      config: {
        project_name: "snap-test",
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
        tools: join(saivageDir, "tools"),
        research: join(tmpDir, "research"),
        tmp: join(saivageDir, "tmp"),
        runtimeState: join(saivageDir, "tmp", "state", "runtime.json"),
        chats: join(saivageDir, "tmp", "chats"),
        inspectorWorkspace: join(saivageDir, "tmp", "inspector-workspace"),
        work: join(saivageDir, "tmp", "work"),
      },
    },
    router: router as AgentContext["router"],
    mcpRuntime: {
      getAllTools: () => [],
      callTool: async () => ({ ok: true }),
    } as unknown as AgentContext["mcpRuntime"],
    agentId: "snap-1",
    role: "reviewer",
    stageId: "stage-snap-1",
    modelSpec: "test/model",
  };
}

function stubRouter(chat: (req: ChatRequest) => Promise<ChatResponse>) {
  return {
    chat,
    getMaxContextTokens: () => 100_000,
    countTokens: () => 0,
    resetModelHealth: () => undefined,
  };
}

function makeAgent(chat: (req: ChatRequest) => Promise<ChatResponse>): TestAgent {
  return new TestAgent(makeContext(stubRouter(chat)), { systemPrompt: "sys" });
}

// Helper: collect assistant tool_use round ids by issuing a single tool round.
function blocks(...bs: ContentBlock[]): ContentBlock[] { return bs; }

describe("BaseAgent.getConversationSnapshot — round id assignment", () => {
  it("assigns the same roundId to assistant message and matching tool_result", () => {
    const agent = makeAgent(async () => ({ content: "", toolCalls: [], finishReason: "end_turn", usage: { inputTokens: 0, outputTokens: 0 } }));
    agent.push({ role: "user", content: "go" }, "2024-01-01T00:00:00.000Z");
    agent.push({
      role: "assistant",
      content: blocks(
        { type: "text", text: "Calling tool" },
        { type: "tool_use", id: "tu_1", name: "search", input: { q: "x" } },
      ),
    }, "2024-01-01T00:00:01.000Z");
    agent.push({
      role: "user",
      content: blocks({ type: "tool_result", tool_use_id: "tu_1", content: "found" }),
    }, "2024-01-01T00:00:02.000Z");

    const snap = agent.getConversationSnapshot();
    const call = snap.find((e) => e.kind === "tool_call");
    const result = snap.find((e) => e.kind === "tool_result");
    expect(call?.roundId).toBeDefined();
    expect(result?.roundId).toBe(call?.roundId);
  });

  it("tool_result lookup by toolUseId carries toolName and roundId", () => {
    const agent = makeAgent(async () => ({ content: "", toolCalls: [], finishReason: "end_turn", usage: { inputTokens: 0, outputTokens: 0 } }));
    agent.push({ role: "user", content: "go" }, "2024-01-01T00:00:00.000Z");
    agent.push({
      role: "assistant",
      content: blocks({ type: "tool_use", id: "tu_42", name: "fetch_url", input: {} }),
    }, "2024-01-01T00:00:01.000Z");
    agent.push({
      role: "user",
      content: blocks({ type: "tool_result", tool_use_id: "tu_42", content: "ok" }),
    }, "2024-01-01T00:00:02.000Z");

    const snap = agent.getConversationSnapshot();
    const result = snap.find((e) => e.kind === "tool_result");
    expect(result?.toolName).toBe("fetch_url");
    expect(result?.toolUseId).toBe("tu_42");
  });

  it("no entry carries a legacy `tool` field; only `toolName`/`toolUseId`", () => {
    const agent = makeAgent(async () => ({ content: "", toolCalls: [], finishReason: "end_turn", usage: { inputTokens: 0, outputTokens: 0 } }));
    agent.push({
      role: "assistant",
      content: blocks({ type: "tool_use", id: "tu_1", name: "x", input: {} }),
    }, "2024-01-01T00:00:00.000Z");
    agent.push({
      role: "user",
      content: blocks({ type: "tool_result", tool_use_id: "tu_1", content: "r" }),
    }, "2024-01-01T00:00:01.000Z");
    const snap = agent.getConversationSnapshot();
    for (const e of snap) {
      expect((e as unknown as { tool?: unknown }).tool).toBeUndefined();
    }
  });

  it("emits a synthetic activity lead when assistant has only tool_use blocks", () => {
    const agent = makeAgent(async () => ({ content: "", toolCalls: [], finishReason: "end_turn", usage: { inputTokens: 0, outputTokens: 0 } }));
    agent.push({ role: "user", content: "go" }, "2024-01-01T00:00:00.000Z");
    agent.push({
      role: "assistant",
      content: blocks(
        { type: "tool_use", id: "tu_a", name: "a", input: {} },
        { type: "tool_use", id: "tu_b", name: "b", input: {} },
      ),
    }, "2024-01-01T00:00:01.000Z");

    const snap = agent.getConversationSnapshot();
    const activity = snap.find((e) => e.kind === "activity");
    expect(activity).toBeDefined();
    expect(activity?.blockIndex).toBe(-1);
    expect(activity?.content).toContain("Using 2 tools");
  });

  it("orphan tool_result (no matching tool_use) still emits with inherited message roundId", () => {
    const agent = makeAgent(async () => ({ content: "", toolCalls: [], finishReason: "end_turn", usage: { inputTokens: 0, outputTokens: 0 } }));
    agent.push({
      role: "user",
      content: blocks({ type: "tool_result", tool_use_id: "tu_missing", content: "orphan" }),
    }, "2024-01-01T00:00:00.000Z");
    const snap = agent.getConversationSnapshot();
    const result = snap.find((e) => e.kind === "tool_result");
    expect(result).toBeDefined();
    expect(result?.toolName).toBeUndefined();
    expect(result?.roundId).toBe("r-msg:0");
  });

  it("two tool_use blocks with the same id (duplicate dispatch) share roundId and pair with first tool_result by id", () => {
    const agent = makeAgent(async () => ({ content: "", toolCalls: [], finishReason: "end_turn", usage: { inputTokens: 0, outputTokens: 0 } }));
    agent.push({
      role: "assistant",
      content: blocks(
        { type: "tool_use", id: "tu_dup", name: "search", input: { q: "a" } },
        { type: "tool_use", id: "tu_dup", name: "search", input: { q: "b" } },
      ),
    }, "2024-01-01T00:00:00.000Z");
    agent.push({
      role: "user",
      content: blocks({ type: "tool_result", tool_use_id: "tu_dup", content: "ok" }),
    }, "2024-01-01T00:00:01.000Z");

    const snap = agent.getConversationSnapshot();
    const calls = snap.filter((e) => e.kind === "tool_call");
    expect(calls).toHaveLength(2);
    expect(calls[0].roundId).toBe(calls[1].roundId);
    const result = snap.find((e) => e.kind === "tool_result");
    expect(result?.roundId).toBe(calls[0].roundId);
    expect(result?.toolName).toBe("search");
  });

  it("addDiagnostic with no pending round attaches to currentRoundId or r-pre", () => {
    const agent = makeAgent(async () => ({ content: "", toolCalls: [], finishReason: "end_turn", usage: { inputTokens: 0, outputTokens: 0 } }));
    agent.diagnose("model_issue", "before any round");
    const snap1 = agent.getConversationSnapshot();
    expect(snap1.find((e) => e.kind === "model_issue")?.roundId).toBe("r-pre");

    agent.push({ role: "assistant", content: "hi" }, "2024-01-01T00:00:00.000Z");
    agent.diagnose("model_issue", "after assistant msg");
    const snap2 = agent.getConversationSnapshot();
    const d = snap2.filter((e) => e.kind === "model_issue");
    // The most recent diagnostic should attach to the assistant's roundId.
    const assistantRound = snap2.find((e) => e.role === "assistant")?.roundId;
    expect(d[d.length - 1].roundId).toBe(assistantRound);
  });
});

describe("BaseAgent.getConversationSnapshot — compaction", () => {
  it("re-keys all messages after compaction with r-compacted-N", () => {
    const agent = makeAgent(async () => ({ content: "", toolCalls: [], finishReason: "end_turn", usage: { inputTokens: 0, outputTokens: 0 } }));
    agent.push({ role: "user", content: "u1" }, "2024-01-01T00:00:00.000Z");
    agent.push({ role: "assistant", content: "a1" }, "2024-01-01T00:00:01.000Z");

    agent.replace([
      { role: "user", content: "summary" },
      { role: "assistant", content: "ack" },
    ], "2024-01-01T00:01:00.000Z");

    const snap = agent.getConversationSnapshot();
    const rounds = new Set(snap.filter((e) => e.kind === "text").map((e) => e.roundId));
    expect([...rounds]).toEqual(["r-compacted-1"]);
  });

  it("diagnostic emitted before compaction keeps its roundId after compaction re-keys messages", () => {
    const agent = makeAgent(async () => ({ content: "", toolCalls: [], finishReason: "end_turn", usage: { inputTokens: 0, outputTokens: 0 } }));
    agent.push({ role: "assistant", content: "a1" }, "2024-01-01T00:00:01.000Z");
    const assistantRound = agent.getConversationSnapshot().find((e) => e.role === "assistant")!.roundId;
    agent.diagnose("model_issue", "pre-compact diag");

    agent.replace([{ role: "user", content: "summary" }], "2024-01-01T00:01:00.000Z");

    const snap = agent.getConversationSnapshot();
    const diag = snap.find((e) => e.kind === "model_issue");
    expect(diag?.roundId).toBe(assistantRound);
    expect(diag?.roundId).not.toBe("r-compacted-1");
  });

  it("assistant message pushed after compaction starts a fresh round id (not r-compacted-*)", () => {
    const agent = makeAgent(async () => ({ content: "", toolCalls: [], finishReason: "end_turn", usage: { inputTokens: 0, outputTokens: 0 } }));
    agent.push({ role: "assistant", content: "a1" }, "2024-01-01T00:00:00.000Z");
    agent.replace([{ role: "user", content: "summary" }], "2024-01-01T00:01:00.000Z");
    agent.push({ role: "assistant", content: "a2" }, "2024-01-01T00:02:00.000Z");

    const snap = agent.getConversationSnapshot();
    const assistantRounds = snap.filter((e) => e.role === "assistant" && e.kind === "text").map((e) => e.roundId);
    // The post-compaction assistant should not reuse r-compacted-1.
    const post = assistantRounds[assistantRounds.length - 1];
    expect(post).not.toBe("r-compacted-1");
    expect(post).toMatch(/^r-msg:\d+$/);
  });
});

describe("BaseAgent.callLLM — pending round + activity status", () => {
  it("clears pendingCall and pendingRoundId on success; getActivityStatus reflects null", async () => {
    const agent = makeAgent(async (): Promise<ChatResponse> => ({
      content: "ok",
      toolCalls: [],
      finishReason: "end_turn",
      usage: { inputTokens: 0, outputTokens: 0 },
    }));
    const result = await agent.run();
    expect(result.content).toBe("ok");
    expect(agent.getActivityStatus().pending_call).toBeNull();
  });

  it("diagnostic written during retry attaches to the pending round; cap exhaustion throws and clears pendingCall", async () => {
    vi.useFakeTimers();
    try {
      let attempts = 0;
      const chat = async (): Promise<ChatResponse> => {
        attempts++;
        throw new Error(`socket hang up #${attempts}`);
      };
      const agent = makeAgent(chat);
      agent.setTransientCap(2);

      const runPromise = agent.run().catch((e) => e);
      // Advance through one backoff sleep.
      await vi.advanceTimersByTimeAsync(31_000);
      await vi.advanceTimersByTimeAsync(46_000);
      const err = await runPromise;
      expect(err).toBeInstanceOf(Error);
      expect(String(err)).toContain("LLM call failed");

      // pendingCall should be cleared
      expect(agent.getActivityStatus().pending_call).toBeNull();

      // All diagnostics emitted during the failed round should share roundId r1.
      const snap = agent.getConversationSnapshot();
      const diags = snap.filter((e) => e.kind === "model_issue");
      expect(diags.length).toBeGreaterThanOrEqual(1);
      for (const d of diags) {
        expect(d.roundId).toBe("r1");
      }
    } finally {
      vi.useRealTimers();
    }
  });
});
