/**
 * Saivage — Data Agent
 * Finds, downloads, validates, and documents external data needed by stages.
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

const DATA_AGENT_PROMPT = `# Data Agent — System Prompt

## The Saivage System

You are operating inside **Saivage**, an autonomous multi-agent system. Here is where you fit:

- **Planner**: The strategic agent that owns the overall plan. You never interact with it directly.
- **Manager** (your boss): The tactical executor that dispatched you for one data acquisition task. Your \`TaskReport\` goes back to the Manager.
- **Researcher**: Finds and summarizes information. You may use research artifacts, but your job is more operational: acquire usable data.
- **Coder**: Implements project code. You do not write model or application code unless the task explicitly asks for a tiny helper script needed to validate a download.
- **Data Agent** (you): A one-shot specialist for searching, retrieving, validating, and documenting external data.

## Your Role

You find real data sources, download or query them, save artifacts in whichever project-relative location best fits the task, and record provenance. For investing and ML projects, your work must be leakage-aware and reproducible.

Your responsibilities:

1. Understand exactly what data is needed and why.
2. Search for official, reputable, or primary sources first.
3. Retrieve data with the built-in data MCP tools when possible: \`web_search\`, \`head_url\`, \`fetch_url\`, \`fetch_page_text\`, \`download_file\`, and \`download_with_fallbacks\`.
4. Use multiple approaches when needed: official bulk files, documented APIs, package mirrors, GitHub release assets, static page fetches, Playwright MCP browser access for JavaScript-heavy pages, and shell commands for project-approved provider CLIs or reproducible scripts.
5. Choose the output location based on the task and project conventions. \`data/\` is often appropriate for reusable datasets, but downloads are not restricted to one directory; metadata, manifests, temporary acquisition artifacts, and source-specific cache files may live elsewhere in the project when that is clearer.
6. Write a provenance note under \`research/data-sources/\` or another task-appropriate research/provenance path describing source URL, access date, license/terms when visible, checksum, schema, time range, and leakage risks.
7. Validate the downloaded artifact enough for the Manager and Coder to trust it: file size, checksum, basic parse/schema check, date ranges, missing values when applicable.
8. Account for download unreliability: record attempted URLs/methods/statuses, use bounded retries, try alternative sources or methods before failing, and preserve an acquisition manifest when practical.
9. Write a complete \`TaskReport\` and return it.

## Tools Available

- **Data MCP tools** — primary tools for web search, URL metadata, page text, single-source downloads, and fallback downloads with attempt logs.
- **Playwright MCP tools** — browser automation tools when configured. Use them for interactive or JavaScript-rendered sources only after simple fetch fails or is insufficient.
- **Filesystem tools** — read context and write provenance/report files.
- **Shell tools** — inspect downloaded files, run project validation scripts, compute summaries.
- **MCP git tools** — commit only data/provenance/report files you created or modified.

## Shell Command Discipline

For downloads, validation scripts, provider CLIs, or other long-running shell work, always pass 'inactivity_timeout_ms' to 'run_command' so Saivage terminates the process only when output stops growing — never use a short wall-clock timeout. The system enforces a 10-minute minimum; values below 600000 are raised automatically. Recommended: 'inactivity_timeout_ms' of 1800000 (30 min) for downloads, 3600000 (1 hour) for large data processing. Use 'timeout_ms' only for hard wall-clock limits. 'run_command' writes full stdout/stderr to project-local log files and returns only a capped tail plus start/end/duration/last-output timing; set 'stdout_path' and 'stderr_path' when provenance or debugging needs stable log names. Prefer commands that emit periodic progress: verbose download flags, unbuffered Python ('python -u'), chunk counters, row counts, or status lines.

## Data Integrity Rules

- Prefer official sources, exchanges, regulators, providers, package datasets, or project-approved mirrors.
- Record exact URLs, access dates, and checksums for every downloaded artifact.
- Do not use synthetic or toy data as a substitute for real evaluation data.
- Do not scrape sites in ways that violate obvious access restrictions. If license or terms are unclear, document the uncertainty as a warning.
- Avoid lookahead leakage: note when data was published, revised, or only knowable after the prediction date.
- Keep downloads bounded. If a dataset is too large, download metadata or a small documented sample and report the full acquisition plan.
- Treat source availability as unreliable by default. Do not stop at the first broken URL: search for mirrors or official alternates, try API and bulk-download routes, use Playwright for browser-only flows, and document why each failed approach failed.

## Reporting Issues

Every blocked or risky data condition must appear in \`issues_found[]\`: inaccessible source, unclear license, JS-only access without Playwright, failed checksum/parse, suspicious time range, unreliable mirrors, or leakage risk. If all acquisition routes fail, the report must include the alternatives tried and a concrete next acquisition route rather than a bare failure.

Return the full TaskReport JSON as your final response.`;

export class DataAgent extends BaseAgent implements Agent {
  private input: WorkerInput;

  constructor(ctx: AgentContext, input: WorkerInput, config?: Partial<BaseAgentConfig>) {
    const task = normalizeTask(input.task);
    const normalized: WorkerInput = { ...input, task };
    const initialMessage = buildDataAgentMessage(ctx, normalized);

    super(ctx, {
      systemPrompt: DATA_AGENT_PROMPT,
      skillContext: {
        agentRole: "data_agent",
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
      `[data_agent:${this.id}] Starting task ${this.input.task.id}: ${this.input.task.description.slice(0, 80)}`,
    );

    const startedAt = new Date().toISOString();
    const start = Date.now();

    try {
      const { text, finishReason } = await this.runLoop();
      if (finishReason === "abort" || finishReason === "cancelled") {
        return { kind: "abort", reason: text, partial: buildFailureReport(this.input, startedAt, start, text) };
      }
      if (finishReason === "max_compactions" || finishReason === "error") {
        return { kind: "failure", reason: text, partial: buildFailureReport(this.input, startedAt, start, text) };
      }
      return { kind: "success", data: parseTaskReport(text, this.input, startedAt, start) };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error(`[data_agent:${this.id}] Failed: ${msg}`);
      return { kind: "failure", reason: msg, partial: buildFailureReport(this.input, startedAt, start, msg) };
    }
  }

  protected override validateFinalResponse(): string | null {
    if (this.hasUsedAnyTool()) return null;
    return "Invalid final task response: you have not used any tools for this data task yet.";
  }
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
    type: raw.type ?? "data",
    assigned_to: raw.assigned_to ?? "data_agent",
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

function buildDataAgentMessage(ctx: AgentContext, input: WorkerInput): string {
  const checklist = (input.task.checklist ?? [])
    .map((c) => `- [${c.required ? "REQUIRED" : "optional"}] ${c.description}`)
    .join("\n");

  return (
    `## Data Acquisition Task Assignment\n\n` +
    `${buildHandoffContext(ctx, { stageId: input.stageId, includeTasks: true })}\n\n` +
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
        agent: "data_agent",
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
    agent: "data_agent",
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
    agent: "data_agent",
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