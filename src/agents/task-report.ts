/**
 * Saivage — Shared TaskReport helpers for worker agents.
 *
 * `normalizeTask`, `parseTaskReport`, and `buildFailureReport` were previously
 * duplicated in coder.ts, researcher.ts, data-agent.ts, and reviewer.ts. They
 * now live here, parameterised by the worker role. The behaviour of the
 * extracted code matches the prior per-worker copies with one deliberate
 * unification noted in `buildFailureReport`.
 */

import { TaskReportSchema, type Task, type TaskReport } from "../types.js";
import { parseLlmJsonAs } from "../parse-llm-json.js";
import type { WorkerInput } from "./types.js";
import type { WorkerRole } from "./roster.js";

export type { WorkerRole };

/**
 * Per-call validation schema for worker-emitted TaskReport payloads.
 *
 * `agent` is owned by the runtime (each worker injects its own role literal
 * after validation), so it is omitted here. This keeps the schema role-agnostic
 * and means worker payloads do not need to repeat (or correctly spell) the
 * `agent` field.
 */
const WorkerPayloadSchema = TaskReportSchema.omit({ agent: true }).partial();

export const ROLE_TO_TASK_TYPE: Record<WorkerRole, Task["type"]> = {
  coder: "code",
  researcher: "research",
  data_agent: "data",
  reviewer: "review",
  designer: "design",
  critic: "critique",
};

/** Normalize a task object that may have alternate field names from LLM output. */
export function normalizeTask(raw: Record<string, unknown>, role: WorkerRole): Task {
  const descriptionParts = [
    (raw.description as string | undefined) ?? (raw.objective as string | undefined) ?? "(no description)",
  ];
  if (Array.isArray(raw.files) && raw.files.length > 0) {
    descriptionParts.push(
      `Suggested files or starting points:\n${(raw.files as string[])
        .map((file) => `- ${file}`)
        .join("\n")}`,
    );
  }
  if (typeof raw.instructions === "string" && raw.instructions.trim()) {
    descriptionParts.push(
      `Detailed instructions from Manager:\n${raw.instructions.trim()}`,
    );
  }

  return {
    id: (raw.id as string | undefined) ?? "unknown",
    type: (raw.type as Task["type"] | undefined) ?? ROLE_TO_TASK_TYPE[role],
    assigned_to: (raw.assigned_to as Task["assigned_to"] | undefined) ?? role,
    description: descriptionParts.join("\n\n"),
    checklist: Array.isArray(raw.checklist)
      ? (raw.checklist as Task["checklist"])
      : Array.isArray(raw.acceptance_criteria)
        ? (raw.acceptance_criteria as string[]).map((c) => ({
            description: c,
            required: true,
          }))
        : [],
    dependencies: (raw.dependencies as Task["dependencies"]) ?? [],
    status: (raw.status as Task["status"]) ?? "pending",
    tags: (raw.tags as Task["tags"]) ?? [],
    attempt: (raw.attempt as number | undefined) ?? 1,
    max_attempts: (raw.max_attempts as number | undefined) ?? 3,
  };
}

export function parseTaskReport(
  text: string,
  input: WorkerInput,
  role: WorkerRole,
  startedAt: string,
  startMs: number,
): TaskReport {
  const result = parseLlmJsonAs(text, WorkerPayloadSchema);
  if (!result.ok) {
    return buildFailureReport(
      input,
      role,
      startedAt,
      startMs,
      `worker emitted ${result.reason}: ${result.detail}`,
    );
  }
  const parsed = result.value;
  return {
    task_id: parsed.task_id ?? input.task.id,
    stage_id: parsed.stage_id ?? input.stageId,
    agent: role,
    status: parsed.status ?? "completed",
    summary: parsed.summary ?? "",
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
