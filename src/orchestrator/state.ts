import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from "node:fs";
import { join } from "node:path";
import { saivageDir } from "../config.js";

// --- Types ---

export type Priority = 0 | 1 | 2 | 3; // P0=interactive, P1=foreground, P2=system, P3=background

export type TodoStatus =
  | "pending"
  | "in-progress"
  | "blocked"
  | "completed"
  | "failed"
  | "cancelled";

export interface TodoItem {
  id: string;
  goal: string;
  title?: string;
  description?: string;
  status: TodoStatus;
  priority: Priority;
  project: "target" | "self";
  agentType?: string;
  assignedAgent?: string;
  branch?: string;
  parentId?: string;
  dependsOn: string[];
  context?: string;
  result?: string;
  error?: string;
  stageId?: number;
  taskRef?: string;
  retryCount: number;
  maxRetries: number;
  nextRetryAt?: string;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
}

export interface OrchestratorState {
  todos: TodoItem[];
  activeAgents: AgentInfo[];
  lastEventId: number;
  completedSinceRetrospective: number;
}

export interface AgentInfo {
  id: string;
  type: string;
  taskId: string;
  status: "running" | "idle";
  iteration: number;
  startedAt: string;
}

// --- Persistence ---

function statePath(): string {
  return join(saivageDir(), "state");
}

function stateFilePath(): string {
  return join(statePath(), "orchestrator.json");
}

export function createEmptyState(): OrchestratorState {
  return {
    todos: [],
    activeAgents: [],
    lastEventId: 0,
    completedSinceRetrospective: 0,
  };
}

export function loadState(): OrchestratorState {
  const fp = stateFilePath();
  if (!existsSync(fp)) return createEmptyState();
  try {
    const raw = JSON.parse(readFileSync(fp, "utf-8"));
    // Backfill new fields for existing state files
    if (raw.completedSinceRetrospective === undefined) {
      raw.completedSinceRetrospective = 0;
    }
    // Backfill retry fields on todos
    if (Array.isArray(raw.todos)) {
      for (const t of raw.todos) {
        if (t.retryCount === undefined) t.retryCount = 0;
        if (t.maxRetries === undefined) t.maxRetries = 2;
      }
    }
    return raw as OrchestratorState;
  } catch {
    return createEmptyState();
  }
}

export function saveState(state: OrchestratorState): void {
  const dir = statePath();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const fp = stateFilePath();
  const tmp = fp + ".tmp";
  writeFileSync(tmp, JSON.stringify(state, null, 2) + "\n", "utf-8");
  renameSync(tmp, fp);
}

// --- Helpers ---

export function findTodo(state: OrchestratorState, id: string): TodoItem | undefined {
  return state.todos.find((t) => t.id === id);
}

/** Pending tasks whose dependencies are ALL satisfied — ready to dispatch */
export function pendingTodos(state: OrchestratorState): TodoItem[] {
  const now = Date.now();
  return state.todos
    .filter((t) => t.status === "pending")
    .filter((t) => {
      // Respect retry cooldown
      if (t.nextRetryAt && new Date(t.nextRetryAt).getTime() > now) return false;
      return true;
    })
    .filter((t) => t.dependsOn.every((dep) => {
      const depTodo = findTodo(state, dep);
      return depTodo?.status === "completed";
    }));
}

export function activeTodos(state: OrchestratorState): TodoItem[] {
  return state.todos.filter((t) => t.status === "in-progress");
}

/**
 * Find tasks that are blocked/pending with at least one dependency that is
 * cancelled or failed — these can never become ready without replanning.
 */
export function deadlockedTodos(state: OrchestratorState): TodoItem[] {
  return state.todos
    .filter((t) => t.status === "pending" || t.status === "blocked")
    .filter((t) =>
      t.dependsOn.some((dep) => {
        const d = findTodo(state, dep);
        return d?.status === "cancelled" || d?.status === "failed";
      }),
    );
}

/**
 * Mark pending tasks with unmet dependencies as "blocked",
 * and transition blocked tasks back to "pending" when their deps are met.
 * Returns the number of transitions made.
 */
export function reconcileDependencyStatus(state: OrchestratorState): number {
  let transitions = 0;
  for (const todo of state.todos) {
    if (todo.dependsOn.length === 0) continue;

    const allMet = todo.dependsOn.every((dep) => {
      const d = findTodo(state, dep);
      return d?.status === "completed";
    });

    if (todo.status === "pending" && !allMet) {
      todo.status = "blocked";
      todo.updatedAt = new Date().toISOString();
      transitions++;
    } else if (todo.status === "blocked" && allMet) {
      todo.status = "pending";
      todo.updatedAt = new Date().toISOString();
      transitions++;
    }
  }
  return transitions;
}
