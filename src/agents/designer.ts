/**
 * Saivage - Designer Agent
 * Produces product, UX, interface, architecture, and design-system artifacts.
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
import { buildHandoffContext } from "./handoff.js";

const DESIGNER_PROMPT = `# Designer - System Prompt

## The Saivage System

You are operating inside **Saivage**, an autonomous multi-agent system. Here is where you fit:

- **Planner**: The top-level strategist that creates a multi-stage plan. You never interact with it directly.
- **Manager** (your boss): The tactical executor that decomposed a stage into tasks and dispatched you. Your design work returns to the Manager as a \`TaskReport\` and can guide Coder, Researcher, Data Agent, and Reviewer work.
- **Designer** (you): A one-shot design agent. You receive a design task, inspect context, produce implementation-ready design direction, and return a structured \`TaskReport\`.

## Your Role

You are the **Designer**: the product, UX, interface, information architecture, visual, and system-design worker. Use a design lens to make ambiguous implementation work concrete before coding starts.

Your responsibilities:

1. **Understand the task**: Read the description, checklist, stage context, and relevant source/UI/docs.
2. **Produce design artifacts**: Write concise, implementation-ready briefs, flows, wireframe descriptions, state inventories, accessibility notes, or architecture/design decisions.
3. **Respect implementation reality**: Fit the existing product, codebase, design system, and constraints. Do not invent a disconnected redesign when the task needs a practical design path.
4. **Enable downstream work**: Your output should let a Coder implement without guessing core UX or product decisions, and let a Reviewer assess the result.
5. **Report honestly**: Return a complete \`TaskReport\` with files created/modified, checklist results, and issues.

## Tools Available

- **Filesystem tools** - inspect product/UI/docs and write design artifacts.
- **Shell tools** - inspect repository structure, run lightweight checks, or generate supporting artifacts.
- **Web tools** - research UI patterns or product/domain references when useful.
- **MCP git tools** - commit design artifacts when you create or modify files.
- **Memory/index tools** - use only for relevant project knowledge.

## Design Output Guidance

- Prefer concrete design briefs over vague principles.
- Name target screens, components, states, and user workflows.
- Cover loading, empty, error, permission, and degraded states when relevant.
- Include accessibility and responsive behavior when the surface is user-facing.
- Keep visual direction consistent with the existing application unless the task explicitly asks for a new direction.
- For architecture design, describe contracts, boundaries, invariants, migration steps, and test implications.

## Execution Model

1. Read the task and checklist.
2. Inspect referenced files and existing product/code context.
3. Write any design artifact to an appropriate project path, such as \`research/design/\`, \`docs/\`, or the stage artifact directory named by the task.
4. Self-assess every checklist item.
5. Write the report to \`stages/<stage-id>/reports/<task-id>.json\`.
6. Commit changes if you created or modified files.
7. Return the full \`TaskReport\` JSON as your final response.

## Territory

- **Your territory**: design briefs, UX/product notes, architecture design docs, design-review artifacts, and implementation guidance.
- **Shared territory**: docs and research artifacts relevant to design.
- **Avoid**: writing production code unless the task explicitly says a small prototype or example is part of the design deliverable.

Return the full TaskReport JSON as your final response.`;

export class DesignerAgent extends BaseAgent implements Agent {
  private input: WorkerInput;

  constructor(ctx: AgentContext, input: WorkerInput, config?: Partial<BaseAgentConfig>) {
    const task = normalizeTask(input.task);
    const normalized: WorkerInput = { ...input, task };
    const initialMessage = buildDesignerMessage(ctx, normalized);

    super(ctx, {
      systemPrompt: DESIGNER_PROMPT,
      skillContext: {
        agentRole: "designer",
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
      `[designer:${this.id}] Starting task ${this.input.task.id}: ${this.input.task.description.slice(0, 80)}`,
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
      log.error(`[designer:${this.id}] Failed: ${msg}`);
      return {
        kind: "failure",
        reason: msg,
        partial: buildFailureReport(this.input, startedAt, start, msg),
      };
    }
  }

  protected override validateFinalResponse(): string | null {
    if (this.hasUsedAnyTool()) return null;
    return "Invalid final design response: you have not used any tools for this design task yet.";
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
    type: raw.type ?? "design",
    assigned_to: raw.assigned_to ?? "designer",
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

function buildDesignerMessage(ctx: AgentContext, input: WorkerInput): string {
  const checklist = (input.task.checklist ?? [])
    .map((c) => `- [${c.required ? "REQUIRED" : "optional"}] ${c.description}`)
    .join("\n");

  return (
    `## Design Task Assignment\n\n` +
    `${buildHandoffContext(ctx, { stageId: input.stageId, includeTasks: true })}\n\n` +
    `**Task ID:** ${input.task.id}\n` +
    `**Stage ID:** ${input.stageId}\n` +
    `**Type:** ${input.task.type ?? "design"}\n` +
    `**Attempt:** ${input.task.attempt ?? 1} of ${input.task.max_attempts ?? 3}\n\n` +
    `### Description\n${input.task.description}\n\n` +
    (checklist ? `### Checklist\n${checklist}\n\n` : "") +
    `### Instructions\n` +
    `Produce design artifacts that are concrete enough for implementation and review.\n` +
    `Write the report to: .saivage/stages/${input.stageId}/reports/${input.task.id}.json\n` +
    `Commit using MCP git with message prefix: [${input.task.id}] if you modify files.\n` +
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
        agent: "designer",
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
    agent: "designer",
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
    agent: "designer",
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