/**
 * Saivage — WorkerAgent base class.
 *
 * Shared lifecycle for every manager-dispatched, TaskReport-producing worker
 * role. `BaseAgent` owns the LLM/tool/compact loop; `WorkerAgent` owns the
 * "build initial message → normalise task → run loop → parse TaskReport →
 * return" wrapper.
 *
 * Some worker roles are **stage-scoped** (see `RosterEntry.stageScoped`).
 * For those, the dispatcher reuses one instance across follow-up dispatches
 * within the same stage. `runNext()` is the public entry point used by the
 * dispatcher for those reuse cases: it updates the input, injects a follow-up
 * banner so the LLM sees a clear boundary between turns, and reuses the
 * shared `executeTask()` pipeline. The conversation history (and therefore
 * prior findings) is preserved automatically by `BaseAgent`.
 */

import { BaseAgent, type BaseAgentConfig } from "./base.js";
import type {
  Agent,
  AgentContext,
  AgentResult,
  WorkerInput,
} from "./types.js";
import {
  normalizeTask,
  buildFailureReport,
  ROLE_TO_TASK_TYPE,
  type WorkerRole,
} from "./task-report.js";
import { getWorkerInitMeta } from "./roster.js";
import { loadRolePrompt } from "./prompts.js";
import { buildEagerBlock } from "../knowledge/eagerLoader.js";
import { buildHandoffContext } from "./handoff.js";
import { log } from "../log.js";
import { checkWorkerCompletion } from "./compliance.js";
import { ProjectStore } from "../store/project-store.js";

export interface BuildInitialMessageOpts {
  headingSuffix?: string;
  prependFollowUp?: boolean;
}

export async function buildInitialMessage(
  ctx: AgentContext,
  input: WorkerInput,
  role: WorkerRole,
  opts: BuildInitialMessageOpts = {},
): Promise<string> {
  const meta = getWorkerInitMeta(role);
  const checklist = (input.task.checklist ?? [])
    .map((c) => `- [${c.required ? "REQUIRED" : "optional"}] ${c.description}`)
    .join("\n");
  const handoff = await buildHandoffContext(ctx, {
    stageId: input.stageId,
    includeTasks: true,
  });
  const defaultType = ROLE_TO_TASK_TYPE[role];
  const headingSuffix = opts.headingSuffix ?? "";

  const instructions: string[] = [];
  if (opts.prependFollowUp && meta.followUpInstruction) {
    instructions.push(meta.followUpInstruction);
  }
  instructions.push(...meta.extraInstructionLines);
  if (meta.notesDir) {
    instructions.push(`Write optional detailed notes to: ${meta.notesDir(input.stageId)}`);
  }
  instructions.push(
    `Call task_write_report({ report }) with a TaskReport object for .saivage/stages/${input.stageId}/reports/${input.task.id}.json`,
  );
  instructions.push(
    `Commit using git with message prefix: [${input.task.id}] if you modify files.`,
  );
  instructions.push("After submitting the report, return a concise final response. Do not include the full TaskReport JSON in the final response.");

  return (
    `## ${meta.heading}${headingSuffix}\n\n` +
    `${handoff}\n\n` +
    `**Task ID:** ${input.task.id}\n` +
    `**Stage ID:** ${input.stageId}\n` +
    `**Type:** ${input.task.type ?? defaultType}\n` +
    `**Attempt:** ${input.task.attempt ?? 1} of ${input.task.max_attempts ?? 3}\n\n` +
    `### Description\n${input.task.description}\n\n` +
    (checklist ? `### Checklist\n${checklist}\n\n` : "") +
    `### Instructions\n${instructions.join("\n")}`
  );
}

export class WorkerAgent extends BaseAgent implements Agent {
  protected input: WorkerInput;
  protected readonly workerRole: WorkerRole;
  private readonly invalidFinalResponseMessage: string;
  /** Number of completed turns; >0 means the next `run()` is a follow-up. */
  private turnCount = 0;

  constructor(
    ctx: AgentContext,
    input: WorkerInput,
    role: WorkerRole,
    eagerSkillBlock: string,
    initialMessage: string,
    config?: Partial<BaseAgentConfig>,
  ) {
    const task = normalizeTask(input.task as unknown as Record<string, unknown>, role);
    const normalized: WorkerInput = { ...input, task };
    const meta = getWorkerInitMeta(role);
    super(ctx, {
      systemPrompt: loadRolePrompt(meta.promptKey),
      eagerSkillBlock,
      skillContext: {
        agentRole: role,
        description: task.description,
        tags: task.tags ?? [],
      },
      initialMessage,
      ...config,
    });
    this.input = normalized;
    this.workerRole = role;
    this.invalidFinalResponseMessage = meta.invalidFinalResponseMessage;
  }

  static async createWorker(
    ctx: AgentContext,
    input: WorkerInput,
    role: WorkerRole,
    config?: Partial<BaseAgentConfig>,
  ): Promise<WorkerAgent> {
    const initialMessage = await buildInitialMessage(ctx, input, role);
    const eagerSkillBlock = await buildEagerBlock(
      ctx.project.projectRoot,
      role,
      input.task.description,
      input.task.tags ?? [],
    );
    return new WorkerAgent(ctx, input, role, eagerSkillBlock, initialMessage, config);
  }

  async run(): Promise<AgentResult> {
    this.input = { ...this.input, task: normalizeTask(this.input.task as unknown as Record<string, unknown>, this.workerRole) };
    if (this.turnCount > 0) {
      const followUp = await buildInitialMessage(this.ctx, this.input, this.workerRole, {
        headingSuffix: ` — Follow-up ${this.turnCount + 1}`,
        prependFollowUp: true,
      });
      this.injectMessage(followUp);
    }
    this.turnCount++;
    return this.executeTask(this.input);
  }

  /**
   * Public entry point used by the dispatcher when reusing a stage-scoped
   * worker for a follow-up task. Swaps the bound input and re-enters `run()`
   * so the follow-up banner is injected and the shared `executeTask()`
   * pipeline handles the rest.
   */
  async runNext(input: WorkerInput): Promise<AgentResult> {
    this.input = input;
    return this.run();
  }

  /**
   * Shared try/catch/finishReason → AgentResult mapping. Used by `run()` for
   * every worker, including stage-scoped roles after the follow-up banner has
   * been injected.
   */
  protected async executeTask(input: WorkerInput): Promise<AgentResult> {
    log.info(
      `[${this.workerRole}:${this.id}] Starting task ${input.task.id}: ${input.task.description.slice(0, 80)}`,
    );
    const startedAt = new Date().toISOString();
    const startMs = Date.now();

    try {
      const { text, finishReason } = await this.runLoop();
      if (finishReason === "abort" || finishReason === "cancelled") {
        return {
          kind: "abort",
          reason: text,
          partial: buildFailureReport(
            input,
            this.workerRole,
            startedAt,
            startMs,
            text,
          ),
        };
      }
      if (finishReason === "max_compactions" || finishReason === "error") {
        return {
          kind: "failure",
          reason: text,
          partial: buildFailureReport(
            input,
            this.workerRole,
            startedAt,
            startMs,
            text,
          ),
        };
      }
      const artifact = this.readTaskReportArtifact();
      if (artifact.kind === "valid") {
        return { kind: "success", data: artifact.artifact };
      }
      const reason = artifact.kind === "missing"
        ? `Expected TaskReport artifact was not written at ${artifact.path}.`
        : `Invalid TaskReport artifact at ${artifact.path}: ${artifact.reason}.`;
      return {
        kind: "failure",
        reason,
        partial: buildFailureReport(
          input,
          this.workerRole,
          startedAt,
          startMs,
          reason,
        ),
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error(`[${this.workerRole}:${this.id}] Failed: ${msg}`);
      return {
        kind: "failure",
        reason: msg,
        partial: buildFailureReport(
          input,
          this.workerRole,
          startedAt,
          startMs,
          msg,
        ),
      };
    }
  }

  protected override validateFinalResponse(text: string): string | null {
    const artifact = this.readTaskReportArtifact();
    if (artifact.kind === "invalid") {
      return `Invalid TaskReport artifact at ${artifact.path}: ${artifact.reason}. Fix the on-disk TaskReport JSON for stage ${this.input.stageId}, task ${this.input.task.id}.`;
    }
    const violation = checkWorkerCompletion({
      text,
      hasMeaningfulToolEvidence: this.hasMeaningfulToolEvidence(),
      requiredToolMessage: this.invalidFinalResponseMessage,
      artifactValidated: artifact.kind === "valid",
    });
    return violation?.repairPrompt ?? null;
  }

  private readTaskReportArtifact() {
    return new ProjectStore(this.ctx.project).readExpectedStageTaskReport({
      stageId: this.input.stageId,
      taskId: this.input.task.id,
      agent: this.workerRole,
    });
  }
}
