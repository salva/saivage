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

import { EventBus } from "../events/bus.js";
import { PlanService } from "../mcp/plan-server.js";
import { NoteService } from "../mcp/notes-server.js";
import { NoteManager } from "../runtime/notes.js";
import {
  loadProject,
  discoverProject,
  type ProjectContext,
} from "../store/project.js";
import { recoverFromCrash, writeRuntimeState, createRuntimeState, isAnotherInstanceRunning, acquireRuntimeLock, RuntimeTracker } from "../runtime/recovery.js";
import { RuntimeSupervisor } from "../runtime/supervisor.js";
import { consumeShutdownHandoff } from "../runtime/shutdown-handoff.js";
import { RuntimeLifecycle } from "../runtime/lifecycle.js";
import type { AgentResult } from "../agents/types.js";
import type { ServiceEntry } from "../mcp/types.js";
import type { ChildSpawner } from "../runtime/dispatcher.js";
import { log } from "../log.js";
import { ModelRoutingResolver } from "../routing/resolver.js";
import { createChildSpawner as createAgentOrchestratorChildSpawner } from "./agent-orchestrator.js";
import {
  PlannerRunner,
  queuePlannerDirective,
  runPlanner as runPlannerFromRunner,
} from "./planner-runner.js";

export {
  CONTINUOUS_IMPROVEMENT_PROMPT,
  RECOVERY_PROMPT,
  waitForRecoveryDelay,
} from "./planner-runner.js";

/** Saivage runtime context — returned by bootstrap. */
export interface SaivageRuntime {
  config: SaivageConfig;
  router: ModelRouter;
  routing: ModelRoutingResolver;
  mcpRuntime: McpRuntime;
  eventBus: EventBus;
  planService: PlanService;
  noteManager: NoteManager;
  project: ProjectContext;
  tracker: RuntimeTracker;
  plannerControl: PlannerControl;
  /** Dedicated runtime directives injected into the next Planner startup. */
  plannerStartupDirectives: string[];
  /** Live agent instances for conversation inspection. */
  agentRegistry: Map<string, import("../agents/base.js").BaseAgent>;
  /** Background log-only supervisor for stuck-agent detection. */
  supervisor: RuntimeSupervisor | null;
  /** Runtime lifecycle/cancellation owner. */
  lifecycle?: RuntimeLifecycle;
  /** RAG MCP service skeleton (F02 B07). */
  ragService: import("./rag/service.js").RagService;
  /** Knowledge store façade (F01 B07). */
  knowledgeStore: import("../knowledge/init.js").KnowledgeStore;
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
  // Warm provider model caches AFTER usage inspection: inspectUsageAtStartup
  // may call setApiKey() on providers (which resets caches like copilot's
  // modelsCache). Warming after ensures synchronous capability lookups
  // (router.getMaxContextTokens) succeed at planner / chat WS startup.
  await router.warmupProviderCaches();
  log.info(`[v2] Providers: ${router.listProviders().join(", ")}`);

  // 4. Initialize MCP runtime + builtin services
  const mcpRuntime = new McpRuntime(config);
  const { ragService, ragManager, knowledgeStore } = await initializeKnowledgeAndRag(project, config);
  registerBuiltinServices(mcpRuntime, config.mcp, config.security, {
    project,
    rag: ragService,
    knowledge: knowledgeStore,
  });
  await startConfiguredMcpServers(mcpRuntime, config);
  mcpRuntime.startMonitoring();

  // 5. Register Plan MCP service (in-process)
  const planService = new PlanService(project.saivageDir);
  await planService.init();
  planService.setGitCommit(async (files: string[], message: string) => {
    // Use MCP git service to commit
    const result = await mcpRuntime.callTool("git", "git_commit", { files, message }, {
      role: "planner",
      agentId: "runtime:plan-service",
      projectRoot: project.projectRoot,
      operatorContext: true,
      author: "runtime:plan-service",
    });
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
  const noteManager = new NoteManager(project.paths.notes);
  {
    const cleaned = await noteManager.cleanupStaleNotes(config.runtime.notes.volatileTtlMs);
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
  const lifecycle = new RuntimeLifecycle({
    project,
    tracker,
    mcpRuntime,
    knowledgeStore,
    ragManager,
    eventBus,
    runtimeLock,
    getSupervisor: () => supervisor,
  });

  const runtime: SaivageRuntime = {
    config,
    router,
    routing,
    mcpRuntime,
    eventBus,
    planService,
    noteManager,
    project,
    tracker,
    plannerControl,
    plannerStartupDirectives: [],
    agentRegistry,
    supervisor: null,
    lifecycle,
    ragService,
    knowledgeStore,
    shutdown: () => lifecycle.shutdown(),
  };

  lifecycle.installFatalHandlers();

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
  return createAgentOrchestratorChildSpawner(runtime);
}

/**
 * Start the Planner agent and run the autonomous loop.
 */
export async function runPlanner(
  runtime: SaivageRuntime,
  options: { abortSignal?: { aborted: boolean } } = {},
): Promise<AgentResult> {
  return runPlannerFromRunner(runtime, options);
}

/**
 * Run the planner in a recovery loop. When the planner exits (success or
 * max-nudges), wait the configured recovery delay then restart with a continuation prompt.
 * Only stops on explicit plan_done, abort, or process shutdown.
 */
export async function runPlannerWithRecovery(
  runtime: SaivageRuntime,
): Promise<AgentResult> {
  return new PlannerRunner(runtime).runWithRecovery();
}

// ─── Helpers ────────────────────────────────────────────────────────────────

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

async function initializeKnowledgeAndRag(
  project: ProjectContext,
  config: SaivageConfig,
): Promise<{
  ragService: import("./rag/service.js").RagService;
  ragManager: import("../rag/index.js").RagManager;
  knowledgeStore: import("../knowledge/init.js").KnowledgeStore;
}> {
  // F02 B07 — RagService shares the mutable datasets array with the manager.
  const ragDatasets = [...config.rag.datasets];
  const { createRagManager } = await import("../rag/index.js");
  const ragManager = await createRagManager({
    projectRoot: project.projectRoot,
    projectId: project.config.project_name,
    enabled: config.rag.enabled,
    datasets: ragDatasets,
  });
  const ragService: import("./rag/service.js").RagService = {
    manager: ragManager,
    datasets: ragDatasets,
    watchStatus: new Map(),
    // Static admin-role membership derived from the roster: the librarian is
    // the only non-operator role with admin access to RAG tools.
    adminRoles: new Set(["librarian"]),
    control: { busy: false },
    enabled: config.rag.enabled,
    projectRoot: project.projectRoot,
  };
  const { initKnowledgeStore } = await import("../knowledge/init.js");
  const knowledgeStore = await initKnowledgeStore({
    projectRoot: project.projectRoot,
    ragManager: ragService.manager,
    ragDatasets: ragService.datasets,
    ragEnabled: ragService.enabled,
  });
  return { ragService, ragManager, knowledgeStore };
}
