/**
 * Saivage — LibrarianAgent tests (F03 B03).
 *
 * Mirrors the DesignerAgent / ReviewerAgent harness in `agents.test.ts`:
 * a mocked router/mcpRuntime drives `LibrarianAgent.run()` through the
 * three terminal paths returned by `BaseAgent.runLoop()`.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { LibrarianAgent, type LibrarianInput } from "./librarian.js";
import { ensureDir } from "../store/documents.js";
import { NoteManager } from "../runtime/notes.js";
import type { AgentContext } from "./types.js";
import type { ChatRequest, ChatResponse } from "../providers/types.js";
import { ProviderError } from "../providers/error.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "saivage-librarian-test-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function makeLibrarianContext(
  root: string,
  router: unknown,
  mcpRuntimeOverride?: Partial<AgentContext["mcpRuntime"]>,
): AgentContext {
  const saivageDir = join(root, ".saivage");
  ensureDir(saivageDir);
  ensureDir(join(saivageDir, "skills"));

  return {
    project: {
      projectRoot: root,
      saivageDir,
      config: {
        project_name: "test",
        objectives: ["test objective"],
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
    } as AgentContext["project"],
    router: router as AgentContext["router"],
    mcpRuntime: {
      getAllTools: () => [],
      callTool: async () => ({ ok: true }),
      ...mcpRuntimeOverride,
    } as AgentContext["mcpRuntime"],
    noteManager: new NoteManager(join(saivageDir, "notes")),
    agentId: "librarian-1",
    role: "librarian",
    modelSpec: "test/model",
  };
}

describe("LibrarianAgent", () => {
  it("create() formats initial message and eager block from input", async () => {
    const router = {
      getMaxContextTokens: () => 200_000,
      countTokens: () => 0,
      chat: async (): Promise<ChatResponse> => ({
        content: "noop",
        toolCalls: [],
        finishReason: "end_turn",
        usage: { inputTokens: 0, outputTokens: 0 },
      }),
    };
    const input: LibrarianInput = {
      objective: "Investigate RAG retrieval miss for dataset-x",
      collection_id: "dataset-x",
      context: "worker hit zero results",
    };
    const ctx = makeLibrarianContext(tmpDir, router);
    const agent = await LibrarianAgent.create(ctx, input);
    const messages = (agent as unknown as { messages: { role: string; content: string }[] }).messages;
    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe("user");
    expect(messages[0].content).toContain("# Objective");
    expect(messages[0].content).toContain("Investigate RAG retrieval miss for dataset-x");
    expect(messages[0].content).toContain("# Collection");
    expect(messages[0].content).toContain("dataset-x");
    expect(messages[0].content).toContain("# Context");
    expect(messages[0].content).toContain("worker hit zero results");
    expect(agent.role).toBe("librarian");
  });

  it("create() omits optional sections when not provided", async () => {
    const router = {
      getMaxContextTokens: () => 200_000,
      countTokens: () => 0,
      chat: async (): Promise<ChatResponse> => ({
        content: "noop",
        toolCalls: [],
        finishReason: "end_turn",
        usage: { inputTokens: 0, outputTokens: 0 },
      }),
    };
    const ctx = makeLibrarianContext(tmpDir, router);
    const agent = await LibrarianAgent.create(ctx, { objective: "audit rag policy" });
    const messages = (agent as unknown as { messages: { role: string; content: string }[] }).messages;
    expect(messages[0].content).toContain("# Objective");
    expect(messages[0].content).not.toContain("# Collection");
    expect(messages[0].content).not.toContain("# Context");
  });

  it("run() returns success on end_turn", async () => {
    let callCount = 0;
    const router = {
      getMaxContextTokens: () => 200_000,
      countTokens: () => 0,
      chat: async (_request: ChatRequest): Promise<ChatResponse> => {
        callCount++;
        if (callCount === 1) {
          return {
            content: "Inspecting RAG state.",
            toolCalls: [{ id: "t1", name: "test_tool", input: {} }],
            finishReason: "tool_use",
            usage: { inputTokens: 1, outputTokens: 1 },
          };
        }
        return {
          content: "Librarian summary: no drift detected.",
          toolCalls: [],
          finishReason: "end_turn",
          usage: { inputTokens: 1, outputTokens: 1 },
        };
      },
    };
    const ctx = makeLibrarianContext(tmpDir, router, {
      getAllTools: () => [
        { name: "test_tool", description: "test", inputSchema: {}, service: "test" },
      ],
      callTool: async () => ({ ok: true }),
    });
    const agent = await LibrarianAgent.create(ctx, { objective: "smoke" });
    const result = await agent.run();
    expect(result.kind).toBe("success");
    if (result.kind === "success") {
      expect(result.data).toBe("Librarian summary: no drift detected.");
    }
  });

  it("run() returns abort when abort signal is set", async () => {
    const router = {
      getMaxContextTokens: () => 200_000,
      countTokens: () => 0,
      chat: async (): Promise<ChatResponse> => {
        throw new Error("router should not be called when aborted");
      },
    };
    const ctx = makeLibrarianContext(tmpDir, router);
    const agent = await LibrarianAgent.create(
      ctx,
      { objective: "abort path" },
      { abortSignal: { aborted: true } },
    );
    const result = await agent.run();
    expect(result.kind).toBe("abort");
  });

  it("run() returns failure when the LLM call errors", async () => {
    const router = {
      getMaxContextTokens: () => 200_000,
      countTokens: () => 0,
      chat: async (): Promise<ChatResponse> => {
        throw new ProviderError({ kind: "non_retryable", message: "provider exploded" });
      },
    };
    const ctx = makeLibrarianContext(tmpDir, router);
    const agent = await LibrarianAgent.create(ctx, { objective: "failure path" });
    const result = await agent.run();
    expect(result.kind).toBe("failure");
    if (result.kind === "failure") {
      expect(result.reason).toContain("provider exploded");
    }
  });
});
