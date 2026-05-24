/**
 * Saivage — Data Agent
 * Finds, downloads, validates, and documents external data needed by stages.
 */

import { WorkerAgent } from "./worker.js";
import type { BaseAgentConfig } from "./base.js";
import type { AgentContext, WorkerInput } from "./types.js";
import { buildHandoffContext } from "./handoff.js";
import { loadRolePrompt } from "./prompts.js";
import { buildEagerBlock } from "../knowledge/eagerLoader.js";


export class DataAgent extends WorkerAgent {
  static async create(
    ctx: AgentContext,
    input: WorkerInput,
    config?: Partial<BaseAgentConfig>,
  ): Promise<DataAgent> {
    const initialMessage = await buildDataAgentMessage(ctx, input);
    const eagerSkillBlock = await buildEagerBlock(
      ctx.project.projectRoot,
      "data_agent",
      input.task.description,
      input.task.tags ?? [],
    );
    return new DataAgent(ctx, input, initialMessage, eagerSkillBlock, config);
  }

  constructor(
    ctx: AgentContext,
    input: WorkerInput,
    initialMessage: string,
    eagerSkillBlock: string,
    config?: Partial<BaseAgentConfig>,
  ) {
    super(ctx, input, {
      role: "data_agent",
      systemPrompt: loadRolePrompt("data-agent"),
      eagerSkillBlock,
      initialMessage,
      invalidFinalResponseMessage:
        "Invalid final task response: you have not used any tools for this data task yet.",
      ...config,
    });
  }
}

async function buildDataAgentMessage(ctx: AgentContext, input: WorkerInput): Promise<string> {
  const checklist = (input.task.checklist ?? [])
    .map((c) => `- [${c.required ? "REQUIRED" : "optional"}] ${c.description}`)
    .join("\n");
  const handoffBlock = await buildHandoffContext(ctx, { stageId: input.stageId, includeTasks: true });

  return (
    `## Data Acquisition Task Assignment\n\n` +
    `${handoffBlock}\n\n` +
    `**Task ID:** ${input.task.id}\n` +
    `**Stage ID:** ${input.stageId}\n` +
    `**Type:** ${input.task.type ?? "data"}\n` +
    `**Attempt:** ${input.task.attempt ?? 1} of ${input.task.max_attempts ?? 3}\n\n` +
    `### Description\n${input.task.description}\n\n` +
    (checklist ? `### Checklist\n${checklist}\n\n` : "") +
    `### Instructions\n` +
    `Write downloaded artifacts to the project-relative path that best fits the task; data/ is common but not mandatory.\n` +
    `Write provenance notes under research/data-sources/ or another clearly named research/provenance path.\n` +
    `Use retries, fallback source URLs, alternate access methods, and an attempt manifest when downloads are unreliable.\n` +
    `Write the report to: .saivage/stages/${input.stageId}/reports/${input.task.id}.json\n` +
    `Commit using MCP git with message prefix: [${input.task.id}]\n` +
    `Return the full TaskReport JSON as your final response.`
  );
}
