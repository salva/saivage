import { ManagerAgent } from "../agents/manager.js";
import { InspectorAgent } from "../agents/inspector.js";
import { LibrarianAgent } from "../agents/librarian.js";
import { WorkerAgent } from "../agents/worker.js";
import type { AgentContext, AgentResult, Agent } from "../agents/types.js";
import { formatAgentResultReason } from "../agents/types.js";
import { assertExhaustive, getRoster } from "../agents/roster.js";
import type { DispatchableRole, WorkerRole } from "../agents/roster.js";
import type { AgentState, Task } from "../types.js";
import type { ChildSpawner } from "../runtime/dispatcher.js";
import { agentId } from "../ids.js";
import { log } from "../log.js";
import type { EventBus } from "../events/bus.js";
import type { PlanService } from "../mcp/plan-server.js";
import type { AgentRuntimeDeps } from "./runtime-facades.js";

export class AgentOrchestrator {
  /**
   * Stage-scoped worker cache. Indexed by `stageId` then by role. Stage-scoped
   * roles (reviewer, designer, critic) keep their conversation history across
   * follow-up dispatches within the same stage so each new task builds on the
   * prior turns instead of starting from a blank slate.
   */
  private stageWorkers = new Map<
    string,
    Map<WorkerRole, { agent: WorkerAgent; ctx: AgentContext }>
  >();

  constructor(private readonly runtime: AgentRuntimeDeps) {}

  createChildSpawner(): ChildSpawner {
    return (role, input, parentCtx) => this.run(role, input, parentCtx);
  }

  async run(
    role: DispatchableRole,
    input: unknown,
    _parentCtx: AgentContext,
  ): Promise<AgentResult> {
    const { project, router, mcpRuntime, noteManager, eventBus, tracker } = this.runtime;
    const lifecycleSignal = this.runtime.lifecycle?.signal;
    const abortSignal = lifecycleSignal ? { aborted: lifecycleSignal.aborted } : undefined;

    const ctx: AgentContext = {
      project,
      router,
      mcpRuntime,
      noteManager,
      agentId: agentId(),
      role,
      ...resolveAgentRoute(this.runtime, role),
    };

    let agent: Agent;
    let runAgent: (() => Promise<AgentResult>) | undefined;
    let trackingAgentId = ctx.agentId;
    let taskId: string | undefined;
    let managerStageId: string | undefined;
    let stageScopedWorker: { stageId: string; role: WorkerRole } | undefined;

    switch (role) {
      case "manager": {
        const managerInput = input as import("../agents/types.js").ManagerInput;
        const gateFailure = await assertStageDispatchable(
          this.runtime.planService,
          managerInput.stage?.id,
        );
        if (gateFailure) {
          log.warn(
            `[dispatch-gate] rejected run_manager(${managerInput.stage?.id ?? "?"}): ` +
              `${gateFailure.code} ${gateFailure.error}`,
          );
          return { kind: "failure", reason: gateFailure };
        }
        const managerSpawner = this.createChildSpawner();
        managerStageId = managerInput.stage?.id;
        ctx.stageId = managerStageId;
        agent = await ManagerAgent.create(ctx, managerInput, managerSpawner, {
          abortSignal,
          onActivity: (agentId) => tracker.agentActivity(agentId),
          onCompactionUpdate: tracker.agentCompactionUpdate.bind(tracker),
        });
        tracker.setCurrentStage(managerStageId ?? null);
        break;
      }

      case "coder":
      case "researcher":
      case "data_agent":
      case "reviewer":
      case "designer":
      case "critic": {
        const workerInput = normalizeWorkerDispatchInput(input, role);
        const stageId = workerInput.stageId ?? "unknown-stage";
        ctx.stageId = workerInput.stageId;

        const isStageScoped = getRoster(role).stageScoped;
        const cached = isStageScoped ? this.getCachedStageWorker(stageId, role) : undefined;
        stageScopedWorker = isStageScoped ? { stageId, role } : undefined;

        if (cached) {
          agent = cached.agent;
          trackingAgentId = cached.ctx.agentId;
          runAgent = () => cached.agent.runNext(workerInput);
        } else {
          const worker = await WorkerAgent.createWorker(ctx, workerInput, role, {
            abortSignal,
            onActivity: (agentId) => tracker.agentActivity(agentId),
            onCompactionUpdate: tracker.agentCompactionUpdate.bind(tracker),
          });
          agent = worker;
          if (isStageScoped) {
            this.cacheStageWorker(stageId, role, { agent: worker, ctx });
          }
        }

        taskId = workerInput.task?.id;
        tracker.setCurrentStage(workerInput.stageId);
        break;
      }

      case "inspector": {
        const inspectorInput = input as import("../agents/types.js").InspectorInput;
        ctx.stageId = tracker.getCurrentStage() ?? undefined;
        agent = await InspectorAgent.create(ctx, inspectorInput, {
          abortSignal,
          onActivity: (agentId) => tracker.agentActivity(agentId),
          onCompactionUpdate: tracker.agentCompactionUpdate.bind(tracker),
        });
        break;
      }

      case "librarian": {
        const librarianInput = input as import("../agents/librarian.js").LibrarianInput;
        agent = await LibrarianAgent.create(ctx, librarianInput, {
          abortSignal,
          onActivity: (agentId) => tracker.agentActivity(agentId),
          onCompactionUpdate: tracker.agentCompactionUpdate.bind(tracker),
        });
        break;
      }

      default:
        return assertExhaustive(role);
    }

    tracker.agentStarted(trackingAgentId, role as AgentState["agent_type"], taskId);
    this.runtime.agentRegistry.set(trackingAgentId, agent as unknown as import("../agents/base.js").BaseAgent);
    const unsubscribeShutdown = lifecycleSignal?.onAbort(() => {
      if (abortSignal) abortSignal.aborted = true;
      agent.cancel();
    });

    try {
      const result = await (runAgent ?? (() => agent.run()))();

      // Publish events for significant results
      if (role === "manager") {
        const stageId = (input as import("../agents/types.js").ManagerInput).stage?.id;
        await publishAgentResult(eventBus, role, stageId, result);
      } else if (role === "inspector") {
        await publishAgentResult(eventBus, role, undefined, result);
      }
      if (stageScopedWorker && (result.kind === "failure" || result.kind === "abort")) {
        this.evictStageWorker(stageScopedWorker.stageId, stageScopedWorker.role);
      }

      return result;
    } finally {
      tracker.agentStopped(trackingAgentId);
      if (role === "manager") {
        tracker.setCurrentStage(null);
        if (managerStageId) this.evictStage(managerStageId);
      }
      unsubscribeShutdown?.();
      this.runtime.agentRegistry.delete(trackingAgentId);
    }
  }

  private getCachedStageWorker(
    stageId: string,
    role: WorkerRole,
  ): { agent: WorkerAgent; ctx: AgentContext } | undefined {
    return this.stageWorkers.get(stageId)?.get(role);
  }

  private cacheStageWorker(
    stageId: string,
    role: WorkerRole,
    entry: { agent: WorkerAgent; ctx: AgentContext },
  ): void {
    let perStage = this.stageWorkers.get(stageId);
    if (!perStage) {
      perStage = new Map();
      this.stageWorkers.set(stageId, perStage);
    }
    perStage.set(role, entry);
  }

  private evictStageWorker(stageId: string, role: WorkerRole): void {
    const perStage = this.stageWorkers.get(stageId);
    if (!perStage) return;
    perStage.delete(role);
    if (perStage.size === 0) this.stageWorkers.delete(stageId);
  }

  private evictStage(stageId: string): void {
    this.stageWorkers.delete(stageId);
  }
}

export function createChildSpawner(runtime: AgentRuntimeDeps): ChildSpawner {
  return new AgentOrchestrator(runtime).createChildSpawner();
}

/**
 * Stage-dispatch gate. Validates that a `run_manager` dispatch is admissible
 * against `plan.json` before constructing a ManagerAgent or mutating tracker
 * state.
 */
async function assertStageDispatchable(
  planService: PlanService,
  dispatchedStageId: string | undefined,
): Promise<import("../agents/types.js").StructuredFailureReason | null> {
  if (!dispatchedStageId || dispatchedStageId.trim() === "") {
    return { code: "VALIDATION_ERROR", error: "run_manager requires stage.id" };
  }
  const plan = await planService.plan_get();
  if ("code" in plan) {
    return { code: plan.code, error: plan.error };
  }
  const lookup = await planService.plan_get_stage(dispatchedStageId);
  if ("code" in lookup) {
    // STAGE_NOT_FOUND from plan_get_stage means not in active or history.
    return {
      code: "STAGE_NOT_FOUND",
      error:
        `Stage '${dispatchedStageId}' is not in plan.stages; ` +
        `call plan_add_stage(stage) and plan_set_current('${dispatchedStageId}') before run_manager.`,
    };
  }
  if (lookup.source === "history") {
    return {
      code: "STAGE_MISMATCH",
      error:
        `Stage '${dispatchedStageId}' is already in plan.history; ` +
        `call plan_add_stage with a new id and plan_set_current before run_manager.`,
    };
  }
  if (plan.current_stage_id !== dispatchedStageId) {
    return {
      code: "STAGE_MISMATCH",
      error:
        `Stage '${dispatchedStageId}' is not the current stage ` +
        `(plan.current_stage_id=${plan.current_stage_id === null ? "null" : `'${plan.current_stage_id}'`}); ` +
        `call plan_set_current('${dispatchedStageId}') before run_manager.`,
    };
  }
  return null;
}

function normalizeWorkerDispatchInput(
  input: unknown,
  role: DispatchableRole,
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
    } as Task,
  };
}

function firstNonEmptyString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim() !== "") return value.trim();
  }
  return undefined;
}

function resolveAgentRoute(runtime: AgentRuntimeDeps, role: string): Pick<AgentContext, "modelSpec" | "authProfileKey" | "accountRef"> {
  const route = runtime.routing.resolve(role);
  return {
    modelSpec: route.modelSpec,
    authProfileKey: route.authProfileKey,
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
          summary: formatAgentResultReason(result.reason),
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
