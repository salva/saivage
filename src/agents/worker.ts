/**
 * Saivage — WorkerAgent base class.
 *
 * Shared lifecycle for the four manager-dispatched, task-scoped, TaskReport-
 * producing worker roles: Coder, Researcher, Data Agent, Reviewer.
 * `BaseAgent` keeps its role as "LLM/tool/compact loop". `WorkerAgent` owns
 * "build initial message → normalise task → run loop → parse TaskReport → return".
 *
 * `ReviewerAgent` extends `WorkerAgent` but overrides `run()` to delegate to
 * `review(this.input)`; the shared post-loop mapping lives in `executeTask()`
 * so reviewer can reuse it without giving up its pre-loop normalisation and
 * message injection.
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
  parseTaskReport,
  buildFailureReport,
  ROLE_TO_TASK_TYPE,
  type WorkerRole,
} from "./task-report.js";
import { getWorkerInitMeta } from "./roster.js";
import { loadRolePrompt } from "./prompts.js";
import { buildEagerBlock } from "../knowledge/eagerLoader.js";
import { buildHandoffContext } from "./handoff.js";
import { log } from "../log.js";

type WorkerCtor = new (
  ctx: AgentContext,
  input: WorkerInput,
  role: WorkerRole,
  eagerSkillBlock: string,
  initialMessage: string,
  config?: Partial<BaseAgentConfig>,
) => WorkerAgent;

const WORKER_CTORS = new Map<WorkerRole, WorkerCtor>();

export function registerWorkerCtor(role: WorkerRole, ctor: WorkerCtor): void {
  WORKER_CTORS.set(role, ctor);
}

export function hasWorkerCtor(role: WorkerRole): boolean {
  return WORKER_CTORS.has(role);
}

function getWorkerCtor(role: WorkerRole): WorkerCtor {
  const ctor = WORKER_CTORS.get(role);
  if (!ctor) throw new Error(`No worker ctor registered for role "${role}"`);
  return ctor;
}

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
    `Write the report to: .saivage/stages/${input.stageId}/reports/${input.task.id}.json`,
  );
  instructions.push(
    `Commit using MCP git with message prefix: [${input.task.id}] if you modify files.`,
  );
  instructions.push("Return the full TaskReport JSON as your final response.");

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

export abstract class WorkerAgent extends BaseAgent implements Agent {
  protected input: WorkerInput;
  protected readonly workerRole: WorkerRole;
  private readonly invalidFinalResponseMessage: string;

  constructor(
    ctx: AgentContext,
    input: WorkerInput,
    role: WorkerRole,
    eagerSkillBlock: string,
    initialMessage: string,
    config?: Partial<BaseAgentConfig>,
  ) {
    const task = normalizeTask(input.task, role);
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

  static async createWorker<T extends WorkerAgent>(
    ctx: AgentContext,
    input: WorkerInput,
    role: WorkerRole,
    config?: Partial<BaseAgentConfig>,
  ): Promise<T> {
    const initialMessage = await buildInitialMessage(ctx, input, role);
    const eagerSkillBlock = await buildEagerBlock(
      ctx.project.projectRoot,
      role,
      input.task.description,
      input.task.tags ?? [],
    );
    const ctor = getWorkerCtor(role);
    return new ctor(ctx, input, role, eagerSkillBlock, initialMessage, config) as T;
  }

  async run(): Promise<AgentResult> {
    return this.executeTask(this.input);
  }

  /**
   * Shared try/catch/finishReason → AgentResult mapping. Used by `run()` on
   * the pure workers (coder, researcher, data-agent) and by
   * `ReviewerAgent.review()` after it injects its follow-up message.
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
      return {
        kind: "success",
        data: parseTaskReport(
          text,
          input,
          this.workerRole,
          startedAt,
          startMs,
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

  protected override validateFinalResponse(_text: string): string | null {
    if (this.hasUsedAnyTool()) return null;
    return this.invalidFinalResponseMessage;
  }
}
