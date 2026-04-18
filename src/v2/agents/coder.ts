/**
 * Saivage v2 — Coder Agent
 * Executes coding/testing/documentation tasks, writes code, runs tests,
 * commits changes, produces TaskReport.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { BaseAgent, type BaseAgentConfig } from "./base.js";
import type {
  AgentContext,
  AgentResult,
  WorkerInput,
  Agent,
} from "./types.js";
import type { TaskReport } from "../types.js";
import { log } from "../../log.js";

const CODER_PROMPT = `# Coder — System Prompt

You are the **Coder**, the primary worker agent that writes code, runs commands, and executes tasks.

## Your Role

You receive a task with a description and checklist from the Manager. You execute the task, verify your work against the checklist, write a task report, and commit your changes. You are **one-shot** — each task is a fresh invocation.

## Tools Available

- Filesystem tools — read/write any project file.
- Shell tools — run commands, tests, build steps.
- Web tools — fetch documentation, API references.
- MCP git tools (git_commit, git_status, git_diff, git_log) — for committing your work.
- Memory tools (store, recall, list, delete) — persist and recall knowledge across tasks.
- Index tools (ingest, search) — full-text search across project documents.

## Execution Model

1. Read the task description and checklist.
2. Read any relevant skills loaded into your context.
3. Assess the current state of the code — read relevant files before making changes.
4. Execute the work: write code, run commands, run tests.
5. Self-assess against every checklist item. Be honest about what passed and what didn't.
6. Write the task report to stages/<stage-id>/reports/<task-id>.json.
7. Commit your changes via MCP git.
8. Return the task report to the Manager.

## Work Conventions

- Your territory: project source code, tests, documentation, config files, build scripts.
- Avoid modifying: files under research/ (Researcher's territory), tools/inspector/ (Inspector's territory).
- Always write: your task report under stages/<stage-id>/reports/.
- Match existing code style and conventions.
- Commit only files you modified. Use MCP git, never shell git.
- Commit message format: [tsk-<id>] <concise description>
- Record the commit SHA in your task report's commits field.

## Task Report

Write a complete, honest report. status "completed" only if all required checklist items pass.
Do not hide failures. Honest reporting is critical.

Return the full TaskReport JSON as your final response.`;

export class CoderAgent extends BaseAgent implements Agent {
  private input: WorkerInput;

  constructor(ctx: AgentContext, input: WorkerInput, config?: Partial<BaseAgentConfig>) {
    // Normalize task fields — the Manager LLM may use alternate names
    const task = normalizeTask(input.task);
    const normalized: WorkerInput = { ...input, task };
    const initialMessage = buildCoderMessage(normalized);

    super(ctx, {
      systemPrompt: CODER_PROMPT,
      skillContext: {
        agentRole: "coder",
        description: task.description,
        tags: task.tags ?? [],
      },
      initialMessage,
      ...config,
    });

    this.input = normalized;
  }

  async run(): Promise<AgentResult> {
    log.info(
      `[coder:${this.id}] Starting task ${this.input.task.id}: ${this.input.task.description.slice(0, 80)}`,
    );

    const startedAt = new Date().toISOString();
    const start = Date.now();

    try {
      const { text, finishReason } = await this.runLoop();

      if (finishReason === "abort" || finishReason === "cancelled") {
        return {
          kind: "abort",
          reason: text,
          partial: buildFailureReport(this.input, startedAt, start, text),
        };
      }

      if (finishReason === "max_compactions" || finishReason === "error") {
        return {
          kind: "failure",
          reason: text,
          partial: buildFailureReport(this.input, startedAt, start, text),
        };
      }

      // Try to parse the TaskReport from the response
      const report = parseTaskReport(text, this.input, startedAt, start);
      return { kind: "success", data: report };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error(`[coder:${this.id}] Failed: ${msg}`);
      return {
        kind: "failure",
        reason: msg,
        partial: buildFailureReport(this.input, startedAt, start, msg),
      };
    }
  }
}

/** Normalize a task object that may have alternate field names from LLM output. */
function normalizeTask(raw: any): import("../types.js").Task {
  return {
    id: raw.id ?? "unknown",
    type: raw.type ?? "code",
    assigned_to: raw.assigned_to ?? "coder",
    description: raw.description ?? raw.objective ?? raw.instructions ?? "(no description)",
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

function buildCoderMessage(input: WorkerInput): string {
  const checklist = (input.task.checklist ?? [])
    .map(
      (c) =>
        `- [${c.required ? "REQUIRED" : "optional"}] ${c.description}`,
    )
    .join("\n");

  return (
    `## Task Assignment\n\n` +
    `**Task ID:** ${input.task.id}\n` +
    `**Stage ID:** ${input.stageId}\n` +
    `**Type:** ${input.task.type ?? "code"}\n` +
    `**Attempt:** ${input.task.attempt ?? 1} of ${input.task.max_attempts ?? 3}\n\n` +
    `### Description\n${input.task.description}\n\n` +
    (checklist ? `### Checklist\n${checklist}\n\n` : "") +
    `### Instructions\n` +
    `Write the report to: .saivage/stages/${input.stageId}/reports/${input.task.id}.json\n` +
    `Commit using MCP git with message prefix: [${input.task.id}]\n` +
    `Return the full TaskReport JSON as your final response.`
  );
}

function parseTaskReport(
  text: string,
  input: WorkerInput,
  startedAt: string,
  startMs: number,
): TaskReport {
  // Try to extract JSON from the response
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]) as TaskReport;
      // Ensure required fields
      return {
        task_id: parsed.task_id ?? input.task.id,
        stage_id: parsed.stage_id ?? input.stageId,
        agent: "coder",
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
      // Fall through to default
    }
  }

  // Fallback: create a basic report from the text response
  return {
    task_id: input.task.id,
    stage_id: input.stageId,
    agent: "coder",
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
    agent: "coder",
    status: "failed",
    summary: `Task failed: ${reason}`,
    checklist_results: [],
    files_modified: [],
    files_created: [],
    tests_added: [],
    tests_run: [],
    commits: [],
    issues_found: [],
    failure_reason: reason,
    started_at: startedAt,
    completed_at: new Date().toISOString(),
    duration_ms: Date.now() - startMs,
  };
}
