/**
 * Saivage — Reviewer Agent
 * Reviews completed stage work against objectives and acceptance criteria.
 */

import { WorkerAgent } from "./worker.js";
import type { BaseAgentConfig } from "./base.js";
import type { AgentContext, AgentResult, WorkerInput } from "./types.js";
import { normalizeTask } from "./task-report.js";
import { buildHandoffContext } from "./handoff.js";
import { renderRosterSummary } from "./roster.js";

const REVIEWER_PROMPT = `# Reviewer — System Prompt

## The Saivage System

You are operating inside **Saivage**, an autonomous multi-agent system. Here is where you fit:

${renderRosterSummary("reviewer")}

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

## Shell Command Discipline

For long-running verification commands, always pass 'inactivity_timeout_ms' to 'run_command' so Saivage terminates the process only when output stops growing — never use a short wall-clock timeout. The system enforces a 10-minute minimum for any timeout; values below 600000 are raised automatically. Recommended: 'inactivity_timeout_ms' of 600000 (10 min) for quick checks, 1800000 (30 min) for full test suites. Use 'timeout_ms' only for hard wall-clock limits. 'run_command' writes full stdout/stderr to project-local log files and returns only a capped tail plus start/end/duration/last-output timing; set 'stdout_path' and 'stderr_path' when review evidence should have stable log names. Prefer commands that emit periodic progress, such as verbose flags, unbuffered Python ('python -u'), counters, or status lines.

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

export class ReviewerAgent extends WorkerAgent {
  private reviewCount = 0;

  constructor(
    ctx: AgentContext,
    input: WorkerInput,
    config?: Partial<BaseAgentConfig>,
  ) {
    super(ctx, input, {
      role: "reviewer",
      systemPrompt: REVIEWER_PROMPT,
      buildInitialMessage: (i) => buildReviewerMessage(ctx, i),
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
      this.injectMessage(
        buildReviewerMessage(this.ctx, this.input, this.reviewCount + 1),
      );
    }
    this.reviewCount++;
    return this.executeTask(this.input);
  }
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
