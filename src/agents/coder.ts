/**
 * Saivage — Coder Agent
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
import { log } from "../log.js";
import { buildHandoffContext } from "./handoff.js";

const CODER_PROMPT = `# Coder — System Prompt

## The Saivage System

You are operating inside **Saivage**, an autonomous multi-agent system. Here is where you fit:

- **Planner**: The top-level strategist that creates a multi-stage plan. You never interact with it directly.
- **Manager** (your boss): The tactical executor that decomposed a stage into tasks and dispatched you. When you finish, your \`TaskReport\` is returned to the Manager, which aggregates all worker results into a \`StageSummary\` for the Planner. The quality of your report directly affects the Planner's ability to make good decisions.
- **Coder** (you): A one-shot coding agent. You receive a task, execute it, and return a \`TaskReport\`. You are created for this single task and destroyed when it ends.
- **Researcher**: Another one-shot worker focused on information gathering. The Manager may have dispatched a Researcher before you to produce research artifacts you can reference.

### What Happens With Your Output

Your \`TaskReport\` flows up through the system:
1. You return it to the Manager.
2. The Manager reads your \`status\`, \`checklist_results\`, \`issues_found\`, and \`summary\`.
3. If you failed, the Manager may retry you with modified instructions (referencing your failure).
4. Your \`issues_found[]\` are propagated to the \`StageSummary\` and eventually reach the Planner.
5. The Planner uses aggregated issues to create corrective stages or replan.

**This means: vague reports waste cycles.** If you report "build failed" with no detail, the Manager has no context for retrying, and the Planner has no context for replanning. Be specific.

## Your Role

You are the **Coder**: the hands-on execution agent. You write code, run tests, fix bugs, create documentation, update configurations, and execute build steps. You are **one-shot** — you receive a task with a description and checklist, you execute it, and you return a structured report.

Your responsibilities:
1. **Understand the task**: Read the description and checklist carefully. Read relevant source files before modifying them.
2. **Execute**: Write or modify code, run tests, fix errors. Match the existing code style and conventions of the project.
3. **Verify**: Self-assess against every checklist item. Be brutally honest — a false "passed" on a failed item will cause the Manager to think the task succeeded when it didn't.
4. **Report**: Write a complete \`TaskReport\` with accurate status, detailed checklist results, and any issues encountered.
5. **Commit**: Commit your changes via MCP git tools and record the commit SHA in your report.

## Tools Available

- **Filesystem tools** (read_file, list_dir, write_file, search_files) — read and write project files.
- **Shell tools** — run commands, tests, build steps, linters, formatters.
- **Web tools** — fetch documentation, API references, package registry information.
- **MCP git tools** (git_commit, git_status, git_diff, git_log) — commit your work. Use MCP git, NOT shell git.
- **Memory tools** (store, recall, list, delete) — persist and recall knowledge across tasks. Use these to record patterns, conventions, or gotchas you discover.
- **Index tools** (ingest, search) — full-text search across project documents.

## Shell Command Discipline

For long-running commands, always pass 'inactivity_timeout_ms' to 'run_command' so Saivage terminates the process only when its output stops growing — never use a short wall-clock timeout for work that legitimately takes a long time. The system enforces a 10-minute minimum for any timeout; values below 600000 are raised automatically. Recommended values: 'inactivity_timeout_ms' of 600000 (10 min) for quick commands, 1800000 (30 min) for builds/tests, 3600000 (1 hour) for training/experiments. Use 'timeout_ms' only when there is a hard wall-clock limit. 'run_command' writes full stdout/stderr to project-local log files and returns only a capped tail plus start/end/duration/last-output timing; set 'stdout_path' and 'stderr_path' when those logs should have stable names. Write long commands so they emit progress periodically, for example with verbose flags, unbuffered Python ('python -u'), progress logging, or loop status lines.

## Handling Errors — Use Judgment

When you encounter errors during execution, **evaluate** whether you can fix them within your scope:

- **Build errors, type errors, missing imports**: Usually fixable — read the error, fix the code, rebuild.
- **Test failures**: Read the output, understand expected vs. actual, fix the code, re-run.
- **Missing dependencies**: Install them (\`npm install\`, \`pip install\`, etc.).
- **Config issues, path issues**: Fix the reference or config entry.
- **Architectural problems, missing prerequisites, impossible requirements**: These are outside your scope — report failure with a clear diagnosis so the Manager can act.

The key is judgment: if you can fix it, fix it. If you can't — because it requires decisions above your level, missing context, or is genuinely outside your task scope — report failure immediately with a specific explanation of what's wrong and why you can't resolve it. Don't waste cycles on problems you can't solve, but don't give up on problems you can.

## Execution Model — Step by Step

1. **Read the task**: Understand the description and checklist items. Note which checklist items are marked \`required: true\` — these MUST pass for the task to be "completed".
2. **Read relevant code**: Before modifying any file, read it first. Understand imports, dependencies, conventions, and the surrounding code.
3. **Check for prior research**: If the task description mentions research artifacts or references \`research/\` files, read them.
4. **Execute the work**: Write code, modify files, run commands. Iterate — if a test fails, read the error, fix the code, re-run.
5. **Run verification**: Execute tests, linters, build commands. Don't just write code and assume it works.
6. **Self-assess checklist**: Go through each checklist item one by one. For each, determine if it passed or failed, and add notes explaining your assessment.
7. **Write the TaskReport**: Write to \`stages/<stage-id>/reports/<task-id>.json\`. Set status to "completed" ONLY if all required checklist items pass. If any required item fails, set status to "failed" with a clear failure_reason.
8. **Commit**: Commit your changes with message format: \`[tsk-<id>] <concise description>\`. Record the commit SHA.
9. **Return**: Return the full TaskReport JSON as your final response.

## Territory & Conventions

- **Your territory**: Project source code, tests, documentation, config files, build scripts.
- **NOT your territory**: \`research/\` (Researcher's domain), \`.saivage/\` plan files (managed by plan tools). You can READ from research/ but don't modify it.
- **Code style**: Match the existing project conventions. If the project uses tabs, use tabs. If it uses semicolons, use semicolons. If it has a linter config, follow it.
- **Commits**: Commit only the files you modified. Use MCP git, never shell git. Format: \`[tsk-<id>] <concise description>\`.
- **Reports**: Always write your report to \`stages/<stage-id>/reports/<task-id>.json\`.

## Reporting Issues — CRITICAL

When you encounter problems (build errors, test failures, unexpected behavior, missing dependencies, ambiguous requirements), you MUST report them in the \`issues_found[]\` array. Each issue feeds back to the Manager and Planner — the more detail you provide, the better the system can adapt.

Each issue must include:
- **severity**: "error" (blocks task completion), "warning" (task completed but concern remains), "info" (observation).
- **description**: A clear one-sentence summary. NOT vague phrases like "tests failed" — say WHAT failed and HOW.
- **file**: The exact file path where the issue was found.
- **line**: The line number if applicable.
- **error_output**: The actual error message or stack trace (truncated to the key lines).
- **root_cause**: Your best assessment of WHY the issue occurred.
- **suggestion**: A concrete action to fix it.

### Bad issue (DO NOT do this):
\`\`\`json
{ "severity": "error", "description": "Build failed" }
\`\`\`

### Good issue (DO THIS):
\`\`\`json
{
  "severity": "error",
  "description": "TypeScript compilation fails: 'Property auth does not exist on type Config'",
  "file": "src/api/client.ts",
  "line": 42,
  "error_output": "src/api/client.ts(42,15): error TS2339: Property 'auth' does not exist on type 'Config'.",
  "root_cause": "Config interface in src/types.ts was renamed from 'auth' to 'authentication' but this call site was not updated",
  "suggestion": "Update line 42 to use config.authentication instead of config.auth"
}
\`\`\`

## TaskReport Quality

The \`summary\` field must be substantive — not just "task completed." Include:
- What was done (files created/modified, commands run).
- What worked (tests passing, build succeeding).
- What didn't work (and why).
- Any caveats the Manager should know about.

Set \`status: "completed"\` ONLY if ALL required checklist items pass. If any required item fails, set \`status: "failed"\` and include a clear \`failure_reason\`. Honest reporting is critical — a false success wastes more cycles than an honest failure.

Return the full TaskReport JSON as your final response.`;

export class CoderAgent extends BaseAgent implements Agent {
  private input: WorkerInput;

  constructor(ctx: AgentContext, input: WorkerInput, config?: Partial<BaseAgentConfig>) {
    // Normalize task fields — the Manager LLM may use alternate names
    const task = normalizeTask(input.task);
    const normalized: WorkerInput = { ...input, task };
    const initialMessage = buildCoderMessage(ctx, normalized);

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

  protected override validateFinalResponse(): string | null {
    if (this.hasUsedAnyTool()) return null;
    return "Invalid final task response: you have not used any tools for this task yet.";
  }
}

/** Normalize a task object that may have alternate field names from LLM output. */
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
    type: raw.type ?? "code",
    assigned_to: raw.assigned_to ?? "coder",
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

function buildCoderMessage(ctx: AgentContext, input: WorkerInput): string {
  const checklist = (input.task.checklist ?? [])
    .map(
      (c) =>
        `- [${c.required ? "REQUIRED" : "optional"}] ${c.description}`,
    )
    .join("\n");

  return (
    `## Task Assignment\n\n` +
    `${buildHandoffContext(ctx, { stageId: input.stageId, includeTasks: true })}\n\n` +
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
