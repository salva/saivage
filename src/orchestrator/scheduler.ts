import type { TodoItem, Priority, AgentInfo } from "./state.js";

/**
 * Priority scheduler: P0 (interactive) > P1 (foreground) > P2 (system) > P3 (background).
 * Within the same priority, FIFO ordering.
 *
 * Concurrency rules:
 * - At most one coder agent at a time (file-collision avoidance)
 * - Researchers, executors, planners may run in parallel
 * - Overall cap: config.agent.maxConcurrentAgents
 */
export class Scheduler {
  private lastUserActivity = Date.now();

  /** Record user activity to boost interactive priority */
  touchUserActivity(): void {
    this.lastUserActivity = Date.now();
  }

  /** Time since last user activity in ms */
  idleTimeMs(): number {
    return Date.now() - this.lastUserActivity;
  }

  /** Whether the user appears idle (no activity for 2 minutes) */
  isUserIdle(): boolean {
    return this.idleTimeMs() > 120_000;
  }

  /**
   * Sort ready items by priority, then by creation time.
   * Returns a new sorted array — does not mutate input.
   */
  rank(items: TodoItem[]): TodoItem[] {
    return [...items].sort((a, b) => {
      if (a.priority !== b.priority) return a.priority - b.priority;
      return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
    });
  }

  /**
   * Pick the next N items to dispatch, given concurrency limit.
   * Enforces coder serialization: at most one coder agent at a time.
   */
  pickNext(
    ready: TodoItem[],
    maxConcurrent: number,
    currentActive: number,
    activeAgents: AgentInfo[] = [],
  ): TodoItem[] {
    let slots = maxConcurrent - currentActive;
    if (slots <= 0) return [];

    const ranked = this.rank(ready);

    // If user is idle, allow background tasks
    // If user is active, only allow P0-P2
    const filtered = this.isUserIdle()
      ? ranked
      : ranked.filter((t) => t.priority <= 2);

    // Check if a coder is already running
    const coderRunning = activeAgents.some((a) => a.type === "coder");

    const picked: TodoItem[] = [];
    for (const item of filtered) {
      if (slots <= 0) break;

      const isCoder = (item.agentType ?? "coder") === "coder";

      // Enforce coder serialization: skip coder tasks if one is already running
      if (isCoder && (coderRunning || picked.some((p) => (p.agentType ?? "coder") === "coder"))) {
        continue;
      }

      picked.push(item);
      slots--;
    }

    return picked;
  }
}
