import type { BaseAgent } from "../agents/base.js";
import type { AgentContext } from "../agents/types.js";
import type { EventBus } from "../events/bus.js";
import type { PlanService } from "../mcp/plan-server.js";
import type { McpRuntime } from "../mcp/runtime.js";
import type { ModelRoutingResolver } from "../routing/resolver.js";
import type { RuntimeTracker } from "../runtime/recovery.js";
import type { NoteManager } from "../runtime/notes.js";
import type { RuntimeLifecycle } from "../runtime/lifecycle.js";
import type { ProjectContext } from "../store/project.js";
import type { StageRunStore } from "../store/stage-run-store.js";
import type { SaivageConfig } from "../config.js";
import type { PlannerControl } from "./bootstrap.js";

export interface AgentRuntimeDeps {
  project: ProjectContext;
  router: AgentContext["router"];
  routing: ModelRoutingResolver;
  mcpRuntime: McpRuntime;
  noteManager: NoteManager;
  eventBus: EventBus;
  planService: PlanService;
  stageRuns?: StageRunStore;
  tracker: RuntimeTracker;
  agentRegistry: Map<string, BaseAgent>;
  lifecycle?: Pick<RuntimeLifecycle, "signal">;
}

export interface PlannerRuntimeDeps extends AgentRuntimeDeps {
  config: Pick<SaivageConfig, "runtime">;
  plannerControl: PlannerControl;
  plannerStartupDirectives: string[];
}
