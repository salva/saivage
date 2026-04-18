import { describe, it, expect, vi, beforeEach } from "vitest";
import { SubAgent, type SubAgentDeps } from "./base.js";
import type { TaskAssignment } from "./protocol.js";
import { EventBus } from "../orchestrator/eventBus.js";
import type { ChatResponse } from "../providers/types.js";
import type { SaivageConfig } from "../config.js";

const stubConfig: SaivageConfig = {
  models: {
    orchestrator: "test/model",
    coder: "test/model",
    researcher: "test/model",
    executor: "test/model",
    chat: "test/model",
    default: "test/model",
  },
  providers: {},
  failover: {},
  server: { port: 7777, host: "0.0.0.0" },
  agent: { maxConcurrentAgents: 3 },
  generator: { language: "typescript", testBeforeRegister: true, sandbox: true },
  runtime: { maxServices: 50, restartOnCrash: true, healthCheckIntervalMs: 30000, idleShutdownMs: 300000 },
  versions: { storagePath: "~/.saivage/versions", retainCount: 5 },
  sandbox: { timeoutMs: 120000, secondaryInstancePort: 7778 },
  watchdog: { enabled: false, healthCheckIntervalMs: 5000, restartTimeoutMs: 60000 },
  autonomy: { enabled: false, planningCooldownMs: 60000, maxTasksPerCycle: 3, objectives: [], planDocsPath: ".saivage/planning", retrospectiveInterval: 10 },
  project: { root: "/tmp/test-project", venv: "", description: "" },
  security: { injectionScanner: false, maxScanLengthBytes: 100000 },
} as SaivageConfig;

function makeMockDeps(
  chatResponses: ChatResponse[],
): SubAgentDeps {
  let callCount = 0;

  const mockRouter = {
    resolveModelForRole: vi.fn().mockReturnValue("test/model"),
    chat: vi.fn().mockImplementation(async () => {
      const response = chatResponses[callCount++];
      if (!response) throw new Error("No more mock responses");
      return response;
    }),
    getProvider: vi.fn(),
    listProviders: vi.fn().mockReturnValue([]),
    clearStickyFailover: vi.fn(),
  } as unknown as SubAgentDeps["router"];

  const mockRuntime = {
    getAllTools: vi.fn().mockReturnValue([
      {
        name: "read_file",
        description: "Read a file",
        inputSchema: {},
        service: "filesystem",
      },
    ]),
    callTool: vi.fn().mockResolvedValue("file contents here"),
    getClient: vi.fn(),
    startService: vi.fn(),
    stopService: vi.fn(),
    listRunning: vi.fn().mockReturnValue([]),
    shutdown: vi.fn(),
    startMonitoring: vi.fn(),
    stopMonitoring: vi.fn(),
    startFromEntry: vi.fn(),
  } as unknown as SubAgentDeps["runtime"];

  const eventBus = new EventBus();

  return { router: mockRouter, runtime: mockRuntime, eventBus, config: stubConfig, allSkills: [] };
}

function makeTask(overrides: Partial<TaskAssignment> = {}): TaskAssignment {
  return {
    id: "test-task-1",
    type: "code",
    goal: "Write hello world",
    ...overrides,
  };
}

describe("SubAgent ReAct loop", () => {
  it("completes when LLM returns no tool calls", async () => {
    const deps = makeMockDeps([
      {
        content: "Done! The task is complete.",
        toolCalls: [],
        finishReason: "end_turn",
        usage: { inputTokens: 100, outputTokens: 50 },
      },
    ]);

    const agent = new SubAgent(
      {
        type: "coder",
        systemPrompt: "You are a coder.",
        modelRole: "coder",
      },
      deps,
    );

    const completed = vi.fn();
    deps.eventBus.on("agent:completed", completed);

    const result = await agent.run(makeTask());
    expect(result).toBe("Done! The task is complete.");
    expect(completed).toHaveBeenCalledTimes(1);
  });

  it("executes tool calls and loops", async () => {
    const deps = makeMockDeps([
      {
        content: "Let me read the file first.",
        toolCalls: [
          { id: "tc1", name: "read_file", input: { path: "test.txt" } },
        ],
        finishReason: "tool_use",
        usage: { inputTokens: 100, outputTokens: 50 },
      },
      {
        content: "Based on the file, the task is done.",
        toolCalls: [],
        finishReason: "end_turn",
        usage: { inputTokens: 200, outputTokens: 100 },
      },
    ]);

    const agent = new SubAgent(
      {
        type: "coder",
        systemPrompt: "You are a coder.",
        modelRole: "coder",
      },
      deps,
    );

    const result = await agent.run(makeTask());
    expect(result).toBe("Based on the file, the task is done.");
    expect(deps.runtime.callTool).toHaveBeenCalledWith(
      "filesystem",
      "read_file",
      { path: "test.txt" },
    );
  });

  it("cancellation stops the loop", async () => {
    const deps = makeMockDeps([
      {
        content: "Working...",
        toolCalls: [{ id: "tc", name: "read_file", input: { path: "x" } }],
        finishReason: "tool_use",
        usage: { inputTokens: 10, outputTokens: 10 },
      },
      {
        content: "Still working...",
        toolCalls: [],
        finishReason: "end_turn",
        usage: { inputTokens: 10, outputTokens: 10 },
      },
    ]);

    const agent = new SubAgent(
      {
        type: "coder",
        systemPrompt: "You are a coder.",
        modelRole: "coder",
      },
      deps,
    );

    // Cancel after first iteration
    deps.eventBus.on("agent:progress", () => {
      agent.cancel();
    });

    await expect(agent.run(makeTask())).rejects.toThrow("cancelled");
  });

  it("emits blocked when tool not found", async () => {
    const deps = makeMockDeps([
      {
        content: "",
        toolCalls: [
          { id: "tc", name: "nonexistent_tool", input: {} },
        ],
        finishReason: "tool_use",
        usage: { inputTokens: 10, outputTokens: 10 },
      },
      {
        content: "Hmm, tool not found. Done.",
        toolCalls: [],
        finishReason: "end_turn",
        usage: { inputTokens: 10, outputTokens: 10 },
      },
    ]);

    const agent = new SubAgent(
      {
        type: "coder",
        systemPrompt: "You are a coder.",
        modelRole: "coder",
      },
      deps,
    );

    const blocked = vi.fn();
    deps.eventBus.on("agent:blocked", blocked);

    await agent.run(makeTask());
    expect(blocked).toHaveBeenCalledTimes(1);
    expect(blocked).toHaveBeenCalledWith(
      expect.objectContaining({ missingTool: "nonexistent_tool" }),
    );
  });
});
