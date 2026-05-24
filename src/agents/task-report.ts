/**
 * Saivage — Shared TaskReport helpers for worker agents.
 *
 * `normalizeTask`, `parseTaskReport`, and `buildFailureReport` were previously
 * duplicated in coder.ts, researcher.ts, data-agent.ts, and reviewer.ts. They
 * now live here, parameterised by the worker role. The behaviour of the
 * extracted code matches the prior per-worker copies with one deliberate
 * unification noted in `buildFailureReport`.
 */

import type { Task, TaskReport } from "../types.js";
import type { WorkerInput } from "./types.js";

export type WorkerRole = "coder" | "researcher" | "data_agent" | "reviewer";

const ROLE_TO_TASK_TYPE: Record<WorkerRole, Task["type"]> = {
  coder: "code",
  researcher: "research",
  data_agent: "data",
  reviewer: "review",
};

/** Normalize a task object that may have alternate field names from LLM output. */
export function normalizeTask(raw: any, role: WorkerRole): Task {
  const descriptionParts = [
    raw.description ?? raw.objective ?? "(no description)",
  ];
  if (Array.isArray(raw.files) && raw.files.length > 0) {
    descriptionParts.push(
      `Suggested files or starting points:\n${raw.files
        .map((file: string) => `- ${file}`)
        .join("\n")}`,
    );
  }
  if (typeof raw.instructions === "string" && raw.instructions.trim()) {
    descriptionParts.push(
      `Detailed instructions from Manager:\n${raw.instructions.trim()}`,
    );
  }

  return {
    id: raw.id ?? "unknown",
    type: raw.type ?? ROLE_TO_TASK_TYPE[role],
    assigned_to: raw.assigned_to ?? role,
    description: descriptionParts.join("\n\n"),
    checklist: Array.isArray(raw.checklist)
      ? raw.checklist
      : Array.isArray(raw.acceptance_criteria)
        ? raw.acceptance_criteria.map((c: string) => ({
            description: c,
            required: true,
          }))
        : [],
    dependencies: raw.dependencies ?? [],
    status: raw.status ?? "pending",
    tags: raw.tags ?? [],
    attempt: raw.attempt ?? 1,
    max_attempts: raw.max_attempts ?? 3,
  };
}

export function parseTaskReport(
  text: string,
  input: WorkerInput,
  role: WorkerRole,
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
        agent: role,
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

  return {
    task_id: input.task.id,
    stage_id: input.stageId,
    agent: role,
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

/**
 * Build a TaskReport for a failed run. `issues_found` always contains a single
 * `error` issue describing the failure (previously coder/researcher returned an
 * empty array — this unifies them with data-agent/reviewer).
 */
export function buildFailureReport(
  input: WorkerInput,
  role: WorkerRole,
  startedAt: string,
  startMs: number,
  reason: string,
): TaskReport {
  return {
    task_id: input.task.id,
    stage_id: input.stageId,
    agent: role,
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
