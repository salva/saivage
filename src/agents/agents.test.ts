/**
 * Tests for Phase 3: LLM Integration (skills, conventions)
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { resolveSkills, formatSkillsForPrompt } from "../skills/loader.js";
import { checkConvention, getConvention } from "./conventions.js";
import { writeDoc, ensureDir } from "../store/documents.js";
import { SkillIndexSchema } from "../types.js";
import { ReviewerAgent } from "./reviewer.js";
import { ChatAgent } from "./chat.js";
import { CoderAgent } from "./coder.js";
import { ManagerAgent } from "./manager.js";
import { EventBus } from "../events/bus.js";
import type { ChatChannel } from "../channels/types.js";
import type { AgentContext, ManagerInput, WorkerInput } from "./types.js";
import type { ChatRequest, ChatResponse } from "../providers/types.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "saivage-test-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// ─── Skill Loader ────────────────────────────────────────────────────────────

describe("Skill Loader", () => {
  it("resolves skills matching keywords", () => {
    const skillsDir = join(tmpDir, "skills");
    ensureDir(skillsDir);

    // Write a skill file
    writeFileSync(join(skillsDir, "testing.md"), "# Testing Best Practices\nAlways test edge cases.", "utf-8");

    // Write index.json
    writeDoc(
      join(skillsDir, "index.json"),
      {
        skills: [
          {
            name: "testing",
            file: "testing.md",
            description: "Testing best practices",
            triggers: ["keyword:test", "keyword:jest", "tag:testing"],
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          },
          {
            name: "deployment",
            file: "deploy.md",
            description: "Deployment guide",
            triggers: ["keyword:deploy", "tag:ops"],
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          },
        ],
      },
      SkillIndexSchema,
    );

    // Write deploy.md too
    writeFileSync(join(skillsDir, "deploy.md"), "# Deploy Guide\nUse CI/CD.", "utf-8");

    const result = resolveSkills(
      {
        agentRole: "coder",
        description: "Write unit tests for the auth module",
        tags: ["testing"],
      },
      skillsDir,
      5,
    );

    expect(result.length).toBeGreaterThanOrEqual(1);
    expect(result[0].entry.name).toBe("testing");
    expect(result[0].matchScore).toBeGreaterThan(0);
  });

  it("filters by target_agents", () => {
    const skillsDir = join(tmpDir, "skills");
    ensureDir(skillsDir);

    writeFileSync(join(skillsDir, "coder-only.md"), "# Coder Only", "utf-8");

    writeDoc(
      join(skillsDir, "index.json"),
      {
        skills: [
          {
            name: "coder-only",
            file: "coder-only.md",
            description: "Only for coders",
            triggers: ["keyword:code"],
            target_agents: ["coder"],
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          },
        ],
      },
      SkillIndexSchema,
    );

    // Should match for coder
    const coderResult = resolveSkills(
      { agentRole: "coder", description: "Write code" },
      skillsDir,
    );
    expect(coderResult).toHaveLength(1);

    // Should NOT match for researcher
    const researcherResult = resolveSkills(
      { agentRole: "researcher", description: "Write code" },
      skillsDir,
    );
    expect(researcherResult).toHaveLength(0);
  });

  it("respects max skill budget", () => {
    const skillsDir = join(tmpDir, "skills");
    ensureDir(skillsDir);

    const skills = Array.from({ length: 10 }, (_, i) => ({
      name: `skill-${i}`,
      file: `skill-${i}.md`,
      description: `Skill ${i}`,
      triggers: ["keyword:test"],
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }));

    for (const s of skills) {
      writeFileSync(join(skillsDir, s.file), `# ${s.name}`, "utf-8");
    }

    writeDoc(join(skillsDir, "index.json"), { skills }, SkillIndexSchema);

    const result = resolveSkills(
      { agentRole: "coder", description: "test something" },
      skillsDir,
      3,
    );
    expect(result).toHaveLength(3);
  });

  it("formatSkillsForPrompt formats correctly", () => {
    const formatted = formatSkillsForPrompt([
      {
        entry: {
          name: "testing",
          file: "testing.md",
          description: "Test",
          triggers: [],
          created_at: "",
          updated_at: "",
        },
        content: "# Testing\nTest things.",
        matchScore: 1,
      },
    ]);

    expect(formatted).toContain("--- SKILL: testing ---");
    expect(formatted).toContain("# Testing");
  });

  it("formatSkillsForPrompt returns empty string for no skills", () => {
    expect(formatSkillsForPrompt([])).toBe("");
  });
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
    const agent = new ReviewerAgent(ctx, firstInput);

    await agent.review(firstInput);
    await agent.review(makeReviewInput("review-2", "Recheck blocker after corrective task t2"));

    expect(calls).toHaveLength(4);
    const secondMessages = JSON.stringify(calls[3].messages);
    expect(secondMessages).toContain("first review found blocker");
    expect(secondMessages).toContain("Follow-up Review 2");
    expect(secondMessages).toContain("Recheck blocker after corrective task t2");
  });
});

describe("ChatAgent", () => {
  it("serializes incoming user messages for one session", async () => {
    const firstResponse = deferred<void>();
    const firstRouterCall = deferred<void>();
    const routerCalls: ChatRequest[] = [];
    const router = {
      getMaxContextTokens: () => 200_000,
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
});

describe("Execution guards", () => {
  it("retries coder when it tries to finish before any tool use", async () => {
    const calls: ChatRequest[] = [];
    const router = {
      getMaxContextTokens: () => 200_000,
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

    const agent = new CoderAgent(
      makeReviewerContext(tmpDir, router, {
        getAllTools: () => [{ name: "test_tool", description: "test", inputSchema: {}, service: "test" }],
        callTool: async () => ({ ok: true }),
      }),
      makeWorkerInput("task-1", "Do one thing"),
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
        planHistory: join(saivageDir, "plan-history.json"),
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
    agentId: "reviewer-1",
    role: "reviewer",
    modelSpec: "test/model",
  };
}

function makeChatContext(root: string, router: unknown): AgentContext {
  const ctx = makeReviewerContext(root, router);
  return {
    ...ctx,
    agentId: "chat-1",
    role: "chat",
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
