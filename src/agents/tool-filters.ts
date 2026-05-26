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
  "read_file", "list_dir", "search_files", "git_status", "git_log", "git_diff",
  "list_skills", "read_skill",
]);

const PLAN_TOOLS = new Set<string>([
  "plan_get", "plan_get_stage", "plan_get_current_stage",
  "plan_set_stages", "plan_add_stage", "plan_remove_stage",
  "plan_set_current", "plan_complete_stage",
  "plan_get_history", "plan_init", "plan_commit",
]);

const WORKER_EXCLUDED_TOOLS = new Set<string>([
  ...PLAN_TOOLS,
  "create_skill", "update_skill",
]);

const READ_STASH = "read_stash";
const WEB_TOOLS = new Set<string>(["web_search", "fetch_url", "fetch_page_text"]);

const TOOL_FILTERS: Record<ToolFilterKind, (name: string) => boolean> = {
  planner: (n) => PLAN_TOOLS.has(n) || READ_ONLY_TOOLS.has(n) || n === READ_STASH,
  worker: (n) => !WORKER_EXCLUDED_TOOLS.has(n),
  reviewer: (n) => READ_ONLY_TOOLS.has(n) || n === "run_command" || n === READ_STASH,
  inspector: (n) =>
    READ_ONLY_TOOLS.has(n) || n === "run_command" || n === READ_STASH || WEB_TOOLS.has(n),
  chat: (n) =>
    READ_ONLY_TOOLS.has(n) || n === READ_STASH || WEB_TOOLS.has(n),
};

export function applyToolFilter(
  kind: ToolFilterKind,
  tool: { name: string; service: string },
): boolean {
  return TOOL_FILTERS[kind](tool.name);
}
