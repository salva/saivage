/**
 * Saivage — Crash Recovery
 * On startup: read runtime.json, detect stale PID, reconstruct state
 * from disk, reset in-progress and aborted tasks to pending.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { readDoc, readDocOrNull, writeDoc } from "../store/documents.js";
import {
  RuntimeStateSchema,
  TaskListSchema,
  TaskReportSchema,
  StageSummarySchema,
  type RuntimeState,
  type AgentState,
  type TaskList,
  type TaskReport,
  type StageSummary,
} from "../types.js";
import { log } from "../log.js";
import type { PlanService } from "../mcp/plan-server.js";
import type { ProjectContext } from "../store/project.js";

export interface RecoveryResult {
  /** Whether recovery was needed. */
  recovered: boolean;
  /** Stage ID that was being processed, if any. */
  stageId: string | null;
  /** Whether a summary.json exists but stage isn't archived to history. */
  needsArchival: boolean;
  /** Summary to archive, if needsArchival is true. */
  summary?: StageSummary;
}

/**
 * Check if another instance is already running.
 * Returns true if another process owns the runtime state.
 */
export function isAnotherInstanceRunning(runtimeStatePath: string): boolean {
  const state = readDocOrNull(runtimeStatePath, RuntimeStateSchema);
  if (!state) return false;
  if (state.status === "idle") return false;

  // Check if the PID is alive
  try {
    process.kill(state.pid, 0); // Signal 0 = check existence
    return true; // Process is alive
  } catch {
    return false; // Process is dead → stale state
  }
}

/**
 * Run crash recovery for a project.
 * Reconstructs state from disk and resets interrupted tasks.
 */
export function recoverFromCrash(
  project: ProjectContext,
  planService: PlanService,
): RecoveryResult {
  const runtimeStatePath = project.paths.runtimeState;

  // Read old runtime state
  const oldState = readDocOrNull(runtimeStatePath, RuntimeStateSchema);
  if (!oldState || oldState.status === "idle") {
    return { recovered: false, stageId: null, needsArchival: false };
  }

  log.info(`[recovery] Detected stale runtime state (PID: ${oldState.pid}, status: ${oldState.status})`);

  const stageId = oldState.current_stage_id;
  if (!stageId) {
    log.info("[recovery] No current stage — fresh start");
    return { recovered: true, stageId: null, needsArchival: false };
  }

  const stageDir = join(project.paths.stages, stageId);
  const summaryPath = join(stageDir, "summary.json");
  const tasksPath = join(stageDir, "tasks.json");
  const reportsDir = join(stageDir, "reports");

  // Check if summary.json exists (stage reached terminal result before crash)
  if (existsSync(summaryPath)) {
    const summary = readDocOrNull(summaryPath, StageSummarySchema);
    if (summary) {
      // Check if the stage is still in the active plan (not yet archived)
      const plan = planService.plan_get();
      if (plan && !("code" in plan)) {
        const stillActive = plan.stages.some((s) => s.id === stageId);
        if (stillActive) {
          log.info(
            `[recovery] Stage ${stageId} has summary but not archived — Planner must call plan_complete_stage()`,
          );
          return {
            recovered: true,
            stageId,
            needsArchival: true,
            summary,
          };
        }
      }
      // Already archived, nothing to do for this stage
      return { recovered: true, stageId, needsArchival: false };
    }
  }

  // Check tasks.json — reset in-progress and aborted tasks
  if (existsSync(tasksPath)) {
    const taskList = readDocOrNull(tasksPath, TaskListSchema);
    if (taskList) {
      let modified = false;

      for (const task of taskList.tasks) {
        // Check for orphaned report files
        if (
          task.status === "pending" ||
          task.status === "in-progress" ||
          task.status === "aborted"
        ) {
          const reportPath = join(reportsDir, `${task.id}.json`);
          if (existsSync(reportPath)) {
            const report = readDocOrNull(reportPath, TaskReportSchema);
            if (report) {
              if (
                report.status === "completed" &&
                report.commits.length > 0
              ) {
                log.info(
                  `[recovery] Task ${task.id}: report exists with commits — marking completed`,
                );
                task.status = "completed";
                task.completed_at = report.completed_at;
                modified = true;
                continue;
              } else {
                log.info(
                  `[recovery] Task ${task.id}: report exists but no commits — marking failed`,
                );
                task.status = "failed";
                modified = true;
                continue;
              }
            }
          }

          // No report — reset to pending
          if (task.status === "in-progress" || task.status === "aborted") {
            log.info(
              `[recovery] Task ${task.id}: resetting ${task.status} → pending`,
            );
            task.status = "pending";
            task.started_at = undefined;
            modified = true;
          }
        }
      }

      if (modified) {
        taskList.updated_at = new Date().toISOString();
        writeDoc(tasksPath, taskList, TaskListSchema);
      }
    }
  }

  return { recovered: true, stageId, needsArchival: false };
}

/**
 * Write the runtime state file (updated on every significant state change).
 */
export function writeRuntimeState(
  path: string,
  state: RuntimeState,
): void {
  writeDoc(path, state, RuntimeStateSchema);
}

/**
 * Create an initial runtime state for a new run.
 */
export function createRuntimeState(
  stageId: string | null = null,
): RuntimeState {
  return {
    status: "running",
    current_stage_id: stageId,
    active_agents: [],
    started_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    pid: process.pid,
  };
}

/**
 * Tracks agent lifecycle and persists runtime state to disk.
 * Used by bootstrap to keep `runtime-state.json` accurate for the dashboard.
 */
export class RuntimeTracker {
  private agents = new Map<string, AgentState>();
  private currentStageId: string | null = null;
  private startedAt: string;

  constructor(private statePath: string) {
    this.startedAt = new Date().toISOString();
  }

  /** Register an agent as active and persist. */
  agentStarted(agentId: string, agentType: AgentState["agent_type"], taskId?: string): void {
    this.agents.set(agentId, {
      agent_type: agentType,
      agent_id: agentId,
      status: "running",
      current_task_id: taskId,
      started_at: new Date().toISOString(),
    });
    this.flush();
  }

  /** Remove an agent and persist. */
  agentStopped(agentId: string): void {
    this.agents.delete(agentId);
    this.flush();
  }

  /** Persist a heartbeat for an active agent without changing lifecycle state. */
  agentActivity(agentId: string): void {
    if (!this.agents.has(agentId)) return;
    this.flush();
  }

  /** Update the current stage ID and persist. */
  setCurrentStage(stageId: string | null): void {
    this.currentStageId = stageId;
    this.flush();
  }

  private flush(): void {
    const state: RuntimeState = {
      status: "running",
      current_stage_id: this.currentStageId,
      active_agents: [...this.agents.values()],
      started_at: this.startedAt,
      updated_at: new Date().toISOString(),
      pid: process.pid,
    };
    writeRuntimeState(this.statePath, state);
  }
}
