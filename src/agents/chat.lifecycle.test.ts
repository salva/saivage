/**
 * F23 — chat lifecycle: cancel() closes the channel, run() resolves, and the
 * server/telegram-style IIFE wrappers remove registry/session entries.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { ChatAgent } from "./chat.js";
import { EventBus } from "../events/bus.js";
import { ensureDir } from "../store/documents.js";
import type { ChatChannel } from "../channels/types.js";
import type { WsOutbound } from "../channels/ws-schema.js";
import type { AgentContext } from "./types.js";
import type { BaseAgent } from "./base.js";
import type { ChatRequest, ChatResponse } from "../providers/types.js";
import { NoteManager } from "../runtime/notes.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "saivage-chat-lifecycle-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

class FakeChannel implements ChatChannel {
  closed = false;
  private closeHandler?: () => void;

  send(_message: string): void {
    // no-op
  }

  sendEvent(_event: WsOutbound): void {
    // no-op
  }

  onMessage(_handler: (message: string) => void | Promise<void>): void {
    // no-op
  }

  onClose(handler: () => void): void {
    this.closeHandler = handler;
    if (this.closed) handler();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.closeHandler?.();
  }
}

function makeContext(root: string): AgentContext {
  const saivageDir = join(root, ".saivage");
  ensureDir(saivageDir);
  ensureDir(join(saivageDir, "skills"));
  const router = {
    getMaxContextTokens: () => 200_000,
    countTokens: () => 0,
    chat: async (_req: ChatRequest): Promise<ChatResponse> => ({
      content: "",
      toolCalls: [],
      finishReason: "end_turn",
      usage: { inputTokens: 0, outputTokens: 0 },
    }),
  };
  return {
    project: {
      projectRoot: root,
      saivageDir,
      config: {
        project_name: "test",
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
        tools: join(saivageDir, "tools"),
        research: join(root, "research"),
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
    } as AgentContext["mcpRuntime"],
    noteManager: new NoteManager(join(saivageDir, "notes")),
    agentId: "chat-1",
    role: "chat",
    stageId: undefined,
    channelId: "web",
    sessionId: "session-test-1",
    modelSpec: "test/model",
  };
}

describe("ChatAgent lifecycle (F23)", () => {
  it("closes the channel and resolves run() when cancel() is called", async () => {
    const channel = new FakeChannel();
    const ctx = makeContext(tmpDir);
    const agent = new ChatAgent(
      ctx,
      { channel: "web", sessionId: "session-test-1" },
      channel,
      new EventBus(),
    );
    const runPromise = agent.run();
    agent.cancel();
    const result = await runPromise;
    expect(channel.closed).toBe(true);
    expect(result.kind).toBe("success");
  });

  it("server-style IIFE removes the WebSocket chat entry from the registry after cancel()", async () => {
    const channel = new FakeChannel();
    const ctx = makeContext(tmpDir);
    const agent = new ChatAgent(
      ctx,
      { channel: "web", sessionId: "session-test-1" },
      channel,
      new EventBus(),
    );
    const registry = new Map<string, BaseAgent>();
    registry.set(ctx.agentId, agent);
    const wrapper = (async () => {
      try {
        await agent.run();
      } finally {
        registry.delete(ctx.agentId);
      }
    })();
    agent.cancel();
    await wrapper;
    expect(registry.has(ctx.agentId)).toBe(false);
  });

  it("telegram-style IIFE removes both the registry entry and the per-chat session after cancel()", async () => {
    const channel = new FakeChannel();
    const ctx = makeContext(tmpDir);
    const agent = new ChatAgent(
      ctx,
      { channel: "telegram", sessionId: "session-test-1" },
      channel,
      new EventBus(),
    );
    const registry = new Map<string, BaseAgent>();
    const sessions = new Map<number, unknown>();
    const chatId = 42;
    registry.set(ctx.agentId, agent);
    sessions.set(chatId, { channel });
    const wrapper = (async () => {
      try {
        await agent.run();
      } finally {
        registry.delete(ctx.agentId);
        sessions.delete(chatId);
      }
    })();
    agent.cancel();
    await wrapper;
    expect(registry.has(ctx.agentId)).toBe(false);
    expect(sessions.has(chatId)).toBe(false);
  });
});
