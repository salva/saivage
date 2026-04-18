import { describe, it, expect } from "vitest";
import {
  createEmptyState,
  findTodo,
  pendingTodos,
  activeTodos,
  type TodoItem,
  type OrchestratorState,
} from "./state.js";

function makeTodo(overrides: Partial<TodoItem> = {}): TodoItem {
  return {
    id: "t1",
    goal: "Test task",
    status: "pending",
    priority: 1,
    project: "target",
    dependsOn: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

describe("OrchestratorState", () => {
  it("creates empty state", () => {
    const state = createEmptyState();
    expect(state.todos).toHaveLength(0);
    expect(state.activeAgents).toHaveLength(0);
  });

  it("findTodo finds by id", () => {
    const state = createEmptyState();
    state.todos.push(makeTodo({ id: "t1" }));
    state.todos.push(makeTodo({ id: "t2" }));

    expect(findTodo(state, "t1")?.id).toBe("t1");
    expect(findTodo(state, "t3")).toBeUndefined();
  });

  it("pendingTodos returns only pending with resolved deps", () => {
    const state = createEmptyState();
    state.todos.push(makeTodo({ id: "t1", status: "pending" }));
    state.todos.push(makeTodo({ id: "t2", status: "in-progress" }));
    state.todos.push(
      makeTodo({ id: "t3", status: "pending", dependsOn: ["t2"] }),
    );
    state.todos.push(
      makeTodo({ id: "t4", status: "pending", dependsOn: ["t1"] }),
    );

    const pending = pendingTodos(state);
    // t1 is pending with no deps — ready
    // t3 depends on t2 which is in-progress — not ready
    // t4 depends on t1 which is pending — not ready (not completed)
    expect(pending.map((t) => t.id)).toEqual(["t1"]);
  });

  it("activeTodos returns in-progress items", () => {
    const state = createEmptyState();
    state.todos.push(makeTodo({ id: "t1", status: "pending" }));
    state.todos.push(makeTodo({ id: "t2", status: "in-progress" }));
    state.todos.push(makeTodo({ id: "t3", status: "completed" }));

    expect(activeTodos(state).map((t) => t.id)).toEqual(["t2"]);
  });
});
