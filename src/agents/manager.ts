/**
 * Saivage — Manager Agent
 * Receives a stage, decomposes into tasks, dispatches via run_coder(),
 * run_researcher(), run_data_agent(), run_designer(), run_critic(), run_reviewer(), processes TaskReports, handles failures,
 * writes StageSummary.
 */

import { BaseAgent, type BaseAgentConfig } from "./base.js";
import type {
  AgentContext,
  AgentResult,
  ManagerInput,
  Agent,
} from "./types.js";
import type { StageSummary, Stage } from "../types.js";
import type { ChildSpawner } from "../runtime/dispatcher.js";
import { log } from "../log.js";
import { buildHandoffContext } from "./handoff.js";
import { loadRolePrompt } from "./prompts.js";
import { buildEagerBlock } from "../knowledge/eagerLoader.js";
import { getDispatchToolsFor } from "./roster.js";
import { checkManagerCompletion } from "./compliance.js";
import { ProjectStore } from "../store/project-store.js";


export class ManagerAgent extends BaseAgent implements Agent {
  private input: ManagerInput;

  static async create(
    ctx: AgentContext,
    input: ManagerInput,
    childSpawner: ChildSpawner,
    config?: Partial<BaseAgentConfig>,
  ): Promise<ManagerAgent> {
    const stage = normalizeStage(input.stage as unknown as Record<string, unknown>);
    const normalized: ManagerInput = { stage };
    const initialMessage = await buildManagerMessage(ctx, normalized);
    const eagerSkillBlock = await buildEagerBlock(
      ctx.project.projectRoot,
      "manager",
      stage.objective,
      stage.tags,
    );
    return new ManagerAgent(ctx, normalized, initialMessage, eagerSkillBlock, childSpawner, config);
  }

  constructor(
    ctx: AgentContext,
    input: ManagerInput,
    initialMessage: string,
    eagerSkillBlock: string,
    childSpawner: ChildSpawner,
    config?: Partial<BaseAgentConfig>,
  ) {
    const stage = input.stage;

    super(ctx, {
      systemPrompt: loadRolePrompt("manager"),
      eagerSkillBlock,
      skillContext: {
        agentRole: "manager",
        description: stage.objective,
        tags: stage.tags,
      },
      childSpawner,
      initialMessage,
      ...config,
    });

    this.input = input;
  }

  async run(): Promise<AgentResult> {
    const stage = this.input.stage;
    log.info(
      `[manager:${this.id}] Starting stage ${stage.id}: ${stage.objective.slice(0, 80)}`,
    );

    const startedAt = new Date().toISOString();
    const start = Date.now();

    try {
      const { text, finishReason } = await this.runLoop();

      if (finishReason === "abort" || finishReason === "cancelled") {
        const summary = buildAbortSummary(stage, startedAt, start, text);
        return { kind: "abort", reason: text, partial: summary };
      }

      if (finishReason === "max_compactions" || finishReason === "error") {
        const summary = buildFailureSummary(stage, startedAt, start, text);
        return { kind: "failure", reason: text, partial: summary };
      }

      const artifact = this.readStageSummaryArtifact();
      if (artifact.kind !== "valid") {
        const reason = artifact.kind === "missing"
          ? `Expected StageSummary artifact was not written at ${artifact.path}.`
          : `Invalid StageSummary artifact at ${artifact.path}: ${artifact.reason}.`;
        const summary = buildFailureSummary(stage, startedAt, start, reason);
        return { kind: "failure", reason, partial: summary };
      }
      const summary = artifact.artifact;

      if (summary.result === "escalated" && summary.escalation) {
        return { kind: "escalation", escalation: summary.escalation };
      }

      return { kind: "success", data: summary };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error(`[manager:${this.id}] Failed: ${msg}`);
      const summary = buildFailureSummary(stage, startedAt, start, msg);
      return { kind: "failure", reason: msg, partial: summary };
    }
  }

  protected override validateFinalResponse(text: string): string | null {
    const artifact = this.readStageSummaryArtifact();
    if (artifact.kind === "invalid") {
      return `Invalid StageSummary artifact at ${artifact.path}: ${artifact.reason}. Fix the on-disk StageSummary JSON for stage ${this.input.stage.id}.`;
    }
    const dispatchTools = getDispatchToolsFor("manager");
    const violation = checkManagerCompletion({
      text,
      hasWorkerEvidence: this.hasMeaningfulToolNamed(...dispatchTools),
      hasReviewerEvidence: this.hasMeaningfulToolNamed("run_reviewer"),
      artifactResult: artifact.kind === "valid" ? artifact.artifact.result : undefined,
    });
    return violation?.repairPrompt ?? null;
  }

  private readStageSummaryArtifact() {
    return new ProjectStore(this.ctx.project).readExpectedStageSummary(this.input.stage.id);
  }
}

/** Normalize a stage object that may have missing fields from LLM output. */
function normalizeStage(raw: Record<string, unknown>): Stage {
  return {
    id: (raw.id as string | undefined) ?? "unknown",
    objective: (raw.objective as string | undefined) ?? (raw.description as string | undefined) ?? "(no objective)",
    starting_points: (raw.starting_points as Stage["starting_points"]) ?? [],
    expected_outcomes: (raw.expected_outcomes as Stage["expected_outcomes"]) ?? [],
    acceptance_criteria: (raw.acceptance_criteria as Stage["acceptance_criteria"]) ?? [],
    references: (raw.references as Stage["references"]) ?? [],
    tags: (raw.tags as Stage["tags"]) ?? [],
  };
}

async function buildManagerMessage(ctx: AgentContext, input: ManagerInput): Promise<string> {
  const stage = input.stage;
  const outcomes = (stage.expected_outcomes ?? [])
    .map((o) => `- ${o}`)
    .join("\n") || "(none)";
  const criteria = (stage.acceptance_criteria ?? [])
    .map((c) => `- ${c}`)
    .join("\n") || "(none)";
  const refs = (stage.references ?? []).length > 0
    ? stage.references.map((r) => `- ${r}`).join("\n")
    : "(none)";
  const starting = (stage.starting_points ?? [])
    .map((s) => `- ${s}`)
    .join("\n") || "(none)";
  const handoffBlock = await buildHandoffContext(ctx, { stage });

  return (
    `## Stage Assignment\n\n` +
    `${handoffBlock}\n\n` +
    `**Stage ID:** ${stage.id}\n` +
    `**Objective:** ${stage.objective}\n\n` +
    `### Starting Points\n${starting}\n\n` +
    `### Expected Outcomes\n${outcomes}\n\n` +
    `### Acceptance Criteria\n${criteria}\n\n` +
    `### References\n${refs}\n\n` +
    `### Tags\n${(stage.tags ?? []).join(", ") || "(none)"}\n\n` +
    `### Instructions\n` +
    `1. Read the referenced documents to understand the context.\n` +
    `2. Decompose this stage into tasks and write .saivage/stages/${stage.id}/tasks.json as a TaskList object with stage_id, created_at, updated_at, and tasks. Do not write a bare JSON array.\n` +
    `3. Dispatch tasks to Coder, Researcher, and Data Agent workers as appropriate.\n` +
    `4. After main work completes, dispatch a Reviewer to validate the stage against objective, outcomes, acceptance criteria, and artifacts.\n` +
    `5. If the Reviewer finds blockers or important issues, plan targeted correction tasks, dispatch them, and rerun review after material fixes. In each follow-up review, summarize the corrective tasks, new TaskReports, changed files, and previous issues the Reviewer should recheck. Continue this review/fix/re-review loop until blockers are resolved, warnings are accepted as residual risk, or escalation is justified.\n` +
    `6. Process results, handle failures, write the summary.\n` +
    `7. Write .saivage/stages/${stage.id}/summary.json.\n` +
    `8. After writing the summary, return a concise final response. Do not include the full StageSummary JSON in the final response.`
  );
}

function buildFailureSummary(
  stage: Stage,
  startedAt: string,
  startMs: number,
  reason: string,
): StageSummary {
  return {
    stage_id: stage.id,
    result: "failed",
    summary: `Stage failed: ${reason}`,
    tasks_completed: 0,
    tasks_failed: 0,
    total_tasks: 0,
    outcomes_achieved: [],
    outcomes_missed: stage.expected_outcomes,
    issues: [{ severity: "error", description: reason }],
    started_at: startedAt,
    completed_at: new Date().toISOString(),
    duration_ms: Date.now() - startMs,
  };
}

function buildAbortSummary(
  stage: Stage,
  startedAt: string,
  startMs: number,
  reason: string,
): StageSummary {
  return {
    stage_id: stage.id,
    result: "aborted",
    summary: `Stage aborted: ${reason}`,
    tasks_completed: 0,
    tasks_failed: 0,
    total_tasks: 0,
    outcomes_achieved: [],
    outcomes_missed: stage.expected_outcomes,
    issues: [],
    abort_reason: reason,
    started_at: startedAt,
    completed_at: new Date().toISOString(),
    duration_ms: Date.now() - startMs,
  };
}
