import { describe, it, expect } from "vitest";
import { Scheduler } from "./scheduler.js";
import type { TodoItem, AgentInfo } from "./state.js";

function makeTodo(overrides: Partial<TodoItem> = {}): TodoItem {
  return {
    id: "t1",
    goal: "Test",
    status: "pending",
    priority: 1,
    project: "target",
    dependsOn: [],
    retryCount: 0,
    maxRetries: 2,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeAgent(overrides: Partial<AgentInfo> = {}): AgentInfo {
  return {
    id: "a1",
    type: "coder",
    taskId: "t1",
    status: "running",
    iteration: 0,
    startedAt: new Date().toISOString(),
    ...overrides,
  };
}

describe("Scheduler", () => {
  it("ranks by priority (lower number = higher priority)", () => {
    const scheduler = new Scheduler();
    const items = [
      makeTodo({ id: "bg", priority: 3 }),
      makeTodo({ id: "interactive", priority: 0 }),
      makeTodo({ id: "fg", priority: 1 }),
      makeTodo({ id: "sys", priority: 2 }),
    ];

    const ranked = scheduler.rank(items);
    expect(ranked.map((t) => t.id)).toEqual([
      "interactive",
      "fg",
      "sys",
      "bg",
    ]);
  });

  it("same priority sorted by creation time (FIFO)", () => {
    const scheduler = new Scheduler();
    const items = [
      makeTodo({ id: "later", priority: 1, createdAt: "2026-04-12T02:00:00Z" }),
      makeTodo({ id: "earlier", priority: 1, createdAt: "2026-04-12T01:00:00Z" }),
    ];

    const ranked = scheduler.rank(items);
    expect(ranked.map((t) => t.id)).toEqual(["earlier", "later"]);
  });

  it("pickNext respects concurrency limit", () => {
    const scheduler = new Scheduler();
    scheduler.touchUserActivity();

    const items = [
      makeTodo({ id: "t1", agentType: "researcher" }),
      makeTodo({ id: "t2", agentType: "researcher" }),
      makeTodo({ id: "t3", agentType: "researcher" }),
    ];

    const picked = scheduler.pickNext(items, 5, 3);
    expect(picked).toHaveLength(2); // 5 - 3 = 2 slots
  });

  it("pickNext returns empty when at capacity", () => {
    const scheduler = new Scheduler();
    const items = [makeTodo({ id: "t1" })];

    const picked = scheduler.pickNext(items, 3, 3);
    expect(picked).toHaveLength(0);
  });

  it("pickNext serializes coder agents — only one at a time", () => {
    const scheduler = new Scheduler();
    scheduler.touchUserActivity();

    const items = [
      makeTodo({ id: "c1", agentType: "coder" }),
      makeTodo({ id: "c2", agentType: "coder" }),
      makeTodo({ id: "r1", agentType: "researcher" }),
    ];

    // No agents running — picks one coder + the researcher
    const picked = scheduler.pickNext(items, 5, 0, []);
    expect(picked.map((t) => t.id)).toEqual(["c1", "r1"]);
  });

  it("pickNext skips coder tasks when a coder is already running", () => {
    const scheduler = new Scheduler();
    scheduler.touchUserActivity();

    const items = [
      makeTodo({ id: "c1", agentType: "coder" }),
      makeTodo({ id: "r1", agentType: "researcher" }),
      makeTodo({ id: "e1", agentType: "executor" }),
    ];

    const activeAgents = [makeAgent({ id: "a1", type: "coder", taskId: "c0" })];

    const picked = scheduler.pickNext(items, 5, 1, activeAgents);
    // Should skip the coder, pick researcher and executor
    expect(picked.map((t) => t.id)).toEqual(["r1", "e1"]);
  });

  it("pickNext allows coder when only non-coders are running", () => {
    const scheduler = new Scheduler();
    scheduler.touchUserActivity();

    const items = [
      makeTodo({ id: "c1", agentType: "coder" }),
    ];

    const activeAgents = [makeAgent({ id: "a1", type: "researcher", taskId: "r0" })];

    const picked = scheduler.pickNext(items, 5, 1, activeAgents);
    expect(picked.map((t) => t.id)).toEqual(["c1"]);
  });
});
