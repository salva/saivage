/**
 * Per-tool renderers for the Agents view.
 *
 * Given a tool name plus the raw JSON args/result text, return a structured
 * compact representation made of inline parts. The renderer is intentionally
 * narrow: it surfaces the ONE piece of information a user wants to see for
 * each common Saivage tool and discards operational noise (timings, paths to
 * log files, internal stash markers, etc.).
 *
 * Unknown tools fall through to a generic formatter.
 */

export type InlinePart =
  | { kind: "text"; value: string; tone?: "muted" | "ok" | "warn" | "error" }
  | { kind: "code"; value: string }
  | { kind: "file"; path: string; root?: "project" | "saivage" }
  | { kind: "url"; url: string };

export interface FormattedToolPair {
  /** Short verb-like label shown in the strong column. */
  label: string;
  /** Inline parts describing the *input*. */
  summary: InlinePart[];
  /** Inline parts describing the *result*. */
  result: InlinePart[];
  /** Visual tone for the result text. */
  resultTone?: "muted" | "ok" | "warn" | "error";
}

function tryParse(value: string | undefined | null): unknown {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    return undefined;
  }
}

/** Unwrap MCP-style { content: <real result> } envelopes. */
function unwrap(value: unknown): unknown {
  if (value && typeof value === "object" && "content" in (value as Record<string, unknown>)) {
    const inner = (value as Record<string, unknown>).content;
    // If `content` is itself a string and looks like JSON, parse it too.
    if (typeof inner === "string") {
      const parsed = tryParse(inner);
      return parsed ?? inner;
    }
    return inner ?? value;
  }
  return value;
}

function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return value.slice(0, max) + "…";
}

function firstLine(value: string): string {
  const nl = value.indexOf("\n");
  return nl === -1 ? value : value.slice(0, nl);
}

function plural(n: number, singular: string, plural?: string): string {
  return `${n} ${n === 1 ? singular : (plural ?? singular + "s")}`;
}

/** Result content for non-error tool calls is text that may be JSON. */
interface RawResult {
  raw: string;
  json: unknown;
  isError: boolean;
}

function makeResult(content: string | undefined, isError: boolean): RawResult {
  const raw = content ?? "";
  return { raw, json: unwrap(tryParse(raw)), isError };
}

// ─── Per-tool formatters ────────────────────────────────────────────────

type Formatter = (args: Record<string, unknown>, res: RawResult) => FormattedToolPair;

function genericError(res: RawResult): InlinePart[] {
  const text = firstLine(res.raw).replace(/^Error:\s*/, "");
  return [{ kind: "text", value: truncate(text || "error", 140), tone: "error" }];
}

/** Detect the runtime's "result stashed" marker and pull the size out. */
function detectStash(raw: string): { chars: number; path?: string } | null {
  if (!raw || !raw.startsWith("[Result stashed")) return null;
  const sizeMatch = /(\d+)\s*chars/.exec(raw);
  const pathMatch = /path="([^"]+)"/.exec(raw);
  return {
    chars: sizeMatch ? Number(sizeMatch[1]) : 0,
    path: pathMatch ? pathMatch[1] : undefined,
  };
}

/** Short suffix of a stash id/path for display (last 8 chars after the final segment). */
function shortStashId(path: string): string {
  const last = path.split("/").pop() ?? path;
  const tok = last.split("|").pop() ?? last;
  return tok.length > 8 ? `…${tok.slice(-8)}` : tok;
}

const readFile: Formatter = (args, res) => {
  const path = String(args.path ?? "");
  let result: InlinePart[];
  let tone: FormattedToolPair["resultTone"] = "muted";
  if (res.isError) {
    result = genericError(res);
    tone = "error";
  } else {
    const j = res.json;
    let content = "";
    if (j && typeof j === "object" && "content" in (j as Record<string, unknown>)) {
      content = String((j as Record<string, unknown>).content ?? "");
    } else if (typeof j === "string") {
      content = j;
    } else {
      content = res.raw;
    }
    if (content.startsWith("[Result stashed")) {
      const m = detectStash(content);
      result = [{ kind: "text", value: m ? `stashed (${m.chars.toLocaleString()} chars)` : "stashed" }];
    } else {
      const lines = content.split("\n").length;
      const bytes = new TextEncoder().encode(content).length;
      result = [{ kind: "text", value: `${plural(lines, "line")} · ${bytes.toLocaleString()} B` }];
    }
  }
  return {
    label: "read",
    summary: [{ kind: "file", path, root: "project" }],
    result,
    resultTone: tone,
  };
};

const writeFile: Formatter = (args, res) => {
  const path = String(args.path ?? "");
  const content = String(args.content ?? "");
  const lines = content ? content.split("\n").length : 0;
  return {
    label: "write",
    summary: [{ kind: "file", path, root: "project" }],
    result: res.isError
      ? genericError(res)
      : [{ kind: "text", value: `${plural(lines, "line")} written` }],
    resultTone: res.isError ? "error" : "ok",
  };
};

const listDir: Formatter = (args, res) => {
  const path = String(args.path ?? "");
  let result: InlinePart[];
  if (res.isError) {
    result = genericError(res);
  } else {
    const j = res.json as { entries?: unknown[] } | undefined;
    const entries = Array.isArray(j?.entries) ? j!.entries! : [];
    const dirs = entries.filter((e) => (e as { type?: string }).type === "dir").length;
    const files = entries.length - dirs;
    result = [
      {
        kind: "text",
        value: entries.length === 0
          ? "empty"
          : `${plural(entries.length, "entry", "entries")}` + (dirs ? ` (${dirs} dir${dirs === 1 ? "" : "s"})` : ""),
      },
    ];
    void files;
  }
  return {
    label: "ls",
    summary: [{ kind: "file", path: path || ".", root: "project" }],
    result,
    resultTone: res.isError ? "error" : "muted",
  };
};

const searchFiles: Formatter = (args, res) => {
  const dir = String(args.directory ?? "");
  const pattern = String(args.pattern ?? "");
  let result: InlinePart[];
  if (res.isError) {
    result = genericError(res);
  } else {
    const j = res.json as { files?: unknown[] } | undefined;
    const files = Array.isArray(j?.files) ? j!.files! : [];
    result = [{ kind: "text", value: files.length === 0 ? "no matches" : plural(files.length, "match", "matches") }];
  }
  return {
    label: "find",
    summary: [
      { kind: "code", value: pattern },
      { kind: "text", value: " in ", tone: "muted" },
      { kind: "file", path: dir, root: "project" },
    ],
    result,
    resultTone: res.isError ? "error" : "muted",
  };
};

const runCommand: Formatter = (args, res) => {
  const command = String(args.command ?? "").trim();
  const cwd = args.cwd ? String(args.cwd) : "";
  const j = res.json as
    | { exitCode?: number; stdout?: string; stderr?: string; duration_ms?: number }
    | undefined;
  const exit = j?.exitCode;
  const stderr = (j?.stderr ?? "").trim();
  const stdout = (j?.stdout ?? "").trim();
  const tailLine = (text: string) => {
    if (!text) return "";
    const lines = text.split("\n").filter(Boolean);
    return lines[lines.length - 1] ?? "";
  };
  // When the runtime stashes a too-large result, the raw payload is the stash
  // marker rather than a structured object. Render compactly so the agent's
  // follow-up read_stash row carries the detail.
  const stash = detectStash(res.raw);
  let result: InlinePart[];
  let tone: FormattedToolPair["resultTone"];
  if (res.isError) {
    result = genericError(res);
    tone = "error";
  } else if (stash) {
    result = [{ kind: "text", value: `stashed (${stash.chars.toLocaleString()} chars)`, tone: "muted" }];
    tone = "muted";
  } else if (exit === 0) {
    const t = tailLine(stdout);
    result = [
      { kind: "text", value: "exit 0", tone: "ok" },
      ...(t ? [{ kind: "text" as const, value: ` · ${truncate(t, 140)}`, tone: "muted" as const }] : []),
    ];
    tone = "ok";
  } else {
    const t = tailLine(stderr) || tailLine(stdout) || res.raw;
    result = [
      { kind: "text", value: `exit ${exit ?? "?"}`, tone: "error" },
      { kind: "text", value: ` · ${truncate(t, 140)}`, tone: "error" },
    ];
    tone = "error";
  }
  const cmdLine = truncate(command, 140);
  const summary: InlinePart[] = [{ kind: "code", value: cmdLine }];
  if (cwd) summary.push({ kind: "text", value: ` (cwd ${truncate(cwd, 40)})`, tone: "muted" });
  return { label: "$", summary, result, resultTone: tone };
};

const gitStatus: Formatter = (_args, res) => {
  if (res.isError) return { label: "git status", summary: [], result: genericError(res), resultTone: "error" };
  const j = res.json as { files?: unknown[]; clean?: boolean; branch?: string } | undefined;
  const count = Array.isArray(j?.files) ? j!.files!.length : 0;
  const branch = j?.branch ? ` on ${j.branch}` : "";
  return {
    label: "git status",
    summary: [],
    result: [
      {
        kind: "text",
        value: count === 0 ? `clean${branch}` : `${plural(count, "change")}${branch}`,
        tone: count === 0 ? "ok" : "muted",
      },
    ],
  };
};

const gitLog: Formatter = (args, res) => {
  if (res.isError) return { label: "git log", summary: [], result: genericError(res), resultTone: "error" };
  const j = res.json as { commits?: unknown[] } | undefined;
  const count = Array.isArray(j?.commits) ? j!.commits!.length : 0;
  const n = args.n ?? args.max_count;
  return {
    label: "git log",
    summary: n ? [{ kind: "text", value: `last ${n}`, tone: "muted" }] : [],
    result: [{ kind: "text", value: plural(count, "commit"), tone: "muted" }],
  };
};

const gitDiff: Formatter = (args, res) => {
  if (res.isError) return { label: "git diff", summary: [], result: genericError(res), resultTone: "error" };
  const j = res.json as { diff?: string; files?: unknown[] } | undefined;
  const diffText = typeof j?.diff === "string" ? j.diff : "";
  const lines = diffText ? diffText.split("\n").length : 0;
  const files = Array.isArray(j?.files) ? j!.files!.length : undefined;
  const summary: InlinePart[] = args.path
    ? [{ kind: "file", path: String(args.path), root: "project" }]
    : [];
  return {
    label: "git diff",
    summary,
    result: [{
      kind: "text",
      value: lines === 0
        ? "no changes"
        : files !== undefined
          ? `${plural(files, "file")} · ${plural(lines, "line")}`
          : plural(lines, "line"),
      tone: "muted",
    }],
  };
};

const gitCommit: Formatter = (args, res) => {
  const message = String(args.message ?? "");
  if (res.isError) {
    return {
      label: "git commit",
      summary: [{ kind: "text", value: truncate(message, 140) }],
      result: genericError(res),
      resultTone: "error",
    };
  }
  const j = res.json as { hash?: string; sha?: string; noop?: boolean } | undefined;
  const sha = (j?.hash ?? j?.sha ?? "").slice(0, 7);
  return {
    label: "git commit",
    summary: [{ kind: "text", value: truncate(message, 140) }],
    result: [{
      kind: "text",
      value: j?.noop ? "nothing to commit" : sha ? sha : "committed",
      tone: j?.noop ? "muted" : "ok",
    }],
    resultTone: j?.noop ? "muted" : "ok",
  };
};

const readSkill: Formatter = (args, res) => {
  const name = String(args.name ?? "");
  return {
    label: "skill",
    summary: [{ kind: "code", value: name }],
    result: res.isError
      ? genericError(res)
      : [{ kind: "text", value: "loaded", tone: "muted" }],
    resultTone: res.isError ? "error" : "muted",
  };
};

const listSkills: Formatter = (_args, res) => {
  if (res.isError) return { label: "list skills", summary: [], result: genericError(res), resultTone: "error" };
  const j = res.json as { skills?: unknown[] } | undefined;
  const n = Array.isArray(j?.skills) ? j!.skills!.length : 0;
  return {
    label: "list skills",
    summary: [],
    result: [{ kind: "text", value: plural(n, "skill"), tone: "muted" }],
  };
};

const webSearch: Formatter = (args, res) => {
  const query = String(args.query ?? "");
  if (res.isError) {
    return {
      label: "search",
      summary: [{ kind: "text", value: truncate(query, 140) }],
      result: genericError(res),
      resultTone: "error",
    };
  }
  const j = res.json as { results?: unknown[] } | undefined;
  const n = Array.isArray(j?.results) ? j!.results!.length : 0;
  return {
    label: "search",
    summary: [{ kind: "text", value: truncate(query, 140) }],
    result: [{ kind: "text", value: n === 0 ? "no results" : plural(n, "result"), tone: "muted" }],
  };
};

const fetchUrl: Formatter = (args, res) => {
  const url = String(args.url ?? "");
  if (res.isError) {
    return { label: "fetch", summary: [{ kind: "url", url }], result: genericError(res), resultTone: "error" };
  }
  const j = res.json as { status?: number; body?: string; text?: string; bytes?: number } | undefined;
  const status = j?.status;
  const body = (j?.body ?? j?.text ?? "");
  const bytes = j?.bytes ?? new TextEncoder().encode(body).length;
  return {
    label: "fetch",
    summary: [{ kind: "url", url }],
    result: [{
      kind: "text",
      value: `${status ?? "ok"} · ${bytes.toLocaleString()} B`,
      tone: status && status >= 400 ? "warn" : "muted",
    }],
  };
};

const downloadFile: Formatter = (args, res) => {
  const url = String(args.url ?? "");
  const path = String(args.path ?? "");
  if (res.isError) {
    return {
      label: "download",
      summary: [{ kind: "url", url }, { kind: "text", value: " → " }, { kind: "file", path, root: "project" }],
      result: genericError(res),
      resultTone: "error",
    };
  }
  const j = res.json as { bytes?: number; size?: number; sha256?: string } | undefined;
  const bytes = j?.bytes ?? j?.size;
  return {
    label: "download",
    summary: [{ kind: "url", url }, { kind: "text", value: " → " }, { kind: "file", path, root: "project" }],
    result: [{
      kind: "text",
      value: bytes !== undefined ? `${bytes.toLocaleString()} B` : "downloaded",
      tone: "ok",
    }],
    resultTone: "ok",
  };
};

const planGet: Formatter = (_args, res) => {
  if (res.isError) return { label: "plan", summary: [], result: genericError(res), resultTone: "error" };
  const j = res.json as { stages?: unknown[]; current_stage_id?: string | null; not_found?: boolean } | undefined;
  if (j?.not_found || res.raw.includes("PLAN_NOT_FOUND")) {
    return { label: "plan", summary: [], result: [{ kind: "text", value: "no plan", tone: "warn" }] };
  }
  const stages = Array.isArray(j?.stages) ? j!.stages!.length : 0;
  const current = j?.current_stage_id ?? null;
  const parts: InlinePart[] = [{ kind: "text", value: plural(stages, "stage"), tone: "muted" }];
  if (current) {
    parts.push({ kind: "text", value: " · current=", tone: "muted" }, { kind: "code", value: current });
  }
  return { label: "plan", summary: [], result: parts };
};

const planGetCurrent: Formatter = (_args, res) => {
  if (res.isError) return { label: "current stage", summary: [], result: genericError(res), resultTone: "error" };
  const j = res.json as { id?: string; objective?: string } | undefined;
  return {
    label: "current stage",
    summary: [],
    result: j?.id
      ? [{ kind: "code", value: j.id }]
      : [{ kind: "text", value: "none", tone: "muted" }],
  };
};

const planGetHistory: Formatter = (args, res) => {
  if (res.isError) return { label: "plan history", summary: [], result: genericError(res), resultTone: "error" };
  const j = res.json as { stages?: unknown[] } | undefined;
  const n = Array.isArray(j?.stages) ? j!.stages!.length : 0;
  const lastN = args.last_n;
  return {
    label: "plan history",
    summary: lastN ? [{ kind: "text", value: `last ${lastN}`, tone: "muted" }] : [],
    result: [{ kind: "text", value: plural(n, "stage"), tone: "muted" }],
  };
};

const planSetCurrent: Formatter = (args, res) => ({
  label: "→ current",
  summary: [{ kind: "code", value: String(args.stage_id ?? "") }],
  result: res.isError ? genericError(res) : [{ kind: "text", value: "set", tone: "ok" }],
  resultTone: res.isError ? "error" : "ok",
});

const planSetStages: Formatter = (args, res) => {
  const stages = Array.isArray(args.stages) ? args.stages.length : 0;
  const current = args.current_stage_id ? ` · current=` : "";
  const parts: InlinePart[] = [{ kind: "text", value: plural(stages, "stage") }];
  if (args.current_stage_id) {
    parts.push({ kind: "text", value: current, tone: "muted" }, { kind: "code", value: String(args.current_stage_id) });
  }
  return {
    label: "set stages",
    summary: parts,
    result: res.isError ? genericError(res) : [{ kind: "text", value: "updated", tone: "ok" }],
    resultTone: res.isError ? "error" : "ok",
  };
};

const planAddStage: Formatter = (args, res) => {
  const stage = args.stage as { id?: string; objective?: string } | undefined;
  return {
    label: "+ stage",
    summary: [
      { kind: "code", value: String(stage?.id ?? "") },
      ...(stage?.objective
        ? [{ kind: "text" as const, value: ` — ${truncate(String(stage.objective), 120)}`, tone: "muted" as const }]
        : []),
    ],
    result: res.isError ? genericError(res) : [{ kind: "text", value: "added", tone: "ok" }],
    resultTone: res.isError ? "error" : "ok",
  };
};

const planRemoveStage: Formatter = (args, res) => ({
  label: "− stage",
  summary: [{ kind: "code", value: String(args.stage_id ?? "") }],
  result: res.isError ? genericError(res) : [{ kind: "text", value: "removed", tone: "ok" }],
  resultTone: res.isError ? "error" : "ok",
});

const planCompleteStage: Formatter = (args, res) => {
  const result = String(args.result ?? "");
  const tone: FormattedToolPair["resultTone"] = result === "completed" ? "ok"
    : result === "escalated" ? "warn"
    : result === "failed" ? "error"
    : "muted";
  const glyph = result === "completed" ? "✓" : result === "failed" ? "✗" : result === "escalated" ? "↑" : "·";
  return {
    label: `${glyph} stage`,
    summary: [
      { kind: "code", value: String(args.stage_id ?? "") },
      { kind: "text", value: ` ${result}`, tone },
    ],
    result: res.isError ? genericError(res) : [{ kind: "text", value: "archived", tone: "muted" }],
    resultTone: res.isError ? "error" : tone,
  };
};

const planInit: Formatter = (args, res) => {
  const stages = Array.isArray(args.stages) ? args.stages.length : 0;
  return {
    label: "init plan",
    summary: [{ kind: "text", value: plural(stages, "stage") }],
    result: res.isError ? genericError(res) : [{ kind: "text", value: "created", tone: "ok" }],
    resultTone: res.isError ? "error" : "ok",
  };
};

const planCommit: Formatter = (args, res) => ({
  label: "plan commit",
  summary: [{ kind: "text", value: truncate(String(args.message ?? ""), 140) }],
  result: res.isError ? genericError(res) : [{ kind: "text", value: "committed", tone: "ok" }],
  resultTone: res.isError ? "error" : "ok",
});

const planDone: Formatter = (args, res) => ({
  label: "Planner completed",
  summary: [{ kind: "text", value: truncate(String(args.reason ?? ""), 160) }],
  result: res.isError ? genericError(res) : [{ kind: "text", value: "recorded", tone: "ok" }],
  resultTone: res.isError ? "error" : "ok",
});

const createNote: Formatter = (args, res) => {
  const flags: string[] = [];
  if (args.urgent) flags.push("urgent");
  if (args.permanent) flags.push("permanent");
  const suffix = flags.length ? ` (${flags.join(", ")})` : "";
  return {
    label: `note${suffix}`,
    summary: [{ kind: "text", value: truncate(String(args.content ?? ""), 160), tone: args.urgent ? "warn" : undefined }],
    result: res.isError ? genericError(res) : [{ kind: "text", value: "created", tone: "ok" }],
    resultTone: res.isError ? "error" : "ok",
  };
};

const dispatch = (label: string, key: "stage" | "task" | "request"): Formatter => (args, res) => {
  const obj = args[key] as { id?: string; objective?: string; scope?: string } | undefined;
  const id = obj?.id ?? "";
  const text = obj?.objective ?? obj?.scope ?? "";
  const summary: InlinePart[] = [
    { kind: "code", value: id },
    ...(text ? [{ kind: "text" as const, value: ` — ${truncate(text, 160)}`, tone: "muted" as const }] : []),
  ];
  // Result: parse the child report
  if (res.isError) {
    return { label, summary, result: genericError(res), resultTone: "error" };
  }
  const r = res.json as { result?: string; status?: string; summary?: string; failure_reason?: string } | undefined;
  const outcome = r?.result ?? r?.status ?? "";
  const tone: FormattedToolPair["resultTone"] = outcome === "completed" ? "ok"
    : outcome === "escalated" ? "warn"
    : outcome === "failed" || outcome === "aborted" ? "error"
    : "muted";
  const detail = r?.failure_reason ?? r?.summary ?? "";
  const resultParts: InlinePart[] = [];
  if (outcome) resultParts.push({ kind: "text", value: outcome, tone });
  if (detail) {
    resultParts.push({ kind: "text", value: outcome ? ` · ${truncate(firstLine(detail), 160)}` : truncate(firstLine(detail), 160), tone: "muted" });
  }
  if (resultParts.length === 0) resultParts.push({ kind: "text", value: "returned", tone: "muted" });
  return { label, summary, result: resultParts, resultTone: tone };
};

const readStash: Formatter = (args, res) => {
  const path = String(args.path ?? "");
  const id = path ? shortStashId(path) : "stash";
  let result: InlinePart[];
  let tone: FormattedToolPair["resultTone"] = "muted";
  if (res.isError) {
    result = genericError(res);
    tone = "error";
  } else {
    const text = typeof res.json === "string" ? res.json : res.raw;
    const lines = text ? text.split("\n").length : 0;
    const bytes = new TextEncoder().encode(text).length;
    result = [{ kind: "text", value: `${plural(lines, "line")} · ${bytes.toLocaleString()} B` }];
  }
  return {
    label: "read_stash",
    summary: [{ kind: "code", value: id }],
    result,
    resultTone: tone,
  };
};

const FORMATTERS: Record<string, Formatter> = {
  read_file: readFile,
  write_file: writeFile,
  list_dir: listDir,
  search_files: searchFiles,
  run_command: runCommand,
  read_stash: readStash,
  git_status: gitStatus,
  git_log: gitLog,
  git_diff: gitDiff,
  git_commit: gitCommit,
  read_skill: readSkill,
  list_skills: listSkills,
  web_search: webSearch,
  fetch_url: fetchUrl,
  fetch_page_text: fetchUrl,
  download_file: downloadFile,
  download_with_fallbacks: downloadFile,
  plan_get: planGet,
  plan_get_stage: planGetCurrent,
  plan_get_current_stage: planGetCurrent,
  plan_get_history: planGetHistory,
  plan_set_current: planSetCurrent,
  plan_set_stages: planSetStages,
  plan_add_stage: planAddStage,
  plan_remove_stage: planRemoveStage,
  plan_complete_stage: planCompleteStage,
  plan_init: planInit,
  plan_commit: planCommit,
  plan_done: planDone,
  create_note: createNote,
  run_manager: dispatch("→ manager", "stage"),
  run_coder: dispatch("→ coder", "task"),
  run_researcher: dispatch("→ researcher", "task"),
  run_data_agent: dispatch("→ data", "task"),
  run_reviewer: dispatch("→ reviewer", "task"),
  run_inspector: dispatch("→ inspector", "request"),
};

const genericFormatter: Formatter = (args, res) => {
  const argSummary = (() => {
    try {
      const json = JSON.stringify(args);
      return truncate(json, 140);
    } catch {
      return "";
    }
  })();
  if (res.isError) {
    return { label: "tool", summary: [{ kind: "code", value: argSummary }], result: genericError(res), resultTone: "error" };
  }
  return {
    label: "tool",
    summary: [{ kind: "code", value: argSummary }],
    result: [{ kind: "text", value: truncate(firstLine(res.raw), 140), tone: "muted" }],
  };
};

/**
 * Format a tool-call/result pair into compact inline parts.
 * `argText` is the JSON-encoded arguments string (as stored in the entry
 * `content`). `resultText` is the result content. `toolName` selects the
 * specific renderer; unknown tools use a generic fallback.
 */
export function formatToolPair(
  toolName: string,
  argText: string | undefined,
  resultText: string | undefined,
  isError: boolean,
): FormattedToolPair {
  const args = (tryParse(argText) as Record<string, unknown> | undefined) ?? {};
  const res = makeResult(resultText, isError);
  const formatter = FORMATTERS[toolName] ?? genericFormatter;
  // Defensive: if a formatter throws on unexpected shape, fall back.
  try {
    return formatter(args, res);
  } catch {
    return genericFormatter(args, res);
  }
}

/** Tool name → friendly label (used as the strong element when no row is rendered). */
export function toolDisplayName(toolName: string): string {
  return FORMATTERS[toolName] ? toolName : toolName;
}
