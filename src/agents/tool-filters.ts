/**
 * Saivage — Role-based tool filtering.
 *
 * Owns the implementation of every `ToolFilterKind` declared on the roster.
 * The `TOOL_FILTERS` record is typed `Record<ToolFilterKind, …>` so adding a
 * new union member without an implementation here is a compile error, not a
 * silent fall-through.
 */

import type { ToolFilterKind } from "./roster.js";

const READ_ONLY_TOOLS = new Set<string>([
  "read", "glob", "grep", "git_status", "git_log", "git_diff", "skill",
]);

const PLAN_TOOLS = new Set<string>([
  "plan_get", "plan_get_stage", "plan_get_current_stage",
  "plan_set_stages", "plan_add_stage", "plan_remove_stage",
  "plan_set_current", "plan_complete_stage",
  "plan_get_history", "plan_init", "plan_commit", "plan_done",
]);

const STAGE_ARTIFACT_TOOLS = new Set<string>([
  "stage_write_tasks", "task_write_report", "stage_write_summary",
  "stage_get_run", "stage_list_reports",
]);

const WORKER_EXCLUDED_TOOLS = new Set<string>([
  ...PLAN_TOOLS,
]);

const WEB_TOOLS = new Set<string>(["websearch", "webfetch"]);

const LIBRARIAN_TOOLS = new Set<string>([
  "rag_list", "rag_stats", "rag_query",
  "rag_register", "rag_ingest", "rag_drop", "rag_admin",
  "read", "glob", "grep", "skill",
  "list_memories", "get_memory", "search_memories",
  "create_memory", "update_memory",
]);

const TOOL_FILTERS: Record<ToolFilterKind, (name: string) => boolean> = {
  planner: (n) => PLAN_TOOLS.has(n) || STAGE_ARTIFACT_TOOLS.has(n) || READ_ONLY_TOOLS.has(n),
  worker: (n) => !WORKER_EXCLUDED_TOOLS.has(n),
  reviewer: (n) => READ_ONLY_TOOLS.has(n) || STAGE_ARTIFACT_TOOLS.has(n) || n === "run_command",
  inspector: (n) =>
    READ_ONLY_TOOLS.has(n) || n === "run_command" || WEB_TOOLS.has(n),
  chat: (n) =>
    READ_ONLY_TOOLS.has(n) || WEB_TOOLS.has(n) || n === "create_note",
  librarian: (n) => LIBRARIAN_TOOLS.has(n),
};

export function applyToolFilter(
  kind: ToolFilterKind,
  tool: { name: string; service: string },
): boolean {
  return TOOL_FILTERS[kind](tool.name);
}
