import { join } from "node:path";
import { readDocLenient } from "../store/documents.js";
import {
  PlanHistorySchema,
  PlanSchema,
  TaskListSchema,
  type Plan,
  type Stage,
} from "../types.js";
import type { AgentContext } from "./types.js";

interface HandoffOptions {
  stageId?: string;
  stage?: Stage;
  includeTasks?: boolean;
}

export function buildHandoffContext(
  ctx: AgentContext,
  options: HandoffOptions = {},
): string {
  const plan = readDocLenient(ctx.project.paths.plan, PlanSchema);
  const history = readDocLenient(ctx.project.paths.planHistory, PlanHistorySchema);
  const stage = options.stage ?? findStage(plan, options.stageId);

  const lines: string[] = [
    "## Shared Project Context",
    "",
    `**Project:** ${ctx.project.config.project_name}`,
    `**Project Root:** ${ctx.project.projectRoot}`,
    `**Saivage Dir:** ${ctx.project.saivageDir}`,
    `**Agent Role:** ${ctx.role}`,
    `**Model:** ${ctx.modelSpec}`,
    "",
    "### Project Objectives",
    formatList(ctx.project.config.objectives),
    "",
  ];

  if (plan) {
    lines.push(
      "### Current Plan Snapshot",
      `Current stage: ${plan.current_stage_id ?? "(none)"}`,
      "Pending stages:",
      formatList(
        plan.stages.slice(0, 8).map((item) => {
          const marker = item.id === plan.current_stage_id ? " [current]" : "";
          return `${item.id}${marker}: ${item.objective}`;
        }),
      ),
      "",
    );
  }

  if (history?.stages?.length) {
    lines.push(
      "### Recent Stage History",
      formatList(
        history.stages.slice(-5).reverse().map((item) =>
          `${item.id} (${item.result}): ${truncate(item.summary, 260)}`,
        ),
      ),
      "",
    );
  }

  if (stage) {
    lines.push(
      "### Parent Stage Context",
      `Stage: ${stage.id}`,
      `Objective: ${stage.objective}`,
      "Starting points:",
      formatList(stage.starting_points),
      "Expected outcomes:",
      formatList(stage.expected_outcomes),
      "Acceptance criteria:",
      formatList(stage.acceptance_criteria),
      "References:",
      formatList(stage.references),
      "",
    );
  }

  if (options.includeTasks && options.stageId) {
    const tasks = readDocLenient(
      join(ctx.project.paths.stages, options.stageId, "tasks.json"),
      TaskListSchema,
    );
    if (tasks?.tasks?.length) {
      lines.push(
        "### Stage Task Context",
        formatList(
          tasks.tasks.map((task) =>
            `${task.id} (${task.assigned_to}/${task.status}, attempt ${task.attempt}/${task.max_attempts}): ${task.description}`,
          ),
        ),
        "",
      );
    }
  }

  lines.push(
    "### Handoff Guidance",
    "Use this context to avoid rediscovering already-known project state. If the direct assignment conflicts with this context, trust the direct assignment and report the conflict clearly in your structured output.",
  );

  return lines.join("\n");
}

function findStage(plan: Plan | null, stageId?: string): Stage | undefined {
  if (!stageId || !plan?.stages) return undefined;
  return plan.stages.find((stage) => stage.id === stageId);
}

function formatList(items: string[] | undefined): string {
  if (!items?.length) return "- (none)";
  return items.map((item) => `- ${item}`).join("\n");
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}...`;
}