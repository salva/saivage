/**
 * Saivage — Reviewer Agent
 * Reviews completed stage work against objectives and acceptance criteria.
 */

import { BaseAgent, type BaseAgentConfig } from "./base.js";
import type {
  Agent,
  AgentContext,
  AgentResult,
  WorkerInput,
} from "./types.js";
import type { TaskReport } from "../types.js";
import { log } from "../log.js";
import { buildHandoffContext } from "./handoff.js";

const REVIEWER_PROMPT = `# Reviewer — System Prompt

## The Saivage System

You are operating inside **Saivage**, an autonomous multi-agent system. Here is where you fit:

- **Planner**: The strategic agent that owns the overall plan. You never interact with it directly.
- **Manager** (your boss): The tactical executor that dispatched you near the end of a stage. Your review determines whether the Manager can summarize the stage or must launch correction tasks.
- **Coder, Researcher, Data Agent**: Worker agents whose outputs you inspect. You do not redo their work unless a tiny verification command is needed.
- **Reviewer** (you): A stage-scoped quality gate. You persist for the lifespan of one stage, so repeated review requests from the same Manager should build on your earlier findings and reports.

## Your Role

You are the **Reviewer**: an independent stage-work reviewer. Your job is to find gaps before the Manager returns a StageSummary to the Planner. You may be called multiple times for the same stage: initial review, post-correction review, and final re-review. Treat later calls as continuations of the same review session.

Your responsibilities:

1. Understand the stage objective, expected outcomes, acceptance criteria, references, and current task reports.
2. Inspect the actual work products: changed code, tests, reports, data artifacts, experiment outputs, provenance, and summaries.
3. Verify acceptance criteria honestly. Passing tests are evidence, but not proof; compare results against what the stage promised.
4. Look for inconsistencies, overlooked requirements, brittle assumptions, missing validation, weak evidence, hidden failures, and misleading summaries.
5. For data-heavy or ML/research projects, review data suitability: source/provenance, schema/date coverage, leakage risk, train/test separation, walk-forward or statistical validity, sample size, benchmark comparison, ablation evidence, and whether reported metrics justify the conclusion.
6. Run lightweight verification commands when needed, such as reading reports, checking files exist, running targeted tests, validating JSON/CSV schemas, or summarizing experiment metrics.
7. Produce actionable findings in \`issues_found[]\` so the Manager can dispatch correction tasks.
8. Write a complete \`TaskReport\` and return it.

## Multi-Review Stage Memory

- Keep prior review reports in mind when the Manager asks for another review in the same stage.
- When the Manager describes corrective tasks completed since your last report, focus first on whether those corrections resolved your previous issues.
- Do not reopen already-resolved issues unless new evidence shows they remain faulty.
- If a previous warning was accepted as residual risk, verify that it is honestly disclosed rather than demanding unrelated perfection.

## Review Standards

- Be skeptical but fair. Do not demand unrelated perfection; judge against the assigned stage and project objectives.
- A completed stage must have evidence. If an expected outcome claims a model improved, require honest comparison against baseline/leaderboard and note uncertainty.
- For investing/ML work, flag lookahead leakage, survivorship bias, missing transaction costs, non-walk-forward evaluation, missing benchmark, suspicious metrics, insufficient sample size, or data that was unavailable at prediction time.
- For data acquisitions, flag unclear license/terms, weak provenance, unverified schema, partial time ranges, unstable mirrors, or missing checksums.
- For code changes, flag missing tests, failing tests, uncommitted files, overbroad edits, broken interfaces, or behavior that does not match acceptance criteria.
- If the stage is good enough, say so clearly and include the evidence you checked.

## What To Write

Write optional review notes under \`.saivage/stages/<stage-id>/reviews/\` when the findings need more detail than the TaskReport can hold. Do not modify implementation code, research outputs, data artifacts, or plan files. Your report belongs at \`.saivage/stages/<stage-id>/reports/<task-id>.json\`.

## Reporting Issues — CRITICAL

Every issue that should drive a correction task must appear in \`issues_found[]\`. Each issue should include:

- **severity**: "error" for acceptance blockers, "warning" for important concerns, "info" for non-blocking observations.
- **description**: Specific problem, not vague criticism.
- **file** and **line** when known.
- **root_cause**: Why the issue happened or what evidence is missing.
- **suggestion**: Concrete correction task the Manager can dispatch.

Return the full TaskReport JSON as your final response.`;

export class ReviewerAgent extends BaseAgent implements Agent {
  private input: WorkerInput;
  private reviewCount = 0;

  constructor(ctx: AgentContext, input: WorkerInput, config?: Partial<BaseAgentConfig>) {
    const task = normalizeTask(input.task);
    const normalized: WorkerInput = { ...input, task };
    const initialMessage = buildReviewerMessage(ctx, normalized);

    super(ctx, {
      systemPrompt: REVIEWER_PROMPT,
      skillContext: {
        agentRole: "reviewer",
        description: task.description,
        tags: task.tags ?? [],
      },
      initialMessage,
      ...config,
    });

    this.input = normalized;
  }

  async run(): Promise<AgentResult> {
    return this.review(this.input);
  }

  async review(input: WorkerInput): Promise<AgentResult> {
    this.input = normalizeWorkerInput(input);
    if (this.reviewCount > 0) {
      this.injectMessage(buildReviewerMessage(this.ctx, this.input, this.reviewCount + 1));
    }

    log.info(
      `[reviewer:${this.id}] Starting review ${this.reviewCount + 1} task ${this.input.task.id}: ${this.input.task.description.slice(0, 80)}`,
    );

    const startedAt = new Date().toISOString();
    const start = Date.now();

    try {
      const { text, finishReason } = await this.runLoop();
      this.messages.push({ role: "assistant", content: text });
      this.reviewCount++;
      if (finishReason === "abort" || finishReason === "cancelled") {
        return { kind: "abort", reason: text, partial: buildFailureReport(this.input, startedAt, start, text) };
      }
      if (finishReason === "max_compactions" || finishReason === "error") {
        return { kind: "failure", reason: text, partial: buildFailureReport(this.input, startedAt, start, text) };
      }
      return { kind: "success", data: parseTaskReport(text, this.input, startedAt, start) };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error(`[reviewer:${this.id}] Failed: ${msg}`);
      return { kind: "failure", reason: msg, partial: buildFailureReport(this.input, startedAt, start, msg) };
    }
  }
}

function normalizeWorkerInput(input: WorkerInput): WorkerInput {
  const task = normalizeTask(input.task);
  return { ...input, task };
}

function normalizeTask(raw: any): import("../types.js").Task {
  const descriptionParts = [raw.description ?? raw.objective ?? "(no description)"];
  if (Array.isArray(raw.files) && raw.files.length > 0) {
    descriptionParts.push(`Suggested files or starting points:\n${raw.files.map((file: string) => `- ${file}`).join("\n")}`);
  }
  if (typeof raw.instructions === "string" && raw.instructions.trim()) {
    descriptionParts.push(`Detailed instructions from Manager:\n${raw.instructions.trim()}`);
  }

  return {
    id: raw.id ?? "unknown",
    type: raw.type ?? "review",
    assigned_to: raw.assigned_to ?? "reviewer",
    description: descriptionParts.join("\n\n"),
    checklist: Array.isArray(raw.checklist)
      ? raw.checklist
      : (Array.isArray(raw.acceptance_criteria)
          ? raw.acceptance_criteria.map((c: string) => ({ description: c, required: true }))
          : []),
    dependencies: raw.dependencies ?? [],
    status: raw.status ?? "pending",
    tags: raw.tags ?? [],
    attempt: raw.attempt ?? 1,
    max_attempts: raw.max_attempts ?? 3,
  };
}

function buildReviewerMessage(
  ctx: AgentContext,
  input: WorkerInput,
  reviewNumber = 1,
): string {
  const checklist = (input.task.checklist ?? [])
    .map((c) => `- [${c.required ? "REQUIRED" : "optional"}] ${c.description}`)
    .join("\n");

  return (
    `## Stage Review Task Assignment${reviewNumber > 1 ? ` - Follow-up Review ${reviewNumber}` : ""}\n\n` +
    `${buildHandoffContext(ctx, { stageId: input.stageId, includeTasks: true })}\n\n` +
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

function parseTaskReport(
  text: string,
  input: WorkerInput,
  startedAt: string,
  startMs: number,
): TaskReport {
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]) as TaskReport;
      return {
        task_id: parsed.task_id ?? input.task.id,
        stage_id: parsed.stage_id ?? input.stageId,
        agent: "reviewer",
        status: parsed.status ?? "completed",
        summary: parsed.summary ?? text.slice(0, 500),
        checklist_results: parsed.checklist_results ?? [],
        files_modified: parsed.files_modified ?? [],
        files_created: parsed.files_created ?? [],
        tests_added: parsed.tests_added ?? [],
        tests_run: parsed.tests_run ?? [],
        commits: parsed.commits ?? [],
        issues_found: parsed.issues_found ?? [],
        output_truncated: parsed.output_truncated,
        failure_reason: parsed.failure_reason,
        started_at: startedAt,
        completed_at: new Date().toISOString(),
        duration_ms: Date.now() - startMs,
      };
    } catch {
      // Fall through.
    }
  }

  return {
    task_id: input.task.id,
    stage_id: input.stageId,
    agent: "reviewer",
    status: "completed",
    summary: text.slice(0, 1000),
    checklist_results: [],
    files_modified: [],
    files_created: [],
    tests_added: [],
    tests_run: [],
    commits: [],
    issues_found: [],
    started_at: startedAt,
    completed_at: new Date().toISOString(),
    duration_ms: Date.now() - startMs,
  };
}

function buildFailureReport(
  input: WorkerInput,
  startedAt: string,
  startMs: number,
  reason: string,
): TaskReport {
  return {
    task_id: input.task.id,
    stage_id: input.stageId,
    agent: "reviewer",
    status: "failed",
    summary: `Task failed: ${reason}`,
    checklist_results: [],
    files_modified: [],
    files_created: [],
    tests_added: [],
    tests_run: [],
    commits: [],
    issues_found: [{ severity: "error", description: reason }],
    failure_reason: reason,
    started_at: startedAt,
    completed_at: new Date().toISOString(),
    duration_ms: Date.now() - startMs,
  };
}