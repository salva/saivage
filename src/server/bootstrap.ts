/**
 * Saivage — Bootstrap
 * Wires all v2 components together: loads config, initializes providers,
 * MCP runtime, event bus, Plan MCP service, registers agent spawners,
 * runs crash recovery, starts the Planner, handles graceful shutdown.
 */

import { loadConfig, type SaivageConfig } from "../config.js";
import { ModelRouter } from "../providers/router.js";
import { McpRuntime } from "../mcp/runtime.js";
import { ensureBuiltinServices } from "../mcp/builtins.js";
import { getOAuthApiKey, hasOAuthCredentials } from "../auth/index.js";
import { cleanStash } from "../runtime/stash.js";

import { EventBus } from "../events/bus.js";
import { PlanService } from "../mcp/plan-server.js";
import {
  loadProject,
  discoverProject,
  type ProjectContext,
} from "../store/project.js";
import { recoverFromCrash, writeRuntimeState, createRuntimeState } from "../runtime/recovery.js";
import { PlannerAgent } from "../agents/planner.js";
import { ManagerAgent } from "../agents/manager.js";
import { CoderAgent } from "../agents/coder.js";
import { ResearcherAgent } from "../agents/researcher.js";
import { InspectorAgent } from "../agents/inspector.js";
import type { AgentContext, AgentResult, Agent } from "../agents/types.js";
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
  ensureBuiltinServices();

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

  // 6. Crash recovery
  const recovery = await recoverFromCrash(project, planService);
  if (recovery.recovered) {
    log.info(`[v2] Crash recovery completed (stale state from previous run)`);
    if (recovery.needsArchival) {
      log.info(`[v2] Stage ${recovery.stageId} needs archival by Planner`);
    }
  }

  // 7. Event bus
  const eventBus = new EventBus();

  // 8. Clean stale stash files
  cleanStash();

  // Write initial runtime state
  const runtimeState = createRuntimeState();
  await writeRuntimeState(project.paths.runtimeState, runtimeState);

  const runtime: SaivageRuntime = {
    config,
    router,
    mcpRuntime,
    eventBus,
    planService,
    project,
    shutdown: async () => {
      log.info("[v2] Shutting down...");
      eventBus.clear();
      // Runtime state cleared
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
    const { project, router, mcpRuntime, eventBus } = runtime;

    const ctx: AgentContext = {
      project,
      router,
      mcpRuntime,
      agentId: agentId(),
      role,
      modelSpec: resolveModelSpec(project, role),
    };

    let agent: Agent;

    switch (role) {
      case "manager": {
        const managerInput = input as import("../agents/types.js").ManagerInput;
        const managerSpawner = createChildSpawner(runtime);
        agent = new ManagerAgent(ctx, managerInput, managerSpawner);
        break;
      }

      case "coder": {
        const workerInput = input as import("../agents/types.js").WorkerInput;
        agent = new CoderAgent(ctx, workerInput);
        break;
      }

      case "researcher": {
        const workerInput = input as import("../agents/types.js").WorkerInput;
        agent = new ResearcherAgent(ctx, workerInput);
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

    const result = await agent.run();

    // Publish events for significant results
    if (role === "manager") {
      const stageId = (input as import("../agents/types.js").ManagerInput).stage?.id;
      await publishAgentResult(eventBus, role, stageId, result);
    } else if (role === "inspector") {
      await publishAgentResult(eventBus, role, undefined, result);
    }

    return result;
  };
}

/**
 * Start the Planner agent and run the autonomous loop.
 */
export async function runPlanner(
  runtime: SaivageRuntime,
): Promise<AgentResult> {
  const { project, router, mcpRuntime } = runtime;

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
    process.off("SIGINT", shutdownHandler);
    process.off("SIGTERM", shutdownHandler);
    await runtime.shutdown();
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

