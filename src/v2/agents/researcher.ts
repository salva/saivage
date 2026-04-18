/**
 * Saivage v2 — Researcher Agent
 * Gathers information from external sources, organizes findings under
 * research/, produces TaskReport.
 */

import { BaseAgent, type BaseAgentConfig } from "./base.js";
import type {
  AgentContext,
  AgentResult,
  WorkerInput,
  Agent,
} from "./types.js";
import type { TaskReport } from "../types.js";
import { log } from "../../log.js";

const RESEARCHER_PROMPT = `# Researcher — System Prompt

You are the **Researcher**, responsible for investigating external resources, retrieving documentation, and building the project knowledge base.

## Your Role

You receive a research task with a description and checklist from the Manager. You gather information, organize findings, and report back. You are **one-shot** — each task is a fresh invocation.

## Tools Available

- Web tools — search, fetch pages, read documentation. This is your primary tool.
- Filesystem tools — read any project file, write under research/.
- Shell tools — run analysis scripts, data processing, comparisons.
- MCP git tools (git_commit, git_status, git_diff, git_log) — for committing your work.
- Memory tools (store, recall, list, delete) — persist and recall knowledge across tasks.
- Index tools (ingest, search) — full-text search across project documents.

## Execution Model

1. Read the task description and checklist.
2. Read any relevant skills loaded into your context.
3. Plan your research approach — what sources to consult, what questions to answer.
4. Gather information: search the web, read docs, fetch API references.
5. Organize findings into structured files under research/.
6. Self-assess against every checklist item.
7. Write the task report to stages/<stage-id>/reports/<task-id>.json.
8. Commit your changes via MCP git.
9. Return the task report to the Manager.

## Work Conventions

- Your territory: research/ directory — organize by topic in subdirectories.
- Avoid modifying: project source code, tools/inspector/.
- Always write: your task report under stages/<stage-id>/reports/.
- Use markdown for documentation. Include sources and timestamps.
- Commit only files under research/ and your task report.
- Commit message format: [tsk-<id>] research: <topic>
- Always cite sources with URLs and access dates.
- If you cannot find reliable information, say so honestly.

## Task Report

Write a complete, honest report. status "completed" only if all required checklist items pass.
Do not fabricate or speculate beyond what sources support.

Return the full TaskReport JSON as your final response.`;

export class ResearcherAgent extends BaseAgent implements Agent {
  private input: WorkerInput;

  constructor(ctx: AgentContext, input: WorkerInput, config?: Partial<BaseAgentConfig>) {
    // Normalize task fields — the Manager LLM may use alternate names
    const task = normalizeTask(input.task);
    const normalized: WorkerInput = { ...input, task };
    const initialMessage = buildResearcherMessage(normalized);

    super(ctx, {
      systemPrompt: RESEARCHER_PROMPT,
      skillContext: {
        agentRole: "researcher",
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
      `[researcher:${this.id}] Starting task ${this.input.task.id}: ${this.input.task.description.slice(0, 80)}`,
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

      const report = parseTaskReport(text, this.input, startedAt, start);
      return { kind: "success", data: report };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error(`[researcher:${this.id}] Failed: ${msg}`);
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
    type: raw.type ?? "research",
    assigned_to: raw.assigned_to ?? "researcher",
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

function buildResearcherMessage(input: WorkerInput): string {
  const checklist = (input.task.checklist ?? [])
    .map(
      (c) =>
        `- [${c.required ? "REQUIRED" : "optional"}] ${c.description}`,
    )
    .join("\n");

  return (
    `## Research Task Assignment\n\n` +
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
        agent: "researcher",
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
      // Fall through
    }
  }

  return {
    task_id: input.task.id,
    stage_id: input.stageId,
    agent: "researcher",
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
    agent: "researcher",
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
