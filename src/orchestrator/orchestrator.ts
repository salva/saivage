import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { EventBus } from "./eventBus.js";
import { Scheduler } from "./scheduler.js";
import { BranchManager } from "./branchManager.js";
import {
  loadState,
  saveState,
  findTodo,
  pendingTodos,
  activeTodos,
  deadlockedTodos,
  reconcileDependencyStatus,
  createEmptyState,
  type OrchestratorState,
  type TodoItem,
  type Priority,
  type AgentInfo,
} from "./state.js";
import {
  PlanManager,
  taskRefToTodoId,
  type MasterPlan,
  type StagePlan,
  type StageTask,
  type StageInfo,
} from "./planManager.js";
import type { ModelRouter } from "../providers/router.js";
import type { McpRuntime } from "../mcp/runtime.js";
import { SubAgent, type SubAgentDeps } from "../agents/base.js";
import { getAgentType } from "../agents/registry.js";
import type { TaskAssignment } from "../agents/protocol.js";
import type { SaivageConfig } from "../config.js";
import { saivageDir } from "../config.js";
import { discoverSkills, type Skill } from "../skills/index.js";
import { parseModelId } from "../providers/types.js";
import { log } from "../log.js";

export interface OrchestratorDeps {
  config: SaivageConfig;
  router: ModelRouter;
  runtime: McpRuntime;
  eventBus: EventBus;
}

export class Orchestrator {
  private state: OrchestratorState;
  private scheduler: Scheduler;
  private branchManager: BranchManager;
  private deps: OrchestratorDeps;
  private running = false;
  private runningAgents = new Map<string, SubAgent>();
  private processInterval: ReturnType<typeof setInterval> | null = null;
  private processing = false;
  private allSkills: Skill[] = [];

  // Autonomous planning state
  private lastPlanningAt = 0;
  private planning = false;
  private planningStartedAt = 0;
  private stageRemediationCount = 0;
  private lastActiveStageId: number | null = null;
  private static readonly MAX_REMEDIATIONS = 3;
  private static readonly PLANNING_TIMEOUT_MS = 5 * 60 * 1000; // 5 min safety

  // Layered planning (Spec 14)
  private planManager: PlanManager | null = null;

  constructor(deps: OrchestratorDeps) {
    this.deps = deps;
    this.state = loadState();
    this.scheduler = new Scheduler();
    this.branchManager = new BranchManager(
      process.cwd(),
      process.cwd(), // self CWD — same for now, dual-project in Stage 10
    );

    // Initialize planning docs if project root is configured
    const proj = deps.config.project;
    const auto = deps.config.autonomy;
    if (proj.root && auto.enabled) {
      this.planManager = new PlanManager(proj.root, auto.planDocsPath);
    }
  }

  /** Start the orchestrator event loop */
  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;

    log.info("Orchestrator starting");

    // Discover skills from all sources
    const projRoot = this.deps.config.project?.root;
    this.allSkills = discoverSkills(
      process.cwd(),  // Saivage root (built-in skills)
      projRoot || undefined,  // Target project (workspace skills)
    );
    if (this.allSkills.length > 0) {
      log.info(`Skills loaded: ${this.allSkills.map(s => s.metadata.name).join(", ")}`);
    }

    // Initialize layered planning (master plan → stage plan → tasks)
    if (this.planManager) {
      await this.initializePlanning();
    }

    // Recover orphaned in-progress tasks (from a previous crash/restart)
    const orphaned = activeTodos(this.state);
    if (orphaned.length > 0) {
      for (const todo of orphaned) {
        todo.status = "pending";
        todo.updatedAt = new Date().toISOString();
        log.info(`Recovered orphaned task: "${todo.goal.slice(0, 80)}..."`);
      }
      this.state.activeAgents = [];
      saveState(this.state);
    }

    // Subscribe to events
    this.deps.eventBus.on("agent:completed", (data) => this.onAgentCompleted(data));
    this.deps.eventBus.on("agent:failed", (data) => this.onAgentFailed(data));
    this.deps.eventBus.on("agent:blocked", (data) => this.onAgentBlocked(data));
    this.deps.eventBus.on("agent:progress", (data) => this.onAgentProgress(data));

    // Process loop — check for dispatchable work every 2 seconds
    this.processInterval = setInterval(() => {
      this.processQueue().catch((err) => {
        log.error(`Orchestrator process error: ${err}`);
      });
    }, 2_000);

    // Initial processing
    await this.processQueue();

    log.info("Orchestrator started");
  }

  /** Stop the orchestrator */
  async stop(): Promise<void> {
    this.running = false;
    if (this.processInterval) {
      clearInterval(this.processInterval);
      this.processInterval = null;
    }

    // Cancel running agents
    for (const [id, agent] of this.runningAgents) {
      agent.cancel();
      log.info(`Cancelled agent ${id}`);
    }
    this.runningAgents.clear();

    saveState(this.state);
    log.info("Orchestrator stopped");
  }

  /** Submit work programmatically (without going through MCP) */
  submitWork(params: {
    goal: string;
    priority?: Priority;
    agentType?: string;
    project?: "target" | "self";
    context?: string;
    dependsOn?: string[];
  }): string {
    const todo: TodoItem = {
      id: randomUUID(),
      goal: params.goal,
      status: "pending",
      priority: params.priority ?? 1,
      project: params.project ?? "target",
      agentType: params.agentType ?? "coder",
      dependsOn: params.dependsOn ?? [],
      context: params.context,
      retryCount: 0,
      maxRetries: 2,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    this.state.todos.push(todo);
    saveState(this.state);
    log.info(`Work submitted: "${todo.goal}" [${todo.id}]`);

    // Trigger immediate processing
    this.processQueue().catch(() => {});

    return todo.id;
  }

  /** Get current state (for status display) */
  getState(): OrchestratorState {
    return this.state;
  }

  /** Record user activity to gate background task scheduling */
  touchUserActivity(): void {
    this.scheduler.touchUserActivity();
  }

  /** Get conversation log for a running agent */
  getAgentLog(agentId: string, maxEntries = 50) {
    const agent = this.runningAgents.get(agentId);
    if (!agent) return null;
    const info = this.state.activeAgents.find((a) => a.id === agentId);
    const todo = info ? findTodo(this.state, info.taskId) : null;
    return {
      agentId,
      taskId: info?.taskId,
      goal: todo?.goal,
      type: info?.type,
      iteration: info?.iteration ?? 0,
      startedAt: info?.startedAt,
      entries: agent.getConversationLog(maxEntries),
    };
  }

  /** Get plan data for the web UI */
  getPlanData() {
    if (!this.planManager) return null;
    const masterPlan = this.planManager.readMasterPlan();
    const config = this.deps.config;
    const activeStage = masterPlan?.stages.find((s) => s.status === "active");
    const activeStagePlan = activeStage
      ? this.planManager.readStagePlan(activeStage.id)
      : null;
    return {
      project: {
        description: config.project.description,
        objectives: config.autonomy.objectives,
        root: config.project.root,
      },
      masterPlan,
      activeStagePlan,
      journal: this.planManager.readJournalTail(100),
    };
  }

  /** Get a specific stage plan */
  getStagePlan(stageId: number) {
    return this.planManager?.readStagePlan(stageId) ?? null;
  }

  // --- Replanning ---

  /**
   * Scoped replanning: the LLM classifies the change scope (task/stage/plan)
   * and executes the appropriate level of change.
   */
  async replan(newRequirements: string): Promise<void> {
    log.info(`Replan requested: "${newRequirements.slice(0, 100)}"`);
    await this.deps.eventBus.emit("orchestrator:planning", {
      status: "replan_started",
      message: newRequirements.slice(0, 200),
    });

    try {
      const proj = this.deps.config.project;
      const plan = this.planManager?.readMasterPlan();
      const activeStage = plan?.stages.find((s) => s.status === "active");
      const stagePlan = activeStage
        ? this.planManager?.readStagePlan(activeStage.id)
        : null;

      const pendingTasks = this.state.todos
        .filter((t) => t.status === "pending" || t.status === "blocked")
        .map((t) => `  - [${t.id}] (${t.agentType ?? "coder"}) ${t.goal}`)
        .join("\n");

      const runningTasks = this.state.activeAgents
        .map((a) => {
          const todo = findTodo(this.state, a.taskId);
          return `  - [${a.taskId}] (${a.type}, iter ${a.iteration}) ${todo?.goal ?? "unknown"}`;
        })
        .join("\n");

      const system = `You are the Saivage orchestrator replanner. The user has changed direction or priorities.
Determine the scope of this change and output the appropriate response.

## Project
${proj.root ? `Root: ${proj.root}` : ""}
${proj.description || ""}

## Master Plan
${plan ? `Vision: ${plan.vision}
Stages: ${plan.stages.map((s) => `${s.id}. ${s.title} [${s.status}]`).join(", ")}
Active stage: ${activeStage ? `${activeStage.id}: ${activeStage.title}` : "none"}` : "(no master plan)"}

## Current Stage Plan
${stagePlan ? `Goal: ${stagePlan.goal}\nTasks:\n${stagePlan.tasks.map((t) => `  - ${t.ref}: ${t.title} [${t.status}]`).join("\n")}` : "(no stage plan)"}

## Running Agents
${runningTasks || "(none)"}

## Pending Tasks
${pendingTasks || "(none)"}

## Instructions
Classify scope:
- "task": Cancel/add/modify specific tasks only. Stage and master plan unchanged.
- "stage": Regenerate current stage plan with new tasks. Master plan unchanged.
- "plan": Change project direction — new master plan and stage.

Output a JSON object (no markdown fences):
{
  "scope": "task" | "stage" | "plan",
  "reasoning": "Why this scope was chosen",
  "cancelTaskIds": ["id1"],
  "cancelAgentTaskIds": ["taskId of running agent to cancel"],
  "newTasks": [{"goal": "...", "agentType": "coder", "priority": 1, "context": "optional"}],
  "masterPlanUpdate": null or {"vision": "...", "successCriteria": ["..."], "stages": [{"title": "...", "goal": "...", "entryCriteria": "...", "exitCriteria": "..."}]},
  "stagePlanUpdate": null or {"goal": "...", "approach": "...", "tasks": [{"title": "...", "goal": "...", "agentType": "coder", "dependsOn": []}], "notes": ""},
  "journalEntry": "what changed and why"
}

Rules:
- Cancel running agents ONLY if they directly conflict.
- For task-level: set masterPlanUpdate and stagePlanUpdate to null.
- For stage-level: set masterPlanUpdate to null.
- Max ${this.deps.config.autonomy.maxTasksPerCycle} new tasks for task-level.`;

      const modelSpec = this.deps.router.resolveModelForRole("orchestrator");
      const { model } = parseModelId(modelSpec);

      const response = await this.deps.router.chat({
        modelSpec,
        model,
        system,
        messages: [
          { role: "user", content: `## New Requirements\n${newRequirements}` },
        ],
        maxTokens: 8192,
      });

      log.info(
        `Replan: LLM responded (${response.usage.inputTokens}in/${response.usage.outputTokens}out)`,
      );

      const result = this.parseJsonResponse(response.content) as {
        scope: "task" | "stage" | "plan";
        reasoning: string;
        cancelTaskIds?: string[];
        cancelAgentTaskIds?: string[];
        newTasks?: Array<{
          goal: string;
          agentType?: string;
          priority?: number;
          context?: string;
        }>;
        masterPlanUpdate?: {
          vision: string;
          successCriteria: string[];
          stages: Array<{
            title: string;
            goal: string;
            entryCriteria: string;
            exitCriteria: string;
          }>;
        } | null;
        stagePlanUpdate?: {
          goal: string;
          approach: string;
          tasks: Array<{
            title: string;
            goal: string;
            agentType: string;
            dependsOn: number[];
          }>;
          notes: string;
        } | null;
        journalEntry?: string;
      };

      log.info(`Replan scope: ${result.scope} — ${result.reasoning}`);

      // 1. Cancel tasks
      if (Array.isArray(result.cancelTaskIds)) {
        for (const id of result.cancelTaskIds) {
          this.cancelWork(id);
        }
      }
      if (Array.isArray(result.cancelAgentTaskIds)) {
        for (const id of result.cancelAgentTaskIds) {
          this.cancelRunningTask(id);
        }
      }

      // 2. Execute based on scope
      if (
        result.scope === "plan" &&
        result.masterPlanUpdate &&
        this.planManager
      ) {
        // Plan-level: rebuild everything
        this.cancelAll();

        const today = new Date().toISOString().split("T")[0];
        const auto = this.deps.config.autonomy;
        const newPlan: MasterPlan = {
          version: (plan?.version ?? 0) + 1,
          created: plan?.created ?? today,
          lastUpdated: today,
          activeStage: 1,
          iterative: plan?.iterative ?? false,
          vision: result.masterPlanUpdate.vision,
          objectives: auto.objectives,
          successCriteria: result.masterPlanUpdate.successCriteria || [],
          stages: result.masterPlanUpdate.stages.slice(0, 8).map((s, i) => ({
            id: i + 1,
            title: s.title,
            goal: s.goal,
            status: (i === 0 ? "active" : "pending") as StageInfo["status"],
            entryCriteria: s.entryCriteria,
            exitCriteria: s.exitCriteria,
            started: i === 0 ? today : undefined,
          })),
        };
        this.planManager.writeMasterPlan(newPlan);

        const newActive = newPlan.stages[0];
        if (newActive) {
          await this.generateStagePlan(newActive);
          const sp = this.planManager.readStagePlan(newActive.id);
          if (sp) this.importStageTasks(sp);
        }
      } else if (
        result.scope === "stage" &&
        result.stagePlanUpdate &&
        this.planManager &&
        activeStage
      ) {
        // Stage-level: cancel pending stage tasks, rebuild stage plan
        for (const todo of this.state.todos) {
          if (
            todo.stageId === activeStage.id &&
            (todo.status === "pending" || todo.status === "blocked")
          ) {
            todo.status = "cancelled";
            todo.updatedAt = new Date().toISOString();
          }
        }
        saveState(this.state);

        const today = new Date().toISOString().split("T")[0];
        const newStagePlan: StagePlan = {
          stageId: activeStage.id,
          title: activeStage.title,
          status: "active",
          created: stagePlan?.created ?? today,
          lastUpdated: today,
          goal: result.stagePlanUpdate.goal || activeStage.goal,
          approach: result.stagePlanUpdate.approach || "",
          tasks: result.stagePlanUpdate.tasks.map((t, i) => ({
            ref: `${activeStage.id}.${i + 1}`,
            title: t.title,
            goal: t.goal || t.title,
            agentType: t.agentType || "coder",
            dependsOn: (t.dependsOn || []).map(
              (d) => `${activeStage.id}.${d}`,
            ),
            status: "pending",
          })),
          notes: result.stagePlanUpdate.notes || "",
        };
        this.planManager.writeStagePlan(activeStage.id, newStagePlan);
        this.importStageTasks(newStagePlan);
      } else {
        // Task-level: just add new tasks
        if (Array.isArray(result.newTasks)) {
          const maxTasks = this.deps.config.autonomy.maxTasksPerCycle;
          for (const task of result.newTasks.slice(0, maxTasks)) {
            this.submitWork({
              goal: task.goal,
              agentType:
                typeof task.agentType === "string" ? task.agentType : "coder",
              priority: (typeof task.priority === "number"
                ? task.priority
                : 1) as Priority,
              context:
                typeof task.context === "string" ? task.context : undefined,
            });
          }
        }
      }

      // 3. Journal
      this.appendJournalEntry(
        `REPLAN (${result.scope}): ${newRequirements.slice(0, 80)}`,
        "completed",
        result.reasoning || "User-requested replan",
      );

      log.info(`Replan complete: scope=${result.scope}`);
      await this.deps.eventBus.emit("orchestrator:planning", {
        status: "replan_completed",
        message: result.reasoning ?? "Replan complete",
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error(`Replan error: ${msg}`);
      await this.deps.eventBus.emit("orchestrator:planning", {
        status: "error",
        error: `Replan failed: ${msg}`,
      });
    }
  }

  // --- Queue Management ---

  /**
   * Cancel a pending task (removes from queue).
   * Returns true if the task was found and cancelled.
   */
  cancelWork(taskId: string): boolean {
    const todo = findTodo(this.state, taskId);
    if (!todo) return false;
    if (todo.status === "in-progress") {
      return this.cancelRunningTask(taskId);
    }
    if (todo.status !== "pending" && todo.status !== "blocked") return false;

    todo.status = "cancelled";
    todo.updatedAt = new Date().toISOString();
    saveState(this.state);
    log.info(`Task cancelled: "${todo.goal}" [${taskId}]`);
    return true;
  }

  /**
   * Cancel a running task — stops the agent, reverts its branch, marks as cancelled.
   */
  cancelRunningTask(taskId: string): boolean {
    const todo = findTodo(this.state, taskId);
    if (!todo || todo.status !== "in-progress") return false;

    // Find and cancel the agent
    const agentInfo = this.state.activeAgents.find((a) => a.taskId === taskId);
    if (agentInfo) {
      const agent = this.runningAgents.get(agentInfo.id);
      if (agent) {
        agent.cancel();
        this.runningAgents.delete(agentInfo.id);
      }
      this.state.activeAgents = this.state.activeAgents.filter(
        (a) => a.taskId !== taskId,
      );
    }

    todo.status = "cancelled";
    todo.updatedAt = new Date().toISOString();
    saveState(this.state);

    log.info(`Running task cancelled: "${todo.goal}" [${taskId}]`);

    // Journal the cancellation
    this.appendJournalEntry(todo.goal, "failed", "Cancelled by user request");

    return true;
  }

  /**
   * Send an out-of-band message to a running agent.
   * The message is injected into the agent's conversation at the next iteration,
   * enabling runtime redirection without killing it.
   */
  messageAgent(agentId: string, message: string): boolean {
    const agent = this.runningAgents.get(agentId);
    if (!agent) return false;
    agent.injectMessage(message);
    log.info(`Message injected into agent ${agentId.slice(0, 8)}: "${message.slice(0, 80)}"`);
    return true;
  }

  /**
   * Modify a pending task's goal, priority, or agent type.
   */
  modifyWork(taskId: string, changes: {
    goal?: string;
    priority?: Priority;
    agentType?: string;
    context?: string;
  }): boolean {
    const todo = findTodo(this.state, taskId);
    if (!todo || todo.status !== "pending") return false;

    if (changes.goal !== undefined) todo.goal = changes.goal;
    if (changes.priority !== undefined) todo.priority = changes.priority;
    if (changes.agentType !== undefined) todo.agentType = changes.agentType;
    if (changes.context !== undefined) todo.context = changes.context;
    todo.updatedAt = new Date().toISOString();
    saveState(this.state);
    log.info(`Task modified: "${todo.goal}" [${taskId}]`);
    return true;
  }

  /**
   * Cancel all pending tasks. Returns the number of tasks cancelled.
   */
  clearPendingQueue(): number {
    let count = 0;
    for (const todo of this.state.todos) {
      if (todo.status === "pending" || todo.status === "blocked") {
        todo.status = "cancelled";
        todo.updatedAt = new Date().toISOString();
        count++;
      }
    }
    saveState(this.state);
    if (count > 0) log.info(`Cleared ${count} pending task(s)`);
    return count;
  }

  /**
   * Cancel all pending tasks AND stop all running agents.
   * Use when doing a full direction change.
   * Returns { pendingCancelled, agentsCancelled }.
   */
  cancelAll(): { pendingCancelled: number; agentsCancelled: number } {
    const pendingCancelled = this.clearPendingQueue();

    let agentsCancelled = 0;
    const activeTaskIds = this.state.activeAgents.map((a) => a.taskId);
    for (const taskId of activeTaskIds) {
      if (this.cancelRunningTask(taskId)) agentsCancelled++;
    }

    log.info(`Cancel all: ${pendingCancelled} pending + ${agentsCancelled} running`);
    return { pendingCancelled, agentsCancelled };
  }

  // --- Event Handlers ---

  private async onAgentCompleted(data: unknown): Promise<void> {
    const { taskId, result, agentId } = data as {
      taskId: string;
      result: string;
      agentId: string;
    };

    const todo = findTodo(this.state, taskId);
    if (todo) {
      todo.status = "completed";
      todo.result = result;
      todo.updatedAt = new Date().toISOString();
      todo.completedAt = new Date().toISOString();
      log.info(`Task completed: "${todo.goal}" [${taskId}]`);

      // Try to merge the work branch
      const merged = await this.branchManager.mergeBack(taskId, todo.project);
      if (merged) {
        log.info(`Branch merged for task ${taskId.slice(0, 8)}`);
      }

      // Update journal with completion entry
      this.appendJournalEntry(todo.goal, "completed", result);

      // Write-through: update stage plan file
      if (todo.stageId != null && todo.taskRef && this.planManager) {
        this.planManager.updateTaskInStagePlan(todo.stageId, todo.taskRef, {
          status: "completed",
          result: result?.slice(0, 300),
        });
      }

      this.state.completedSinceRetrospective++;
    }

    // Persist the agent's conversation for debugging
    this.persistTranscript(agentId, taskId, "completed");

    // Remove from active agents
    this.state.activeAgents = this.state.activeAgents.filter(
      (a) => a.id !== agentId,
    );
    this.runningAgents.delete(agentId);
    saveState(this.state);

    // Emit orchestrator event
    await this.deps.eventBus.emit("orchestrator:completed", {
      todoId: taskId,
      result,
    });

    // Prune old completed/failed/cancelled todos to prevent state bloat
    this.pruneOldTodos();

    // Reconcile dependency status: unblock tasks whose deps are now met
    reconcileDependencyStatus(this.state);
    saveState(this.state);

    // Run retrospective if enough tasks have completed (don't wait for empty queue)
    await this.maybeRetrospective();

    // Check if active stage is complete and advance if so
    await this.checkStageCompletion();

    // Process queue — completing one task may unblock others
    await this.processQueue();
  }

  private async onAgentFailed(data: unknown): Promise<void> {
    const { taskId, error, agentId } = data as {
      taskId: string;
      error: string;
      agentId: string;
    };

    const todo = findTodo(this.state, taskId);
    if (todo) {
      // Determine if this failure is retryable
      const nonRetryable = [
        "Agent appears stuck",
        "Rogue judge terminated",
        "Cancelled by user",
        "Unknown agent type",
        "Dependency failed",
      ];
      const isRetryable = !nonRetryable.some((pat) => error.includes(pat));

      if (isRetryable && todo.retryCount < todo.maxRetries) {
        // Schedule retry with exponential backoff: 30s, 120s, 480s
        todo.retryCount++;
        const delaySec = 30 * Math.pow(4, todo.retryCount - 1);
        todo.status = "pending";
        todo.error = `Retry ${todo.retryCount}/${todo.maxRetries}: ${error}`;
        todo.nextRetryAt = new Date(Date.now() + delaySec * 1000).toISOString();
        todo.assignedAgent = undefined;
        todo.updatedAt = new Date().toISOString();
        log.info(`Task will retry (${todo.retryCount}/${todo.maxRetries}) in ${delaySec}s: "${todo.goal.slice(0, 60)}"`);
      } else {
        todo.status = "failed";
        todo.error = error;
        todo.updatedAt = new Date().toISOString();
        log.warn(`Task failed: "${todo.goal}" — ${error}`);

        // Update journal with failure entry
        this.appendJournalEntry(todo.goal, "failed", error);

        // Write-through: update stage plan file
        if (todo.stageId != null && todo.taskRef && this.planManager) {
          this.planManager.updateTaskInStagePlan(todo.stageId, todo.taskRef, {
            status: "failed",
            result: error?.slice(0, 300),
          });
        }

        // Cascade-fail: any pending tasks that depend on this one
        const dependents = this.state.todos.filter(
          (t) => (t.status === "pending" || t.status === "blocked") && t.dependsOn.includes(taskId),
        );
        for (const dep of dependents) {
          dep.status = "failed";
          dep.error = `Dependency failed: ${todo.goal.slice(0, 80)} — ${error.slice(0, 120)}`;
          dep.updatedAt = new Date().toISOString();
          log.warn(`Cascade-failed: "${dep.goal.slice(0, 60)}" (depends on ${taskId.slice(0, 8)})`);
        }
      }
    }

    // Persist the agent's conversation for debugging
    this.persistTranscript(agentId, taskId, "failed");

    this.state.activeAgents = this.state.activeAgents.filter(
      (a) => a.id !== agentId,
    );
    this.runningAgents.delete(agentId);

    // Reconcile dependency status after failure
    reconcileDependencyStatus(this.state);
    saveState(this.state);

    await this.deps.eventBus.emit("orchestrator:failed", {
      todoId: taskId,
      error,
    });

    // Check stage completion and process queue after failure —
    // a failed task makes all stage tasks terminal which should trigger advancement
    await this.checkStageCompletion();
    await this.processQueue();
  }

  private async onAgentBlocked(data: unknown): Promise<void> {
    const { taskId, reason, missingTool, agentId } = data as {
      taskId: string;
      reason: string;
      missingTool?: string;
      agentId: string;
    };

    const todo = findTodo(this.state, taskId);
    if (todo) {
      todo.status = "blocked";
      todo.error = reason;
      todo.updatedAt = new Date().toISOString();
      log.warn(`Task blocked: "${todo.goal}" — ${reason}`);
    }

    // Release the concurrency slot
    this.state.activeAgents = this.state.activeAgents.filter(
      (a) => a.id !== agentId,
    );
    this.runningAgents.delete(agentId);
    saveState(this.state);

    await this.deps.eventBus.emit("orchestrator:failed", {
      todoId: taskId,
      error: `Blocked: ${reason}`,
    });

    // TODO (Stage 8): If missingTool, trigger generator pipeline
    if (missingTool) {
      log.info(`Missing tool "${missingTool}" — generator not yet implemented`);
    }
  }

  private async onAgentProgress(data: unknown): Promise<void> {
    const { agentId, iteration, summary } = data as {
      agentId: string;
      taskId: string;
      iteration: number;
      summary: string;
    };

    const agentInfo = this.state.activeAgents.find((a) => a.id === agentId);
    if (agentInfo) {
      agentInfo.iteration = iteration;

      // Check for excessive wall-clock time (>10 min) — log warning,
      // but don't kill. The SubAgent's own rogue detection handles spinning.
      if (agentInfo.startedAt) {
        const elapsed = Date.now() - new Date(agentInfo.startedAt).getTime();
        if (elapsed > 10 * 60 * 1000 && iteration > 0 && iteration % 10 === 0) {
          log.warn(
            `Agent ${agentId} has been running for ${Math.round(elapsed / 60000)}min (iter ${iteration})`,
          );
        }
      }
    }
    // Don't persist on every progress event — too frequent
  }

  // --- Queue Processing ---

  private async processQueue(): Promise<void> {
    if (!this.running || this.processing) return;
    this.processing = true;
    try {
      // Safety: reset planning flag if stuck for too long
      if (this.planning && this.planningStartedAt > 0 &&
          Date.now() - this.planningStartedAt > Orchestrator.PLANNING_TIMEOUT_MS) {
        log.warn(`Planning flag stuck for ${Math.round((Date.now() - this.planningStartedAt) / 1000)}s — force-resetting`);
        this.planning = false;
        this.planningStartedAt = 0;
      }

      // Reconcile blocked/pending status based on dependencies
      const transitions = reconcileDependencyStatus(this.state);
      if (transitions > 0) saveState(this.state);

      const ready = pendingTodos(this.state);
      const currentActive = activeTodos(this.state).length;
      const maxConcurrent = this.deps.config.agent.maxConcurrentAgents;

      const toDispatch = this.scheduler.pickNext(
        ready,
        maxConcurrent,
        currentActive,
        this.state.activeAgents,
      );

      for (const todo of toDispatch) {
        await this.dispatchAgent(todo);
      }

      // Stage advancement: when nothing is pending or running, check if stage is done
      if (toDispatch.length === 0 && ready.length === 0 && currentActive === 0) {
        // Check for deadlocked tasks (blocked by cancelled/failed deps)
        const deadlocked = deadlockedTodos(this.state);
        if (deadlocked.length > 0) {
          await this.resolveDeadlockedTasks(deadlocked);
        } else {
          // Check for stuck blocked tasks with no path to resolution
          const blocked = this.state.todos.filter(t => t.status === "blocked");
          if (blocked.length > 0) {
            // These tasks are blocked but not deadlocked — their deps may be
            // in a weird state. Treat them as deadlocked for recovery.
            log.warn(`Found ${blocked.length} stuck blocked task(s) with no ready/active work — treating as deadlocked`);
            await this.resolveDeadlockedTasks(blocked);
          } else {
            await this.checkStageCompletion();
          }
        }
      }
    } finally {
      this.processing = false;
    }
  }

  // --- Layered Planning (Spec 14) ---

  /**
   * Initialize the three-tier planning system.
   * Called once from start(). Handles both fresh start and legacy migration.
   */
  private async initializePlanning(): Promise<void> {
    if (!this.planManager) return;
    const auto = this.deps.config.autonomy;
    if (!auto.enabled || auto.objectives.length === 0) return;
    const proj = this.deps.config.project;

    try {
      // Migrate legacy flat docs if present
      if (!this.planManager.isBootstrapped() && this.planManager.hasLegacyDocs()) {
        const legacy = this.planManager.migrateLegacy();
        if (legacy) {
          log.info("Generating master plan from legacy docs...");
          await this.generateMasterPlan(auto.objectives, proj.description, legacy);
        }
      }

      // Generate master plan if not yet bootstrapped
      if (!this.planManager.isBootstrapped()) {
        log.info("Generating initial master plan...");
        await this.generateMasterPlan(auto.objectives, proj.description);
      }

      // Find active stage
      const activeStage = this.planManager.getActiveStage();
      if (!activeStage) {
        log.info("No active stage — plan may be complete");
        return;
      }

      // Generate stage plan if none exists
      if (!this.planManager.readStagePlan(activeStage.id)) {
        log.info(
          `Generating stage plan for Stage ${activeStage.id}: ${activeStage.title}...`,
        );
        await this.generateStagePlan(activeStage);
      }

      // Import stage tasks into orchestrator state
      const stagePlan = this.planManager.readStagePlan(activeStage.id);
      if (stagePlan) {
        this.importStageTasks(stagePlan);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error(`Planning initialization failed: ${msg}`);
    }
  }

  /**
   * Import tasks from a stage plan into orchestrator state.
   * Idempotent — skips tasks already present.
   */
  private importStageTasks(stagePlan: StagePlan): void {
    let imported = 0;
    for (const task of stagePlan.tasks) {
      const todoId = taskRefToTodoId(task.ref);

      // Skip if already exists
      if (findTodo(this.state, todoId)) continue;

      // Map stage-level deps (e.g. "2.1") to todo IDs ("stage-2-task-1")
      const depIds = task.dependsOn.map((dep) => taskRefToTodoId(dep));

      const todo: TodoItem = {
        id: todoId,
        goal: task.goal,
        title: task.title,
        status: "pending",
        priority: 1 as Priority,
        project: "target",
        agentType: task.agentType || "coder",
        dependsOn: depIds,
        stageId: stagePlan.stageId,
        taskRef: task.ref,
        retryCount: 0,
        maxRetries: 2,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      this.state.todos.push(todo);
      imported++;
    }

    if (imported > 0) {
      reconcileDependencyStatus(this.state);
      saveState(this.state);
      log.info(
        `Imported ${imported} tasks from stage ${stagePlan.stageId}`,
      );
    }
  }

  /**
   * Resolve tasks that are deadlocked because their dependencies were
   * cancelled or failed. Invokes the planner to decide how to proceed:
   * replace tasks, modify goals, remove dependencies, or cancel them.
   */
  private async resolveDeadlockedTasks(
    deadlocked: TodoItem[],
  ): Promise<void> {
    if (!this.planManager || this.planning) return;
    this.planning = true;
    this.planningStartedAt = Date.now();

    try {
      const plan = this.planManager.readMasterPlan();
      const activeStage = plan?.stages.find((s) => s.status === "active");
      if (!activeStage) return;

      const stagePlan = this.planManager.readStagePlan(activeStage.id);

      const deadlockedDesc = deadlocked
        .map((t) => {
          const failedDeps = t.dependsOn
            .map((dep) => {
              const d = findTodo(this.state, dep);
              return d ? `${dep} [${d.status}]: ${d.goal?.slice(0, 80)}` : dep;
            })
            .filter((_, i) => {
              const d = findTodo(this.state, t.dependsOn[i]);
              return d?.status === "cancelled" || d?.status === "failed";
            });
          return `- ${t.id} (${t.taskRef ?? "?"}): ${t.goal?.slice(0, 100)}\n  Blocked by: ${failedDeps.join("; ")}`;
        })
        .join("\n");

      const allTasks = this.state.todos
        .filter((t) => t.stageId === activeStage.id)
        .map(
          (t) =>
            `- ${t.id} (${t.taskRef ?? "?"}): [${t.status}] ${t.goal?.slice(0, 80)}`,
        )
        .join("\n");

      const system = `You are resolving a dependency deadlock in a project's stage plan.
Some tasks are blocked because their dependencies were cancelled or failed.
You must decide how to resolve each deadlocked task.

## Stage ${activeStage.id}: ${activeStage.title}
Goal: ${activeStage.goal}

## All tasks in this stage
${allTasks}

## Deadlocked tasks
${deadlockedDesc}

## Instructions
For each deadlocked task, choose ONE action:
- "replace": Cancel the deadlocked task and create a new replacement task with an updated goal that doesn't depend on the cancelled/failed work
- "modify": Keep the task but change its goal and remove the broken dependencies
- "cancel": Cancel the task (the stage can proceed without it)

Output a JSON array (no markdown fences):
[
  {
    "taskId": "the deadlocked task ID",
    "action": "replace" | "modify" | "cancel",
    "newGoal": "updated goal (for replace/modify)",
    "newAgentType": "coder" | "researcher" | "executor" (for replace, optional),
    "reasoning": "why this action"
  }
]`;

      const modelSpec = this.deps.router.resolveModelForRole("orchestrator");
      const { model } = parseModelId(modelSpec);

      log.info(
        `Resolving ${deadlocked.length} deadlocked task(s) in stage ${activeStage.id}...`,
      );

      const response = await this.deps.router.chat({
        modelSpec,
        model,
        system,
        messages: [
          {
            role: "user",
            content: "Resolve the deadlocked tasks now.",
          },
        ],
        maxTokens: 2048,
      });

      log.info(
        `Deadlock resolution: LLM responded (${response.usage.inputTokens}in/${response.usage.outputTokens}out)`,
      );

      const parsed = this.parseJsonResponse(response.content) as unknown;
      const resolutions: Array<{
        taskId: string;
        action: "replace" | "modify" | "cancel";
        newGoal?: string;
        newAgentType?: string;
        reasoning?: string;
      }> = Array.isArray(parsed)
        ? parsed
        : typeof parsed === "object" && parsed !== null && "resolutions" in parsed
          ? (parsed as { resolutions: unknown[] }).resolutions as never[]
          : [parsed as never];

      let modified = false;
      for (const res of resolutions) {
        const todo = findTodo(this.state, res.taskId);
        if (!todo) continue;

        if (res.action === "cancel") {
          todo.status = "cancelled";
          todo.updatedAt = new Date().toISOString();
          todo.result = `Cancelled by planner: ${res.reasoning ?? "dependency deadlock"}`;
          log.info(`Deadlock resolution: cancelled ${res.taskId}`);
          modified = true;
        } else if (res.action === "modify" && res.newGoal) {
          todo.goal = res.newGoal;
          todo.title = res.newGoal.slice(0, 120);
          todo.dependsOn = todo.dependsOn.filter((dep) => {
            const d = findTodo(this.state, dep);
            return d?.status !== "cancelled" && d?.status !== "failed";
          });
          todo.status = todo.dependsOn.every((dep) => {
            const d = findTodo(this.state, dep);
            return d?.status === "completed";
          })
            ? "pending"
            : "blocked";
          todo.updatedAt = new Date().toISOString();
          log.info(
            `Deadlock resolution: modified ${res.taskId} → "${res.newGoal.slice(0, 60)}"`,
          );
          modified = true;
        } else if (res.action === "replace" && res.newGoal) {
          todo.status = "cancelled";
          todo.updatedAt = new Date().toISOString();
          todo.result = `Replaced by planner: ${res.reasoning ?? "dependency deadlock"}`;

          const newId = `${res.taskId}-r`;
          this.state.todos.push({
            id: newId,
            goal: res.newGoal,
            title: res.newGoal.slice(0, 120),
            status: "pending",
            priority: todo.priority,
            project: todo.project,
            agentType: res.newAgentType ?? todo.agentType ?? "coder",
            dependsOn: [],
            stageId: todo.stageId,
            taskRef: todo.taskRef ? `${todo.taskRef}r` : undefined,
            retryCount: 0,
            maxRetries: todo.maxRetries,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          });
          log.info(
            `Deadlock resolution: replaced ${res.taskId} with ${newId} → "${res.newGoal.slice(0, 60)}"`,
          );
          modified = true;
        }
      }

      if (modified) {
        saveState(this.state);
        this.appendJournalEntry(
          `Deadlock resolution (stage ${activeStage.id})`,
          "completed",
          `Resolved ${resolutions.length} deadlocked task(s): ${resolutions.map((r) => `${r.taskId}→${r.action}`).join(", ")}`,
        );

        // Update stage plan file if present
        if (stagePlan) {
          for (const res of resolutions) {
            const ref = deadlocked.find((d) => d.id === res.taskId)?.taskRef;
            if (ref) {
              this.planManager!.updateTaskInStagePlan(
                activeStage.id,
                ref,
                {
                  status:
                    res.action === "cancel" || res.action === "replace"
                      ? "cancelled"
                      : "pending",
                  result:
                    res.action === "cancel"
                      ? `Cancelled: ${res.reasoning ?? ""}`
                      : res.action === "replace"
                        ? `Replaced: ${res.reasoning ?? ""}`
                        : undefined,
                },
              );
            }
          }
        }
      }

      await this.deps.eventBus.emit("orchestrator:planning", {
        status: "deadlock_resolved",
        message: `Resolved ${deadlocked.length} deadlocked task(s)`,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error(`Deadlock resolution failed: ${msg}`);
    } finally {
      this.planning = false;
    }
  }

  /**
   * Check if the active stage is complete and advance if so.
   * Called after task completion and when the queue is empty.
   */
  private async checkStageCompletion(): Promise<void> {
    if (!this.planManager || this.planning) return;
    const auto = this.deps.config.autonomy;
    if (!auto.enabled) return;

    const plan = this.planManager.readMasterPlan();
    if (!plan) return;

    const activeStage = plan.stages.find((s) => s.status === "active");
    if (!activeStage) {
      log.info("No active stage — all work complete");
      return;
    }

    // Get all tasks for the active stage
    const stageTasks = this.state.todos.filter(
      (t) => t.stageId === activeStage.id,
    );
    if (stageTasks.length === 0) return; // No tasks imported yet

    // Check if all are terminal
    const allTerminal = stageTasks.every(
      (t) =>
        t.status === "completed" ||
        t.status === "failed" ||
        t.status === "cancelled",
    );
    if (!allTerminal) return; // Still working

    // Cooldown
    if (Date.now() - this.lastPlanningAt < auto.planningCooldownMs) return;

    this.planning = true;
    this.planningStartedAt = Date.now();
    this.lastPlanningAt = Date.now();

    // Track remediation count per stage to prevent infinite loops
    if (activeStage.id !== this.lastActiveStageId) {
      this.stageRemediationCount = 0;
      this.lastActiveStageId = activeStage.id;
    }

    try {
      log.info(
        `All tasks for Stage ${activeStage.id} are terminal — evaluating exit criteria...`,
      );
      await this.deps.eventBus.emit("orchestrator:planning", {
        status: "stage_evaluation",
        message: `Evaluating Stage ${activeStage.id}: ${activeStage.title}`,
      });

      const stagePlan = this.planManager.readStagePlan(activeStage.id);
      const evaluation = await this.evaluateExitCriteria(
        plan,
        activeStage,
        stagePlan,
      );

      if (evaluation.met) {
        log.info(
          `Stage ${activeStage.id} exit criteria met — advancing...`,
        );

        const next = this.planManager.advanceStage();

        if (next) {
          log.info(`Activated Stage ${next.id}: ${next.title}`);

          await this.generateStagePlan(next);
          const newStagePlan = this.planManager.readStagePlan(next.id);
          if (newStagePlan) {
            this.importStageTasks(newStagePlan);
          }

          await this.deps.eventBus.emit("orchestrator:planning", {
            status: "stage_advanced",
            message: `Advanced to Stage ${next.id}: ${next.title}`,
          });
        } else {
          if (plan.iterative) {
            // Iterative project — regenerate the master plan for next cycle
            log.info(
              "All stages complete — regenerating master plan for next iteration cycle",
            );
            await this.deps.eventBus.emit("orchestrator:planning", {
              status: "plan_iteration",
              message:
                "All stages complete — starting next iteration cycle",
            });

            // Run a mandatory retrospective before replanning so the LLM
            // has a fresh self-assessment of what worked and what didn't
            log.info("Running mandatory pre-replan retrospective...");
            await this.runRetrospective();
            this.state.completedSinceRetrospective = 0;
            saveState(this.state);

            await this.regenerateMasterPlan(plan);

            const newPlan = this.planManager.readMasterPlan();
            const newActive = newPlan?.stages.find(
              (s) => s.status === "active",
            );
            if (newActive) {
              await this.generateStagePlan(newActive);
              const newStagePlan = this.planManager.readStagePlan(
                newActive.id,
              );
              if (newStagePlan) {
                this.importStageTasks(newStagePlan);
              }
            }
          } else {
            // Non-iterative project — plan is complete
            log.info("All stages complete — project goals achieved");
            await this.deps.eventBus.emit("orchestrator:planning", {
              status: "plan_complete",
              message: "All stages complete",
            });
          }
        }

        this.appendJournalEntry(
          `Stage ${activeStage.id}: ${activeStage.title}`,
          "completed",
          evaluation.reasoning,
        );
      } else {
        this.stageRemediationCount++;
        log.info(
          `Stage ${activeStage.id} exit criteria NOT met (remediation attempt ${this.stageRemediationCount}/${Orchestrator.MAX_REMEDIATIONS})`,
        );

        if (this.stageRemediationCount >= Orchestrator.MAX_REMEDIATIONS) {
          // Circuit breaker: too many remediation attempts — force-advance
          log.warn(
            `Stage ${activeStage.id} hit max remediation attempts (${Orchestrator.MAX_REMEDIATIONS}) — force-advancing to next stage`,
          );
          this.appendJournalEntry(
            `Stage ${activeStage.id}: ${activeStage.title}`,
            "completed",
            `Force-advanced after ${this.stageRemediationCount} failed remediation attempts. Exit criteria not met: ${evaluation.reasoning}`,
          );
          this.stageRemediationCount = 0;

          const next = this.planManager.advanceStage();
          if (next) {
            log.info(`Force-activated Stage ${next.id}: ${next.title}`);
            await this.generateStagePlan(next);
            const newStagePlan = this.planManager.readStagePlan(next.id);
            if (newStagePlan) {
              this.importStageTasks(newStagePlan);
            }
            await this.deps.eventBus.emit("orchestrator:planning", {
              status: "stage_force_advanced",
              message: `Force-advanced to Stage ${next.id} after ${Orchestrator.MAX_REMEDIATIONS} remediation failures`,
            });
          } else if (plan.iterative) {
            log.info("No more stages — regenerating master plan for next cycle");

            // Run a mandatory retrospective before replanning
            log.info("Running mandatory pre-replan retrospective...");
            await this.runRetrospective();
            this.state.completedSinceRetrospective = 0;
            saveState(this.state);

            await this.regenerateMasterPlan(plan);
            const newPlan = this.planManager.readMasterPlan();
            const newActive = newPlan?.stages.find((s) => s.status === "active");
            if (newActive) {
              await this.generateStagePlan(newActive);
              const newStagePlan = this.planManager.readStagePlan(newActive.id);
              if (newStagePlan) this.importStageTasks(newStagePlan);
            }
          }
        } else if (evaluation.remediation && evaluation.remediation.length > 0) {
          const stagePlanObj = this.planManager.readStagePlan(activeStage.id);
          if (stagePlanObj) {
            const existingCount = stagePlanObj.tasks.length;
            for (let i = 0; i < evaluation.remediation.length; i++) {
              const rem = evaluation.remediation[i];
              const taskNum = existingCount + i + 1;
              stagePlanObj.tasks.push({
                ref: `${activeStage.id}.${taskNum}`,
                title: rem.title,
                goal: rem.goal || rem.title,
                agentType: rem.agentType || "coder",
                dependsOn: rem.dependsOn || [],
                status: "pending",
              });
            }
            this.planManager.writeStagePlan(activeStage.id, stagePlanObj);
            this.importStageTasks(stagePlanObj);
          }

          await this.deps.eventBus.emit("orchestrator:planning", {
            status: "stage_remediation",
            message: `Stage ${activeStage.id} needs ${evaluation.remediation?.length ?? 0} more tasks (attempt ${this.stageRemediationCount})`,
          });
        } else {
          // No remediation tasks suggested but exit criteria not met — force advance
          log.warn(`Stage ${activeStage.id} exit criteria not met and no remediation suggested — force-advancing`);
          this.stageRemediationCount = 0;
          const next = this.planManager.advanceStage();
          if (next) {
            await this.generateStagePlan(next);
            const newStagePlan = this.planManager.readStagePlan(next.id);
            if (newStagePlan) this.importStageTasks(newStagePlan);
          }
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error(`Stage completion check error: ${msg}`);
    } finally {
      this.planning = false;
    }
  }

  // --- LLM Planning Methods ---

  private parseJsonResponse(text: string): unknown {
    let jsonStr = text
      .trim()
      .replace(/^```(?:json)?\s*/, "")
      .replace(/\s*```$/, "");
    const objMatch = jsonStr.match(/\{[\s\S]*\}/);
    if (objMatch) jsonStr = objMatch[0];
    return JSON.parse(jsonStr);
  }

  private async generateMasterPlan(
    objectives: string[],
    description: string,
    legacy?: {
      objectives: string;
      longTermPlan: string;
      shortTermPlan: string;
    },
  ): Promise<void> {
    if (!this.planManager) return;
    const proj = this.deps.config.project;
    const auto = this.deps.config.autonomy;

    const legacyCtx = legacy
      ? `
## Existing Planning Documents (being migrated)

### Previous Objectives
${legacy.objectives}

### Previous Long-Term Plan
${legacy.longTermPlan}

### Previous Short-Term Plan
${legacy.shortTermPlan}
`
      : "";

    const system = `You are planning a software project for autonomous AI agents to execute.

## Project
${proj.root ? `Root: ${proj.root}` : "No project configured."}
${description || ""}

## Objectives
${objectives.map((o, i) => `${i + 1}. ${o}`).join("\n")}
${legacyCtx}
## Instructions
Create a phased master plan. Each stage should be:
- Achievable in 3-${auto.maxTasksPerCycle * 2} tasks
- Independently valuable (the project improves even if we stop here)
- Ordered from most critical to least critical

## CRITICAL PRIORITY RULE
The primary goal is always to RESEARCH, TRAIN, and EVALUATE models.
Infrastructure, CI, governance, and tooling are ONLY justified when they directly
unblock the next model training or evaluation cycle. Never plan infrastructure
for its own sake. Every stage must produce either:
- A trained model with evaluation results, OR
- Research findings that directly inform the next training run, OR
- Data/features that will be consumed by model training in the SAME iteration.
If a stage has no model training or evaluation, it is wrong. Fix it.

## DATA AND METRICS RULES
- ALL model training, validation, and research MUST use REAL market data. Simulated or
  synthetic data is STRICTLY FORBIDDEN for these purposes. Synthetic data may only be
  used in automated code tests (unit/integration tests).
- Model evaluation MUST include BUSINESS/INVESTING metrics (Sharpe ratio, max drawdown,
  annualized return, profit factor, win rate, risk-adjusted return) alongside standard
  DS metrics (MAE, RMSE, accuracy). The goal is predicting PROFITABLY, not just accurately.

Output a JSON object (no markdown fences):
{
  "vision": "project vision summary",
  "iterative": true | false,
  "successCriteria": ["criterion 1", "criterion 2"],
  "stages": [
    {
      "title": "Stage title",
      "goal": "What this stage achieves",
      "entryCriteria": "Conditions to start",
      "exitCriteria": "Conditions to consider it done"
    }
  ]
}

Set "iterative" to true ONLY if the objectives describe an ongoing, cyclical process
(e.g. research → implement → evaluate → repeat, continuous data collection, iterative
improvement). When iterative is true, completing all stages triggers automatic plan
regeneration for the next cycle. Set to false for one-shot projects that have a
definite end state.

Generate 3-6 stages. The first stage should begin immediately.`;

    const modelSpec = this.deps.router.resolveModelForRole("orchestrator");
    const { model } = parseModelId(modelSpec);

    const response = await this.deps.router.chat({
      modelSpec,
      model,
      system,
      messages: [{ role: "user", content: "Generate the master plan now." }],
      maxTokens: 4096,
    });

    log.info(
      `Master plan generation: LLM responded (${response.usage.inputTokens}in/${response.usage.outputTokens}out)`,
    );

    const parsed = this.parseJsonResponse(response.content) as {
      vision: string;
      iterative?: boolean;
      successCriteria: string[];
      stages: Array<{
        title: string;
        goal: string;
        entryCriteria: string;
        exitCriteria: string;
      }>;
    };

    const today = new Date().toISOString().split("T")[0];
    const masterPlan: MasterPlan = {
      version: 1,
      created: today,
      lastUpdated: today,
      activeStage: 1,
      iterative: parsed.iterative === true,
      vision: parsed.vision || description,
      objectives,
      successCriteria: parsed.successCriteria || [],
      stages: parsed.stages.slice(0, 8).map((s, i) => ({
        id: i + 1,
        title: s.title,
        goal: s.goal,
        status: (i === 0 ? "active" : "pending") as StageInfo["status"],
        entryCriteria: s.entryCriteria,
        exitCriteria: s.exitCriteria,
        started: i === 0 ? today : undefined,
      })),
    };

    this.planManager.writeMasterPlan(masterPlan);
    this.purgeStaleTasksForNewPlan();
  }

  /**
   * Regenerate the master plan after all stages complete.
   * The project is iterative: each cycle builds on the previous one.
   * The LLM sees what was accomplished and plans the next iteration.
   */
  private async regenerateMasterPlan(
    previousPlan: MasterPlan,
  ): Promise<void> {
    if (!this.planManager) return;
    const proj = this.deps.config.project;
    const auto = this.deps.config.autonomy;

    const completedStages = previousPlan.stages
      .filter((s) => s.status === "completed" || s.status === "skipped")
      .map((s) => {
        const sp = this.planManager!.readStagePlan(s.id);
        const taskSummary = sp
          ? sp.tasks
              .map(
                (t) =>
                  `    - ${t.ref}: ${t.title} [${t.status}]${t.result ? ` → ${t.result.slice(0, 100)}` : ""}`,
              )
              .join("\n")
          : "    (no stage plan)";
        return `  Stage ${s.id}: ${s.title} [${s.status}]\n${taskSummary}`;
      })
      .join("\n");

    const recentJournal = this.planManager.readJournalTail(60);
    const exploration = this.planManager.readExploration();

    const system = `You are planning the NEXT ITERATION of an ongoing, iterative project.
This project never "finishes" — each cycle builds on the previous one with more data, better models, and improved infrastructure.

## Project
${proj.root ? `Root: ${proj.root}` : ""}
${proj.description || ""}

## Objectives (ongoing)
${auto.objectives.map((o, i) => `${i + 1}. ${o}`).join("\n")}

## Previous Plan (iteration ${previousPlan.version}, now complete)
Vision: ${previousPlan.vision}
Completed stages:
${completedStages}

## Recent Journal
${recentJournal || "(empty)"}

## Exploration Ideas
${exploration || "(none)"}

## CRITICAL PRIORITY RULE
The primary goal is always to RESEARCH, TRAIN, and EVALUATE models.
Infrastructure, CI, governance, and tooling are ONLY justified when they directly
unblock the next model training or evaluation cycle. Never plan infrastructure
for its own sake. If the previous cycle was mostly infrastructure/tooling with no
new model trained or evaluated, the NEXT cycle MUST start with model training.
Every iteration must produce at least one trained model with evaluation metrics.

## DATA AND METRICS RULES
- ALL model training, validation, and research MUST use REAL market data. Simulated or
  synthetic data is STRICTLY FORBIDDEN for these purposes. Synthetic data may only be
  used in automated code tests (unit/integration tests).
- Model evaluation MUST include BUSINESS/INVESTING metrics (Sharpe ratio, max drawdown,
  annualized return, profit factor, win rate, risk-adjusted return) alongside standard
  DS metrics (MAE, RMSE, accuracy). The goal is predicting PROFITABLY, not just accurately.

## Instructions
Plan the NEXT iteration cycle. Consider:
- What was achieved in the previous cycle? Did we actually train and evaluate a model?
- If not, the first priority is to train/evaluate with EXISTING infrastructure.
- What new data sources, models, algorithms, or features should be explored?
- Infrastructure/tooling ONLY if it blocks the next training run.

The cycle pattern should follow: research → train → evaluate → improve.
At least 50% of stages must directly involve model training or evaluation.
Generate 3-6 stages for this NEXT iteration.

Output a JSON object (no markdown fences):
{
  "vision": "updated project vision reflecting current maturity",
  "successCriteria": ["criterion 1", ...],
  "stages": [
    {"title": "...", "goal": "...", "entryCriteria": "...", "exitCriteria": "..."}
  ]
}`;

    const modelSpec = this.deps.router.resolveModelForRole("orchestrator");
    const { model } = parseModelId(modelSpec);

    const response = await this.deps.router.chat({
      modelSpec,
      model,
      system,
      messages: [
        {
          role: "user",
          content:
            "The previous iteration is complete. Plan the next iteration cycle now.",
        },
      ],
      maxTokens: 4096,
    });

    log.info(
      `Master plan regeneration: LLM responded (${response.usage.inputTokens}in/${response.usage.outputTokens}out)`,
    );

    const parsed = this.parseJsonResponse(response.content) as {
      vision: string;
      successCriteria: string[];
      stages: Array<{
        title: string;
        goal: string;
        entryCriteria: string;
        exitCriteria: string;
      }>;
    };

    const today = new Date().toISOString().split("T")[0];
    const newPlan: MasterPlan = {
      version: previousPlan.version + 1,
      created: today,
      lastUpdated: today,
      activeStage: 1,
      iterative: true, // inherited — only iterative plans trigger regeneration
      vision: parsed.vision || previousPlan.vision,
      objectives: auto.objectives,
      successCriteria: parsed.successCriteria || [],
      stages: parsed.stages.slice(0, 8).map((s, i) => ({
        id: i + 1,
        title: s.title,
        goal: s.goal,
        status: (i === 0 ? "active" : "pending") as StageInfo["status"],
        entryCriteria: s.entryCriteria,
        exitCriteria: s.exitCriteria,
        started: i === 0 ? today : undefined,
      })),
    };

    this.planManager.writeMasterPlan(newPlan);
    this.purgeStaleTasksForNewPlan();

    this.appendJournalEntry(
      `Plan iteration ${previousPlan.version} → ${newPlan.version}`,
      "completed",
      `Previous cycle complete. New plan: ${newPlan.stages.map((s) => s.title).join(" → ")}`,
    );

    log.info(
      `Master plan regenerated: v${newPlan.version} with ${newPlan.stages.length} stages`,
    );
  }

  /**
   * Remove all tasks when a new master plan is written.
   * Old completed tasks share IDs with new plan tasks (stage-1-task-1, etc.)
   * and would block importStageTasks from importing the new plan's tasks.
   * History is preserved in stage plan files, journal, and transcripts.
   */
  private purgeStaleTasksForNewPlan(): void {
    const count = this.state.todos.length;
    if (count === 0) return;
    this.state.todos = [];
    this.stageRemediationCount = 0;
    this.lastActiveStageId = undefined;
    saveState(this.state);
    log.info(`Purged all ${count} tasks from previous plan`);
  }

  private async generateStagePlan(stage: StageInfo): Promise<void> {
    if (!this.planManager) return;
    const proj = this.deps.config.project;
    const auto = this.deps.config.autonomy;
    const plan = this.planManager.readMasterPlan();

    const previousResults =
      plan?.stages
        .filter((s) => s.status === "completed")
        .map(
          (s) =>
            `- Stage ${s.id}: ${s.title} — completed ${s.completed ?? ""}`,
        )
        .join("\n") || "(no previous stages)";

    const recentJournal = this.planManager.readJournalTail(40);

    const system = `You are creating a detailed task plan for Stage ${stage.id}: ${stage.title}.

## Master Plan Context
${plan ? `Vision: ${plan.vision}\nObjectives: ${plan.objectives.join("; ")}\nPrevious stages:\n${previousResults}` : "No master plan context available."}

## Current Stage
- **Title:** ${stage.title}
- **Goal:** ${stage.goal}
- **Exit criteria:** ${stage.exitCriteria}

## Recent Journal
${recentJournal || "(empty)"}

${proj.root ? `## Project\nRoot: ${proj.root}\n${proj.description || ""}` : ""}

## PRIORITY RULE
Prefer researcher and executor tasks over coder tasks. Code should only be written
when it is the minimal change needed to unblock model training or evaluation.
Do NOT create tasks for CI pipelines, governance frameworks, dashboards, or
infrastructure unless the stage goal explicitly requires it AND a model training
task in this stage depends on it. When in doubt, use existing code and tools.

## DATA AND METRICS RULES
- ALL model training, validation, and research MUST use REAL market data. Never use
  simulated or synthetic data for training or evaluation. Synthetic data is ONLY
  acceptable in automated code tests (unit/integration tests).
- Evaluation tasks MUST compute business/investing metrics (Sharpe ratio, max drawdown,
  annualized return, profit factor, win rate) alongside DS metrics (MAE, RMSE, accuracy).
  A model that is accurate but not profitable is not a success.

## Instructions
Break this stage into ${Math.max(3, auto.maxTasksPerCycle)} concrete, atomic tasks.
Each task must be achievable by a single agent in one session.
Specify dependencies between tasks (by task number within this stage).
Order from highest priority to lowest.

Output a JSON object (no markdown fences):
{
  "goal": "Restate the stage goal with more detail",
  "approach": "Strategy and constraints for this stage",
  "tasks": [
    {
      "title": "Short task title",
      "goal": "What the agent should do — detailed and specific",
      "agentType": "coder|researcher|executor",
      "dependsOn": []
    }
  ],
  "notes": "Any observations or constraints"
}

Task dependencies: use 1-based task numbers within this stage.
Example: if task 3 depends on tasks 1 and 2, use "dependsOn": [1, 2].`;

    const modelSpec = this.deps.router.resolveModelForRole("orchestrator");
    const { model } = parseModelId(modelSpec);

    const response = await this.deps.router.chat({
      modelSpec,
      model,
      system,
      messages: [{ role: "user", content: "Generate the stage plan now." }],
      maxTokens: 4096,
    });

    log.info(
      `Stage plan generation: LLM responded (${response.usage.inputTokens}in/${response.usage.outputTokens}out)`,
    );

    const parsed = this.parseJsonResponse(response.content) as {
      goal: string;
      approach: string;
      tasks: Array<{
        title: string;
        goal: string;
        agentType: string;
        dependsOn: number[];
      }>;
      notes: string;
    };

    const today = new Date().toISOString().split("T")[0];
    const stagePlan: StagePlan = {
      stageId: stage.id,
      title: stage.title,
      status: "active",
      created: today,
      lastUpdated: today,
      goal: parsed.goal || stage.goal,
      approach: parsed.approach || "",
      tasks: parsed.tasks
        .slice(0, auto.maxTasksPerCycle * 2)
        .map((t, i) => ({
          ref: `${stage.id}.${i + 1}`,
          title: t.title,
          goal: t.goal || t.title,
          agentType: t.agentType || "coder",
          dependsOn: (t.dependsOn || []).map((d) => `${stage.id}.${d}`),
          status: "pending",
        })),
      notes: parsed.notes || "",
    };

    this.planManager.writeStagePlan(stage.id, stagePlan);
  }

  private async evaluateExitCriteria(
    plan: MasterPlan,
    stage: StageInfo,
    stagePlan: StagePlan | null,
  ): Promise<{
    met: boolean;
    reasoning: string;
    remediation?: Array<{
      title: string;
      goal: string;
      agentType: string;
      dependsOn?: string[];
    }>;
  }> {
    const taskResults =
      stagePlan?.tasks
        .map((t) => {
          const todo = this.state.todos.find(
            (td) => td.stageId === stage.id && td.taskRef === t.ref,
          );
          const icon =
            todo?.status === "completed"
              ? "✅"
              : todo?.status === "failed"
                ? "❌"
                : "⏭️";
          return `- ${icon} Task ${t.ref}: ${t.title}\n  ${todo?.result?.slice(0, 200) || todo?.error?.slice(0, 200) || "no details"}`;
        })
        .join("\n") || "(no tasks)";

    const system = `You are evaluating whether a project stage has met its exit criteria.

## Stage ${stage.id}: ${stage.title}
- **Goal:** ${stage.goal}
- **Exit criteria:** ${stage.exitCriteria}

## Task Results
${taskResults}

## Instructions
Analyze whether the exit criteria have been met based on the task results.
If not fully met, suggest specific remediation tasks (max 3).

Output a JSON object (no markdown fences):
{
  "met": true/false,
  "reasoning": "Explanation of your assessment",
  "remediation": [
    {"title": "...", "goal": "...", "agentType": "coder"}
  ]
}

Set remediation to an empty array if exit criteria are met.`;

    const modelSpec = this.deps.router.resolveModelForRole("orchestrator");
    const { model } = parseModelId(modelSpec);

    const response = await this.deps.router.chat({
      modelSpec,
      model,
      system,
      messages: [
        { role: "user", content: "Evaluate the exit criteria now." },
      ],
      maxTokens: 2048,
    });

    const parsed = this.parseJsonResponse(response.content) as {
      met: boolean;
      reasoning: string;
      remediation?: Array<{
        title: string;
        goal: string;
        agentType: string;
        dependsOn?: string[];
      }>;
    };

    return {
      met: !!parsed.met,
      reasoning: parsed.reasoning || "",
      remediation: parsed.remediation,
    };
  }

  // --- Plan Summaries (for MCP tools / chat agent) ---

  /** Master plan summary */
  getPlanSummary(): {
    vision: string;
    objectives: string[];
    stages: Array<{ id: number; title: string; status: string }>;
  } | null {
    if (!this.planManager) return null;
    const plan = this.planManager.readMasterPlan();
    if (!plan) return null;
    return {
      vision: plan.vision,
      objectives: plan.objectives,
      stages: plan.stages.map((s) => ({
        id: s.id,
        title: s.title,
        status: s.status,
      })),
    };
  }

  /** Active stage summary with live task statuses */
  getStageSummary(): {
    stageId: number;
    title: string;
    goal: string;
    tasks: Array<{
      ref: string;
      title: string;
      status: string;
      result?: string;
    }>;
  } | null {
    if (!this.planManager) return null;
    const activeStage = this.planManager.getActiveStage();
    if (!activeStage) return null;
    const stagePlan = this.planManager.readStagePlan(activeStage.id);
    if (!stagePlan) return null;
    return {
      stageId: stagePlan.stageId,
      title: stagePlan.title,
      goal: stagePlan.goal,
      tasks: stagePlan.tasks.map((t) => {
        const todoId = taskRefToTodoId(t.ref);
        const todo = findTodo(this.state, todoId);
        return {
          ref: t.ref,
          title: t.title,
          status: todo?.status ?? t.status,
          result: todo?.result?.slice(0, 200) ?? t.result,
        };
      }),
    };
  }

  // --- Journal & Retrospective ---

  private appendJournalEntry(
    goal: string,
    status: "completed" | "failed",
    detail: string,
  ): void {
    if (!this.planManager) return;
    const date = new Date().toISOString().split("T")[0];
    const time = new Date().toISOString().split("T")[1]?.slice(0, 5) ?? "";
    const icon = status === "completed" ? "✅" : "❌";
    const detailTruncated =
      detail.length > 500 ? detail.slice(0, 500) + "..." : detail;
    const entry = `\n## ${date} ${time} — ${icon} ${goal.slice(0, 100)}\n**Status**: ${status}\n**Result**: ${detailTruncated}\n\n---\n`;
    this.planManager.appendJournal(entry);
  }

  /**
   * Prune old completed/failed/cancelled todos to prevent unbounded state growth.
   * Keeps the most recent 50 terminal todos; removes older ones.
   */
  private pruneOldTodos(): void {
    const maxTerminal = 50;
    const terminal = this.state.todos.filter(
      (t) => t.status === "completed" || t.status === "failed" || t.status === "cancelled",
    );
    if (terminal.length <= maxTerminal) return;

    // Sort by updatedAt descending, keep the newest
    terminal.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    const toRemove = new Set(terminal.slice(maxTerminal).map((t) => t.id));
    const before = this.state.todos.length;
    this.state.todos = this.state.todos.filter((t) => !toRemove.has(t.id));
    if (this.state.todos.length < before) {
      log.info(`Pruned ${before - this.state.todos.length} old todos (kept ${maxTerminal} terminal)`);
      saveState(this.state);
    }
  }

  private async maybeRetrospective(): Promise<void> {
    if (!this.planManager) return;
    const interval = this.deps.config.autonomy.retrospectiveInterval;
    if (this.state.completedSinceRetrospective < interval) return;

    try {
      log.info(`Retrospective triggered (${this.state.completedSinceRetrospective} tasks completed since last)`);
      await this.deps.eventBus.emit("orchestrator:planning", {
        status: "retrospective_started",
      });
      await this.runRetrospective();
      this.state.completedSinceRetrospective = 0;
      saveState(this.state);
      await this.deps.eventBus.emit("orchestrator:planning", {
        status: "retrospective_completed",
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error(`Retrospective error: ${msg}`);
    }
  }

  private async runRetrospective(): Promise<void> {
    if (!this.planManager) return;
    const proj = this.deps.config.project;
    const plan = this.planManager.readMasterPlan();
    const activeStage = plan?.stages.find((s) => s.status === "active");
    const stagePlan = activeStage
      ? this.planManager.readStagePlan(activeStage.id)
      : null;

    const recentTasks = this.state.todos
      .filter((t) => t.status === "completed" || t.status === "failed")
      .slice(-30)
      .map((t) => {
        const icon = t.status === "completed" ? "✅" : "❌";
        const detail = t.result?.slice(0, 200) ?? t.error?.slice(0, 200) ?? "";
        return `- ${icon} ${t.goal}\n  ${detail}`;
      })
      .join("\n");

    const system = `You are performing a retrospective analysis for the Saivage autonomous agent system.

## Project
${proj.root ? `Root: ${proj.root}` : ""}
${proj.description || ""}

## Master Plan
${plan ? `Vision: ${plan.vision}\nStages:\n${plan.stages.map((s) => `${s.id}. ${s.title} [${s.status}]`).join("\n")}` : "(no plan)"}

## Current Stage
${stagePlan ? `${stagePlan.title} — ${stagePlan.goal}` : "(no active stage)"}

## Exploration
${this.planManager.readExploration() || "(empty)"}

## Recent Work
${recentTasks || "(none)"}

## Instructions
Analyze progress. Consider:
1. Which objectives are advancing? Which are stalled?
2. Patterns in successes and failures?
3. Should future master plan stages be adjusted?
4. New exploration ideas?

Output a JSON object (no markdown fences):
{
  "exploration": "full updated markdown for exploration.md (or null)",
  "journalEntry": "## Retrospective — date\\nAnalysis...",
  "analysis": "Brief 2-3 sentence summary"
}`;

    const modelSpec = this.deps.router.resolveModelForRole("orchestrator");
    const { model } = parseModelId(modelSpec);

    const response = await this.deps.router.chat({
      modelSpec,
      model,
      system,
      messages: [{ role: "user", content: "Perform the retrospective analysis now." }],
      maxTokens: 4096,
    });

    log.info(`Retrospective: LLM responded (${response.usage.inputTokens}in/${response.usage.outputTokens}out)`);

    try {
      const result = this.parseJsonResponse(response.content) as {
        exploration?: string | null;
        journalEntry?: string;
        analysis?: string;
      };

      if (result.exploration && typeof result.exploration === "string") {
        this.planManager.writeExploration(result.exploration);
      }
      if (result.journalEntry && typeof result.journalEntry === "string") {
        this.planManager.appendJournal("\n" + result.journalEntry + "\n\n---\n");
      }
      if (result.analysis) {
        log.info(`Retrospective summary: ${result.analysis}`);
      }
    } catch {
      log.warn("Retrospective: failed to parse JSON response");
    }
  }

  /**
   * Persist an agent's conversation log to a JSONL file for debugging.
   */
  private persistTranscript(agentId: string, taskId: string, status: "completed" | "failed"): void {
    const agent = this.runningAgents.get(agentId);
    if (!agent) return;

    try {
      const dir = join(saivageDir(), "transcripts");
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

      const todo = findTodo(this.state, taskId);
      const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
      const fp = join(dir, `${timestamp}_${taskId.slice(0, 8)}_${status}.jsonl`);

      const header = JSON.stringify({
        agentId,
        taskId,
        status,
        goal: todo?.goal,
        agentType: todo?.agentType,
        startedAt: todo?.startedAt,
        completedAt: new Date().toISOString(),
      });
      appendFileSync(fp, header + "\n");

      const entries = agent.getConversationLog(500);
      for (const entry of entries) {
        appendFileSync(fp, JSON.stringify(entry) + "\n");
      }

      log.info(`Transcript saved: ${fp}`);
    } catch (err) {
      log.warn(`Failed to save transcript: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async dispatchAgent(todo: TodoItem): Promise<void> {
    const agentTypeName = todo.agentType ?? "coder";
    const agentConfig = getAgentType(agentTypeName);

    if (!agentConfig) {
      log.error(`Unknown agent type "${agentTypeName}" for task "${todo.goal}"`);
      todo.status = "failed";
      todo.error = `Unknown agent type: ${agentTypeName}`;
      todo.updatedAt = new Date().toISOString();
      saveState(this.state);
      return;
    }

    // Re-discover skills so newly created skills are available
    const projRoot = this.deps.config.project?.root;
    this.allSkills = discoverSkills(
      process.cwd(),
      projRoot || undefined,
    );

    // Create branch for the work
    const branch = await this.branchManager.createAndCheckout(todo.id, todo.project);
    todo.branch = branch ?? undefined;
    todo.status = "in-progress";
    todo.startedAt = new Date().toISOString();
    todo.updatedAt = new Date().toISOString();

    // Create agent
    const agentDeps: SubAgentDeps = {
      router: this.deps.router,
      runtime: this.deps.runtime,
      eventBus: this.deps.eventBus,
      config: this.deps.config,
      allSkills: this.allSkills,
    };

    const agent = new SubAgent(agentConfig, agentDeps);
    this.runningAgents.set(agent.id, agent);

    // Track in state
    const agentInfo: AgentInfo = {
      id: agent.id,
      type: agentTypeName,
      taskId: todo.id,
      status: "running",
      iteration: 0,
      startedAt: new Date().toISOString(),
    };
    this.state.activeAgents.push(agentInfo);
    todo.assignedAgent = agent.id;
    saveState(this.state);

    log.info(
      `Dispatching ${agentTypeName} agent [${agent.id}] for: "${todo.goal}"`,
    );

    // Emit dispatched event for UI feedback
    await this.deps.eventBus.emit("orchestrator:dispatched", {
      todoId: todo.id,
      agentId: agent.id,
      agentType: agentTypeName,
      goal: todo.goal,
    });

    // Build task assignment
    const task: TaskAssignment = {
      id: todo.id,
      type: agentTypeName,
      goal: todo.goal,
      context: todo.context,
      project: todo.project,
      branch: branch ?? undefined,
    };

    // Run agent asynchronously (fire and forget — events handle completion)
    agent.run(task).catch((err) => {
      // Error is also emitted via events, but log just in case
      log.error(
        `Agent ${agent.id} error: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
  }
}
