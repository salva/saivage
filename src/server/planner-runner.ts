import { PlannerAgent } from "../agents/planner.js";
import { buildPlanMutationContract } from "../agents/planner-contract.js";
import type { AgentContext, AgentResult } from "../agents/types.js";
import { agentId } from "../ids.js";
import { log } from "../log.js";
import type { RuntimeCancellationSignal } from "../runtime/lifecycle.js";
import { createChildSpawner } from "./agent-orchestrator.js";
import type { PlannerRestartRequest } from "./bootstrap.js";
import type { PlannerRuntimeDeps } from "./runtime-facades.js";

export const RECOVERY_PROMPT =
  `SYSTEM RECOVERY: The planner session ended without completing all objectives. ` +
  `You have been automatically restarted. You MUST:\n\n` +
  `1. Call plan_get() to read the current plan state.\n` +
  `2. Call plan_get_history() to see what stages have completed, failed, or escalated.\n\n` +
  buildPlanMutationContract() +
  `3. Assess what work remains to achieve ALL project objectives.\n` +
  `4. If escalated stages exist, analyze WHY they failed and create corrective stages.\n` +
  `5. Following the contract above, call plan_add_stage (if the stage is new) then plan_set_current() on the next stage and dispatch it with run_manager().\n\n` +
  `DO NOT call plan_done unless ALL objectives are truly achieved with evidence from successful stages. ` +
  `If stages have escalated or failed, the objectives are NOT complete — you must fix the issues and retry.`;

export const CONTINUOUS_IMPROVEMENT_PROMPT =
  `SYSTEM CONTINUOUS IMPROVEMENT: The configured project objectives appear complete, but Saivage is running in continuous-improvement mode. ` +
  `Do not stop just because the active plan is empty. You MUST keep improving the target project while preserving its objectives and constraints. ` +
  `The next stage must be driven by the project's stated mission, not by generic repository tidying.\n\n` +
  buildPlanMutationContract() +
  `On this cycle:\n` +
  `1. Call plan_get() and plan_get_history() to confirm the current state.\n` +
  `2. Re-read the project objectives and recent results to identify the next highest-value objective-aligned experiment or blocker.\n` +
  `3. If the project is an ML/research project, first assess whether the dataset is large, complete, high-quality, and auditable enough for model work. If not, prioritize data acquisition, repair, provenance, quality reporting, and snapshot freezing before additional model tuning.\n` +
  `4. Once the data foundation is credible, prefer a research -> data/features -> implementation -> evaluation -> comparison cycle: find a promising model/data idea, implement a bounded experiment, retrieve required data, run honest evaluation, update the leaderboard/reporting, and compare against prior models.\n` +
  `5. Only create maintenance, QA, documentation, or hardening stages when they directly unblock or improve the reliability of the objective-aligned experiment loop.\n` +
  `6. Because plan.json already exists in continuous-improvement cycles, DO NOT call plan_init(). Create at least one concrete, bounded next stage with plan_add_stage() (preferred for single-stage additions; plan_set_stages is also acceptable).\n` +
  `7. Following the contract above, call plan_set_current(stage.id) and then run_manager(stage).\n\n` +
  `Only call plan_done if continuous-improvement mode has been disabled by runtime configuration or shutdown is requested.`;

interface PlannerRunnerDeps {
  runPlanner?: (runtime: PlannerRuntimeDeps, options?: { abortSignal?: { aborted: boolean } }) => Promise<AgentResult>;
  waitForRecoveryDelay?: (ms: number, signal?: RuntimeCancellationSignal) => Promise<boolean>;
}

export class PlannerRunner {
  private readonly runPlannerImpl: NonNullable<PlannerRunnerDeps["runPlanner"]>;
  private readonly waitForRecoveryDelayImpl: NonNullable<PlannerRunnerDeps["waitForRecoveryDelay"]>;

  constructor(
    private readonly runtime: PlannerRuntimeDeps,
    deps: PlannerRunnerDeps = {},
  ) {
    this.runPlannerImpl = deps.runPlanner ?? runPlanner;
    this.waitForRecoveryDelayImpl = deps.waitForRecoveryDelay ?? waitForRecoveryDelay;
  }

  /**
   * Run the planner in a recovery loop. When the planner exits (success or
   * max-nudges), wait the configured recovery delay then restart with a
   * continuation prompt. Only stops on explicit plan_done, abort, or process
   * shutdown.
   */
  async runWithRecovery(): Promise<AgentResult> {
    const lifecycleSignal = this.runtime.lifecycle?.signal;
    let cancelled = lifecycleSignal?.aborted ?? false;
    let iteration = 0;
    let activeAbortSignal: { aborted: boolean } | null = null;

    const unsubscribeShutdown = lifecycleSignal?.onAbort(() => {
      cancelled = true;
      if (activeAbortSignal) activeAbortSignal.aborted = true;
    });

    try {
      while (!cancelled) {
        iteration++;
        log.info(`[recovery] Starting planner (iteration ${iteration})`);

        const abortSignal = { aborted: lifecycleSignal?.aborted ?? false };
        activeAbortSignal = abortSignal;
        let restartDuringRun: PlannerRestartRequest | null = null;
        const unsubscribeRestart = this.runtime.plannerControl.onRestartRequested((request) => {
          restartDuringRun = request;
          abortSignal.aborted = true;
          log.info(`[recovery] Planner restart requested by ${request.requestedBy}: ${request.reason}`);
        });

        let result: AgentResult;
        try {
          result = await this.runPlannerImpl(this.runtime, { abortSignal });
        } finally {
          activeAbortSignal = null;
          unsubscribeRestart();
        }

        const restartRequest = this.runtime.plannerControl.consumeRestartRequest() ?? restartDuringRun;

        if (restartRequest) {
          queuePlannerDirective(this.runtime, buildRestartPrompt(restartRequest));
          await this.runtime.eventBus.publish({
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
          if (!this.runtime.config.runtime.continuousImprovement) {
            log.info(`[recovery] Planner completed via plan_done: ${result.data.summary}`);
            return result;
          }

          queuePlannerDirective(this.runtime, CONTINUOUS_IMPROVEMENT_PROMPT);
          await this.runtime.eventBus.publish({
            type: "plan_updated",
            summary: "Planner completed the active plan via plan_done. Continuous-improvement directive queued; restarting Planner.",
            timestamp: new Date().toISOString(),
          });
          log.info("[recovery] Planner completed via plan_done; continuous-improvement mode is enabled. Restarting planner");
          continue;
        }

        if (cancelled) break;

        // For success (nudge-out) or failure — always retry
        const recoveryDelayMs = this.runtime.config.runtime.recoveryDelayMs;
        log.info(
          `[recovery] Planner ended without plan_done (${result.kind}). ` +
          `Waiting ${recoveryDelayMs / 1000}s before restart...`,
        );

        await this.runtime.eventBus.publish({
          type: "plan_updated",
          summary: `Planner ended (${result.kind}). Recovery restart in ${Math.round(recoveryDelayMs / 1000)}s.`,
          timestamp: new Date().toISOString(),
        });

        if (await this.waitForRecoveryDelayImpl(recoveryDelayMs, lifecycleSignal)) cancelled = true;

        if (cancelled) break;

        queuePlannerDirective(this.runtime, RECOVERY_PROMPT);
        log.info("[recovery] Queued recovery directive for the next planner session");
      }

      log.info("[recovery] Recovery loop cancelled — shutting down");
      return { kind: "abort", reason: "Recovery loop cancelled by shutdown signal" };
    } finally {
      unsubscribeShutdown?.();
    }
  }
}

/**
 * Start the Planner agent and run the autonomous loop.
 */
export async function runPlanner(
  runtime: PlannerRuntimeDeps,
  options: { abortSignal?: { aborted: boolean } } = {},
): Promise<AgentResult> {
  const { project, router, mcpRuntime, noteManager, tracker } = runtime;
  const lifecycleSignal = runtime.lifecycle?.signal;
  const abortSignal = options.abortSignal ?? (lifecycleSignal ? { aborted: lifecycleSignal.aborted } : undefined);

  const ctx: AgentContext = {
    project,
    router,
    mcpRuntime,
    noteManager,
    agentId: agentId(),
    role: "planner",
    ...resolveAgentRoute(runtime, "planner"),
    startupDirectives: runtime.plannerStartupDirectives.splice(0),
    stageId: tracker.getCurrentStage() ?? undefined,
  };

  const childSpawner = createChildSpawner(runtime);
  const planner = await PlannerAgent.create(ctx, childSpawner, {
    abortSignal,
    onActivity: (agentId) => tracker.agentActivity(agentId),
    onCompactionUpdate: tracker.agentCompactionUpdate.bind(tracker),
  });

  tracker.agentStarted(ctx.agentId, "planner");
  runtime.agentRegistry.set(ctx.agentId, planner as import("../agents/base.js").BaseAgent);

  const cancelPlanner = () => {
    if (abortSignal) abortSignal.aborted = true;
    log.info("[v2] Runtime shutdown requested — cancelling Planner");
    planner.cancel();
  };
  const unsubscribeShutdown = lifecycleSignal?.onAbort(cancelPlanner);

  const shutdownHandler = lifecycleSignal ? undefined : () => {
    log.info("[v2] Received shutdown signal — cancelling Planner");
    planner.cancel();
  };
  if (shutdownHandler) {
    process.on("SIGINT", shutdownHandler);
    process.on("SIGTERM", shutdownHandler);
  }

  try {
    const result = await planner.run();
    return result;
  } finally {
    tracker.agentStopped(ctx.agentId);
    runtime.agentRegistry.delete(ctx.agentId);
    unsubscribeShutdown?.();
    if (shutdownHandler) {
      process.off("SIGINT", shutdownHandler);
      process.off("SIGTERM", shutdownHandler);
    }
  }
}

export async function runPlannerWithRecovery(runtime: PlannerRuntimeDeps): Promise<AgentResult> {
  return new PlannerRunner(runtime).runWithRecovery();
}

/**
 * Wait for a recovery-loop delay. Returns true if a shutdown signal cancelled
 * the wait, false if the timer elapsed normally.
 */
export function waitForRecoveryDelay(ms: number, signal?: RuntimeCancellationSignal): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let settled = false;
    let unsubscribeAbort: (() => void) | undefined;
    const finish = (cancelled: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      unsubscribeAbort?.();
      process.off("SIGINT", onCancel);
      process.off("SIGTERM", onCancel);
      resolve(cancelled);
    };
    const timer = setTimeout(() => finish(false), ms);
    const onCancel = () => finish(true);
    if (signal) {
      unsubscribeAbort = signal.onAbort(onCancel);
      if (signal.aborted) finish(true);
    } else {
      process.once("SIGINT", onCancel);
      process.once("SIGTERM", onCancel);
    }
  });
}

export function queuePlannerDirective(runtime: Pick<PlannerRuntimeDeps, "plannerStartupDirectives">, content: string): void {
  runtime.plannerStartupDirectives.push(content);
}

function buildRestartPrompt(request: PlannerRestartRequest): string {
  return (
    `SYSTEM REQUESTED PLANNER RESTART: ${request.requestedBy} explicitly requested that the Planner restart.\n\n` +
    `Requested at: ${request.requestedAt}\n` +
    `Reason/request: ${request.reason}\n\n` +
    `On restart, do not assume the previous in-memory conversation is complete. ` +
    `Call plan_get() and plan_get_history(), reassess current project state, honor this user request, and continue with the next concrete action.`
  );
}

function resolveAgentRoute(runtime: PlannerRuntimeDeps, role: string): Pick<AgentContext, "modelSpec" | "authProfileKey" | "accountRef"> {
  const route = runtime.routing.resolve(role);
  return {
    modelSpec: route.modelSpec,
    authProfileKey: route.authProfileKey,
    accountRef: route.accountRef,
  };
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
