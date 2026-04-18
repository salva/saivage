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
import { PlannerAgent } from "../agents/planner.js";
import { ManagerAgent } from "../agents/manager.js";
import { CoderAgent } from "../agents/coder.js";
import { ResearcherAgent } from "../agents/researcher.js";
import { InspectorAgent } from "../agents/inspector.js";
import type { AgentContext, AgentResult, Agent } from "../agents/types.js";
import type { AgentState } from "../types.js";
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
  /** Stop the runtime gracefully. */
  shutdown: () => Promise<void>;
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
  registerBuiltinServices(mcpRuntime);
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

  const runtime: SaivageRuntime = {
    config,
    router,
    mcpRuntime,
    eventBus,
    planService,
    project,
    tracker,
    shutdown: async () => {
      log.info("[v2] Shutting down...");
      await mcpRuntime.shutdown();
      eventBus.clear();
      const finalState = createRuntimeState();
      finalState.status = "idle";
      await writeRuntimeState(project.paths.runtimeState, finalState);
      log.info("[v2] Shutdown complete");
    },
  };

  return runtime;
}

/**
 * Create the child spawner factory for the agent hierarchy.
 * This is the function that wires Planner → Manager → Coder/Researcher.
 */
export function createChildSpawner(
  runtime: SaivageRuntime,
): ChildSpawner {
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
    let taskId: string | undefined;

    switch (role) {
      case "manager": {
        const managerInput = input as import("../agents/types.js").ManagerInput;
        const managerSpawner = createChildSpawner(runtime);
        agent = new ManagerAgent(ctx, managerInput, managerSpawner);
        tracker.setCurrentStage(managerInput.stage?.id ?? null);
        break;
      }

      case "coder": {
        const workerInput = input as import("../agents/types.js").WorkerInput;
        agent = new CoderAgent(ctx, workerInput);
        taskId = workerInput.task?.id;
        break;
      }

      case "researcher": {
        const workerInput = input as import("../agents/types.js").WorkerInput;
        agent = new ResearcherAgent(ctx, workerInput);
        taskId = workerInput.task?.id;
        break;
      }

      case "inspector": {
        const inspectorInput = input as import("../agents/types.js").InspectorInput;
        agent = new InspectorAgent(ctx, inspectorInput);
        break;
      }

      default:
        return { kind: "failure", reason: `Unknown agent role: ${role}` };
    }

    tracker.agentStarted(ctx.agentId, role as AgentState["agent_type"], taskId);

    try {
      const result = await agent.run();

      // Publish events for significant results
      if (role === "manager") {
        const stageId = (input as import("../agents/types.js").ManagerInput).stage?.id;
        await publishAgentResult(eventBus, role, stageId, result);
      } else if (role === "inspector") {
        await publishAgentResult(eventBus, role, undefined, result);
      }

      return result;
    } finally {
      tracker.agentStopped(ctx.agentId);
    }
  };
}

/**
 * Start the Planner agent and run the autonomous loop.
 */
export async function runPlanner(
  runtime: SaivageRuntime,
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
  const planner = new PlannerAgent(ctx, childSpawner);

  tracker.agentStarted(ctx.agentId, "planner");

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
    process.off("SIGINT", shutdownHandler);
    process.off("SIGTERM", shutdownHandler);
  }
}

const RECOVERY_DELAY_MS = 5 * 60 * 1000; // 5 minutes

const RECOVERY_PROMPT =
  `The planner session ended, but the system has automatically restarted you after a recovery delay. ` +
  `Assess the current state of the project by reading the plan (plan_get, plan_get_history). ` +
  `Determine what work remains and continue executing stages. ` +
  `If all objectives are truly complete and verified, respond with "PLAN_COMPLETE". ` +
  `Otherwise, pick up where you left off and keep making progress.`;

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

  const cancelRecovery = () => { cancelled = true; };
  process.on("SIGINT", cancelRecovery);
  process.on("SIGTERM", cancelRecovery);

  try {
    while (!cancelled) {
      iteration++;
      log.info(`[recovery] Starting planner (iteration ${iteration})`);

      const result = await runPlanner(runtime);

      log.info(`[recovery] Planner exited: ${result.kind} (iteration ${iteration})`);

      // Hard stops — no recovery
      if (result.kind === "abort") {
        log.info("[recovery] Planner aborted — stopping recovery loop");
        return result;
      }

      // Check for genuine PLAN_COMPLETE
      if (
        result.kind === "success" &&
        result.data?.summary?.includes?.("PLAN_COMPLETE")
      ) {
        log.info("[recovery] PLAN_COMPLETE detected — stopping recovery loop");
        return result;
      }

      if (cancelled) break;

      // For success (nudge-out) or failure — wait and retry
      log.info(
        `[recovery] Planner ended without PLAN_COMPLETE (${result.kind}). ` +
        `Waiting ${RECOVERY_DELAY_MS / 1000}s before restart...`,
      );

      await runtime.eventBus.publish({
        type: "plan_updated",
        summary: `Planner ended (${result.kind}). Recovery restart in ${RECOVERY_DELAY_MS / 60000} minutes.`,
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

      // Write a recovery note so the planner knows to reassess
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
        session_id: "recovery",
        content: RECOVERY_PROMPT,
        created_at: new Date().toISOString(),
        permanent: false,
        urgent: false,
      };
      writeDoc(join(notesDir, `${id}.json`), note, UserNoteSchema);
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
  // Check per-role model override in project config
  const overrides = project.config.model_overrides;
  if (overrides?.[role]) return overrides[role];
  // Fallback to default provider
  return project.config.provider ?? "openai-codex/gpt-5.3-codex";
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

