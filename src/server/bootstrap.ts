/**
 * Saivage — Bootstrap
 * Wires all v2 components together: loads config, initializes providers,
 * MCP runtime, event bus, Plan MCP service, registers agent spawners,
 * runs crash recovery, starts the Planner, handles graceful shutdown.
 */

import { loadConfig, type SaivageConfig, configPath } from "../config.js";
import { validateModelCoverage } from "../config-validation.js";
import { ModelRouter } from "../providers/router.js";
import { McpRuntime } from "../mcp/runtime.js";
import { registerBuiltinServices } from "../mcp/builtins.js";
import { cleanStash } from "../runtime/stash.js";
import { writeFileSync } from "node:fs";

import { EventBus } from "../events/bus.js";
import { PlanService } from "../mcp/plan-server.js";
import { NoteService } from "../mcp/notes-server.js";
import { NoteManager } from "../runtime/notes.js";
import {
  loadProject,
  discoverProject,
  type ProjectContext,
} from "../store/project.js";
import { recoverFromCrash, writeRuntimeState, createRuntimeState, isAnotherInstanceRunning, acquireRuntimeLock, RuntimeTracker, type RuntimeLock } from "../runtime/recovery.js";
import { RuntimeSupervisor } from "../runtime/supervisor.js";
import { consumeShutdownHandoff, writeShutdownSummary } from "../runtime/shutdown-handoff.js";
import { PlannerAgent } from "../agents/planner.js";
import { ManagerAgent } from "../agents/manager.js";
import { CoderAgent } from "../agents/coder.js";
import { ResearcherAgent } from "../agents/researcher.js";
import { DataAgent } from "../agents/data-agent.js";
import { ReviewerAgent } from "../agents/reviewer.js";
import { DesignerAgent } from "../agents/designer.js";
import { InspectorAgent } from "../agents/inspector.js";
import { WorkerAgent } from "../agents/worker.js";
import type { AgentContext, AgentResult, Agent } from "../agents/types.js";
import { assertExhaustive } from "../agents/roster.js";
import type { AgentState } from "../types.js";
import type { ServiceEntry } from "../mcp/types.js";
import type { ChildSpawner } from "../runtime/dispatcher.js";
import { agentId } from "../ids.js";
import { log } from "../log.js";
import { ModelRoutingResolver } from "../routing/resolver.js";

/** Saivage runtime context — returned by bootstrap. */
export interface SaivageRuntime {
  config: SaivageConfig;
  router: ModelRouter;
  routing: ModelRoutingResolver;
  mcpRuntime: McpRuntime;
  eventBus: EventBus;
  planService: PlanService;
  project: ProjectContext;
  tracker: RuntimeTracker;
  plannerControl: PlannerControl;
  /** Dedicated runtime directives injected into the next Planner startup. */
  plannerStartupDirectives: string[];
  /** Live agent instances for conversation inspection. */
  agentRegistry: Map<string, import("../agents/base.js").BaseAgent>;
  /** Background log-only supervisor for stuck-agent detection. */
  supervisor: RuntimeSupervisor | null;
  /** Stop the runtime gracefully. */
  shutdown: () => Promise<void>;
}

export interface PlannerRestartRequest {
  reason: string;
  requestedBy: string;
  requestedAt: string;
}

export class PlannerControl {
  private pendingRestart: PlannerRestartRequest | null = null;
  private listeners = new Set<(request: PlannerRestartRequest) => void>();

  requestRestart(reason: string, requestedBy = "user"): PlannerRestartRequest {
    const request = {
      reason,
      requestedBy,
      requestedAt: new Date().toISOString(),
    };
    this.pendingRestart = request;
    for (const listener of this.listeners) listener(request);
    return request;
  }

  consumeRestartRequest(): PlannerRestartRequest | null {
    const request = this.pendingRestart;
    this.pendingRestart = null;
    return request;
  }

  onRestartRequested(listener: (request: PlannerRestartRequest) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

/**
 * Bootstrap the Saivage system.
 *
 * 1. Discover/load project
 * 2. Load runtime config
 * 3. Initialize providers + MCP runtime
 * 4. Register Plan MCP service
 * 5. Run crash recovery
 * 6. Return runtime context (Planner is started separately via runPlanner)
 */
export async function bootstrap(
  projectPath?: string,
): Promise<SaivageRuntime> {
  // 1. Discover project
  const projectRoot = projectPath ?? await discoverProject(process.cwd());
  if (!projectRoot) {
    throw new Error(
      "No .saivage/ project found. Run `saivage init <path>` first.",
    );
  }
  const project = await loadProject(projectRoot);
  log.info(`[v2] Project: ${project.projectRoot}`);

  // Set env vars for subprocess inheritance and project-local path resolution.
  process.env["SAIVAGE_ROOT"] = project.saivageDir;
  process.env["PROJECT_ROOT"] = project.projectRoot;

  // 2. Load project-local runtime config
  const config = await loadConfig(project.projectRoot);
  log.info("[v2] Config loaded");
  const routing = new ModelRoutingResolver(project.config, {
    ...config,
    supervisorModel: config.supervisor.model,
  });

  validateModelCoverage(config, routing, configPath(project.projectRoot));

  // 3. Initialize model router (OAuth credentials are resolved lazily on first use)
  const router = new ModelRouter(config);
  await router.init();
  await router.inspectUsageAtStartup();
  log.info(`[v2] Providers: ${router.listProviders().join(", ")}`);

  // 4. Initialize MCP runtime + builtin services
  const mcpRuntime = new McpRuntime(config);
  registerBuiltinServices(mcpRuntime, config.mcp, config.security);
  await startConfiguredMcpServers(mcpRuntime, config);
  mcpRuntime.startMonitoring();

  // 5. Register Plan MCP service (in-process)
  const planService = new PlanService(project.saivageDir);
  await planService.init();
  planService.setGitCommit(async (files: string[], message: string) => {
    // Use MCP git service to commit
    const result = await mcpRuntime.callTool("git", "git_commit", { files, message });
    return { sha: (result as { sha?: string })?.sha ?? "unknown" };
  });

  const planTools = PlanService.getToolSchemas();
  mcpRuntime.registerInProcess(
    "plan",
    planTools,
    (toolName: string, args: Record<string, unknown>, _ctx?: import("../mcp/toolContext.js").ToolCallContext) =>
      planService.handleToolCall(toolName, args),
  );

  // 6. Single-instance guard: PID-liveness check (fast path) plus an
  // O_CREAT|O_EXCL lockfile that closes the TOCTOU between the check and
  // the first writeRuntimeState call.
  if (await isAnotherInstanceRunning(project.paths.runtimeState)) {
    throw new Error(
      "Another Saivage instance is already running. Stop it first or check runtime.json.",
    );
  }
  const runtimeLock = await acquireRuntimeLock(project.saivageDir);

  // 7. Crash recovery
  const recovery = await recoverFromCrash(project, planService);
  if (recovery.recovered) {
    log.info(`[v2] Crash recovery completed (stale state from previous run)`);
    if (recovery.needsArchival) {
      log.info(`[v2] Stage ${recovery.stageId} needs archival by Planner`);
    }
  }

  // 7b. Clean up stale/expired notes from previous runs
  {
    const noteCleanup = new NoteManager(project.paths.notes);
    const cleaned = await noteCleanup.cleanupStaleNotes(config.runtime.notes.volatileTtlMs);
    if (cleaned > 0) {
      log.info(`[v2] Cleaned ${cleaned} stale/expired notes from previous run`);
    }
  }

  // 8. Event bus
  const eventBus = new EventBus();

  // 9. Clean stale stash files
  await cleanStash();

  // Write initial runtime state
  const runtimeState = createRuntimeState();
  await writeRuntimeState(project.paths.runtimeState, runtimeState);

  // Runtime tracker for agent lifecycle → dashboard
  const tracker = new RuntimeTracker(project.paths.runtimeState);
  const agentRegistry = new Map<string, import("../agents/base.js").BaseAgent>();
  const plannerControl = new PlannerControl();
  let supervisor: RuntimeSupervisor | null = null;

  const runtime: SaivageRuntime = {
    config,
    router,
    routing,
    mcpRuntime,
    eventBus,
    planService,
    project,
    tracker,
    plannerControl,
    plannerStartupDirectives: [],
    agentRegistry,
    supervisor: null,
    shutdown: async () => {
      log.info("[v2] Shutting down...");
      // Freeze the tracker FIRST so any agent activity callbacks firing
      // during teardown cannot race the final "idle" write below.
      tracker.freeze("shutdown");
      try {
        await writeShutdownSummary(project);
      } catch (err) {
        log.warn(`[shutdown] Failed to save shutdown summary: ${err instanceof Error ? err.message : String(err)}`);
      }
      supervisor?.stop();
      await mcpRuntime.shutdown();
      eventBus.clear();
      const finalState = createRuntimeState();
      finalState.status = "idle";
      await writeRuntimeState(project.paths.runtimeState, finalState);
      runtimeLock.release();
      log.info("[v2] Shutdown complete");
    },
  };

  installFatalHandlers(runtime, runtimeLock);

  const noteService = new NoteService(project.paths.notes);
  mcpRuntime.registerInProcess(
    "notes",
    NoteService.getToolSchemas(),
    (toolName: string, args: Record<string, unknown>, _ctx?: import("../mcp/toolContext.js").ToolCallContext) =>
      noteService.handleToolCall(toolName, args),
  );

  supervisor = new RuntimeSupervisor(
    config,
    { router, agentRegistry },
    config.supervisor.enabled ? routing.resolve("supervisor").modelSpec : undefined,
  );
  runtime.supervisor = supervisor;
  supervisor.start();

  const shutdownHandoff = await consumeShutdownHandoff(project);
  if (shutdownHandoff) {
    queuePlannerDirective(runtime, shutdownHandoff);
    log.info("[shutdown] Loaded restart handoff directive for next planner session");
  }

  return runtime;
}

/**
 * Create the child spawner factory for the agent hierarchy.
 * This is the function that wires Planner → Manager → Coder/Researcher.
 */
export function createChildSpawner(
  runtime: SaivageRuntime,
): ChildSpawner {
  const stageReviewers = new Map<string, { agent: ReviewerAgent; ctx: AgentContext }>();

  return async (
    role: import("../agents/roster.js").DispatchableRole,
    input: unknown,
    _parentCtx: AgentContext,
  ): Promise<AgentResult> => {
    const { project, router, mcpRuntime, eventBus, tracker } = runtime;

    const ctx: AgentContext = {
      project,
      router,
      mcpRuntime,
      agentId: agentId(),
      role,
      ...resolveAgentRoute(runtime, role),
    };

    let agent: Agent;
    let trackingAgentId = ctx.agentId;
    let taskId: string | undefined;

    switch (role) {
      case "manager": {
        const managerInput = input as import("../agents/types.js").ManagerInput;
        const managerSpawner = createChildSpawner(runtime);
        ctx.stageId = managerInput.stage?.id;
        agent = await ManagerAgent.create(ctx, managerInput, managerSpawner, {
          onActivity: (agentId) => tracker.agentActivity(agentId),
          onCompactionUpdate: tracker.agentCompactionUpdate.bind(tracker),
        });
        tracker.setCurrentStage(managerInput.stage?.id ?? null);
        break;
      }

      case "coder": {
        const workerInput = normalizeWorkerDispatchInput(input, role);
        ctx.stageId = workerInput.stageId;
        agent = await WorkerAgent.createWorker<CoderAgent>(ctx, workerInput, role, {
          onActivity: (agentId) => tracker.agentActivity(agentId),
          onCompactionUpdate: tracker.agentCompactionUpdate.bind(tracker),
        });
        taskId = workerInput.task?.id;
        tracker.setCurrentStage(workerInput.stageId);
        break;
      }

      case "researcher": {
        const workerInput = normalizeWorkerDispatchInput(input, role);
        ctx.stageId = workerInput.stageId;
        agent = await WorkerAgent.createWorker<ResearcherAgent>(ctx, workerInput, role, {
          onActivity: (agentId) => tracker.agentActivity(agentId),
          onCompactionUpdate: tracker.agentCompactionUpdate.bind(tracker),
        });
        taskId = workerInput.task?.id;
        tracker.setCurrentStage(workerInput.stageId);
        break;
      }

      case "data_agent": {
        const workerInput = normalizeWorkerDispatchInput(input, role);
        ctx.stageId = workerInput.stageId;
        agent = await WorkerAgent.createWorker<DataAgent>(ctx, workerInput, role, {
          onActivity: (agentId) => tracker.agentActivity(agentId),
          onCompactionUpdate: tracker.agentCompactionUpdate.bind(tracker),
        });
        taskId = workerInput.task?.id;
        tracker.setCurrentStage(workerInput.stageId);
        break;
      }

      case "reviewer": {
        const workerInput = normalizeWorkerDispatchInput(input, role);
        const stageId = workerInput.stageId ?? "unknown-stage";
        ctx.stageId = workerInput.stageId;
        const existing = stageReviewers.get(stageId);
        if (existing) {
          agent = existing.agent;
          trackingAgentId = existing.ctx.agentId;
          taskId = workerInput.task?.id;
          tracker.setCurrentStage(workerInput.stageId);
          break;
        }

        const reviewer = await WorkerAgent.createWorker<ReviewerAgent>(ctx, workerInput, role, {
          onActivity: (agentId) => tracker.agentActivity(agentId),
          onCompactionUpdate: tracker.agentCompactionUpdate.bind(tracker),
        });
        agent = reviewer;
        stageReviewers.set(stageId, { agent: reviewer, ctx });
        taskId = workerInput.task?.id;
        tracker.setCurrentStage(workerInput.stageId);
        break;
      }

      case "designer": {
        const workerInput = normalizeWorkerDispatchInput(input, role);
        ctx.stageId = workerInput.stageId;
        agent = await WorkerAgent.createWorker<DesignerAgent>(ctx, workerInput, role, {
          onActivity: (agentId) => tracker.agentActivity(agentId),
          onCompactionUpdate: tracker.agentCompactionUpdate.bind(tracker),
        });
        taskId = workerInput.task?.id;
        tracker.setCurrentStage(workerInput.stageId);
        break;
      }

      case "inspector": {
        const inspectorInput = input as import("../agents/types.js").InspectorInput;
        ctx.stageId = tracker.getCurrentStage() ?? undefined;
        agent = await InspectorAgent.create(ctx, inspectorInput, {
          onActivity: (agentId) => tracker.agentActivity(agentId),
          onCompactionUpdate: tracker.agentCompactionUpdate.bind(tracker),
        });
        break;
      }

      default:
        return assertExhaustive(role);
    }

      tracker.agentStarted(trackingAgentId, role as AgentState["agent_type"], taskId);
      runtime.agentRegistry.set(trackingAgentId, agent as unknown as import("../agents/base.js").BaseAgent);

    try {
      const result = role === "reviewer" && agent instanceof ReviewerAgent
        ? await agent.review(input as import("../agents/types.js").WorkerInput)
        : await agent.run();

      // Publish events for significant results
      if (role === "manager") {
        const stageId = (input as import("../agents/types.js").ManagerInput).stage?.id;
        await publishAgentResult(eventBus, role, stageId, result);
      } else if (role === "inspector") {
        await publishAgentResult(eventBus, role, undefined, result);
      }

      return result;
    } finally {
      tracker.agentStopped(trackingAgentId);
      if (role === "manager") {
        tracker.setCurrentStage(null);
      }
      runtime.agentRegistry.delete(trackingAgentId);
    }
  };
}

function normalizeWorkerDispatchInput(
  input: unknown,
  role: import("../agents/roster.js").DispatchableRole,
): import("../agents/types.js").WorkerInput {
  const raw = input as Record<string, unknown> | null;
  if (!raw || typeof raw !== "object") {
    throw new Error(`Invalid ${role} dispatch: expected an object input`);
  }

  const rawStageId = raw.stageId ?? raw.stage_id;
  if (typeof rawStageId !== "string" || rawStageId.trim() === "") {
    throw new Error(`Invalid ${role} dispatch: missing required stageId`);
  }

  const rawTask = raw.task as Record<string, unknown> | null;
  if (!rawTask || typeof rawTask !== "object") {
    throw new Error(`Invalid ${role} dispatch: missing required task object`);
  }

  const rawTaskId = rawTask.id ?? rawTask.task_id;
  if (typeof rawTaskId !== "string" || rawTaskId.trim() === "") {
    throw new Error(`Invalid ${role} dispatch: task.id is required`);
  }

  const description = firstNonEmptyString(
    rawTask.description,
    rawTask.objective,
    rawTask.title,
    rawTask.name,
    rawTask.instructions,
  );
  if (!description) {
    throw new Error(`Invalid ${role} dispatch: task.description or task.objective is required`);
  }

  return {
    stageId: rawStageId.trim(),
    task: {
      ...rawTask,
      id: rawTaskId.trim(),
      description,
    } as import("../types.js").Task,
  };
}

function firstNonEmptyString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim() !== "") return value.trim();
  }
  return undefined;
}

/**
 * Start the Planner agent and run the autonomous loop.
 */
export async function runPlanner(
  runtime: SaivageRuntime,
  options: { abortSignal?: { aborted: boolean } } = {},
): Promise<AgentResult> {
  const { project, router, mcpRuntime, tracker } = runtime;

  const ctx: AgentContext = {
    project,
    router,
    mcpRuntime,
    agentId: agentId(),
    role: "planner",
    ...resolveAgentRoute(runtime, "planner"),
    startupDirectives: runtime.plannerStartupDirectives.splice(0),
    stageId: tracker.getCurrentStage() ?? undefined,
  };

  const childSpawner = createChildSpawner(runtime);
  const planner = await PlannerAgent.create(ctx, childSpawner, {
    abortSignal: options.abortSignal,
    onActivity: (agentId) => tracker.agentActivity(agentId),
    onCompactionUpdate: tracker.agentCompactionUpdate.bind(tracker),
  });

  tracker.agentStarted(ctx.agentId, "planner");
  runtime.agentRegistry.set(ctx.agentId, planner as import("../agents/base.js").BaseAgent);

  // Handle graceful shutdown
  const shutdownHandler = () => {
    log.info("[v2] Received shutdown signal — cancelling Planner");
    planner.cancel();
  };
  process.on("SIGINT", shutdownHandler);
  process.on("SIGTERM", shutdownHandler);

  try {
    const result = await planner.run();
    return result;
  } finally {
    tracker.agentStopped(ctx.agentId);
    runtime.agentRegistry.delete(ctx.agentId);
    process.off("SIGINT", shutdownHandler);
    process.off("SIGTERM", shutdownHandler);
  }
}

const RECOVERY_PROMPT =
  `SYSTEM RECOVERY: The planner session ended without completing all objectives. ` +
  `You have been automatically restarted. You MUST:\n\n` +
  `1. Call plan_get() to read the current plan state.\n` +
  `2. Call plan_get_history() to see what stages have completed, failed, or escalated.\n` +
  `3. Assess what work remains to achieve ALL project objectives.\n` +
  `4. If escalated stages exist, analyze WHY they failed and create corrective stages.\n` +
  `5. Call plan_set_current() on the next stage and dispatch it with run_manager().\n\n` +
  `DO NOT call plan_done unless ALL objectives are truly achieved with evidence from successful stages. ` +
  `If stages have escalated or failed, the objectives are NOT complete — you must fix the issues and retry.`;

const CONTINUOUS_IMPROVEMENT_PROMPT =
  `SYSTEM CONTINUOUS IMPROVEMENT: The configured project objectives appear complete, but Saivage is running in continuous-improvement mode. ` +
  `Do not stop just because the active plan is empty. You MUST keep improving the target project while preserving its objectives and constraints. ` +
  `The next stage must be driven by the project's stated mission, not by generic repository tidying.\n\n` +
  `On this cycle:\n` +
  `1. Call plan_get() and plan_get_history() to confirm the current state.\n` +
  `2. Re-read the project objectives and recent results to identify the next highest-value objective-aligned experiment or blocker.\n` +
  `3. If the project is an ML/research project, first assess whether the dataset is large, complete, high-quality, and auditable enough for model work. If not, prioritize data acquisition, repair, provenance, quality reporting, and snapshot freezing before additional model tuning.\n` +
  `4. Once the data foundation is credible, prefer a research -> data/features -> implementation -> evaluation -> comparison cycle: find a promising model/data idea, implement a bounded experiment, retrieve required data, run honest evaluation, update the leaderboard/reporting, and compare against prior models.\n` +
  `5. Only create maintenance, QA, documentation, or hardening stages when they directly unblock or improve the reliability of the objective-aligned experiment loop.\n` +
  `6. Because plan.json already exists in continuous-improvement cycles, DO NOT call plan_init(). Create at least one concrete, bounded next stage with plan_add_stage() or plan_set_stages().\n` +
  `7. Dispatch the next stage with run_manager().\n\n` +
  `Only call plan_done if continuous-improvement mode has been disabled by runtime configuration or shutdown is requested.`;

function buildRestartPrompt(request: PlannerRestartRequest): string {
  return (
    `SYSTEM REQUESTED PLANNER RESTART: ${request.requestedBy} explicitly requested that the Planner restart.\n\n` +
    `Requested at: ${request.requestedAt}\n` +
    `Reason/request: ${request.reason}\n\n` +
    `On restart, do not assume the previous in-memory conversation is complete. ` +
    `Call plan_get() and plan_get_history(), reassess current project state, honor this user request, and continue with the next concrete action.`
  );
}

function queuePlannerDirective(runtime: SaivageRuntime, content: string): void {
  runtime.plannerStartupDirectives.push(content);
}

/**
 * Run the planner in a recovery loop. When the planner exits (success or
 * max-nudges), wait the configured recovery delay then restart with a continuation prompt.
 * Only stops on explicit plan_done, abort, or process shutdown.
 */
export async function runPlannerWithRecovery(
  runtime: SaivageRuntime,
): Promise<AgentResult> {
  let cancelled = false;
  let iteration = 0;

  const cancelRecovery = () => { cancelled = true; };
  process.on("SIGINT", cancelRecovery);
  process.on("SIGTERM", cancelRecovery);

  try {
    while (!cancelled) {
      iteration++;
      log.info(`[recovery] Starting planner (iteration ${iteration})`);

      const abortSignal = { aborted: false };
      let restartDuringRun: PlannerRestartRequest | null = null;
      const unsubscribeRestart = runtime.plannerControl.onRestartRequested((request) => {
        restartDuringRun = request;
        abortSignal.aborted = true;
        log.info(`[recovery] Planner restart requested by ${request.requestedBy}: ${request.reason}`);
      });

      let result: AgentResult;
      try {
        result = await runPlanner(runtime, { abortSignal });
      } finally {
        unsubscribeRestart();
      }

      const restartRequest = runtime.plannerControl.consumeRestartRequest() ?? restartDuringRun;

      if (restartRequest) {
        queuePlannerDirective(runtime, buildRestartPrompt(restartRequest));
        await runtime.eventBus.publish({
          type: "plan_updated",
          summary: `Planner restart requested by ${restartRequest.requestedBy}. Restart directive queued.`,
        });
        log.info("[recovery] Restarting planner immediately after explicit request");
        continue;
      }

      log.info(`[recovery] Planner exited: ${result.kind} (iteration ${iteration})`);

      // Hard stops — no recovery
      if (result.kind === "abort") {
        log.info("[recovery] Planner aborted — stopping recovery loop");
        return result;
      }

      // In continuous-improvement mode, plan_done completes the current
      // objective batch and then restarts the Planner for the next cycle.
      if (result.kind === "success" && isPlanDoneCompletion(result.data)) {
        if (!runtime.config.runtime.continuousImprovement) {
          log.info(`[recovery] Planner completed via plan_done: ${result.data.summary}`);
          return result;
        }

        queuePlannerDirective(runtime, CONTINUOUS_IMPROVEMENT_PROMPT);
        await runtime.eventBus.publish({
          type: "plan_updated",
          summary: "Planner completed the active plan via plan_done. Continuous-improvement directive queued; restarting Planner.",
          timestamp: new Date().toISOString(),
        });
        log.info("[recovery] Planner completed via plan_done; continuous-improvement mode is enabled. Restarting planner");
        continue;
      }

      if (cancelled) break;

      // For success (nudge-out) or failure — always retry
      const recoveryDelayMs = runtime.config.runtime.recoveryDelayMs;
      log.info(
        `[recovery] Planner ended without plan_done (${result.kind}). ` +
        `Waiting ${recoveryDelayMs / 1000}s before restart...`,
      );

      await runtime.eventBus.publish({
        type: "plan_updated",
        summary: `Planner ended (${result.kind}). Recovery restart in ${Math.round(recoveryDelayMs / 1000)}s.`,
        timestamp: new Date().toISOString(),
      });

      if (await waitForRecoveryDelay(recoveryDelayMs)) cancelled = true;

      if (cancelled) break;

      queuePlannerDirective(runtime, RECOVERY_PROMPT);
      log.info("[recovery] Queued recovery directive for the next planner session");
    }

    log.info("[recovery] Recovery loop cancelled — shutting down");
    return { kind: "abort", reason: "Recovery loop cancelled by shutdown signal" };
  } finally {
    process.off("SIGINT", cancelRecovery);
    process.off("SIGTERM", cancelRecovery);
  }
}

/**
 * Wait for a recovery-loop delay. Returns true if a shutdown signal cancelled
 * the wait, false if the timer elapsed normally.
 */
export function waitForRecoveryDelay(ms: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (cancelled: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      process.off("SIGINT", onCancel);
      process.off("SIGTERM", onCancel);
      resolve(cancelled);
    };
    const timer = setTimeout(() => finish(false), ms);
    const onCancel = () => finish(true);
    process.once("SIGINT", onCancel);
    process.once("SIGTERM", onCancel);
  });
}

// ─── Helpers ────────────────────────────────────────────────────────────────

let fatalHandlersInstalled = false;

/**
 * Install last-resort handlers for `uncaughtException` / `unhandledRejection`.
 * They flush an "error" runtime state and release the lockfile so the next
 * bootstrap doesn't see ourselves as still running, then exit. Without this
 * a thrown promise in any background path (chat, supervisor, MCP client)
 * would kill the process leaving runtime.json claiming "running".
 */
function installFatalHandlers(runtime: SaivageRuntime, lock: RuntimeLock): void {
  if (fatalHandlersInstalled) return;
  fatalHandlersInstalled = true;

  const onFatal = (label: string) => (err: unknown) => {
    const msg = err instanceof Error ? err.stack ?? err.message : String(err);
    log.error(`[fatal] ${label}: ${msg}`);
    try {
      runtime.tracker.freeze(label);
    } catch { /* ignore */ }
    try {
      const failState = createRuntimeState();
      failState.status = "error";
      // Sync write — we're about to exit and cannot await reliably from a
      // fatal handler. Best-effort only.
      writeFileSync(
        runtime.project.paths.runtimeState,
        JSON.stringify(failState, null, 2),
        "utf-8",
      );
    } catch (writeErr) {
      log.warn(`[fatal] Failed to mark runtime state as error: ${writeErr instanceof Error ? writeErr.message : String(writeErr)}`);
    }
    try { lock.release(); } catch { /* ignore */ }
    // Exit on next tick so the log line has a chance to flush.
    setImmediate(() => process.exit(1));
  };

  process.on("uncaughtException", onFatal("uncaughtException"));
  process.on("unhandledRejection", onFatal("unhandledRejection"));
}

async function startConfiguredMcpServers(
  mcpRuntime: McpRuntime,
  config: SaivageConfig,
): Promise<void> {
  for (const [name, server] of Object.entries(config.mcpServers ?? {})) {
    if (server.disabled || !server.autostart) {
      log.info(`[mcp] Configured external MCP "${name}" is disabled or not autostarted`);
      continue;
    }

    const entry: ServiceEntry = {
      name,
      version: "0.1.0",
      origin: "external",
      command: server.command,
      args: server.args,
      env: server.env,
      transport: server.transport,
      tools: [],
      capabilities: [],
      createdAt: new Date().toISOString(),
    };

    try {
      await mcpRuntime.startFromEntry(entry);
    } catch (err) {
      log.warn(`[mcp] External MCP "${name}" unavailable: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}


function resolveAgentRoute(runtime: SaivageRuntime, role: string): Pick<AgentContext, "modelSpec" | "authProfileKey" | "accountRef"> {
  const route = runtime.routing.resolve(role);
  return {
    modelSpec: route.modelSpec,
    authProfileKey: route.authProfile,
    accountRef: route.accountRef,
  };
}

async function publishAgentResult(
  eventBus: EventBus,
  agentRole: string,
  stageId: string | undefined,
  result: AgentResult,
): Promise<void> {
  switch (result.kind) {
    case "success":
      if (agentRole === "manager") {
        await eventBus.publish({
          type: "stage_completed",
          stage_id: stageId,
          summary: "Stage completed successfully",
        });
      } else if (agentRole === "inspector") {
        const report = result.data as { id?: string } | undefined;
        await eventBus.publish({
          type: "inspector_complete",
          report_id: report?.id,
          summary: "Inspector report ready",
        });
      }
      break;

    case "failure":
      if (agentRole === "manager") {
        await eventBus.publish({
          type: "stage_failed",
          stage_id: stageId,
          summary: result.reason,
        });
      }
      break;

    case "escalation":
      await eventBus.publish({
        type: "escalation",
        stage_id: stageId,
        summary: result.escalation.reason ?? "Stage escalated",
      });
      break;

    case "abort":
      break; // Aborts don't generate events — the user already knows
  }
}

interface PlanDoneCompletion {
  completion: "plan_done";
  summary: string;
}

function isPlanDoneCompletion(value: unknown): value is PlanDoneCompletion {
  return !!value &&
    typeof value === "object" &&
    (value as { completion?: unknown }).completion === "plan_done" &&
    typeof (value as { summary?: unknown }).summary === "string";
}
