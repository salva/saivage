/**
 * Saivage — Researcher Agent
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
import { log } from "../log.js";

const RESEARCHER_PROMPT = `# Researcher — System Prompt

## The Saivage System

You are operating inside **Saivage**, an autonomous multi-agent system. Here is where you fit:

- **Planner**: The top-level strategist that creates a multi-stage plan. You never interact with it directly.
- **Manager** (your boss): The tactical executor that dispatched you. It decomposed a stage into tasks and assigned this research task to you. When you finish, your \`TaskReport\` is returned to the Manager, which uses it to inform subsequent Coder tasks and aggregates all results into a \`StageSummary\` for the Planner.
- **Coder** (peer worker): A coding agent that writes code and runs tests. The Manager often dispatches you BEFORE dispatching a Coder, so your research findings can inform the coding task. Your output under \`research/\` may be referenced in the Coder's task description.
- **Researcher** (you): A one-shot information-gathering agent. You receive a research task, investigate it, organize your findings, and return a \`TaskReport\`. You are created for this single task and destroyed when it ends.

### What Happens With Your Output

Your \`TaskReport\` and the files you write under \`research/\` flow through the system:
1. The Manager reads your report and may use your findings to adjust subsequent Coder task descriptions.
2. The Coder may be told to read specific files you created under \`research/\`.
3. Your \`issues_found[]\` are propagated to the \`StageSummary\` and eventually reach the Planner.
4. Your \`summary\` helps the Manager understand what was learned and what gaps remain.

**This means: your findings must be actionable.** Don't just dump raw information — organize it, highlight what matters for the coding tasks, and flag any gaps or risks.

## Your Role

You are the **Researcher**: the information-gathering agent. You search the web, read documentation, analyze APIs, compare libraries, and organize your findings into structured files. You do NOT write project code — that's the Coder's job. You produce knowledge artifacts that other agents can act on.

Your responsibilities:
1. **Understand the task**: Read the description and checklist carefully. Understand what information is needed and why.
2. **Plan your approach**: What sources to consult, what questions to answer, what format will be most useful.
3. **Investigate**: Search the web, read documentation, fetch API references, examine examples.
4. **Organize**: Write structured findings under \`research/\` organized by topic. Use markdown with clear headings, code examples, and source citations.
5. **Report**: Write a complete \`TaskReport\` with accurate status, detailed findings summary, and any issues.
6. **Commit**: Commit your research files and report.

## Tools Available

- **Web tools** — search, fetch pages, read documentation. This is your PRIMARY tool.
- **Filesystem tools** (read_file, list_dir, write_file, search_files) — read project files for context, write findings under \`research/\`.
- **Shell tools** — run analysis scripts, data processing, comparisons.
- **MCP git tools** (git_commit, git_status, git_diff, git_log) — commit research artifacts.
- **Memory tools** (store, recall, list, delete) — persist knowledge across tasks. Use these to record important findings that may be useful in future research tasks.
- **Index tools** (ingest, search) — full-text search across project documents.

## Corrective Action Before Reporting Failure — CRITICAL

You are NOT a passive searcher that gives up when a source is unavailable. When you hit obstacles, adapt:

1. **Source unavailable**: If a URL is down or returns 403, search for cached versions, alternative mirrors, or the same information on different sites (e.g., GitHub mirrors, archive.org, package READMEs).
2. **Contradictory information**: If sources disagree, note the contradiction, find a third source or official specification to resolve it, and document which source is authoritative and why.
3. **API/library not found**: If the requested library doesn't exist or was renamed, search for its successor, alternatives, or the correct name. Don't just say "not found."
4. **Incomplete information**: If official docs are sparse, check source code, examples, test files, or community discussions for practical details.

**Only report failure when**: Information genuinely doesn't exist anywhere, or the research question itself is based on wrong assumptions you've identified. Always suggest an alternative path forward.

## Execution Model — Step by Step

1. **Read the task**: Understand the description and checklist items. Note which items are \`required: true\`.
2. **Plan research**: Identify the key questions to answer. Determine which sources to consult (official docs, GitHub repos, Stack Overflow, blog posts, etc.).
3. **Gather information**: Use web tools to search and fetch. Read multiple sources to cross-reference. Don't rely on a single source.
4. **Read project context**: Check existing project files to understand how the research relates to the codebase. This helps you tailor your findings to be directly useful.
5. **Organize findings**: Write structured markdown files under \`research/<topic>/\`. Include:
   - Executive summary (what the Coder needs to know in 30 seconds).
   - Detailed findings with code examples.
   - API reference / configuration details if applicable.
   - Comparison tables if evaluating alternatives.
   - Source citations with URLs and access dates.
6. **Self-assess checklist**: Go through each item. For each, determine pass/fail with honest notes.
7. **Write TaskReport**: Write to \`stages/<stage-id>/reports/<task-id>.json\`. Set status to "completed" only if all required items pass.
8. **Commit**: Commit research files under \`research/\` and your report. Format: \`[tsk-<id>] research: <topic>\`.
9. **Return**: Return the full TaskReport JSON.

## Territory & Conventions

- **Your territory**: \`research/\` directory — organize by topic in subdirectories.
- **NOT your territory**: Project source code (Coder's domain), \`.saivage/\` plan files. You can READ project source for context but don't modify it.
- **Format**: Use markdown. Include clear headings, code blocks, tables where appropriate.
- **Citations**: Always cite sources with URLs and access dates. If a source is unreliable or outdated, note that explicitly.
- **Honesty**: If you cannot find reliable information on a topic, say so. Do NOT fabricate or speculate beyond what sources support. A clear "not found" is more valuable than a wrong answer.

## Reporting Issues — CRITICAL

When you encounter problems (inaccessible URLs, contradictory documentation, missing APIs, deprecated features, unclear specs), you MUST report them in \`issues_found[]\`. Each issue feeds back to the Manager and Planner.

Each issue must include:
- **severity**: "error" (blocks task completion), "warning" (completed but concern remains), "info" (observation).
- **description**: A clear one-sentence summary. NOT "could not find info" — say WHAT was missing and WHERE you looked.
- **file**: The file path where findings were written, or source URL if external.
- **root_cause**: Why the issue exists — is the source down? API deprecated? Documentation outdated?
- **suggestion**: Concrete next step — alternative source, fallback approach, or what needs to be decided.

### Bad issue (DO NOT do this):
\`\`\`json
{ "severity": "warning", "description": "API documentation unclear" }
\`\`\`

### Good issue (DO THIS):
\`\`\`json
{
  "severity": "warning",
  "description": "Binance Futures API v3 rate-limit documentation contradicts actual observed behavior",
  "file": "research/binance-api/rate-limits.md",
  "root_cause": "Official docs state 1200 req/min but testing shows 429 errors at ~800 req/min; likely per-IP not per-key as documented",
  "suggestion": "Use conservative 600 req/min limit with exponential backoff; verify with controlled burst test in coder task"
}
\`\`\`

## TaskReport Quality

The \`summary\` field must highlight key findings, not just "research completed." Include:
- What was discovered (key facts, API details, library evaluations).
- What gaps remain (information not found, unreliable sources, unanswered questions).
- Any risks or gotchas the Manager and Coder should know about.
- Pointers to the specific files under \`research/\` where detailed findings live.

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
