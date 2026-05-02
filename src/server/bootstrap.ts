/**
 * Saivage — Bootstrap
 * Wires all v2 components together: loads config, initializes providers,
 * MCP runtime, event bus, Plan MCP service, registers agent spawners,
 * runs crash recovery, starts the Planner, handles graceful shutdown.
 */

import { loadConfig, type SaivageConfig } from "../config.js";
import { ModelRouter } from "../providers/router.js";
import { McpRuntime } from "../mcp/runtime.js";
import { registerBuiltinServices } from "../mcp/builtins.js";
import { createPromptInjectionCop } from "../security/prompt-injection-cop.js";
import { getOAuthApiKey, hasOAuthCredentials } from "../auth/index.js";
import { cleanStash } from "../runtime/stash.js";

import { EventBus } from "../events/bus.js";
import { PlanService } from "../mcp/plan-server.js";
import {
  loadProject,
  discoverProject,
  type ProjectContext,
} from "../store/project.js";
import { recoverFromCrash, writeRuntimeState, createRuntimeState, isAnotherInstanceRunning, RuntimeTracker } from "../runtime/recovery.js";
import { RuntimeSupervisor } from "../runtime/supervisor.js";
import { consumeShutdownHandoff, writeShutdownSummary } from "../runtime/shutdown-handoff.js";
import { PlannerAgent } from "../agents/planner.js";
import { ManagerAgent } from "../agents/manager.js";
import { CoderAgent } from "../agents/coder.js";
import { ResearcherAgent } from "../agents/researcher.js";
import { DataAgent } from "../agents/data-agent.js";
import { ReviewerAgent } from "../agents/reviewer.js";
import { InspectorAgent } from "../agents/inspector.js";
import type { AgentContext, AgentResult, Agent } from "../agents/types.js";
import type { AgentState } from "../types.js";
import type { ServiceEntry } from "../mcp/registry.js";
import type { ChildSpawner } from "../runtime/dispatcher.js";
import { agentId } from "../ids.js";
import { log } from "../log.js";

/** Saivage runtime context — returned by bootstrap. */
export interface SaivageRuntime {
  config: SaivageConfig;
  router: ModelRouter;
  mcpRuntime: McpRuntime;
  eventBus: EventBus;
  planService: PlanService;
  project: ProjectContext;
  tracker: RuntimeTracker;
  plannerControl: PlannerControl;
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
  const projectRoot = projectPath ?? discoverProject(process.cwd());
  if (!projectRoot) {
    throw new Error(
      "No .saivage/ project found. Run `saivage init <path>` first.",
    );
  }
  const project = loadProject(projectRoot);
  log.info(`[v2] Project: ${project.projectRoot}`);

  // Set env vars for subprocess inheritance and project-local path resolution.
  process.env["SAIVAGE_ROOT"] = project.saivageDir;
  process.env["PROJECT_ROOT"] = project.projectRoot;

  // 2. Load project-local runtime config
  const config = loadConfig(true, project.projectRoot);
  log.info("[v2] Config loaded");

  // 3. Initialize model router + OAuth
  const router = new ModelRouter(config);
  await injectOAuthTokens(router);
  log.info(`[v2] Providers: ${router.listProviders().join(", ")}`);

  // 4. Initialize MCP runtime + builtin services
  const mcpRuntime = new McpRuntime(config.runtime);
  registerBuiltinServices(mcpRuntime, { promptInjectionCop: createPromptInjectionCop(config, router) });
  await startConfiguredMcpServers(mcpRuntime, config);
  mcpRuntime.startMonitoring();

  // 5. Register Plan MCP service (in-process)
  const planService = new PlanService(project.saivageDir);
  planService.setGitCommit(async (files: string[], message: string) => {
    // Use MCP git service to commit
    const result = await mcpRuntime.callTool("git", "git_commit", { files, message });
    return { sha: (result as { sha?: string })?.sha ?? "unknown" };
  });

  const planTools = PlanService.getToolSchemas();
  mcpRuntime.registerInProcess(
    "plan",
    planTools,
    (toolName: string, args: Record<string, unknown>) =>
      planService.handleToolCall(toolName, args),
  );

  // 6. Single-instance guard
  if (isAnotherInstanceRunning(project.paths.runtimeState)) {
    throw new Error(
      "Another Saivage instance is already running. Stop it first or check runtime.json.",
    );
  }

  // 7. Crash recovery
  const recovery = await recoverFromCrash(project, planService);
  if (recovery.recovered) {
    log.info(`[v2] Crash recovery completed (stale state from previous run)`);
    if (recovery.needsArchival) {
      log.info(`[v2] Stage ${recovery.stageId} needs archival by Planner`);
    }
  }

  // 8. Event bus
  const eventBus = new EventBus();

  // 9. Clean stale stash files
  cleanStash();

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
    mcpRuntime,
    eventBus,
    planService,
    project,
    tracker,
    plannerControl,
    agentRegistry,
    supervisor: null,
    shutdown: async () => {
      log.info("[v2] Shutting down...");
      try {
        writeShutdownSummary(project);
      } catch (err) {
        log.warn(`[shutdown] Failed to save shutdown summary: ${err instanceof Error ? err.message : String(err)}`);
      }
      supervisor?.stop();
      await mcpRuntime.shutdown();
      eventBus.clear();
      const finalState = createRuntimeState();
      finalState.status = "idle";
      await writeRuntimeState(project.paths.runtimeState, finalState);
      log.info("[v2] Shutdown complete");
    },
  };

  supervisor = new RuntimeSupervisor(config, { router, agentRegistry });
  runtime.supervisor = supervisor;
  supervisor.start();

  const shutdownHandoff = consumeShutdownHandoff(project);
  if (shutdownHandoff) {
    const noteId = await createPlannerNote(runtime, shutdownHandoff, "shutdown-handoff");
    log.info(`[shutdown] Created restart handoff note ${noteId}`);
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
    role: import("../agents/types.js").AgentRole,
    input: unknown,
    parentCtx: AgentContext,
  ): Promise<AgentResult> => {
    const { project, router, mcpRuntime, eventBus, tracker } = runtime;

    const ctx: AgentContext = {
      project,
      router,
      mcpRuntime,
      agentId: agentId(),
      role,
      modelSpec: resolveModelSpec(project, role),
    };

    let agent: Agent;
    let trackingAgentId = ctx.agentId;
    let taskId: string | undefined;

    switch (role) {
      case "manager": {
        const managerInput = input as import("../agents/types.js").ManagerInput;
        const managerSpawner = createChildSpawner(runtime);
        agent = new ManagerAgent(ctx, managerInput, managerSpawner, {
          onActivity: (agentId) => tracker.agentActivity(agentId),
        });
        tracker.setCurrentStage(managerInput.stage?.id ?? null);
        break;
      }

      case "coder": {
        const workerInput = input as import("../agents/types.js").WorkerInput;
        agent = new CoderAgent(ctx, workerInput, {
          onActivity: (agentId) => tracker.agentActivity(agentId),
        });
        taskId = workerInput.task?.id;
        break;
      }

      case "researcher": {
        const workerInput = input as import("../agents/types.js").WorkerInput;
        agent = new ResearcherAgent(ctx, workerInput, {
          onActivity: (agentId) => tracker.agentActivity(agentId),
        });
        taskId = workerInput.task?.id;
        break;
      }

      case "data_agent": {
        const workerInput = input as import("../agents/types.js").WorkerInput;
        agent = new DataAgent(ctx, workerInput, {
          onActivity: (agentId) => tracker.agentActivity(agentId),
        });
        taskId = workerInput.task?.id;
        break;
      }

      case "reviewer": {
        const workerInput = input as import("../agents/types.js").WorkerInput;
        const stageId = workerInput.stageId ?? "unknown-stage";
        const existing = stageReviewers.get(stageId);
        if (existing) {
          agent = existing.agent;
          trackingAgentId = existing.ctx.agentId;
          taskId = workerInput.task?.id;
          break;
        }

        const reviewer = new ReviewerAgent(ctx, workerInput, {
          onActivity: (agentId) => tracker.agentActivity(agentId),
        });
        agent = reviewer;
        stageReviewers.set(stageId, { agent: reviewer, ctx });
        taskId = workerInput.task?.id;
        break;
      }

      case "inspector": {
        const inspectorInput = input as import("../agents/types.js").InspectorInput;
        agent = new InspectorAgent(ctx, inspectorInput, {
          onActivity: (agentId) => tracker.agentActivity(agentId),
        });
        break;
      }

      default:
        return { kind: "failure", reason: `Unknown agent role: ${role}` };
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
      runtime.agentRegistry.delete(trackingAgentId);
    }
  };
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
    modelSpec: resolveModelSpec(project, "planner"),
  };

  const childSpawner = createChildSpawner(runtime);
  const planner = new PlannerAgent(ctx, childSpawner, {
    abortSignal: options.abortSignal,
    onActivity: (agentId) => tracker.agentActivity(agentId),
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

const RECOVERY_DELAY_MS = 60 * 1000; // 1 minute (reduced from 5 to keep momentum)

const RECOVERY_PROMPT =
  `SYSTEM RECOVERY: The planner session ended without completing all objectives. ` +
  `You have been automatically restarted. You MUST:\n\n` +
  `1. Call plan_get() to read the current plan state.\n` +
  `2. Call plan_get_history() to see what stages have completed, failed, or escalated.\n` +
  `3. Assess what work remains to achieve ALL project objectives.\n` +
  `4. If escalated stages exist, analyze WHY they failed and create corrective stages.\n` +
  `5. Call plan_set_current() on the next stage and dispatch it with run_manager().\n\n` +
  `DO NOT say PLAN_COMPLETE unless ALL objectives are truly achieved with evidence from successful stages. ` +
  `If stages have escalated or failed, the objectives are NOT complete — you must fix the issues and retry.`;

const CONTINUOUS_IMPROVEMENT_PROMPT =
  `SYSTEM CONTINUOUS IMPROVEMENT: The configured project objectives appear complete, but Saivage is running in continuous-improvement mode. ` +
  `Do not stop just because the active plan is empty. You MUST keep improving the target project while preserving its objectives and constraints. ` +
  `The next stage must be driven by the project's stated mission, not by generic repository tidying.\n\n` +
  `On this cycle:\n` +
  `1. Call plan_get() and plan_get_history() to confirm the current state.\n` +
  `2. Re-read the project objectives and recent results to identify the next highest-value objective-aligned experiment or blocker.\n` +
  `3. If the project is an ML/research project, prefer a research -> data/features -> implementation -> evaluation -> comparison cycle: find a promising model/data idea, implement a bounded experiment, retrieve required data, run honest evaluation, update the leaderboard/reporting, and compare against prior models.\n` +
  `4. Only create maintenance, QA, documentation, or hardening stages when they directly unblock or improve the reliability of the objective-aligned experiment loop.\n` +
  `5. Create at least one concrete, bounded next stage with plan_add_stage() or plan_set_stages().\n` +
  `6. Dispatch the next stage with run_manager().\n\n` +
  `Only say PLAN_COMPLETE if continuous-improvement mode has been disabled by runtime configuration or shutdown is requested.`;

function buildRestartPrompt(request: PlannerRestartRequest): string {
  return (
    `SYSTEM REQUESTED PLANNER RESTART: ${request.requestedBy} explicitly requested that the Planner restart.\n\n` +
    `Requested at: ${request.requestedAt}\n` +
    `Reason/request: ${request.reason}\n\n` +
    `On restart, do not assume the previous in-memory conversation is complete. ` +
    `Call plan_get() and plan_get_history(), reassess current project state, honor this user request, and continue with the next concrete action.`
  );
}

async function createPlannerNote(
  runtime: SaivageRuntime,
  content: string,
  sessionId: string,
): Promise<string> {
  const { writeDoc, ensureDir } = await import("../store/documents.js");
  const { noteId } = await import("../ids.js");
  const { UserNoteSchema } = await import("../types.js");
  const { join } = await import("node:path");

  const notesDir = runtime.project.paths.notes;
  ensureDir(notesDir);
  const id = noteId();
  const note = {
    id,
    channel: "system",
    session_id: sessionId,
    content,
    created_at: new Date().toISOString(),
    permanent: false,
    urgent: true,
  };
  writeDoc(join(notesDir, `${id}.json`), note, UserNoteSchema);
  return id;
}

/**
 * Run the planner in a recovery loop. When the planner exits (success or
 * max-nudges), wait RECOVERY_DELAY_MS then restart with a continuation prompt.
 * Only stops on explicit PLAN_COMPLETE, abort, or process shutdown.
 */
export async function runPlannerWithRecovery(
  runtime: SaivageRuntime,
): Promise<AgentResult> {
  let cancelled = false;
  let iteration = 0;

  // Increase max listeners to avoid warnings across recovery iterations
  process.setMaxListeners(Math.max(process.getMaxListeners(), 30));

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

      const result = await runPlanner(runtime, { abortSignal });
      unsubscribeRestart();

      const restartRequest = runtime.plannerControl.consumeRestartRequest() ?? restartDuringRun;

      if (restartRequest) {
        const noteId = await createPlannerNote(
          runtime,
          buildRestartPrompt(restartRequest),
          "planner-restart",
        );
        await runtime.eventBus.publish({
          type: "plan_updated",
          summary: `Planner restart requested by ${restartRequest.requestedBy}. Restart note ${noteId} created.`,
        });
        log.info(`[recovery] Restarting planner immediately after explicit request (${noteId})`);
        continue;
      }

      log.info(`[recovery] Planner exited: ${result.kind} (iteration ${iteration})`);

      // Hard stops — no recovery
      if (result.kind === "abort") {
        log.info("[recovery] Planner aborted — stopping recovery loop");
        return result;
      }

      // Check for genuine PLAN_COMPLETE — exact match only.
      // In continuous-improvement mode this is not terminal: it means the
      // current objective batch is complete and the Planner should create the
      // next maintenance/improvement cycle from persisted state.
      if (result.kind === "success" && hasSummary(result.data) && result.data.summary === "PLAN_COMPLETE") {
        if (!runtime.config.runtime.continuousImprovement) {
          log.info("[recovery] PLAN_COMPLETE detected — stopping recovery loop");
          return result;
        }

        const noteId = await createPlannerNote(
          runtime,
          CONTINUOUS_IMPROVEMENT_PROMPT,
          "continuous-improvement",
        );
        await runtime.eventBus.publish({
          type: "plan_updated",
          summary: `Planner completed the active plan. Continuous-improvement note ${noteId} created; restarting Planner.`,
          timestamp: new Date().toISOString(),
        });
        log.info(`[recovery] PLAN_COMPLETE detected; continuous-improvement mode is enabled. Restarting planner (${noteId})`);
        continue;
      }

      if (cancelled) break;

      // For success (nudge-out) or failure — always retry
      log.info(
        `[recovery] Planner ended without PLAN_COMPLETE (${result.kind}). ` +
        `Waiting ${RECOVERY_DELAY_MS / 1000}s before restart...`,
      );

      await runtime.eventBus.publish({
        type: "plan_updated",
        summary: `Planner ended (${result.kind}). Recovery restart in ${Math.round(RECOVERY_DELAY_MS / 1000)}s.`,
        timestamp: new Date().toISOString(),
      });

      // Wait with cancellation support
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, RECOVERY_DELAY_MS);
        const onCancel = () => {
          clearTimeout(timer);
          cancelled = true;
          resolve();
        };
        process.once("SIGINT", onCancel);
        process.once("SIGTERM", onCancel);
      });

      if (cancelled) break;

      const id = await createPlannerNote(runtime, RECOVERY_PROMPT, "recovery");
      log.info(`[recovery] Created recovery note ${id}`);
    }

    log.info("[recovery] Recovery loop cancelled — shutting down");
    return { kind: "abort", reason: "Recovery loop cancelled by shutdown signal" };
  } finally {
    process.off("SIGINT", cancelRecovery);
    process.off("SIGTERM", cancelRecovery);
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function resolveModelSpec(
  project: ProjectContext,
  role: string,
): string {
  // Check per-role model override in project config (config.json)
  const overrides = project.config.model_overrides;
  if (overrides?.[role]) return overrides[role];

  // Check role-based models from runtime config (saivage.json)
  // Map agent roles to config model keys
  const roleToModelKey: Record<string, string> = {
    planner: "orchestrator",
    manager: "orchestrator",
    coder: "coder",
    researcher: "researcher",
    data_agent: "data_agent",
    reviewer: "reviewer",
    inspector: "orchestrator",
    chat: "chat",
  };
  const runtimeConfig = loadConfig(false, project.projectRoot);
  const modelKey = roleToModelKey[role] ?? role;
  const modelFromConfig = (runtimeConfig.models as Record<string, string>)?.[modelKey];
  if (modelFromConfig) return modelFromConfig;

  // Fallback to default provider
  return project.config.provider ?? "openai-codex/gpt-5.3-codex";
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
      status: "active",
      createdAt: new Date().toISOString(),
    };

    try {
      await mcpRuntime.startFromEntry(entry);
    } catch (err) {
      log.warn(`[mcp] External MCP "${name}" unavailable: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

async function injectOAuthTokens(router: ModelRouter): Promise<void> {
  const oauthIds: Record<string, string> = {
    "openai-codex": "openai-codex",
    "anthropic": "anthropic",
    "github-copilot": "github-copilot",
  };

  for (const providerName of router.listProviders()) {
    const oauthId = oauthIds[providerName] ?? providerName;
    if (hasOAuthCredentials(oauthId)) {
      try {
        const key = await getOAuthApiKey(oauthId);
        const provider = router.getProvider(providerName);
        if (key && provider?.setApiKey) {
          provider.setApiKey(key);
          log.info(`[v2] OAuth credentials loaded for ${providerName}`);
        }
      } catch {
        // Non-fatal — provider may still work with env vars
      }
    }
  }
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

function hasSummary(value: unknown): value is { summary: string } {
  return !!value && typeof value === "object" && typeof (value as { summary?: unknown }).summary === "string";
}

