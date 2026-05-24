/**
 * Saivage — Researcher Agent
 * Gathers information from external sources, organizes findings under
 * research/, produces TaskReport.
 */

import { WorkerAgent } from "./worker.js";
import type { BaseAgentConfig } from "./base.js";
import type { AgentContext, WorkerInput } from "./types.js";
import { buildHandoffContext } from "./handoff.js";
import { loadRolePrompt } from "./prompts.js";
import { buildEagerBlock } from "../knowledge/eagerLoader.js";


export class ResearcherAgent extends WorkerAgent {
  static async create(
    ctx: AgentContext,
    input: WorkerInput,
    config?: Partial<BaseAgentConfig>,
  ): Promise<ResearcherAgent> {
    const initialMessage = await buildResearcherMessage(ctx, input);
    const eagerSkillBlock = await buildEagerBlock(
      ctx.project.projectRoot,
      "researcher",
      input.task.description,
      input.task.tags ?? [],
    );
    return new ResearcherAgent(ctx, input, initialMessage, eagerSkillBlock, config);
  }

  constructor(
    ctx: AgentContext,
    input: WorkerInput,
    initialMessage: string,
    eagerSkillBlock: string,
    config?: Partial<BaseAgentConfig>,
  ) {
    super(ctx, input, {
      role: "researcher",
      systemPrompt: loadRolePrompt("researcher"),
      eagerSkillBlock,
      initialMessage,
      invalidFinalResponseMessage:
        "Invalid final task response: you have not used any tools for this research task yet.",
      ...config,
    });
  }
}

async function buildResearcherMessage(ctx: AgentContext, input: WorkerInput): Promise<string> {
  const checklist = (input.task.checklist ?? [])
    .map(
      (c) =>
        `- [${c.required ? "REQUIRED" : "optional"}] ${c.description}`,
    )
    .join("\n");
  const handoffBlock = await buildHandoffContext(ctx, { stageId: input.stageId, includeTasks: true });

  return (
    `## Research Task Assignment\n\n` +
    `${handoffBlock}\n\n` +
    `**Task ID:** ${input.task.id}\n` +
    `**Stage ID:** ${input.stageId}\n` +
    `**Type:** ${input.task.type ?? "research"}\n` +
    `**Attempt:** ${input.task.attempt ?? 1} of ${input.task.max_attempts ?? 3}\n\n` +
    `### Description\n${input.task.description}\n\n` +
    (checklist ? `### Checklist\n${checklist}\n\n` : "") +
    `### Instructions\n` +
    `Write findings under: research/\n` +
    `Write the report to: .saivage/stages/${input.stageId}/reports/${input.task.id}.json\n` +
    `Commit using MCP git with message prefix: [${input.task.id}]\n` +
    `Return the full TaskReport JSON as your final response.`
  );
}

