/**
 * Tests for Phase 3: LLM Integration (skills, conventions)
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { checkConvention, getConvention } from "./conventions.js";
import { ensureDir } from "../store/documents.js";
import { ReviewerAgent } from "./reviewer.js";
import { ChatAgent } from "./chat.js";
import { CoderAgent } from "./coder.js";
import { DesignerAgent } from "./designer.js";
import { ManagerAgent } from "./manager.js";
import { WorkerAgent } from "./worker.js";
import { EventBus } from "../events/bus.js";
import type { ChatChannel } from "../channels/types.js";
import type { WsOutbound } from "../channels/ws-schema.js";
import type { AgentContext, ManagerInput, WorkerInput } from "./types.js";
import type { ChatRequest, ChatResponse } from "../providers/types.js";
import type { PlannerControl } from "../server/bootstrap.js";
import { NoteManager } from "../runtime/notes.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "saivage-test-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// ─── Conventions ─────────────────────────────────────────────────────────────

describe("Conventions", () => {
  it("detects coder writing to research/", () => {
    const warning = checkConvention("coder", "research/findings.md");
    expect(warning).not.toBeNull();
    expect(warning).toContain("Convention violation");
  });

  it("allows coder writing to src/", () => {
    const warning = checkConvention("coder", "src/main.ts");
    expect(warning).toBeNull();
  });

  it("detects researcher writing to src/", () => {
    const warning = checkConvention("researcher", "src/main.ts");
    expect(warning).not.toBeNull();
  });

  it("allows researcher writing to research/", () => {
    const warning = checkConvention("researcher", "research/notes.md");
    expect(warning).toBeNull();
  });

  it("allows data agent writing to data sources", () => {
    const warning = checkConvention("data_agent", "research/data-sources/source.md");
    expect(warning).toBeNull();
  });

  it("detects data agent writing to source code", () => {
    const warning = checkConvention("data_agent", "src/models/new_model.py");
    expect(warning).not.toBeNull();
  });

  it("allows reviewer writing stage review notes", () => {
    const warning = checkConvention("reviewer", ".saivage/stages/stg-1/reviews/review.md");
    expect(warning).toBeNull();
  });

  it("detects reviewer writing to source code", () => {
    const warning = checkConvention("reviewer", "src/models/new_model.py");
    expect(warning).not.toBeNull();
  });

  it("no convention for unknown role returns null", () => {
    // Chat has conventions, but agents without excluded territories pass
    const warning = checkConvention(
      "chat",
      ".saivage/notes/note-1.json",
    );
    expect(warning).toBeNull();
  });

  it("getConvention returns rule for known role", () => {
    const rule = getConvention("coder");
    expect(rule).not.toBeNull();
    expect(rule!.writeTerritory).toContain("src/");
  });
});

describe("ReviewerAgent", () => {
  it("keeps prior review reports visible for follow-up reviews", async () => {
    const calls: ChatRequest[] = [];
    const router = {
      getMaxContextTokens: () => 200_000,
      countTokens: () => 0,
      chat: async (request: ChatRequest): Promise<ChatResponse> => {
        calls.push(request);
        const reviewNumber = Math.ceil(calls.length / 2);
        if (calls.length % 2 === 1) {
          return {
            content: `Inspecting evidence for review ${reviewNumber}.`,
            toolCalls: [{ id: `tool-${reviewNumber}`, name: "test_tool", input: {} }],
            finishReason: "tool_use",
            usage: { inputTokens: 1, outputTokens: 1 },
          };
        }
        return {
          content: JSON.stringify({
            task_id: `review-${reviewNumber}`,
            stage_id: "stage-1",
            agent: "reviewer",
            status: "completed",
            summary: reviewNumber === 1 ? "first review found blocker" : "follow-up checked corrective task",
            checklist_results: [],
            files_modified: [],
            files_created: [],
            tests_added: [],
            tests_run: [],
            commits: [],
            issues_found: [],
          }),
          toolCalls: [],
          finishReason: "end_turn",
          usage: { inputTokens: 1, outputTokens: 1 },
        };
      },
    };

    const ctx = makeReviewerContext(tmpDir, router, {
      getAllTools: () => [{ name: "test_tool", description: "test", inputSchema: {}, service: "test" }],
      callTool: async () => ({ ok: true }),
    });
    const firstInput = makeReviewInput("review-1", "Initial review");
    const agent = await WorkerAgent.createWorker<ReviewerAgent>(ctx, firstInput, "reviewer");

    await agent.review(firstInput);
    await agent.review(makeReviewInput("review-2", "Recheck blocker after corrective task t2"));

    expect(calls).toHaveLength(4);
    const secondMessages = JSON.stringify(calls[3].messages);
    expect(secondMessages).toContain("first review found blocker");
    expect(secondMessages).toContain("Follow-up Review 2");
    expect(secondMessages).toContain("Recheck blocker after corrective task t2");
  });

  it("does not duplicate the final assistant message in this.messages after review()", async () => {
    // Regression for F14 (reviewer half, owned by F09): runLoop() pushes the
    // terminal assistant message; the old reviewer.run() also pushed it,
    // resulting in two identical assistant entries in the conversation.
    const calls: ChatRequest[] = [];
    const router = {
      getMaxContextTokens: () => 200_000,
      countTokens: () => 0,
      chat: async (request: ChatRequest): Promise<ChatResponse> => {
        calls.push(request);
        // Calls 1 and 3 are first turns of each review (need a tool call to
        // satisfy validateFinalResponse on the no-tool turn that follows).
        if (calls.length === 1) {
          return {
            content: "Inspecting evidence.",
            toolCalls: [{ id: "tool-1", name: "test_tool", input: {} }],
            finishReason: "tool_use",
            usage: { inputTokens: 1, outputTokens: 1 },
          };
        }
        if (calls.length === 2) {
          return {
            content: "REVIEW DONE",
            toolCalls: [],
            finishReason: "end_turn",
            usage: { inputTokens: 1, outputTokens: 1 },
          };
        }
        if (calls.length === 3) {
          return {
            content: "Re-inspecting.",
            toolCalls: [{ id: "tool-2", name: "test_tool", input: {} }],
            finishReason: "tool_use",
            usage: { inputTokens: 1, outputTokens: 1 },
          };
        }
        return {
          content: "REVIEW DONE 2",
          toolCalls: [],
          finishReason: "end_turn",
          usage: { inputTokens: 1, outputTokens: 1 },
        };
      },
    };

    const ctx = makeReviewerContext(tmpDir, router, {
      getAllTools: () => [
        { name: "test_tool", description: "test", inputSchema: {}, service: "test" },
      ],
      callTool: async () => ({ ok: true }),
    });
    const firstInput = makeReviewInput("review-1", "Initial review");
    const agent = await WorkerAgent.createWorker<ReviewerAgent>(ctx, firstInput, "reviewer");

    await agent.review(firstInput);
    await agent.review(makeReviewInput("review-2", "Recheck"));

    const assistantTextEquals = (
      m: { role: string; content: unknown },
      target: string,
    ): boolean => {
      if (m.role !== "assistant") return false;
      if (typeof m.content === "string") return m.content === target;
      if (Array.isArray(m.content)) {
        const textBlocks = (m.content as any[])
          .filter((b: any) => b?.type === "text")
          .map((b: any) => b.text ?? "");
        return textBlocks.join("") === target;
      }
      return false;
    };

    // Messages snapshotted on call 3 = state after review 1 finished.
    const msgs = calls[2].messages as any[];
    const count = msgs.filter((m) => assistantTextEquals(m, "REVIEW DONE")).length;
    expect(count).toBe(1);
  });
});

describe("ChatAgent", () => {
  it("serializes incoming user messages for one session", async () => {
    const firstResponse = deferred<void>();
    const firstRouterCall = deferred<void>();
    const routerCalls: ChatRequest[] = [];
    const router = {
      getMaxContextTokens: () => 200_000,
      countTokens: () => 0,
      chat: async (request: ChatRequest): Promise<ChatResponse> => {
        routerCalls.push(request);
        if (routerCalls.length === 1) {
          firstRouterCall.resolve();
          await firstResponse.promise;
        }
        return {
          content: `response ${routerCalls.length}`,
          toolCalls: [],
          finishReason: "end_turn",
          usage: { inputTokens: 1, outputTokens: 1 },
        };
      },
    };

    const channel = new TestChatChannel();
    const agent = new ChatAgent(
      makeChatContext(tmpDir, router),
      { channel: "telegram", sessionId: "telegram-1" },
      channel,
      new EventBus(),
    );

    const runPromise = agent.run();
    await channel.waitForHandler();

    const firstMessage = channel.receive("first");
    const secondMessage = channel.receive("second");
    await firstRouterCall.promise;

    expect(routerCalls).toHaveLength(1);

    firstResponse.resolve(undefined);
    await Promise.all([firstMessage, secondMessage]);

    expect(routerCalls).toHaveLength(2);
    expect(channel.sent).toEqual(["response 1", "response 2"]);

    channel.close();
    await runPromise;
  });

  it("rejects chat messages when the session queue is full", async () => {
    const firstResponse = deferred<void>();
    const routerCalls: ChatRequest[] = [];
    const router = {
      getMaxContextTokens: () => 200_000,
      countTokens: () => 0,
      chat: async (request: ChatRequest): Promise<ChatResponse> => {
        routerCalls.push(request);
        if (routerCalls.length === 1) await firstResponse.promise;
        return {
          content: `response ${routerCalls.length}`,
          toolCalls: [],
          finishReason: "end_turn",
          usage: { inputTokens: 1, outputTokens: 1 },
        };
      },
    };

    const channel = new TestChatChannel();
    const agent = new ChatAgent(
      makeChatContext(tmpDir, router),
      { channel: "telegram", sessionId: "telegram-1" },
      channel,
      new EventBus(),
    );

    const runPromise = agent.run();
    await channel.waitForHandler();

    const pending = [
      channel.receive("one"),
      channel.receive("two"),
      channel.receive("three"),
      channel.receive("four"),
      channel.receive("five"),
    ];
    await channel.receive("six");

    expect(channel.sent).toEqual([
      "I already have several chat messages queued for this session. Please wait for the current replies before sending more.",
    ]);
    expect(routerCalls).toHaveLength(1);

    firstResponse.resolve(undefined);
    await Promise.all(pending);

    expect(routerCalls).toHaveLength(5);
    expect(channel.sent).toHaveLength(6);

    channel.close();
    await runPromise;
  });

  it("does not restart the Planner on free text containing planner and restart", async () => {
    const routerCalls: ChatRequest[] = [];
    const router = {
      getMaxContextTokens: () => 200_000,
      countTokens: () => 0,
      chat: async (request: ChatRequest): Promise<ChatResponse> => {
        routerCalls.push(request);
        return {
          content: "ok",
          toolCalls: [],
          finishReason: "end_turn",
          usage: { inputTokens: 1, outputTokens: 1 },
        };
      },
    };

    const restartCalls: Array<{ reason: string; requestedBy: string }> = [];
    const plannerControl = {
      requestRestart: (reason: string, requestedBy: string) => {
        restartCalls.push({ reason, requestedBy });
        return { requestedAt: new Date().toISOString() };
      },
    } as unknown as PlannerControl;

    const bus = new EventBus();
    const publishedRestartEvents: string[] = [];
    const originalPublish = bus.publish.bind(bus);
    bus.publish = async (event) => {
      if (
        event.type === "plan_updated" &&
        event.summary.startsWith("Planner restart requested from")
      ) {
        publishedRestartEvents.push(event.summary);
      }
      return originalPublish(event);
    };

    const channel = new TestChatChannel();
    const agent = new ChatAgent(
      makeChatContext(tmpDir, router),
      { channel: "web", sessionId: "web-1" },
      channel,
      bus,
      undefined,
      plannerControl,
    );

    const runPromise = agent.run();
    await channel.waitForHandler();

    await channel.receive("Why did the planner restart yesterday?");

    expect(restartCalls).toHaveLength(0);
    expect(publishedRestartEvents).toHaveLength(0);
    expect(routerCalls).toHaveLength(1);
    expect(JSON.stringify(routerCalls[0].messages)).toContain(
      "Why did the planner restart yesterday?",
    );
    expect(channel.sent).toEqual(["ok"]);

    channel.close();
    await runPromise;
  });
});

describe("Execution guards", () => {
  it("retries coder when it tries to finish before any tool use", async () => {
    const calls: ChatRequest[] = [];
    const router = {
      getMaxContextTokens: () => 200_000,
      countTokens: () => 0,
      chat: async (request: ChatRequest): Promise<ChatResponse> => {
        calls.push(request);
        if (calls.length === 1) {
          return {
            content: JSON.stringify({
              task_id: "task-1",
              stage_id: "stage-1",
              status: "failed",
              summary: "I did not execute anything.",
              failure_reason: "I did not execute anything.",
            }),
            toolCalls: [],
            finishReason: "end_turn",
            usage: { inputTokens: 1, outputTokens: 1 },
          };
        }
        if (calls.length === 2) {
          return {
            content: "I am inspecting a file before returning the report.",
            toolCalls: [{ id: "tool-1", name: "test_tool", input: {} }],
            finishReason: "tool_use",
            usage: { inputTokens: 1, outputTokens: 1 },
          };
        }
        return {
          content: JSON.stringify({
            task_id: "task-1",
            stage_id: "stage-1",
            status: "completed",
            summary: "Used a tool and completed the task.",
          }),
          toolCalls: [],
          finishReason: "end_turn",
          usage: { inputTokens: 1, outputTokens: 1 },
        };
      },
    };

    const agent = await WorkerAgent.createWorker<CoderAgent>(
      makeReviewerContext(tmpDir, router, {
        getAllTools: () => [{ name: "test_tool", description: "test", inputSchema: {}, service: "test" }],
        callTool: async () => ({ ok: true }),
      }),
      makeWorkerInput("task-1", "Do one thing"),
      "coder",
    );

    const result = await agent.run();

    expect(result.kind).toBe("success");
    expect(calls).toHaveLength(3);
    expect(JSON.stringify(calls[1].messages)).toContain("Invalid final task response");
  });

  it("retries manager when it tries to finish before dispatching a worker", async () => {
    const calls: ChatRequest[] = [];
    const router = {
      getMaxContextTokens: () => 200_000,
      countTokens: () => 0,
      chat: async (request: ChatRequest): Promise<ChatResponse> => {
        calls.push(request);
        if (calls.length === 1) {
          return {
            content: JSON.stringify({
              stage_id: "stage-1",
              result: "escalated",
              summary: "I did not dispatch any worker.",
              escalation: {
                stage_id: "stage-1",
                reason: "No work attempted.",
                attempted_remediations: [],
                created_at: new Date().toISOString(),
              },
            }),
            toolCalls: [],
            finishReason: "end_turn",
            usage: { inputTokens: 1, outputTokens: 1 },
          };
        }
        if (calls.length === 2) {
          return {
            content: "I am dispatching a coder now.",
            toolCalls: [{ id: "dispatch-1", name: "run_coder", input: { task: {}, stageId: "stage-1" } }],
            finishReason: "tool_use",
            usage: { inputTokens: 1, outputTokens: 1 },
          };
        }
        return {
          content: JSON.stringify({
            stage_id: "stage-1",
            result: "completed",
            summary: "Dispatched worker and completed the stage.",
            tasks_completed: 1,
            tasks_failed: 0,
            total_tasks: 1,
            outcomes_achieved: ["done"],
            outcomes_missed: [],
            issues: [],
          }),
          toolCalls: [],
          finishReason: "end_turn",
          usage: { inputTokens: 1, outputTokens: 1 },
        };
      },
    };

    const agent = new ManagerAgent(
      makeReviewerContext(tmpDir, router),
      makeManagerInput(),
      async () => ({
        kind: "success",
        data: {
          task_id: "task-1",
          stage_id: "stage-1",
          agent: "coder",
          status: "completed",
          summary: "done",
          checklist_results: [],
          files_modified: [],
          files_created: [],
          tests_added: [],
          tests_run: [],
          commits: [],
          issues_found: [],
          started_at: new Date().toISOString(),
          completed_at: new Date().toISOString(),
          duration_ms: 1,
        },
      }),
    );

    const result = await agent.run();

    expect(result.kind).toBe("success");
    expect(calls).toHaveLength(3);
    expect(JSON.stringify(calls[1].messages)).toContain("Invalid final stage response");
  });
});

describe("DesignerAgent", () => {
  it("runs a design task and returns a Designer TaskReport", async () => {
    const router = {
      getMaxContextTokens: () => 200_000,
      countTokens: () => 0,
      chat: async (): Promise<ChatResponse> => ({
        content: JSON.stringify({
          task_id: "design-1",
          stage_id: "stage-1",
          status: "completed",
          summary: "Produced a dashboard design brief.",
        }),
        toolCalls: [{ id: "t1", name: "test_tool", input: {} }],
        finishReason: "tool_use",
        usage: { inputTokens: 1, outputTokens: 1 },
      }),
    };

    // Second call: end_turn with the final TaskReport.
    let callCount = 0;
    const router2 = {
      getMaxContextTokens: () => 200_000,
      countTokens: () => 0,
      chat: async (): Promise<ChatResponse> => {
        callCount++;
        if (callCount === 1) {
          return {
            content: "Inspecting context first.",
            toolCalls: [{ id: "t1", name: "test_tool", input: {} }],
            finishReason: "tool_use",
            usage: { inputTokens: 1, outputTokens: 1 },
          };
        }
        return {
          content: JSON.stringify({
            task_id: "design-1",
            stage_id: "stage-1",
            agent: "designer",
            status: "completed",
            summary: "Produced a dashboard design brief.",
            checklist_results: [],
            files_modified: [],
            files_created: [],
            tests_added: [],
            tests_run: [],
            commits: [],
            issues_found: [],
            started_at: new Date().toISOString(),
            completed_at: new Date().toISOString(),
            duration_ms: 1,
          }),
          toolCalls: [],
          finishReason: "end_turn",
          usage: { inputTokens: 1, outputTokens: 1 },
        };
      },
    };
    void router;

    const input: WorkerInput = {
      stageId: "stage-1",
      task: {
        id: "design-1",
        type: "design",
        assigned_to: "designer",
        description: "Design the dashboard layout",
        checklist: [{ description: "states enumerated", required: true }],
        dependencies: [],
        status: "pending",
        tags: [],
        attempt: 1,
        max_attempts: 3,
      },
    };

    const agent = await WorkerAgent.createWorker<DesignerAgent>(
      makeReviewerContext(tmpDir, router2, {
        getAllTools: () => [
          { name: "test_tool", description: "test", inputSchema: {}, service: "test" },
        ],
        callTool: async () => ({ ok: true }),
      }),
      input,
      "designer",
    );

    const result = await agent.run();
    expect(result.kind).toBe("success");
    if (result.kind === "success") {
      const data = result.data as { agent: string };
      expect(data.agent).toBe("designer");
    }
  });
});

function makeReviewerContext(root: string, router: unknown, mcpRuntimeOverride?: Partial<AgentContext["mcpRuntime"]>): AgentContext {
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
    },
    router: router as AgentContext["router"],
    mcpRuntime: {
      getAllTools: () => [],
      callTool: async () => ({ ok: true }),
      ...mcpRuntimeOverride,
    } as AgentContext["mcpRuntime"],
    noteManager: new NoteManager(join(saivageDir, "notes")),
    agentId: "reviewer-1",
    role: "reviewer",
    stageId: "stage-1",
    modelSpec: "test/model",
  };
}

function makeChatContext(root: string, router: unknown): AgentContext {
  const ctx = makeReviewerContext(root, router);
  return {
    ...ctx,
    agentId: "chat-1",
    role: "chat",
    stageId: undefined,
    channelId: "web",
    sessionId: "session-test-1",
  };
}

class TestChatChannel implements ChatChannel {
  sent: string[] = [];
  private messageHandler?: (message: string) => void | Promise<void>;
  private closeHandler?: () => void;
  private handlerReady = deferred<void>();

  send(message: string): void {
    this.sent.push(message);
  }

  sendEvent(event: WsOutbound): void {
    if (event.type === "message") this.send(event.content);
  }

  onMessage(handler: (message: string) => void | Promise<void>): void {
    this.messageHandler = handler;
    this.handlerReady.resolve();
  }

  onClose(handler: () => void): void {
    this.closeHandler = handler;
  }

  close(): void {
    this.closeHandler?.();
  }

  waitForHandler(): Promise<void> {
    return this.handlerReady.promise;
  }

  receive(message: string): Promise<void> {
    if (!this.messageHandler) throw new Error("No message handler registered");
    return Promise.resolve(this.messageHandler(message));
  }
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

function makeReviewInput(id: string, objective: string): WorkerInput {
  return {
    stageId: "stage-1",
    task: {
      id,
      type: "review",
      assigned_to: "reviewer",
      description: objective,
      checklist: [{ description: "review the stage", required: true }],
      dependencies: [],
      status: "pending",
      tags: [],
      attempt: 1,
      max_attempts: 3,
    },
  };
}

function makeWorkerInput(id: string, objective: string): WorkerInput {
  return {
    stageId: "stage-1",
    task: {
      id,
      type: "code",
      assigned_to: "coder",
      description: objective,
      checklist: [{ description: "do the task", required: true }],
      dependencies: [],
      status: "pending",
      tags: [],
      attempt: 1,
      max_attempts: 3,
    },
  };
}

function makeManagerInput(): ManagerInput {
  return {
    stage: {
      id: "stage-1",
      objective: "Complete one stage",
      starting_points: [],
      expected_outcomes: ["done"],
      acceptance_criteria: ["worker dispatched"],
      references: [],
      tags: [],
    },
  };
}
