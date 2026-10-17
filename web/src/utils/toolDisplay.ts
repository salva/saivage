import type { ToolPair, ToolPairStatus } from "../components/agents/types";

export type DisplayTone = "neutral" | "ok" | "warn" | "error" | "pending" | "muted";

export type ToolCategory =
  | "filesystem"
  | "web"
  | "shell"
  | "git"
  | "plan"
  | "stage_artifact"
  | "dispatch"
  | "skill"
  | "memory"
  | "rag"
  | "note"
  | "external"
  | "unknown";

export type ToolDetailKind =
  | "file_read"
  | "directory_read"
  | "file_write"
  | "search_results"
  | "web_results"
  | "web_fetch"
  | "command"
  | "git_status"
  | "git_diff"
  | "git_log"
  | "git_mutation"
  | "plan_state"
  | "plan_mutation"
  | "stage_artifact"
  | "dispatch"
  | "skill"
  | "memory"
  | "rag"
  | "note"
  | "external"
  | "generic";

export type InlinePart =
  | { kind: "text"; value: string; tone?: DisplayTone }
  | { kind: "code"; value: string }
  | { kind: "file"; path: string; root?: "project" | "saivage"; line?: number }
  | { kind: "url"; url: string }
  | { kind: "conversation"; agentId?: string; roundId?: string; label: string };

export interface DetailFact {
  label: string;
  value: InlinePart[];
  tone?: DisplayTone;
}

export type DetailLink =
  | { kind: "file"; label: string; path: string; root?: "project" | "saivage"; line?: number }
  | { kind: "url"; label: string; url: string }
  | { kind: "conversation"; label: string; agentId: string; roundId?: string };

export interface AttachmentSummary {
  mime: string;
  filename?: string;
  sizeBytes?: number;
  url?: string;
}

export type DetailSection =
  | { kind: "text"; title?: string; content: string }
  | { kind: "code"; title?: string; language?: string; content: string; maxHeight?: string }
  | { kind: "terminal"; title?: string; stdout?: string; stderr?: string; exitCode?: number; maxHeight?: string }
  | { kind: "diff"; title?: string; content: string; files?: string[]; maxHeight?: string }
  | { kind: "table"; title?: string; columns: string[]; rows: InlinePart[][][] }
  | { kind: "list"; title?: string; items: InlinePart[][] }
  | { kind: "attachments"; title?: string; attachments: AttachmentSummary[] };

export interface ToolDisplayModel {
  category: ToolCategory;
  action: string;
  target: InlinePart[];
  status: InlinePart[];
  tone: DisplayTone;
  groupable: boolean;
  mutation: boolean;
  important: boolean;
  detailKind: ToolDetailKind;
}

export interface ToolDetailModel {
  title: string;
  subtitle: InlinePart[];
  facts: DetailFact[];
  sections: DetailSection[];
  links: DetailLink[];
}

export interface ParsedToolPair {
  args: Record<string, unknown>;
  requestParseError: boolean;
  result: unknown;
  resultParseError: boolean;
  unwrapped: unknown;
  rawRequest: string;
  rawResponse: string;
  isError: boolean;
  status: ToolPairStatus;
}

type DisplayBuilder = (pair: ToolPair, parsed: ParsedToolPair) => ToolDisplayModel;
type DetailBuilder = (pair: ToolPair, parsed: ParsedToolPair, display: ToolDisplayModel) => ToolDetailModel;

export const CURRENT_TOOL_NAMES = [
  "read", "write", "glob", "grep", "edit", "apply_patch",
  "websearch", "webfetch",
  "run_command",
  "git_status", "git_create_branch", "git_checkout", "git_commit", "git_merge", "git_diff", "git_delete_branch", "git_log",
  "plan_get", "plan_get_stage", "plan_get_current_stage", "plan_set_stages", "plan_add_stage", "plan_remove_stage", "plan_set_current", "plan_complete_stage", "plan_get_history", "plan_init", "plan_commit", "plan_done",
  "stage_write_tasks", "task_write_report", "stage_write_summary", "stage_get_run", "stage_list_reports",
  "run_manager", "run_inspector", "run_coder", "run_researcher", "run_data_agent", "run_reviewer", "run_designer", "run_critic", "run_librarian",
  "skill",
  "create_memory", "update_memory", "supersede_memory", "archive_memory", "delete_memory", "list_memories", "get_memory", "search_memories",
  "rag_list", "rag_stats", "rag_query", "rag_register", "rag_ingest", "rag_drop", "rag_admin",
  "create_note",
] as const;

export type CurrentToolName = typeof CURRENT_TOOL_NAMES[number];

const CURRENT_TOOL_SET = new Set<string>(CURRENT_TOOL_NAMES);

function parseJson(value: string | undefined): { value: unknown; failed: boolean } {
  if (!value || !value.trim()) return { value: undefined, failed: false };
  try {
    return { value: JSON.parse(value), failed: false };
  } catch {
    return { value, failed: true };
  }
}

function unwrapEnvelope(value: unknown): unknown {
  if (value && typeof value === "object" && "content" in (value as Record<string, unknown>)) {
    const content = (value as Record<string, unknown>).content;
    if (typeof content === "string") {
      const parsed = parseJson(content);
      return parsed.failed ? content : parsed.value;
    }
    return content;
  }
  return value;
}

export function parseToolPair(pair: ToolPair): ParsedToolPair {
  const request = parseJson(pair.call?.content);
  const response = parseJson(pair.result?.content);
  return {
    args: request.value && typeof request.value === "object" && !Array.isArray(request.value)
      ? request.value as Record<string, unknown>
      : {},
    requestParseError: request.failed,
    result: response.value,
    resultParseError: response.failed,
    unwrapped: unwrapEnvelope(response.value),
    rawRequest: pair.call?.content ?? "",
    rawResponse: pair.result?.content ?? "",
    isError: pair.status === "error",
    status: pair.status,
  };
}

function text(value: string, tone?: DisplayTone): InlinePart {
  return { kind: "text", value, tone };
}

function code(value: string): InlinePart {
  return { kind: "code", value };
}

function file(path: string, root: "project" | "saivage" = "project", line?: number): InlinePart {
  return { kind: "file", path, root, ...(line !== undefined ? { line } : {}) };
}

function url(value: string): InlinePart {
  return { kind: "url", url: value };
}

function truncate(value: string, max = 120): string {
  return value.length <= max ? value : value.slice(0, max - 1) + "…";
}

function firstLine(value: string): string {
  return value.split(/\r?\n/)[0] ?? "";
}

function plural(n: number, singular: string, pluralForm = singular + "s"): string {
  return `${n} ${n === 1 ? singular : pluralForm}`;
}

function shortPath(path: string): string {
  const parts = path.split("/").filter(Boolean);
  if (parts.length <= 2) return path || ".";
  return `${parts.at(-2)}/${parts.at(-1)}`;
}

function host(value: string): string {
  try { return new URL(value).hostname; } catch { return truncate(value, 60); }
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function stringValue(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function errorStatus(parsed: ParsedToolPair): InlinePart[] {
  const obj = objectValue(parsed.unwrapped);
  const err = obj.error;
  const codeValue = stringValue(obj.code);
  if (typeof err === "string") return [text(truncate(codeValue || firstLine(err) || "error", 120), "error")];
  if (err && typeof err === "object") {
    const nested = objectValue(err);
    return [text(truncate(stringValue(nested.code) || stringValue(nested.message) || "error", 120), "error")];
  }
  return [text(truncate(firstLine(parsed.rawResponse) || "error", 120), "error")];
}

function baseDisplay(category: ToolCategory, action: string, target: InlinePart[], status: InlinePart[], tone: DisplayTone, detailKind: ToolDetailKind, opts: Partial<ToolDisplayModel> = {}): ToolDisplayModel {
  return {
    category,
    action,
    target,
    status,
    tone,
    detailKind,
    groupable: false,
    mutation: false,
    important: false,
    ...opts,
  };
}

function statusFromPair(pair: ToolPair, parsed: ParsedToolPair, okStatus: InlinePart[] = [text("returned", "muted")]): { status: InlinePart[]; tone: DisplayTone } {
  if (pair.status === "pending") return { status: [text("running...", "pending")], tone: "pending" };
  if (pair.status === "missing") return { status: [text("no result", "warn")], tone: "warn" };
  if (pair.status === "orphan") return { status: [text("orphan result", "warn")], tone: "warn" };
  if (pair.status === "error") return { status: errorStatus(parsed), tone: "error" };
  if (parsed.resultParseError) return { status: [text("returned text", "warn")], tone: "warn" };
  return { status: okStatus, tone: "neutral" };
}

function readDisplay(pair: ToolPair, parsed: ParsedToolPair): ToolDisplayModel {
  const path = stringValue(parsed.args.path, "invalid path");
  const j = objectValue(parsed.unwrapped);
  const entries = arrayValue(j.entries);
  const attachments = arrayValue(j.attachments);
  if (pair.status !== "ok") {
    const st = statusFromPair(pair, parsed);
    return baseDisplay("filesystem", "Read", [file(path)], st.status, st.tone, "file_read", { groupable: false });
  }
  if (entries.length > 0 || "total_entries" in j) {
    const total = numberValue(j.total_entries) ?? entries.length;
    return baseDisplay("filesystem", "List", [file(path)], [text(plural(total, "entry", "entries") + (j.truncated ? " · truncated" : ""), j.truncated ? "warn" : "muted")], j.truncated ? "warn" : "neutral", "directory_read", { groupable: true });
  }
  if (attachments.length > 0) {
    const mime = stringValue(j.mime) || stringValue(objectValue(attachments[0]).mime);
    return baseDisplay("filesystem", "Read image", [file(path)], [text(mime || "attached", "muted")], "neutral", "file_read");
  }
  const lines = numberValue(j.lines_read) ?? (typeof j.content === "string" ? j.content.split(/\r?\n/).length : 0);
  const status = `${plural(lines, "line")}${j.truncated ? " · truncated" : ""}`;
  return baseDisplay("filesystem", "Read", [file(path)], [text(status, j.truncated ? "warn" : "muted")], j.truncated ? "warn" : "neutral", "file_read", { groupable: true });
}

function writeDisplay(pair: ToolPair, parsed: ParsedToolPair): ToolDisplayModel {
  const path = stringValue(parsed.args.path, "invalid path");
  const content = stringValue(parsed.args.content);
  const st = statusFromPair(pair, parsed, [text(content ? plural(content.split(/\r?\n/).length, "line") : "written", "ok")]);
  return baseDisplay("filesystem", "Write", [file(path)], st.status, st.tone === "neutral" ? "ok" : st.tone, "file_write", { mutation: true, important: true });
}

function globDisplay(pair: ToolPair, parsed: ParsedToolPair): ToolDisplayModel {
  const dir = stringValue(parsed.args.directory, ".");
  const pattern = stringValue(parsed.args.pattern, "pattern");
  const files = arrayValue(objectValue(parsed.unwrapped).files);
  const st = statusFromPair(pair, parsed, [text(files.length === 0 ? "no files" : plural(files.length, "file"), "muted")]);
  return baseDisplay("filesystem", "Glob", [code(pattern), text(" in ", "muted"), file(dir)], st.status, st.tone, "search_results", { groupable: pair.status === "ok" });
}

function grepDisplay(pair: ToolPair, parsed: ParsedToolPair): ToolDisplayModel {
  const root = stringValue(parsed.args.path, ".");
  const pattern = stringValue(parsed.args.pattern, "pattern");
  const matches = arrayValue(objectValue(parsed.unwrapped).matches);
  const st = statusFromPair(pair, parsed, [text(matches.length === 0 ? "no matches" : plural(matches.length, "match", "matches"), "muted")]);
  return baseDisplay("filesystem", "Grep", [code(pattern), text(" in ", "muted"), file(root)], st.status, st.tone, "search_results", { groupable: pair.status === "ok" });
}

function editDisplay(pair: ToolPair, parsed: ParsedToolPair): ToolDisplayModel {
  const path = stringValue(parsed.args.path, "invalid path");
  const replacements = numberValue(objectValue(parsed.unwrapped).replacements);
  const st = statusFromPair(pair, parsed, [text(replacements !== undefined ? plural(replacements, "replacement") : "edited", "ok")]);
  return baseDisplay("filesystem", "Edit", [file(path)], st.status, st.tone === "neutral" ? "ok" : st.tone, "file_write", { mutation: true, important: true });
}

function patchDisplay(pair: ToolPair, parsed: ParsedToolPair): ToolDisplayModel {
  const files = arrayValue(objectValue(parsed.unwrapped).files).map(String);
  const st = statusFromPair(pair, parsed, [text(files.length ? `${plural(files.length, "file")} patched` : "applied", "ok")]);
  return baseDisplay("filesystem", "Patch", files.length === 1 ? [file(files[0] ?? "")] : [text(files.length ? plural(files.length, "file") : "diff")], st.status, st.tone === "neutral" ? "ok" : st.tone, "git_diff", { mutation: true, important: true });
}

function websearchDisplay(pair: ToolPair, parsed: ParsedToolPair): ToolDisplayModel {
  const query = stringValue(parsed.args.query, "query");
  const results = arrayValue(objectValue(parsed.unwrapped).results);
  const st = statusFromPair(pair, parsed, [text(results.length === 0 ? "no results" : plural(results.length, "result"), "muted")]);
  return baseDisplay("web", "Web search", [text(truncate(query, 80))], st.status, st.tone, "web_results", { groupable: pair.status === "ok" });
}

function webfetchDisplay(pair: ToolPair, parsed: ParsedToolPair): ToolDisplayModel {
  const rawUrl = stringValue(parsed.args.url, "url");
  const j = objectValue(parsed.unwrapped);
  const saved = stringValue(j.saved_path);
  const status = numberValue(j.status);
  const bytes = numberValue(j.bytes_read) ?? numberValue(j.bytes);
  const stash = stringValue(j.stash_path);
  const attachments = arrayValue(j.attachments);
  const action = saved ? "Download" : attachments.length ? "Fetch image" : parsed.args.metadata_only ? "Fetch metadata" : "Fetch";
  const ok = saved ? [file(saved)] : stash ? [text(`stashed${bytes ? ` · ${bytes.toLocaleString()} B` : ""}`, "warn")] : [text(status ? String(status) : bytes ? `${bytes.toLocaleString()} B` : "fetched", "muted")];
  const st = statusFromPair(pair, parsed, ok);
  return baseDisplay("web", action, [url(rawUrl), ...(saved ? [text(" -> ", "muted"), file(saved)] : [])], st.status, st.tone, "web_fetch", { groupable: pair.status === "ok" && !saved && !parsed.args.save_as });
}

function commandDisplay(pair: ToolPair, parsed: ParsedToolPair): ToolDisplayModel {
  const command = truncate(stringValue(parsed.args.command, "command"), 120);
  const cwd = stringValue(parsed.args.cwd);
  const j = objectValue(parsed.unwrapped);
  const exitCode = numberValue(j.exitCode);
  const ok = exitCode === 0 ? [text("exit 0", "ok")] : [text(exitCode === 124 ? "timeout" : `exit ${exitCode ?? "?"}`, exitCode === 0 ? "ok" : "error")];
  const st = statusFromPair(pair, parsed, ok);
  return baseDisplay("shell", "Shell", [code(command), ...(cwd ? [text(` in ${truncate(cwd, 40)}`, "muted")] : [])], st.status, exitCode === 0 && st.tone === "neutral" ? "ok" : st.tone, "command", { important: true });
}

function gitDisplay(action: string, detailKind: ToolDetailKind, opts: { mutation?: boolean } = {}): DisplayBuilder {
  return (pair, parsed) => {
    const j = objectValue(parsed.unwrapped);
    let target: InlinePart[] = [text("working tree")];
    let ok: InlinePart[] = [text("returned", "muted")];
    switch (pair.toolName) {
      case "git_status": {
        const total = arrayValue(j.modified).length + arrayValue(j.added).length + arrayValue(j.deleted).length + arrayValue(j.untracked).length;
        ok = [text(total === 0 ? "clean" : plural(total, "change"), total === 0 ? "ok" : "muted")];
        break;
      }
      case "git_log": ok = [text(plural(arrayValue(j.commits).length, "commit"), "muted")]; target = parsed.args.branch ? [code(String(parsed.args.branch))] : [text("recent")]; break;
      case "git_diff": ok = [text(stringValue(j.diff).trim() ? plural(stringValue(j.diff).split("\n").length, "line") : "no changes", "muted")]; target = arrayValue(parsed.args.files).length ? arrayValue(parsed.args.files).map((p, i) => i === 0 ? file(String(p)) : text(`, ${String(p)}`, "muted")) : [text(parsed.args.ref1 || parsed.args.ref2 ? "refs" : "working tree")]; break;
      case "git_commit": ok = [text(stringValue(j.sha).slice(0, 7) || "committed", stringValue(j.sha) === "none" ? "muted" : "ok")]; target = [text(truncate(stringValue(parsed.args.message, "commit"), 80))]; break;
      case "git_create_branch": target = [code(stringValue(parsed.args.name, "branch"))]; ok = [text("created", "ok")]; break;
      case "git_checkout": target = [code(stringValue(parsed.args.ref, "ref"))]; ok = [text("checked out", "ok")]; break;
      case "git_merge": target = [code(stringValue(parsed.args.branch, "branch"))]; ok = [text("merged", "ok")]; break;
      case "git_delete_branch": target = [code(stringValue(parsed.args.name, "branch"))]; ok = [text("deleted", "warn")]; break;
    }
    const st = statusFromPair(pair, parsed, ok);
    return baseDisplay("git", action, target, st.status, opts.mutation && st.tone === "neutral" ? "ok" : st.tone, detailKind, { mutation: !!opts.mutation, important: !!opts.mutation, groupable: !opts.mutation && pair.status === "ok" });
  };
}

function planDisplay(action: string, detailKind: ToolDetailKind, mutation = false): DisplayBuilder {
  return (pair, parsed) => {
    const args = parsed.args;
    const j = objectValue(parsed.unwrapped);
    let target: InlinePart[] = [text("plan")];
    let ok: InlinePart[] = [text("returned", mutation ? "ok" : "muted")];
    if (pair.toolName === "plan_get") ok = [text(j.not_found ? "no plan" : plural(arrayValue(j.stages).length, "stage"), j.not_found ? "warn" : "muted")];
    else if (pair.toolName === "plan_get_stage" || pair.toolName === "plan_set_current" || pair.toolName === "plan_remove_stage") target = [code(stringValue(args.stage_id, "stage"))];
    else if (pair.toolName === "plan_get_current_stage") ok = [text(stringValue(j.id) || "none", stringValue(j.id) ? "muted" : "warn")];
    else if (pair.toolName === "plan_set_stages" || pair.toolName === "plan_init") ok = [text(plural(arrayValue(args.stages).length, "stage"), "ok")];
    else if (pair.toolName === "plan_add_stage") { const stage = objectValue(args.stage); target = [code(stringValue(stage.id, "stage")), ...(stage.objective ? [text(` ${truncate(String(stage.objective), 90)}`, "muted")] : [])]; ok = [text("added", "ok")]; }
    else if (pair.toolName === "plan_complete_stage") { const result = stringValue(args.result, "completed"); target = [code(stringValue(args.stage_id, "stage"))]; ok = [text(result, result === "completed" ? "ok" : result === "failed" || result === "aborted" ? "error" : "warn")]; }
    else if (pair.toolName === "plan_get_history") ok = [text(plural(arrayValue(j.stages).length, "stage"), "muted")];
    else if (pair.toolName === "plan_commit") target = [text(truncate(stringValue(args.message, "commit"), 80))];
    else if (pair.toolName === "plan_done") target = [text(truncate(stringValue(args.reason, "complete"), 100))];
    const st = statusFromPair(pair, parsed, ok);
    return baseDisplay("plan", action, target, st.status, mutation && st.tone === "neutral" ? "ok" : st.tone, detailKind, { mutation, important: mutation, groupable: !mutation && pair.status === "ok" });
  };
}

function stageArtifactDisplay(action: string, mutation: boolean): DisplayBuilder {
  return (pair, parsed) => {
    const args = parsed.args;
    const report = objectValue(args.report);
    const summary = objectValue(args.summary);
    const taskList = objectValue(args.task_list);
    const targetId = stringValue(args.stage_id) || stringValue(report.task_id) || stringValue(report.id) || stringValue(summary.stage_id) || stringValue(taskList.stage_id) || "stage";
    const st = statusFromPair(pair, parsed, [text(mutation ? "written" : "loaded", mutation ? "ok" : "muted")]);
    return baseDisplay("stage_artifact", action, [code(targetId)], st.status, mutation && st.tone === "neutral" ? "ok" : st.tone, "stage_artifact", { mutation, important: mutation, groupable: !mutation && pair.status === "ok" });
  };
}

const DISPATCH_LABELS: Record<string, string> = {
  run_manager: "Manager",
  run_inspector: "Inspector",
  run_coder: "Coder",
  run_researcher: "Researcher",
  run_data_agent: "Data Agent",
  run_reviewer: "Reviewer",
  run_designer: "Designer",
  run_critic: "Critic",
  run_librarian: "Librarian",
};

function dispatchDisplay(pair: ToolPair, parsed: ParsedToolPair): ToolDisplayModel {
  const label = DISPATCH_LABELS[pair.toolName] ?? "Dispatch";
  const key = pair.toolName === "run_manager" ? "stage" : pair.toolName === "run_inspector" ? "request" : pair.toolName === "run_librarian" ? "objective" : "task";
  const obj = key === "objective" ? parsed.args : objectValue(parsed.args[key]);
  const targetText = stringValue(obj.id) || stringValue(obj.objective) || stringValue(obj.scope) || stringValue(parsed.args.objective, "request");
  const result = objectValue(parsed.unwrapped);
  const outcome = stringValue(result.result) || stringValue(result.status) || "returned";
  const tone: DisplayTone = outcome === "completed" ? "ok" : outcome === "failed" || outcome === "aborted" ? "error" : outcome === "escalated" ? "warn" : "muted";
  const st = statusFromPair(pair, parsed, [text(outcome, tone)]);
  return baseDisplay("dispatch", label, [text(truncate(targetText, 110))], st.status, st.tone === "neutral" ? tone : st.tone, "dispatch", { important: true });
}

function skillDisplay(pair: ToolPair, parsed: ParsedToolPair): ToolDisplayModel {
  const name = stringValue(parsed.args.name);
  const j = objectValue(parsed.unwrapped);
  const st = statusFromPair(pair, parsed, [text(name ? "loaded" : plural(arrayValue(j.skills).length, "skill"), "muted")]);
  return baseDisplay("skill", name ? "Skill" : "Skills", [name ? code(name) : text("list")], st.status, st.tone, "skill", { groupable: pair.status === "ok" });
}

function topicLabel(value: unknown): string {
  const obj = objectValue(value);
  const domain = stringValue(obj.domain);
  const subject = stringValue(obj.subject);
  const aspect = stringValue(obj.aspect);
  const base = domain && subject ? `${domain}/${subject}` : domain || subject || "memory";
  return aspect ? `${base}:${aspect}` : base;
}

function memoryDisplay(action: string, mutation = false): DisplayBuilder {
  return (pair, parsed) => {
    const target = stringValue(parsed.args.id) || stringValue(parsed.args.old_id) || topicLabel(parsed.args.topic) || stringValue(parsed.args.query, "memory");
    const j = objectValue(parsed.unwrapped);
    const list = arrayValue(j.memories).length || arrayValue(j.results).length || arrayValue(j.records).length;
    const ok = [text(mutation ? "updated" : list ? plural(list, "record") : "loaded", mutation ? "ok" : "muted")];
    const st = statusFromPair(pair, parsed, ok);
    return baseDisplay("memory", action, [text(truncate(target, 90))], st.status, mutation && st.tone === "neutral" ? "ok" : st.tone, "memory", { mutation, important: mutation, groupable: !mutation && pair.status === "ok" });
  };
}

function ragDisplay(action: string, mutation = false): DisplayBuilder {
  return (pair, parsed) => {
    const collection = stringValue(parsed.args.collection_id, "collections");
    const j = objectValue(parsed.unwrapped);
    const results = arrayValue(j.results).length || arrayValue(j.hits).length || numberValue(j.chunks) || numberValue(j.chunk_count) || 0;
    const okText = pair.toolName === "rag_query" ? (results ? plural(results, "hit") : "no hits") : mutation ? "updated" : results ? String(results) : "loaded";
    const st = statusFromPair(pair, parsed, [text(okText, mutation ? "ok" : "muted")]);
    return baseDisplay("rag", action, [code(collection)], st.status, mutation && st.tone === "neutral" ? "ok" : st.tone, "rag", { mutation, important: mutation, groupable: !mutation && pair.status === "ok" });
  };
}

function noteDisplay(pair: ToolPair, parsed: ParsedToolPair): ToolDisplayModel {
  const flags = [parsed.args.urgent ? "urgent" : "", parsed.args.permanent ? "permanent" : ""].filter(Boolean).join(", ") || stringValue(parsed.args.channel, "chat");
  const st = statusFromPair(pair, parsed, [text("created", "ok")]);
  return baseDisplay("note", "Note", [text(flags)], st.status, st.tone === "neutral" ? "ok" : st.tone, "note", { mutation: true, important: true });
}

function externalDisplay(pair: ToolPair, parsed: ParsedToolPair): ToolDisplayModel {
  const status = statusFromPair(pair, parsed, [text(parsed.resultParseError ? "returned text" : "returned", parsed.resultParseError ? "warn" : "muted")]);
  const category: ToolCategory = CURRENT_TOOL_SET.has(pair.toolName) ? "unknown" : pair.toolName.includes("_") ? "external" : "unknown";
  return baseDisplay(category, category === "external" ? "External" : "Tool", [code(pair.toolName || "unknown")], status.status, status.tone, category === "external" ? "external" : "generic");
}

const DISPLAY_BUILDERS: Record<string, DisplayBuilder> = {
  read: readDisplay,
  write: writeDisplay,
  glob: globDisplay,
  grep: grepDisplay,
  edit: editDisplay,
  apply_patch: patchDisplay,
  websearch: websearchDisplay,
  webfetch: webfetchDisplay,
  run_command: commandDisplay,
  git_status: gitDisplay("Git status", "git_status"),
  git_create_branch: gitDisplay("Git branch", "git_mutation", { mutation: true }),
  git_checkout: gitDisplay("Git checkout", "git_mutation", { mutation: true }),
  git_commit: gitDisplay("Git commit", "git_mutation", { mutation: true }),
  git_merge: gitDisplay("Git merge", "git_mutation", { mutation: true }),
  git_diff: gitDisplay("Git diff", "git_diff"),
  git_delete_branch: gitDisplay("Git delete", "git_mutation", { mutation: true }),
  git_log: gitDisplay("Git log", "git_log"),
  plan_get: planDisplay("Plan", "plan_state"),
  plan_get_stage: planDisplay("Plan stage", "plan_state"),
  plan_get_current_stage: planDisplay("Current stage", "plan_state"),
  plan_set_stages: planDisplay("Plan", "plan_mutation", true),
  plan_add_stage: planDisplay("Plan add", "plan_mutation", true),
  plan_remove_stage: planDisplay("Plan remove", "plan_mutation", true),
  plan_set_current: planDisplay("Plan current", "plan_mutation", true),
  plan_complete_stage: planDisplay("Plan stage", "plan_mutation", true),
  plan_get_history: planDisplay("Plan history", "plan_state"),
  plan_init: planDisplay("Plan init", "plan_mutation", true),
  plan_commit: planDisplay("Plan commit", "plan_mutation", true),
  plan_done: planDisplay("Planner complete", "plan_mutation", true),
  stage_write_tasks: stageArtifactDisplay("Stage tasks", true),
  task_write_report: stageArtifactDisplay("Task report", true),
  stage_write_summary: stageArtifactDisplay("Stage summary", true),
  stage_get_run: stageArtifactDisplay("Stage run", false),
  stage_list_reports: stageArtifactDisplay("Stage reports", false),
  run_manager: dispatchDisplay,
  run_inspector: dispatchDisplay,
  run_coder: dispatchDisplay,
  run_researcher: dispatchDisplay,
  run_data_agent: dispatchDisplay,
  run_reviewer: dispatchDisplay,
  run_designer: dispatchDisplay,
  run_critic: dispatchDisplay,
  run_librarian: dispatchDisplay,
  skill: skillDisplay,
  create_memory: memoryDisplay("Memory create", true),
  update_memory: memoryDisplay("Memory update", true),
  supersede_memory: memoryDisplay("Memory supersede", true),
  archive_memory: memoryDisplay("Memory archive", true),
  delete_memory: memoryDisplay("Memory delete", true),
  list_memories: memoryDisplay("Memories"),
  get_memory: memoryDisplay("Memory"),
  search_memories: memoryDisplay("Memory search"),
  rag_list: ragDisplay("RAG"),
  rag_stats: ragDisplay("RAG stats"),
  rag_query: ragDisplay("RAG query"),
  rag_register: ragDisplay("RAG register", true),
  rag_ingest: ragDisplay("RAG ingest", true),
  rag_drop: ragDisplay("RAG drop", true),
  rag_admin: ragDisplay("RAG admin", true),
  create_note: noteDisplay,
};

export function buildToolDisplay(pair: ToolPair): ToolDisplayModel {
  const parsed = parseToolPair(pair);
  try {
    return (DISPLAY_BUILDERS[pair.toolName] ?? externalDisplay)(pair, parsed);
  } catch {
    return externalDisplay(pair, parsed);
  }
}

function fact(label: string, parts: InlinePart[], tone?: DisplayTone): DetailFact {
  return { label, value: parts, tone };
}

function jsonPreview(value: unknown, fallback: string): string {
  if (typeof value === "string") return value;
  try { return JSON.stringify(value, null, 2); } catch { return fallback; }
}

function tableRowsFromStrings(values: string[]): InlinePart[][][] {
  return values.map((value) => [[file(value)]]);
}

function defaultDetail(pair: ToolPair, parsed: ParsedToolPair, display: ToolDisplayModel): ToolDetailModel {
  const facts: DetailFact[] = [
    fact("Tool", [code(pair.toolName)]),
    fact("Status", display.status.length ? display.status : [text(pair.status)]),
  ];
  if (parsed.requestParseError) facts.push(fact("Warning", [text("Request payload could not be parsed", "warn")], "warn"));
  if (parsed.resultParseError) facts.push(fact("Warning", [text("Result payload could not be parsed", "warn")], "warn"));
  const sections: DetailSection[] = [];
  if (pair.status === "error") sections.push({ kind: "text", title: "Error", content: firstLine(parsed.rawResponse) || "Tool returned an error." });
  else if (parsed.rawResponse) sections.push({ kind: "code", title: "Result preview", language: "json", content: truncate(jsonPreview(parsed.unwrapped, parsed.rawResponse), 4000), maxHeight: "260px" });
  return { title: display.action, subtitle: display.target, facts, sections, links: [] };
}

function detailForRead(pair: ToolPair, parsed: ParsedToolPair, display: ToolDisplayModel): ToolDetailModel {
  const model = defaultDetail(pair, parsed, display);
  const path = stringValue(parsed.args.path);
  if (path) model.links.push({ kind: "file", label: "Open path", path });
  const j = objectValue(parsed.unwrapped);
  if (Array.isArray(j.entries)) {
    model.sections = [{ kind: "table", title: "Directory entries", columns: ["Name", "Type"], rows: j.entries.map((entry) => { const e = objectValue(entry); return [[file(path ? `${path}/${stringValue(e.name)}` : stringValue(e.name))], [text(stringValue(e.type))]]; }) }];
  } else if (typeof j.content === "string") {
    model.sections = [{ kind: "code", title: "Content", content: j.content, maxHeight: "320px" }];
  } else if (Array.isArray(j.attachments)) {
    model.sections = [{ kind: "attachments", title: "Attachments", attachments: j.attachments.map((entry) => { const e = objectValue(entry); return { mime: stringValue(e.mime), filename: stringValue(e.filename), url: stringValue(e.url), sizeBytes: numberValue(e.size_bytes) }; }) }];
  }
  return model;
}

function detailForSearch(pair: ToolPair, parsed: ParsedToolPair, display: ToolDisplayModel): ToolDetailModel {
  const model = defaultDetail(pair, parsed, display);
  const j = objectValue(parsed.unwrapped);
  if (Array.isArray(j.files)) model.sections = [{ kind: "table", title: "Files", columns: ["Path"], rows: tableRowsFromStrings(j.files.map(String)) }];
  if (Array.isArray(j.matches)) model.sections = [{ kind: "table", title: "Matches", columns: ["File", "Line", "Text"], rows: j.matches.map((match) => { const m = objectValue(match); return [[file(stringValue(m.path), "project", numberValue(m.line))], [text(String(m.line ?? ""))], [text(truncate(stringValue(m.text), 180))]]; }) }];
  return model;
}

function detailForCommand(pair: ToolPair, parsed: ParsedToolPair, display: ToolDisplayModel): ToolDetailModel {
  const model = defaultDetail(pair, parsed, display);
  const j = objectValue(parsed.unwrapped);
  model.facts.push(fact("Command", [code(stringValue(parsed.args.command))]));
  if (parsed.args.cwd) model.facts.push(fact("CWD", [file(String(parsed.args.cwd))]));
  if (j.duration_ms !== undefined) model.facts.push(fact("Duration", [text(`${j.duration_ms} ms`)]));
  model.sections = [{ kind: "terminal", title: "Output", stdout: stringValue(j.stdout), stderr: stringValue(j.stderr), exitCode: numberValue(j.exitCode), maxHeight: "320px" }];
  for (const key of ["stdout_path", "stderr_path"]) {
    const path = stringValue(j[key]);
    if (path) model.links.push({ kind: "file", label: key === "stdout_path" ? "Open stdout log" : "Open stderr log", path, root: "saivage" });
  }
  return model;
}

function detailForWeb(pair: ToolPair, parsed: ParsedToolPair, display: ToolDisplayModel): ToolDetailModel {
  const model = defaultDetail(pair, parsed, display);
  const j = objectValue(parsed.unwrapped);
  if (parsed.args.url) model.links.push({ kind: "url", label: "Open URL", url: String(parsed.args.url) });
  if (j.saved_path) model.links.push({ kind: "file", label: "Open saved file", path: String(j.saved_path) });
  if (j.stash_path) model.links.push({ kind: "file", label: "Open stash", path: String(j.stash_path), root: "saivage" });
  if (Array.isArray(j.results)) model.sections = [{ kind: "table", title: "Results", columns: ["Title", "URL", "Snippet"], rows: j.results.map((entry) => { const e = objectValue(entry); return [[text(truncate(stringValue(e.title), 80))], [url(stringValue(e.url))], [text(truncate(stringValue(e.snippet), 180))]]; }) }];
  else if (typeof j.content === "string" || typeof j.content_preview === "string") model.sections = [{ kind: "code", title: j.content ? "Content" : "Content preview", content: stringValue(j.content) || stringValue(j.content_preview), maxHeight: "320px" }];
  else if (Array.isArray(j.attachments)) model.sections = [{ kind: "attachments", title: "Attachments", attachments: j.attachments.map((entry) => { const e = objectValue(entry); return { mime: stringValue(e.mime), filename: stringValue(e.filename), url: stringValue(e.url), sizeBytes: numberValue(e.size_bytes) }; }) }];
  return model;
}

function detailForDiff(pair: ToolPair, parsed: ParsedToolPair, display: ToolDisplayModel): ToolDetailModel {
  const model = defaultDetail(pair, parsed, display);
  const j = objectValue(parsed.unwrapped);
  const diff = stringValue(j.diff) || stringValue(parsed.args.patch);
  if (diff) model.sections = [{ kind: "diff", title: "Diff", content: diff, maxHeight: "360px" }];
  const changed = arrayValue(j.files).map(String);
  for (const path of changed) model.links.push({ kind: "file", label: `Open ${shortPath(path)}`, path });
  return model;
}

function detailForListResult(pair: ToolPair, parsed: ParsedToolPair, display: ToolDisplayModel): ToolDetailModel {
  const model = defaultDetail(pair, parsed, display);
  const value = parsed.unwrapped;
  const obj = objectValue(value);
  const candidate = ["commits", "stages", "reports", "skills", "memories", "records", "results", "hits", "files"].find((key) => Array.isArray(obj[key]));
  if (candidate) {
    const rows = arrayValue(obj[candidate]).slice(0, 100).map((entry) => [[text(truncate(jsonPreview(entry, String(entry)), 240))]]);
    model.sections = [{ kind: "table", title: candidate, columns: ["Value"], rows }];
  }
  return model;
}

const DETAIL_BUILDERS: Partial<Record<ToolDetailKind, DetailBuilder>> = {
  file_read: detailForRead,
  directory_read: detailForRead,
  search_results: detailForSearch,
  command: detailForCommand,
  web_fetch: detailForWeb,
  web_results: detailForWeb,
  git_diff: detailForDiff,
  git_log: detailForListResult,
  git_status: detailForListResult,
  plan_state: detailForListResult,
  stage_artifact: detailForListResult,
  skill: detailForListResult,
  memory: detailForListResult,
  rag: detailForListResult,
};

export function buildToolDetail(pair: ToolPair, display = buildToolDisplay(pair)): ToolDetailModel {
  const parsed = parseToolPair(pair);
  try {
    return (DETAIL_BUILDERS[display.detailKind] ?? defaultDetail)(pair, parsed, display);
  } catch {
    return defaultDetail(pair, parsed, { ...display, detailKind: "generic" });
  }
}

export function isCurrentToolName(toolName: string): toolName is CurrentToolName {
  return CURRENT_TOOL_SET.has(toolName);
}
