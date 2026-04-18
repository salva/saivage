/**
 * Saivage — Manager Agent
 * Receives a stage, decomposes into tasks, dispatches via run_coder()/
 * run_researcher(), processes TaskReports, handles failures, writes StageSummary.
 */

import { join } from "node:path";
import { BaseAgent, type BaseAgentConfig } from "./base.js";
import type {
  AgentContext,
  AgentResult,
  ManagerInput,
  Agent,
} from "./types.js";
import type { Task, TaskList, TaskReport, StageSummary, Stage, Escalation } from "../types.js";
import type { ChildSpawner } from "../runtime/dispatcher.js";
import { log } from "../log.js";

const MANAGER_PROMPT = `# Manager — System Prompt

You are the **Manager**, responsible for tactical execution of a single stage. You decompose the stage into tasks, dispatch them to worker agents (Coder and Researcher), and supervise their execution.

## Your Role

You receive a stage description from the Planner and must deliver a completed stage or escalate honestly. You do not write code or do research yourself — you delegate to the Coder and Researcher.

## Tools Available

- run_coder(task) — Dispatch a coding task. Returns a TaskReport.
- run_researcher(task) — Dispatch a research task. Returns a TaskReport.
- MCP git tools (git_commit, git_status, git_diff, git_log) — for committing task and summary files.
- Filesystem tools — for reading/writing task lists, reports, summaries.

## Execution Model

1. Read the stage description and all documents listed in references.
2. Decompose the stage into tasks. Write stages/<stage-id>/tasks.json.
3. Find the next dispatchable task(s) — pending, with all dependencies met.
4. Dispatch via tool call. One Coder + one Researcher can run in parallel if independent. The runtime enforces max 1 Coder + 1 Researcher — excess same-type dispatches are rejected.
5. Process each TaskReport: mark completed/failed, retry if attempt < max_attempts (modify description with failure context), or escalate.
6. Repeat until all tasks done or escalate.
7. On completion: write stages/<stage-id>/summary.json, return it to the Planner.
8. On escalation: write summary.json with result "escalated" and Escalation object.

## Task Decomposition

- Each task needs clear description and checklist.
- Include testing for code changes, documentation for new features.
- Set max_attempts thoughtfully (usually 2-3).
- Order by dependencies. Parallelize where possible.
- On failure: modify description with failure context and suggest different approach.
- Escalate when: objective seems unachievable, retries exhausted, fundamental assumption wrong.

## File Conventions

- Write: stages/<stage-id>/tasks.json, stages/<stage-id>/summary.json
- Commit messages: [stg-<id>] <description>

Return the full StageSummary JSON as your final response.`;

export class ManagerAgent extends BaseAgent implements Agent {
  private input: ManagerInput;

  constructor(
    ctx: AgentContext,
    input: ManagerInput,
    childSpawner: ChildSpawner,
    config?: Partial<BaseAgentConfig>,
  ) {
    // Normalize stage fields — the Planner LLM may omit optional arrays
    const stage = normalizeStage(input.stage);
    const normalized: ManagerInput = { stage };
    const initialMessage = buildManagerMessage(normalized);

    super(ctx, {
      systemPrompt: MANAGER_PROMPT,
      skillContext: {
        agentRole: "manager",
        description: stage.objective,
        tags: stage.tags,
      },
      childSpawner,
      initialMessage,
      ...config,
    });

    this.input = normalized;
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

      // Parse StageSummary from response
      const summary = parseStageSummary(text, stage, startedAt, start);

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
}

/** Normalize a stage object that may have missing fields from LLM output. */
function normalizeStage(raw: any): Stage {
  return {
    id: raw.id ?? "unknown",
    objective: raw.objective ?? raw.description ?? "(no objective)",
    starting_points: raw.starting_points ?? [],
    expected_outcomes: raw.expected_outcomes ?? [],
    acceptance_criteria: raw.acceptance_criteria ?? [],
    references: raw.references ?? [],
    tags: raw.tags ?? [],
  };
}

function buildManagerMessage(input: ManagerInput): string {
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

  return (
    `## Stage Assignment\n\n` +
    `**Stage ID:** ${stage.id}\n` +
    `**Objective:** ${stage.objective}\n\n` +
    `### Starting Points\n${starting}\n\n` +
    `### Expected Outcomes\n${outcomes}\n\n` +
    `### Acceptance Criteria\n${criteria}\n\n` +
    `### References\n${refs}\n\n` +
    `### Tags\n${(stage.tags ?? []).join(", ") || "(none)"}\n\n` +
    `### Instructions\n` +
    `1. Read the referenced documents to understand the context.\n` +
    `2. Decompose this stage into tasks and write .saivage/stages/${stage.id}/tasks.json.\n` +
    `3. Dispatch tasks to Coder and Researcher agents.\n` +
    `4. Process results, handle failures, write the summary.\n` +
    `5. Write .saivage/stages/${stage.id}/summary.json.\n` +
    `6. Return the full StageSummary JSON as your final response.`
  );
}

function parseStageSummary(
  text: string,
  stage: Stage,
  startedAt: string,
  startMs: number,
): StageSummary {
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]) as StageSummary;
      return {
        stage_id: parsed.stage_id ?? stage.id,
        result: parsed.result ?? "completed",
        summary: parsed.summary ?? text.slice(0, 500),
        tasks_completed: parsed.tasks_completed ?? 0,
        tasks_failed: parsed.tasks_failed ?? 0,
        total_tasks: parsed.total_tasks ?? 0,
        outcomes_achieved: parsed.outcomes_achieved ?? [],
        outcomes_missed: parsed.outcomes_missed ?? [],
        issues: parsed.issues ?? [],
        escalation: parsed.escalation,
        abort_reason: parsed.abort_reason,
        started_at: startedAt,
        completed_at: new Date().toISOString(),
        duration_ms: Date.now() - startMs,
      };
    } catch {
      // Fall through
    }
  }

  return {
    stage_id: stage.id,
    result: "completed",
    summary: text.slice(0, 1000),
    tasks_completed: 0,
    tasks_failed: 0,
    total_tasks: 0,
    outcomes_achieved: [],
    outcomes_missed: [],
    issues: [],
    started_at: startedAt,
    completed_at: new Date().toISOString(),
    duration_ms: Date.now() - startMs,
  };
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
