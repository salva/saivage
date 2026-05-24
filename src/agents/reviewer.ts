/**
 * Saivage — Reviewer Agent
 * Reviews completed stage work against objectives and acceptance criteria.
 */

import { WorkerAgent } from "./worker.js";
import type { BaseAgentConfig } from "./base.js";
import type { AgentContext, AgentResult, WorkerInput } from "./types.js";
import { normalizeTask } from "./task-report.js";
import { buildHandoffContext } from "./handoff.js";
import { loadRolePrompt } from "./prompts.js";
import { buildEagerBlock } from "../knowledge/eagerLoader.js";


export class ReviewerAgent extends WorkerAgent {
  private reviewCount = 0;

  static async create(
    ctx: AgentContext,
    input: WorkerInput,
    config?: Partial<BaseAgentConfig>,
  ): Promise<ReviewerAgent> {
    const initialMessage = await buildReviewerMessage(ctx, input);
    const eagerSkillBlock = await buildEagerBlock(
      ctx.project.projectRoot,
      "reviewer",
      input.task.description,
      input.task.tags ?? [],
    );
    return new ReviewerAgent(ctx, input, initialMessage, eagerSkillBlock, config);
  }

  constructor(
    ctx: AgentContext,
    input: WorkerInput,
    initialMessage: string,
    eagerSkillBlock: string,
    config?: Partial<BaseAgentConfig>,
  ) {
    super(ctx, input, {
      role: "reviewer",
      systemPrompt: loadRolePrompt("reviewer"),
      eagerSkillBlock,
      initialMessage,
      invalidFinalResponseMessage:
        "Invalid final review response: you have not used any tools to inspect evidence yet.",
      ...config,
    });
  }

  override async run(): Promise<AgentResult> {
    return this.review(this.input);
  }

  async review(input: WorkerInput): Promise<AgentResult> {
    this.input = { ...input, task: normalizeTask(input.task, "reviewer") };
    if (this.reviewCount > 0) {
      const followUp = await buildReviewerMessage(this.ctx, this.input, this.reviewCount + 1);
      this.injectMessage(followUp);
    }
    this.reviewCount++;
    return this.executeTask(this.input);
  }
}

async function buildReviewerMessage(
  ctx: AgentContext,
  input: WorkerInput,
  reviewNumber = 1,
): Promise<string> {
  const checklist = (input.task.checklist ?? [])
    .map((c) => `- [${c.required ? "REQUIRED" : "optional"}] ${c.description}`)
    .join("\n");
  const handoffBlock = await buildHandoffContext(ctx, { stageId: input.stageId, includeTasks: true });

  return (
    `## Stage Review Task Assignment${reviewNumber > 1 ? ` - Follow-up Review ${reviewNumber}` : ""}\n\n` +
    `${handoffBlock}\n\n` +
    `**Task ID:** ${input.task.id}\n` +
    `**Stage ID:** ${input.stageId}\n` +
    `**Type:** ${input.task.type ?? "review"}\n` +
    `**Attempt:** ${input.task.attempt ?? 1} of ${input.task.max_attempts ?? 3}\n\n` +
    `### Description\n${input.task.description}\n\n` +
    (checklist ? `### Checklist\n${checklist}\n\n` : "") +
    `### Instructions\n` +
    (reviewNumber > 1
      ? `This is a follow-up review in the same stage-scoped reviewer session. Your previous reports and reasoning are above in this conversation. Focus first on the new corrective-task results, then verify whether earlier issues are resolved or still open.\n`
      : "") +
    `Review the stage objectives, expected outcomes, acceptance criteria, task list, worker reports, changed artifacts, and any existing summary drafts.\n` +
    `For data-heavy or ML/research stages, validate data provenance/suitability, leakage controls, statistical acceptance, benchmark comparison, and whether conclusions are supported.\n` +
    `Write optional detailed notes to: .saivage/stages/${input.stageId}/reviews/\n` +
    `Write the report to: .saivage/stages/${input.stageId}/reports/${input.task.id}.json\n` +
    `Commit using MCP git with message prefix: [${input.task.id}] if you create review files.\n` +
    `Return the full TaskReport JSON as your final response.`
  );
}
