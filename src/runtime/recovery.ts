/**
 * Saivage — Crash Recovery
 * On startup: read runtime.json, detect stale PID, reconstruct state
 * from disk, reset in-progress and aborted tasks to pending.
 */

import {
  existsSync,
  readFileSync,
  openSync,
  closeSync,
  writeFileSync,
  unlinkSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { readDoc, readDocOrNull, writeDoc, ensureDir, sweepStaleTempFiles } from "../store/documents.js";
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

  // PID liveness alone is unsafe (PIDs are reused on Linux). Bound the
  // check by recorded `started_at`: if the file claims this process started
  // a very long time ago, the recorded PID almost certainly belongs to
  // someone else now and this state is stale.
  const startedMs = Date.parse(state.started_at);
  if (Number.isFinite(startedMs)) {
    const ageDays = (Date.now() - startedMs) / (24 * 60 * 60 * 1000);
    if (ageDays > 14) return false;
  }

  // Check if the PID is alive
  try {
    process.kill(state.pid, 0); // Signal 0 = check existence
    return true; // Process is alive
  } catch {
    return false; // Process is dead → stale state
  }
}

export interface RuntimeLock {
  /** Release the lock (delete the lockfile). Idempotent. */
  release: () => void;
}

/**
 * Acquire an exclusive runtime lock for this project. Uses an
 * `O_CREAT|O_EXCL` file create so two concurrent bootstraps cannot both
 * succeed even if their `isAnotherInstanceRunning` checks both returned
 * false. If the lock file exists but its PID is dead (or its recorded boot
 * timestamp is older than the safety horizon), the stale lock is removed
 * and the acquisition is retried once.
 */
export function acquireRuntimeLock(saivageDir: string): RuntimeLock {
  const stateDir = join(saivageDir, "tmp", "state");
  ensureDir(stateDir);
  const lockPath = join(stateDir, "runtime.lock");

  const tryCreate = (): boolean => {
    try {
      const fd = openSync(lockPath, "wx");
      try {
        const payload = JSON.stringify({ pid: process.pid, started_at: new Date().toISOString() }) + "\n";
        writeFileSync(fd, payload, "utf-8");
      } finally {
        closeSync(fd);
      }
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw err;
    }
  };

  if (tryCreate()) return makeReleaser(lockPath);

  // Lock exists. Decide whether it's stale.
  let stale = false;
  try {
    const raw = readFileSync(lockPath, "utf-8");
    const parsed = JSON.parse(raw) as { pid?: number; started_at?: string };
    const pid = typeof parsed.pid === "number" ? parsed.pid : null;
    const startedMs = parsed.started_at ? Date.parse(parsed.started_at) : NaN;

    if (!pid) {
      stale = true;
    } else {
      try {
        process.kill(pid, 0);
        // Process exists; check the age horizon.
        if (Number.isFinite(startedMs)) {
          const ageDays = (Date.now() - startedMs) / (24 * 60 * 60 * 1000);
          if (ageDays > 14) stale = true;
        }
      } catch {
        stale = true; // PID dead → lock is stale.
      }
    }
  } catch {
    // Unreadable lock file — treat as stale rather than refusing forever.
    stale = true;
  }

  if (stale) {
    try { unlinkSync(lockPath); } catch { /* ignore */ }
    if (tryCreate()) {
      log.info("[recovery] Removed stale runtime.lock and re-acquired");
      return makeReleaser(lockPath);
    }
  }

  throw new Error(
    "Another Saivage instance is already running (runtime.lock held). " +
      "Stop it first or delete the stale lock under .saivage/tmp/state/.",
  );
}

function makeReleaser(lockPath: string): RuntimeLock {
  let released = false;
  return {
    release: () => {
      if (released) return;
      released = true;
      try { unlinkSync(lockPath); } catch { /* ignore */ }
    },
  };
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

  // Sweep stale `*.tmp` files left over from interrupted writes. Cheap and
  // keeps `.saivage/` tidy; failures here are logged but don't block boot.
  try {
    const stateDir = dirname(runtimeStatePath);
    const removedState = sweepStaleTempFiles(stateDir);
    const removedRoot = sweepStaleTempFiles(project.saivageDir);
    if (removedState + removedRoot > 0) {
      log.info(`[recovery] Swept ${removedState + removedRoot} stale .tmp file(s)`);
    }
  } catch (err) {
    log.warn(`[recovery] Tmp sweep failed: ${err instanceof Error ? err.message : String(err)}`);
  }

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

  const legacyPath = legacyRuntimeStatePath(path);
  if (legacyPath && legacyPath !== path) {
    writeDoc(legacyPath, state, RuntimeStateSchema);
  }
}

function legacyRuntimeStatePath(path: string): string | null {
  if (!path.endsWith(join("tmp", "state", "runtime.json"))) return null;

  const saivageDir = dirname(dirname(dirname(path)));
  return join(saivageDir, "runtime", "runtime-state.json");
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
 * Used by bootstrap to keep the runtime state accurate for the dashboard.
 */
export class RuntimeTracker {
  private agents = new Map<string, AgentState>();
  private currentStageId: string | null = null;
  private startedAt: string;
  private frozen = false;

  constructor(private statePath: string) {
    this.startedAt = new Date().toISOString();
  }

  /** Register an agent as active and persist. */
  agentStarted(agentId: string, agentType: AgentState["agent_type"], taskId?: string): void {
    if (this.frozen) return;
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
    if (this.frozen) return;
    this.agents.delete(agentId);
    this.flush();
  }

  /** Persist a heartbeat for an active agent without changing lifecycle state. */
  agentActivity(agentId: string): void {
    if (this.frozen) return;
    if (!this.agents.has(agentId)) return;
    this.flush();
  }

  /** Update the current stage ID and persist. */
  setCurrentStage(stageId: string | null): void {
    if (this.frozen) return;
    this.currentStageId = stageId;
    this.flush();
  }

  /**
   * Stop persisting state. Used by `runtime.shutdown()` so that any
   * lingering activity callbacks from agents finishing in flight cannot
   * race with the final "idle" write and flip the status back to
   * "running" on disk.
   */
  freeze(reason: string = "shutdown"): void {
    if (this.frozen) return;
    this.frozen = true;
    log.info(`[recovery] RuntimeTracker frozen (${reason})`);
  }

  private flush(): void {
    if (this.frozen) return;
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
