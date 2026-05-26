/**
 * Saivage — WorkerAgent base class.
 *
 * Shared lifecycle for the four manager-dispatched, task-scoped, TaskReport-
 * producing worker roles: Coder, Researcher, Data Agent, Reviewer.
 * `BaseAgent` keeps its role as "LLM/tool/compact loop". `WorkerAgent` owns
 * "normalise task → run loop → parse TaskReport → return".
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
  type WorkerRole,
} from "./task-report.js";
import { log } from "../log.js";

export interface WorkerAgentConfig extends Partial<BaseAgentConfig> {
  role: WorkerRole;
  systemPrompt: string;
  initialMessage: string;
  invalidFinalResponseMessage: string;
  eagerSkillBlock: string;
}

export abstract class WorkerAgent extends BaseAgent implements Agent {
  protected input: WorkerInput;
  protected readonly workerRole: WorkerRole;
  private readonly invalidFinalResponseMessage: string;

  constructor(
    ctx: AgentContext,
    input: WorkerInput,
    config: WorkerAgentConfig,
  ) {
    const task = normalizeTask(input.task, config.role);
    const normalized: WorkerInput = { ...input, task };
    const {
      role,
      systemPrompt,
      initialMessage,
      invalidFinalResponseMessage,
      eagerSkillBlock,
      ...rest
    } = config;
    super(ctx, {
      systemPrompt,
      eagerSkillBlock,
      skillContext: {
        agentRole: role,
        description: task.description,
        tags: task.tags ?? [],
      },
      initialMessage,
      ...rest,
    });
    this.input = normalized;
    this.workerRole = role;
    this.invalidFinalResponseMessage = invalidFinalResponseMessage;
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
