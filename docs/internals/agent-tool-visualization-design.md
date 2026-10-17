# Agent Tool Visualization Design

Status: design plan.

Scope: Saivage web Agents conversation view. This document defines how tool calls and tool results should be displayed after the runtime tool vocabulary changed to the current OpenCode-aligned built-ins plus Saivage plan, dispatch, knowledge, RAG, and artifact tools.

Related background: `docs/internals/opencode-gui-conversation-visualization-analysis.md`.

## Executive Summary

Saivage should replace the current raw-ish tool row/detail model with a compact, human-readable, progressively-disclosed tool visualization system.

The target behavior:

1. The default view is concise. Tool calls scan as narrative milestones, not JSON records.
2. The first interaction shows a human-friendly detail view tailored to the tool type.
3. All original data remains reachable through a shared raw-payload escape hatch.
4. Navigation is lateral and explicit: file links open files, URL links open pages, child-agent links open child conversations.
5. Repetitive context-gathering calls can be grouped, but state mutations, dispatches, errors, diagnostics, and user-visible artifacts must stay visible.

This is not an OpenCode port. OpenCode inspired the information hierarchy: compact rows, expandable details, lazy heavy content, and grouping of low-value context calls. Saivage needs a different interface because it is an autonomous multi-agent runtime with long-running planner, manager, worker, reviewer, inspector, librarian, and chat workflows.

## Current Problems

The current implementation has useful foundations, but it no longer matches the runtime tool surface.

Current UI foundations:

- `ToolCallRow.vue` already renders compact rows and expands details.
- `toolFormatters.ts` already extracts one-line summaries from many tools.
- `InlinePart` already supports text, code, file, and URL parts.
- `open-file` events already let rows and details navigate to project files.
- `timeline.ts` already pairs `tool_call` with `tool_result` or `tool_error` by `toolUseId`.

Current gaps:

- `toolFormatters.ts` still contains many legacy names: `read_file`, `write_file`, `list_dir`, `search_files`, `web_search`, `fetch_url`, `download_file`, `download_with_fallbacks`.
- The current runtime built-ins are `read`, `write`, `glob`, `grep`, `edit`, `apply_patch`, `webfetch`, and `websearch`.
- New dispatch tools are not fully covered: `run_designer`, `run_critic`, and `run_librarian` are missing.
- Current git formatter coverage misses `git_create_branch`, `git_checkout`, `git_merge`, and `git_delete_branch`.
- Knowledge, memory, RAG, and stage-artifact tools are not properly covered.
- Expanded detail currently renders raw `content` through `FormattedContent`; it does not intentionally present the tool result for humans.
- The row grid permanently spends horizontal space on a result column, making normal rows denser and less narrative than necessary.

Design implication: the display registry should be keyed to the current runtime tools only. Removed built-in tool names should not remain in the registry, and no display-only legacy aliases should be added. Separate from that, the UI must keep a generic renderer for future or external MCP tools that are not known at build time.

## Current Runtime Tool Surface

The current canonical tools, based on source inspection, are:

| Group | Tools | Source |
| --- | --- | --- |
| Filesystem | `read`, `write`, `glob`, `grep`, `edit`, `apply_patch` | `src/mcp/builtins/filesystem.ts` |
| Web/data | `websearch`, `webfetch` | `src/mcp/builtins/web.ts` |
| Shell | `run_command` | `src/mcp/builtins/shell.ts` |
| Git | `git_status`, `git_create_branch`, `git_checkout`, `git_commit`, `git_merge`, `git_diff`, `git_delete_branch`, `git_log` | `src/mcp/builtins/git.ts` |
| Plan and stage artifacts | `plan_get`, `plan_get_stage`, `plan_get_current_stage`, `plan_set_stages`, `plan_add_stage`, `plan_remove_stage`, `plan_set_current`, `plan_complete_stage`, `plan_get_history`, `plan_init`, `plan_commit`, `plan_done`, `stage_write_tasks`, `task_write_report`, `stage_write_summary`, `stage_get_run`, `stage_list_reports` | `src/mcp/plan-registry.ts` |
| Dispatch | `run_manager`, `run_inspector`, `run_coder`, `run_researcher`, `run_data_agent`, `run_reviewer`, `run_designer`, `run_critic`, `run_librarian` | `src/agents/dispatch-tool-schemas.ts`, `src/agents/roster.ts` |
| Skills | `skill` | `src/mcp/knowledgeSkills.ts` |
| Memory | `create_memory`, `update_memory`, `supersede_memory`, `archive_memory`, `delete_memory`, `list_memories`, `get_memory`, `search_memories` | `src/mcp/knowledgeMemory.ts` |
| RAG | `rag_list`, `rag_stats`, `rag_query`, `rag_register`, `rag_ingest`, `rag_drop`, `rag_admin` | `src/server/rag/handler.ts` |
| Notes | `create_note` | `src/mcp/notes-server.ts` |
| External MCP | service-specific names, sometimes prefixed on collision, for example `external-files_read` | `src/mcp/runtime.ts` behavior |

Display coverage must include every tool above.

## Design Principles

### Concise By Default

Every tool should collapse to a single sentence-like row:

```text
Read        package.json                         120 lines
Grep        "ToolCallRow" in web/src             3 matches
Shell       npm run typecheck                    exit 0
Coder       fix auth flow                        completed
Plan        stage G2                             completed
RAG         query docs                           5 hits
```

The default row should answer three questions:

1. What kind of action happened?
2. What was the target?
3. What was the outcome?

It should not show raw JSON, full unbounded command output, full file contents, unbounded paths, complete stage objects, or internal envelopes.

### Human-Friendly First Click

Clicking a row opens a detail panel prepared for humans. It should be specific to the tool type:

- `read`: directory listing, file preview, or image attachment metadata.
- `run_command`: command metadata plus terminal-style stdout/stderr tails and log links.
- `write`, `edit`, `apply_patch`, `git_diff`: diff-oriented or changed-files view.
- dispatch tools: objective, status, summary, evidence, issues, and child conversation link when available.
- plan tools: plan state, stage transition, history entry, or artifact path.
- RAG tools: collection, query, hits, ingestion stats, or admin action result.

The detail view should read like an operator report, not like a serialized API payload.

### All Data Reachable

Every expanded detail must include a shared raw-payload escape hatch:

```text
[View raw request] [View raw response]
```

This renders the original request and response exactly as captured in the conversation entry. It is a generic affordance, not per-tool design work. It can be behind a small disclosure control, modal, drawer, or inline toggle. It should be lazy-mounted.

Raw JSON is not necessarily one click away from the compact row. That is acceptable. The invariant is that it is reachable, unmodified, and easy to find once the row is expanded.

### Separate Depth From Navigation

Depth means learning more about this tool call. Navigation means going somewhere else.

Depth path:

```text
compact row -> human detail -> raw payload
```

Navigation paths:

```text
file link -> file viewer/editor
URL link -> browser
child agent link -> child conversation
stash/log link -> file viewer
search match -> file viewer at line
```

Do not overload the row click to do lateral navigation. Row click expands detail. Links inside the row or detail navigate.

### Avoid Over-Featurism

Most tools only need two meaningful depth levels: compact row and human detail. The raw payload escape hatch is shared across all tools. Do not build bespoke third, fourth, or fifth view modes unless a tool has a proven operator need.

Examples of acceptable extra depth:

- Command logs: compact row -> terminal detail -> open full stdout/stderr log file.
- Dispatch: compact row -> dispatch summary -> child conversation.
- Web fetch with stashed text: compact row -> fetch metadata and preview -> open stash file.

These are navigation paths or existing artifact paths, not new per-tool UI modes.

### Errors Stay Visible

Failed tools should not be buried inside collapsed groups. A group may show an error count, but every failed member must either be pulled out as its own row or the group must auto-expand to reveal it.

### Mutations Stay Visible

The UI may group repetitive read-only context calls. It must not hide operations that mutate project state, plan state, git state, memory, RAG registrations, notes, or stage artifacts.

### Stable, Deterministic State

Expansion state must survive polling refreshes. Row IDs and group IDs must be derived from stable conversation identifiers: round ID plus `toolUseId`, or round ID plus contained `toolUseId`s for groups.

## Visual System

### Row Anatomy

Target desktop row:

```text
[chevron] [icon] [action] [target........................] [status]
```

Target mobile row:

```text
[chevron] [icon] [action] [status]
          [target........................]
```

Fields:

| Field | Purpose | Rules |
| --- | --- | --- |
| Chevron | Shows expandable state | Always present for tool rows and groups |
| Icon | Fast category recognition | Optional text/icon token; must not be the only semantic label |
| Action | Friendly verb or role | Title Case for built-ins: `Read`, `Shell`, `Plan`; role names for dispatch: `Coder`, `Reviewer` |
| Target | Main object of the operation | Prefer basename plus muted path context, or concise query/command/objective |
| Status | Outcome | Hidden or muted for uninteresting success; visible for pending, error, warning, counts, or changed state |

The current four-column grid (`chevron | label | summary | result`) should become action-target-status. The status column should not dominate the row on successful routine calls.

### Tone System

| Tone | Meaning | Examples |
| --- | --- | --- |
| neutral | Routine read or informational success | `read`, `glob`, `plan_get` |
| ok | Successful mutation or verified completion | `write`, `edit`, `git_commit`, completed dispatch |
| warn | Escalation, timeout, truncation, no plan, no matches when surprising | `plan_complete_stage` escalated, stashed output, response truncated |
| error | Tool error, failed dispatch, invalid args | any `tool_error`, failed task report |
| pending | Tool call in flight | current round call with no result |

### Detail Panel Anatomy

Every expanded tool detail should have the same skeleton:

```text
Header: Action, target, status, timestamp
Summary: one or two human sentences or structured chips
Body: tool-specific human view
Links: relevant file, URL, log, stash, or child-conversation navigation
Raw: shared raw request/response toggle
```

The body varies by tool. The skeleton does not.

### Raw Payload Toggle

Introduce one shared component:

```ts
interface RawPayloadToggleProps {
  request?: string;
  response?: string;
  responseKind: "result" | "error" | "missing";
}
```

Behavior:

| State | Display |
| --- | --- |
| collapsed | Small `Raw` button or `View raw` disclosure in the detail footer |
| request selected | Syntax-highlighted original request content |
| response selected | Syntax-highlighted original response/error content |
| missing result | Disabled response selector with `No result recorded` |

Do not parse and reserialize if exact byte-for-byte preservation matters. If syntax highlighting needs parsing, keep the original string as the source and only format a display copy.

### Group Rows

Group rows compress low-value repetition. They should have their own detail view listing member rows.

Allowed groups:

| Group | Eligible tools | Conditions |
| --- | --- | --- |
| Gathered context | `read`, `glob`, `grep`, `skill`, `list_memories`, `get_memory`, `search_memories`, `rag_query` | Adjacent, successful, read-only, non-error |
| Checked git | `git_status`, `git_log`, `git_diff` | Adjacent, successful, read-only |
| Read plan | `plan_get`, `plan_get_stage`, `plan_get_current_stage`, `plan_get_history`, `stage_get_run`, `stage_list_reports` | Adjacent, successful, read-only |
| Web research | `websearch`, `webfetch` | Adjacent, successful, read-only, no saved file mutation |

Never group by default:

- `run_*` dispatch tools.
- `run_command` unless it is clearly a repeated read-only inspection and non-error; default should be ungrouped.
- Filesystem mutations: `write`, `edit`, `apply_patch`.
- Git mutations: `git_create_branch`, `git_checkout`, `git_commit`, `git_merge`, `git_delete_branch`.
- Plan mutations: `plan_set_stages`, `plan_add_stage`, `plan_remove_stage`, `plan_set_current`, `plan_complete_stage`, `plan_init`, `plan_commit`, `plan_done`.
- Stage artifact writes: `stage_write_tasks`, `task_write_report`, `stage_write_summary`.
- Knowledge mutations: `create_memory`, `update_memory`, `supersede_memory`, `archive_memory`, `delete_memory`, `create_note`.
- RAG mutations/admin: `rag_register`, `rag_ingest`, `rag_drop`, `rag_admin`.
- Any error, pending, missing, or orphan pair.

Grouping decisions must be based on both the parsed request and parsed response. For example, `webfetch` is groupable only when the request has no `save_as`, and only when the result did not create a saved file. If request parsing fails, default to ungrouped.

Group detail behavior:

| Interaction | Result |
| --- | --- |
| click group row | Expands a list of contained compact rows |
| click contained row | Expands that tool's human detail |
| raw payload | Available per contained row, not at group level |

## Display Model

Replace `FormattedToolPair` with a richer model.

```ts
type ToolCategory =
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

type DisplayTone = "neutral" | "ok" | "warn" | "error" | "pending";

type ToolDetailKind =
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

interface ToolDisplayModel {
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

interface ToolDetailModel {
  title: string;
  subtitle: InlinePart[];
  facts: DetailFact[];
  sections: DetailSection[];
  links: DetailLink[];
}

interface DetailFact {
  label: string;
  value: InlinePart[];
  tone?: DisplayTone | "muted";
}

type DetailLink =
  | { kind: "file"; label: string; path: string; root?: "project" | "saivage"; line?: number }
  | { kind: "url"; label: string; url: string }
  | { kind: "conversation"; label: string; agentId: string; roundId?: string };

interface AttachmentSummary {
  mime: string;
  filename?: string;
  sizeBytes?: number;
  url?: string;
}

type DetailSection =
  | { kind: "text"; title?: string; content: string }
  | { kind: "code"; title?: string; language?: string; content: string; maxHeight?: number }
  | { kind: "terminal"; title?: string; stdout?: string; stderr?: string; exitCode?: number; maxHeight?: number }
  | { kind: "diff"; title?: string; content: string; files?: string[]; maxHeight?: number }
  | { kind: "table"; title?: string; columns: string[]; rows: InlinePart[][][] }
  | { kind: "list"; title?: string; items: InlinePart[][] }
  | { kind: "attachments"; title?: string; attachments: AttachmentSummary[] };
```

Use `DetailSection` consistently:

| Human concept | Section kind |
| --- | --- |
| File preview, skill body, memory body, note body | `code` or `text` |
| Command stdout/stderr | `terminal` |
| Diffs and patches | `diff` |
| Commit lists, directory entries, grep matches, web results, RAG hits, memory lists, stage reports | `table` |
| Short evidence, issues, outcomes, acceptance criteria | `list` |
| Images or fetched/read media | `attachments` |

If a tool-specific section says "table", it means a `DetailSection` with `kind: "table"`. If a renderer cannot confidently map content into a structured section, it should use `text` or `code` plus the raw payload toggle rather than inventing a new section kind.

Keep `InlinePart` for clickable text fragments. Extend it only if needed:

```ts
type InlinePart =
  | { kind: "text"; value: string; tone?: DisplayTone | "muted" }
  | { kind: "code"; value: string }
  | { kind: "file"; path: string; root?: "project" | "saivage"; line?: number }
  | { kind: "url"; url: string }
  | { kind: "conversation"; agentId?: string; roundId?: string; label: string };
```

Rendering support must be updated with this type. The current row click handler only handles `file` and `url`; the new implementation must add an `open-conversation` event for `conversation` parts, and the detail panel must render `DetailLink` values through the same navigation handlers. If child conversation IDs are absent, do not render a disabled fake link; show the child-agent result summary only.

External MCP tools should use `external` or `unknown` display with best-effort extraction. Do not create a large registry of arbitrary external service-specific renderers until real use justifies it.

`unknown` is not a legacy-compatibility path. It is the forward-compatible path for tools that can appear at runtime because MCP is extensible: third-party MCP servers, namespaced collision tools, or future first-party tools not yet covered by the UI registry.

## Backend And Frontend Responsibilities

This change is mostly a presentation redesign, but it still has backend implications. The frontend can improve the current experience using existing conversation entries, but some target interactions require backend/API support to be reliable and typed.

### Backend Responsibilities

The backend should remain the source of truth for conversation entries, tool names, tool use IDs, raw payloads, and child-agent relationships. It should not pre-render UI. It should expose structured facts that make the frontend renderer reliable.

Required backend work:

| Area | Required change | Why |
| --- | --- | --- |
| Tool inventory | Expose or document the canonical current tool list by service | Lets frontend registry completeness tests compare against a real source instead of a manually copied list |
| Raw payload preservation | Continue storing original tool request/result/error `content` unchanged | Required for the raw payload escape hatch |
| Conversation entry schema | Keep `toolName`, `toolUseId`, `kind`, `roundId`, `timestamp`, `content`, `modelSpec`, and `requestedModelSpec` stable or evolve them through typed API changes | Timeline pairing, grouping, expansion state, and diagnostics depend on these fields |
| Tool name validation | Preserve the exact runtime tool name in conversation entries after MCP name collision handling | The frontend registry and external renderer need the displayed name the model actually used |
| Tool result typing | Keep result envelopes structured and stable: `{ content, isError }` plus tool-specific content objects | Human detail renderers depend on parseable structured results |
| Child dispatch references | Add stable child-agent or child-conversation references to dispatch results when available | Enables lateral navigation from `run_*` rows to child conversations |
| External MCP metadata | Preserve service name and runtime tool name for every external tool; preserve original name on collision and description/schema when the MCP server provides them | Lets unknown/external tool rows identify their MCP surface without assuming third-party servers provide rich metadata |
| Artifact paths | Return persisted artifact paths for stage tasks, reports, summaries, command logs, stash files, notes, saved fetches, and RAG artifacts when available | Lets detail panels navigate to evidence files |
| File line links | If file browser/editor supports line navigation, accept and route optional line numbers | Enables `grep`/RAG/search match navigation |
| Error shape | Keep stable error codes in structured payloads | Lets compact rows show meaningful error statuses instead of raw messages |
| Compaction behavior | Preserve tool call/result entries or stable summarized evidence across conversation compaction | Grouping and auditability fail if compaction drops tool evidence without a replacement summary |

Backend changes that are explicitly not required:

- Do not add server-side display strings as the primary UI API.
- Do not add compatibility aliases for removed tool names.
- Do not create a second overflow/stash system for visualization.
- Do not hide raw payloads from the conversation model.

### Frontend Responsibilities

The frontend owns visual hierarchy, grouping, progressive disclosure, and navigation affordances.

Required frontend work:

| Area | Required change | Why |
| --- | --- | --- |
| Display registry | Replace legacy `toolFormatters.ts` coverage with current-tool display builders | Current runtime tools must not fall through to obsolete formatters |
| Detail registry | Add human-readable detail builders by category/tool | First click must show operator-friendly detail, not raw JSON |
| Raw escape hatch | Add shared `RawPayloadToggle.vue` | All data remains reachable without making raw JSON the default |
| Grouping | Add deterministic grouping for adjacent successful read-only calls | Reduces context noise without hiding mutations or errors |
| Navigation | Preserve file/URL links and add conversation links when backend references exist | Separates depth from lateral navigation |
| Unknown/external tools | Add generic external MCP renderer | Future and third-party MCP tools display coherently without bespoke code |
| Tests | Add registry completeness, grouping, raw payload, and component tests | Prevents future tool changes from silently degrading the UI |

Backend and frontend must agree on one invariant: tool call/result data stays structured and raw-preserved; display-specific interpretation lives in the frontend. When compaction or summarization changes what entries are available, the backend must preserve enough stable evidence for the frontend to render a truthful compact summary.

## Implementation Architecture

### Data Flow

Target flow:

```text
ConversationEntry[]
  -> entriesToTimeline()
  -> ToolPair[]
  -> buildToolDisplay(pair)
  -> groupToolDisplayItems(round)
  -> ToolRow / ToolGroupRow
  -> ToolDetailPanel
  -> RawPayloadToggle
```

### Modules

| Module | Responsibility |
| --- | --- |
| `web/src/utils/toolDisplay.ts` | Current tool registry, compact display models, groupability flags |
| `web/src/utils/toolDetails.ts` | Human-readable detail model builders |
| `web/src/utils/rawPayload.ts` | Safe original request/response display helpers |
| `web/src/components/agents/ToolRow.vue` | New compact row |
| `web/src/components/agents/ToolDetailPanel.vue` | Shared expanded detail skeleton |
| `web/src/components/agents/ToolGroupRow.vue` | Group row and contained rows |
| `web/src/components/agents/RawPayloadToggle.vue` | Raw request/response escape hatch |
| `web/src/components/agents/DetailSectionRenderer.vue` | Renders table/list/code/diff/terminal/attachments sections |
| `web/src/components/agents/toolGrouping.ts` | Adjacent grouping rules and deterministic IDs |

The old `toolFormatters.ts` can either be replaced or split. The cleaner path is replacement because many names are obsolete and backward compatibility is not valuable here.

### Parsing Rules

Tool call arguments and results arrive as strings. Display builders should parse defensively:

1. Parse request `content` as JSON object when possible.
2. Parse result `content` as an envelope when possible.
3. Unwrap `{ content: ... }` envelopes where appropriate.
4. Keep the original request/result strings for raw display.
5. If parsing fails, fall back to generic display and preserve raw payload access.

Malformed payload behavior:

| Failure | Compact row | Detail |
| --- | --- | --- |
| Request JSON does not parse | Friendly action from `toolName` if known; target `unparsed request`; warning tone unless result is an error | Show a warning fact `Request payload could not be parsed`, then raw request toggle |
| Result JSON does not parse | Use status `returned text` for success or the first error line for error | Render result as capped `text`/`code`; raw response toggle remains available |
| Both request and result fail to parse | Generic/external row with raw tool name and `unparsed payload` status | Show capped raw text previews plus raw toggles |
| Parsed envelope shape is unexpected | Known tool compact action, generic target/status from available text | Use generic detail sections; do not throw from renderer |

Renderer failures must be contained. A formatter exception should never break the conversation view; it should fall back to `detailKind: "generic"` and keep raw payload access.

### Status Rules

| Pair state | Compact status | Detail behavior |
| --- | --- | --- |
| pending | `running...` or tool-specific pending phrase | Show request facts and pending marker; response raw disabled |
| ok | tool-specific success outcome | Show human result detail and raw request/response |
| error | first meaningful error line and error tone | Show error section first, then request facts, then raw request/error |
| missing | `no result` warning | Show request facts, missing-result warning, raw request only |
| orphan | `orphan result` warning | Show result facts if possible, raw response only |

## Tool-Specific Display Plan

### Filesystem Tools

#### `read`

Purpose: read a project file or directory; optionally read images as multimodal attachments.

Compact row:

| Case | Action | Target | Status |
| --- | --- | --- | --- |
| file text read | `Read` | file path, basename emphasized | `N lines`, `truncated`, or byte count |
| directory read | `List` | directory path | `N entries`, `truncated` when applicable |
| multimodal image | `Read image` | file path | mime and size |
| error | `Read` | requested path when available, otherwise `invalid path` | error code or first error line in error tone |

Human detail:

- Facts: path, mode, offset, limit, line count, size, truncation.
- Text file: syntax-highlighted preview using returned content, with file link.
- Directory: table of entries with type and clickable file/dir paths.
- Image: attachment summary and thumbnail if safe/current components support it; otherwise metadata only.
- Error: code, path, and explanation.

Navigation:

- File path opens project file.
- Directory path opens file browser at directory if supported.

Parameter interactions:

| `read_mode` | `offset`/`limit` | Path type | Valid? | Display implication |
| --- | --- | --- | --- | --- |
| omitted or `auto` | any | text file | yes | text preview with range facts |
| `text` | any | text file | yes | text preview with range facts |
| `auto` | none | supported image | yes | attachment detail |
| `multimodal` | none | supported image file | yes | attachment detail |
| `multimodal` | present | any file | no | error detail explains range unsupported |
| `multimodal` | any | directory | no | error detail explains file required |

Grouping: groupable as context only when successful and read-only. Do not group image reads by default if attachments are important to the operator.

#### `write`

Purpose: write content to a project file.

Compact row:

```text
Write       src/app.ts                            82 lines
```

Human detail:

- Facts: path, line count, byte count.
- Body: content preview, capped.
- If future server result includes previous content or diff metadata, switch to diff view.
- Links: written file.

Grouping: never group. This mutates project state.

Raw escape hatch: useful for exact content when preview is capped.

#### `glob`

Purpose: recursively find files matching a glob.

Compact row:

```text
Glob        **/*.vue in web/src                   12 files
```

Human detail:

- Facts: directory, pattern, max results, truncated reason, skipped paths.
- Body: clickable list/table of matched files.
- Highlight truncation and skipped permission/not-found paths.

Grouping: groupable as context when successful.

#### `grep`

Purpose: search file contents with a JavaScript regex.

Compact row:

```text
Grep        "ToolCallRow" in web/src              3 matches
```

Human detail:

- Facts: pattern, path, include filter, max results, truncated reason.
- Body: match table with file, line, and text snippet.
- Links: each file+line opens file viewer at line if supported.

Grouping: groupable as context when successful.

Parameter interactions:

| `path` | `include` | Valid? | Display implication |
| --- | --- | --- | --- |
| omitted | omitted | yes | target is project root |
| file | omitted | yes | target is that file |
| directory | omitted | yes | target is directory |
| directory | present | yes | include filter shown as chip |
| file | present | technically accepted | show include chip, but result is file-scoped |
| invalid regex | any | no | error detail shows `INVALID_PATTERN` |

#### `edit`

Purpose: replace exact text in one project file.

Compact row:

```text
Edit        src/app.ts                            1 replacement
Edit        src/app.ts                            5 replacements
```

Human detail:

- Facts: path, replacement count, `replace_all` value.
- Body: old/new snippets shown as a mini diff.
- Error detail for `NO_MATCH` and `AMBIGUOUS_MATCH` should make the cause prominent.
- Links: edited file.

Grouping: never group. This mutates project state.

Parameter interactions:

| `old_string` matches | `replace_all` | Valid? | Display implication |
| --- | --- | --- | --- |
| zero | false or omitted | no | error `NO_MATCH` |
| one | false or omitted | yes | `1 replacement` |
| one | true | yes | `1 replacement` |
| multiple | false or omitted | no | error `AMBIGUOUS_MATCH` with match count |
| multiple | true | yes | `N replacements` |

#### `apply_patch`

Purpose: apply a unified diff to one or more files.

Compact row:

```text
Patch       3 files                               applied
```

Human detail:

- Facts: file count, added/deleted/modified when inferable from patch headers.
- Body: diff view of the patch.
- Result section: changed file list from result.
- Error section: patch validation or context mismatch code, with target file.
- Links: changed files.

Grouping: never group. This mutates project state.

### Web/Data Tools

#### `websearch`

Purpose: search public web via configured endpoint.

Compact row:

```text
Web search  "vue raw json toggle"                10 results
```

Human detail:

- Facts: query, max results, upstream status, skipped count.
- Body: list/table of title, URL, snippet.
- Error detail: stable code such as `TIMEOUT`, `NETWORK_ERROR`, `UPSTREAM_HTTP_ERROR`, `PARSE_FAILURE`, `NO_RESULTS_PARSED`.

Navigation: result URLs open browser.

Grouping: groupable as web research when adjacent and successful.

#### `webfetch`

Purpose: fetch HTTP(S) content, optionally metadata only, multimodal attachment, or save as project file.

Compact row:

| Case | Row |
| --- | --- |
| metadata only | `Fetch metadata  example.com  200` |
| inline text | `Fetch  example.com  42 KB` |
| stashed text | `Fetch  example.com  stashed 240 KB` |
| saved file | `Download  example.com -> data/file.csv  2 MB` |
| image attachment | `Fetch image  example.com/image.png  image/png` |
| unsupported binary | `Fetch  example.com/file.bin  unsupported binary` |

Human detail:

- Facts: URL, status, headers, bytes read, SHA-256 when available.
- Text: content preview or stash path with preview.
- Saved file: saved path link, bytes, SHA-256.
- Metadata only: headers table.
- Attachment: attachment metadata and thumbnail if supported.
- Error: code and status/headers when available.

Navigation:

- URL opens browser.
- `saved_path` opens project file.
- `stash_path` opens stash file under `.saivage/tmp/stash`.

Parameter interactions:

| `metadata_only` | `save_as` | `read_mode` | Valid? | Display implication |
| --- | --- | --- | --- | --- |
| true | omitted | any | yes | metadata row and headers detail |
| true | present | any | no | error explains invalid combination |
| false/omitted | present | text/auto/multimodal | yes | download/save row |
| false/omitted | omitted | `text` | yes | inline or stashed text detail |
| false/omitted | omitted | `multimodal` and image | yes | attachment detail |
| false/omitted | omitted | `multimodal` and non-image | no | unsupported media error |
| false/omitted | omitted | `auto` and text mime | yes | inline or stashed text detail |
| false/omitted | omitted | `auto` and image mime | yes | attachment detail |
| false/omitted | omitted | `auto` and unsupported binary | no | unsupported binary error, suggest `save_as` |

Grouping: groupable only when read-only. Do not group `webfetch` with `save_as` because it mutates files.

### Shell Tool

#### `run_command`

Purpose: run shell command with managed stdout/stderr logs and timeout handling.

Compact row:

```text
Shell       npm run typecheck                     exit 0
Shell       npm test                              exit 1
Shell       npm run train                         timeout
```

Human detail:

- Facts: command, cwd, started/completed time, duration, exit code, timeout mode if inferred, output byte counts.
- Body: terminal-style stdout and stderr tail sections.
- Links: stdout/stderr log files in `.saivage/tmp/command-logs`.
- Error/warn: exit code nonzero, timeout exit `124`, or no output.

Navigation:

- stdout path opens log file.
- stderr path opens log file.

Parameter interactions:

| `timeout_ms` | `inactivity_timeout_ms` | Valid? | Runtime behavior | Display implication |
| --- | --- | --- | --- | --- |
| omitted | omitted | yes | runtime hard cap still enforced | show effective duration and no caller timeout chip |
| positive | omitted | yes | clamped to configured floor and inner cap | show wall timeout chip |
| omitted | positive | yes | clamped to configured floor | show inactivity timeout chip |
| positive | positive | yes | both enforced | show both chips |
| `0` | `0` | yes | disables caller values, runtime cap still enforced | show no caller timeout chip |
| negative/non-number | any | no | invalid argument | error detail |

Grouping: never group in this design. Shell commands often carry causal meaning, and there is no current opt-in mechanism to prove a command is a safe low-value inspection. If that mechanism is added later, it must be a separate design change with explicit classification rules and tests.

### Git Tools

#### `git_status`

Compact row:

```text
Git status  working tree                          clean
Git status  working tree                          3 changed
```

Human detail:

- Facts: counts by modified, added, deleted, untracked.
- Body: file list grouped by status.
- Links: files open project file when applicable.

Grouping: groupable in `Checked git` when successful.

#### `git_create_branch`

Compact row:

```text
Git branch  feature/ui                            created
```

Human detail: branch name, created flag, any error output.

Grouping: never group. Mutates git state.

#### `git_checkout`

Compact row:

```text
Git checkout feature/ui                           checked out
```

Human detail: ref, checkout status, errors.

Grouping: never group. Mutates git state.

#### `git_commit`

Compact row:

```text
Git commit  Fix tool visualization                abc1234
Git commit  Fix tool visualization                nothing to commit
```

Human detail:

- Facts: message, task id, file count, SHA.
- Body: files staged/committed.
- Error detail: conflict files or git error.

Grouping: never group. Mutates git state.

#### `git_merge`

Compact row:

```text
Git merge   feature/ui                            merged
```

Human detail: branch, merge output, conflict/error detail.

Grouping: never group.

#### `git_diff`

Compact row:

```text
Git diff    working tree                          240 lines
Git diff    src/app.ts                            no changes
```

Human detail:

- Facts: files filter, ref1, ref2.
- Body: diff view.
- Links: file paths from args or parsed diff headers.

Grouping: groupable when successful and read-only.

Parameter interactions:

| `ref1` | `ref2` | `files` | Display target |
| --- | --- | --- | --- |
| omitted | omitted | omitted | working tree |
| omitted | omitted | present | listed files |
| present | omitted | omitted | diff against ref |
| present | present | omitted | ref range |
| present | present | present | ref range, listed files |

#### `git_delete_branch`

Compact row:

```text
Git delete  feature/ui                            deleted
```

Human detail: branch name, deletion status, errors.

Grouping: never group.

#### `git_log`

Compact row:

```text
Git log     main                                  10 commits
```

Human detail: commit table with short SHA, message, author, date.

Grouping: groupable when successful.

### Plan And Stage Artifact Tools

Plan tools are operationally central. Read-only plan queries may be grouped; writes must stay visible.

#### `plan_get`

Compact row: `Plan  active plan  5 stages` or `Plan  active plan  no plan`.

Detail: stage table, current stage highlighted, raw plan metadata if present.

Grouping: groupable as plan read.

#### `plan_get_stage`

Compact row: `Plan stage  G2  found`.

Detail: stage objective, expected outcomes, acceptance criteria, status/history source.

Grouping: groupable as plan read.

#### `plan_get_current_stage`

Compact row: `Current stage  G2  active` or `Current stage  none`.

Detail: current stage card with objective and criteria.

Grouping: groupable as plan read.

#### `plan_set_stages`

Compact row: `Plan  replace stages  6 stages`.

Detail: new stage list, current stage, stage IDs, objectives, acceptance criteria counts.

Grouping: never group.

#### `plan_add_stage`

Compact row: `Plan  add G7  objective...`.

Detail: full stage card.

Grouping: never group.

#### `plan_remove_stage`

Compact row: `Plan  remove G7  removed`.

Detail: stage id, result, error if not found.

Grouping: never group.

#### `plan_set_current`

Compact row: `Plan  current -> G7  set`.

Detail: previous current if result exposes it, requested current, note if null clears current.

Grouping: never group.

#### `plan_complete_stage`

Compact row:

```text
Plan stage  G7                                    completed
Plan stage  G7                                    failed
Plan stage  G7                                    escalated
Plan stage  G7                                    aborted
```

Detail:

- Result prominently toned.
- Summary paragraph.
- Actual outcomes list.
- Escalation object or abort reason when present.
- Link to stage run/artifacts when available.

Grouping: never group.

#### `plan_get_history`

Compact row: `Plan history  last 5  5 stages`.

Detail: history table with stage id, result, summary, timestamps if present.

Grouping: groupable as plan read.

#### `plan_init`

Compact row: `Plan  initialize  4 stages`.

Detail: initial stages.

Grouping: never group.

#### `plan_commit`

Compact row: `Plan commit  message...  committed`.

Detail: commit message and returned commit metadata.

Grouping: never group.

#### `plan_done`

Compact row: `Planner  complete  recorded`.

Detail: completion reason and evidence summary.

Grouping: never group. This is terminal and should be prominent.

#### `stage_write_tasks`

Compact row: `Stage tasks  G7  5 tasks`.

Detail: task list table with task id, objective, assigned role if present, acceptance criteria count.

Navigation: persisted `.saivage/stages/<stage-id>/tasks.json` if returned by result or inferable.

Grouping: never group.

#### `task_write_report`

Compact row: `Task report  task-3  completed`.

Detail: status, summary, evidence, issues, files touched, persisted path if returned.

Grouping: never group.

#### `stage_write_summary`

Compact row: `Stage summary  G7  completed`.

Detail: result, summary, task counts, outcomes, issues, escalation.

Grouping: never group.

#### `stage_get_run`

Compact row: `Stage run  G7  loaded`.

Detail: reconstructed aggregate summary: tasks count, reports count, summary presence, stage status.

Grouping: groupable as plan/stage read.

#### `stage_list_reports`

Compact row: `Stage reports  G7  4 reports`.

Detail: report list with task ids, agent roles, statuses, paths if present.

Grouping: groupable as plan/stage read.

### Dispatch Tools

Dispatch rows are first-class narrative events and should never be grouped.

Common dispatch compact grammar:

```text
Manager     stage G7                              completed
Coder       task-3                                completed
Researcher  task-4                                failed
Data Agent  task-5                                completed
Reviewer    task-6                                issues found
Designer    task-7                                completed
Critic      task-8                                actionable issues
Inspector   auth flow                             returned
Librarian   rag drift                             returned
```

Common dispatch detail:

- Request card: stage/task/request id, objective or scope, parent stage id, files, instructions, acceptance criteria, references.
- Result card: status/result, summary, failure reason, evidence, issues, actual outcomes, recommendations.
- Links: child conversation if available, report artifacts if present, files from task/report evidence.
- Raw payload toggle.

Current runtime results may not expose child agent or child conversation IDs. In that case, the detail should omit child-conversation navigation entirely and rely on the returned report summary, evidence, issues, and artifacts. Do not show a dead or disabled child-conversation link. Adding stable child references is a separate server/API enhancement.

Tool-specific notes:

| Tool | Compact action | Target | Detail emphasis |
| --- | --- | --- | --- |
| `run_manager` | `Manager` | stage id and objective | stage decomposition and StageSummary |
| `run_inspector` | `Inspector` | scope | findings and recommendations |
| `run_coder` | `Coder` | task id and objective | files changed, tests, TaskReport |
| `run_researcher` | `Researcher` | task id and objective | sources, findings, research artifacts |
| `run_data_agent` | `Data Agent` | task id and objective | data sources, downloaded artifacts, validation |
| `run_reviewer` | `Reviewer` | task id and objective | issues, acceptance criteria validation |
| `run_designer` | `Designer` | task id and objective | produced design artifacts and decisions |
| `run_critic` | `Critic` | task id and objective | critique findings and required changes |
| `run_librarian` | `Librarian` | objective or collection | RAG policy/drift report and memories written |

Dispatch detail should be the main path for understanding child-agent work. Raw JSON should be secondary. Child conversation navigation is lateral and should be a visible link when the runtime exposes the needed ID.

### Skill Tool

#### `skill`

Purpose: list available skills or load one skill by name.

Compact row:

```text
Skills      list                                  12 skills
Skill       build-web                             loaded
```

Human detail:

- List case: skill table with name, status, description.
- Read case: name, description, redacted body preview.
- Error: not found or unauthorized.

Grouping: groupable as context when successful.

Parameter interactions:

| `name` | Behavior | Display |
| --- | --- | --- |
| omitted/blank | list skills | `Skills list` |
| present | read one active skill | `Skill <name>` |

### Memory Tools

Memory tools are important because they affect future agent context. Reads may be grouped; writes should stay visible.

#### `create_memory`

Compact row: `Memory  create <topic>  created`.

Detail: topic, keys, scope, scope_ref, target agents, body preview, reason, expiration/survival flags. Render the structured topic as `domain/subject` plus an optional muted `aspect` chip; never stringify the whole topic object in the compact row.

Grouping: never group.

#### `update_memory`

Compact row: `Memory  update <id>  updated`.

Detail: id, changed fields, reason.

Grouping: never group.

#### `supersede_memory`

Compact row: `Memory  supersede <old_id>  replaced`.

Detail: old id, new record topic rendered as `domain/subject`, new body preview, and reason.

Grouping: never group.

#### `archive_memory`

Compact row: `Memory  archive <id>  archived`.

Detail: id and reason.

Grouping: never group.

#### `delete_memory`

Compact row: `Memory  delete <id>  deleted`.

Detail: id and reason. Use warning tone because hard deletion is destructive.

Grouping: never group.

#### `list_memories`

Compact row: `Memories  project/rag  8 records`.

Detail: filters and memory table.

Grouping: groupable as context when successful.

#### `get_memory`

Compact row: `Memory  <id or topic>  loaded`.

Detail: memory body, topic, keys, scope, supersession status.

Grouping: groupable as context when successful.

#### `search_memories`

Compact row: `Memory search  "rag drift"  5 matches`.

Detail: query, scope, limit, scored result table.

Grouping: groupable as context when successful.

### RAG Tools

RAG tools are primarily Librarian-facing. Read/query tools can group as context; admin/mutation tools must remain visible.

Permission and disabled-state errors are common for RAG. Any RAG tool can return authorization or disabled errors such as missing context, unauthorized role, or disabled service. The compact row should show the requested collection/action plus an error-tone status, and the detail should show the error code before any request facts.

#### `rag_list`

Compact row: `RAG  collections  6 collections`.

Detail: collection table with id, source, status, stats if returned.

Grouping: groupable as context.

#### `rag_stats`

Compact row: `RAG stats  docs  120 chunks`.

Detail: collection id, document/chunk counts, provider/chunker info, watch status.

Grouping: groupable as context.

#### `rag_query`

Compact row: `RAG query  docs  5 hits`.

Detail: collection id, query text, topK, filter, hit table with score, source, snippet.

Navigation: source file/URL links when result exposes them.

Grouping: groupable as context when successful.

#### `rag_register`

Compact row: `RAG register  docs  registered`.

Detail: collection id, source type, chunker, sources, exclusions, provider, persist/watch settings.

Grouping: never group.

#### `rag_ingest`

Compact row: `RAG ingest  docs  ingested`.

Detail: collection id, files/docs/chunks ingested, errors/skips.

Grouping: never group.

#### `rag_drop`

Compact row: `RAG drop  docs  dropped`.

Detail: collection id, persist flag, confirmation result. Warning tone by default.

Grouping: never group.

#### `rag_admin`

Compact row: `RAG admin  docs  reconcile`.

Detail: collection id, action, result.

Grouping: never group.

### Notes Tool

#### `create_note`

Purpose: chat creates Planner notes.

Compact row:

```text
Note        urgent                                created
Note        chat                                  created
```

Human detail:

- Content preview.
- Flags: urgent, permanent, channel, session id.
- Result: note id and path.
- Link: note JSON path under `.saivage/notes`.

Grouping: never group. Notes alter planner context and should stay visible.

### External MCP And Unknown Tools

External MCP tools should use a generic but still coherent display.

Compact row:

```text
External    service.tool                          returned
Tool        unknown_tool                          returned
```

Human detail:

- Facts: tool name, service if available, original name if available.
- Request summary: small key/value table of arguments.
- Result summary: best-effort text/table preview.
- Raw payload toggle.

Rules:

- Treat unknown tools as legitimate runtime events, not UI failures.
- Display the raw tool name prominently enough that operators can identify the MCP surface.
- Do not invent specific renderers for external tools without observed repeated use.
- If an external tool result contains file/URL-looking strings, do not automatically make all strings clickable. Only trusted structured fields or explicit `InlinePart` conversions should navigate.
- Namespaced collision names like `external-files_read` should display both public name and original name if available.

## Navigation Design

### Files

All file links should emit the existing `open-file` event with `{ path, root }`. Add optional line support when the file browser/editor can consume it:

```ts
{ path: string; root: "project" | "saivage"; line?: number }
```

Display rules:

- Compact rows may show basename or short path.
- Detail views must include the full path.
- Tooltips may show full path in compact rows.

### URLs

URL links use `target="_blank"` and `rel="noopener noreferrer"`. Compact rows should show hostname or shortened URL; details show full URL.

### Child Conversations

Dispatch tools should eventually link to child agent conversations. If the result payload does not currently expose child agent/conversation IDs, the UI should show the dispatch detail without a link and the runtime should add a stable child reference later.

Desired link shape:

```ts
{ kind: "conversation"; agentId: string; roundId?: string; label: string }
```

### Logs And Stash Files

Command log paths and webfetch stash paths are project files under `.saivage/`. They should open with `root: "saivage"` or project root depending on existing file browser expectations. The display model should not force a second overflow mechanism. Use the existing file viewer path.

## Accessibility

Requirements:

- Row button `aria-label` should include friendly action, raw tool name, status, and target.
- `aria-expanded` must reflect expansion state.
- Interactive links inside rows/details must stop propagation so they do not toggle the row.
- Raw payload controls must be keyboard reachable.
- Color cannot be the only status indicator; include text such as `failed`, `timeout`, `escalated`, `truncated`.
- Tables in details should use semantic table markup where practical.

## Performance

Performance rules:

- Build compact display models eagerly; they are small.
- Build heavy detail models only when a row or group is expanded.
- Render raw payload only when the raw toggle is opened.
- Cap previews for large text, command output, diffs, and webfetch content.
- Preserve existing stashed-result behavior and do not inline giant payloads.
- Memoize parsed request/result per pair by `toolUseId` and content identity during a render cycle.

## Testing Plan

Unit tests:

- `toolDisplay.test.ts`: every current canonical tool has a compact display model.
- `toolDetails.test.ts`: representative details for file, command, dispatch, plan mutation, memory, RAG, and error cases.
- `toolGrouping.test.ts`: adjacent grouping rules, never-group mutations, errors pulled out, deterministic IDs.
- `rawPayload.test.ts`: request/response raw strings preserved and lazy display state works.

Component tests:

- `ToolRow` renders action-target-status and toggles detail.
- Links inside row/detail navigate without toggling expansion.
- Raw payload toggle shows request and response tabs/states.
- Group rows expand to contained rows.

Focused visual/manual checks:

- Desktop and mobile row layouts.
- Long command row truncation.
- Long path truncation plus full path in detail.
- Error, pending, missing, orphan states.
- Stashed webfetch/command output.

Validation commands:

```bash
npm run typecheck
npm test
npm run build:web
```

If full test suites are too broad for an incremental UI-only change, run the new focused tests plus `npm run typecheck` and record unrun suites in the change summary.

## Implementation Phases

### Phase 1: Backend Contract Audit

Goal: verify the API/conversation data exposes everything the frontend needs. This phase does not have to block all frontend work: frontend compact-row and detail-renderer work can proceed with mocked fixtures, but any navigation or metadata feature that depends on backend fields must wait for this audit or use a documented conditional fallback.

Steps:

1. Audit `ConversationEntry` payloads for tool call, tool result, tool error, `toolName`, `toolUseId`, service metadata, timestamps, model metadata, and raw `content` preservation.
2. Add or document a canonical backend tool inventory source for built-in services and dispatch tools.
3. Verify result payloads for `run_command`, `webfetch`, stage artifacts, RAG, memory, and dispatch tools expose structured fields needed by the detail renderers.
4. Add child dispatch references to dispatch results if the runtime can identify child agents/conversations. If not implemented yet, explicitly document the current absence and keep frontend navigation conditional.
5. Ensure artifact-producing tools return paths when artifacts exist: command logs, stash files, saved webfetch files, notes, stage tasks/reports/summaries, and RAG artifacts.
6. Ensure external MCP tool entries preserve service name and runtime tool name; preserve original name on collision and description/schema metadata only when available.

### Phase 2: Replace Tool Vocabulary Coverage

Goal: no current tool falls through to generic because the web formatter only knows legacy names.

Steps:

1. Create `toolDisplay.ts` with a registry for every current canonical tool.
2. Port useful helper functions from `toolFormatters.ts`: parsing, truncation, pluralization, stash detection.
3. Add explicit compact display builders for all tools listed in this document.
4. Remove obsolete built-in formatter keys: `read_file`, `write_file`, `list_dir`, `search_files`, `web_search`, `fetch_url`, `fetch_page_text`, `download_file`, `download_with_fallbacks`.
5. Keep the generic fallback for future/external MCP tool names. Do not add legacy aliases.

### Phase 3: New Row Layout

Goal: compact rows read as action-target-status.

Steps:

1. Replace `ToolCallRow.vue` row internals with the new display model.
2. Use a computed property instead of calling `formatted()` repeatedly in the template.
3. Update desktop CSS to action-target-status.
4. Update mobile CSS to two-line row.
5. Preserve `aria-expanded`, timestamp title, and link click handling.

### Phase 4: Human Detail Panels

Goal: first click shows human-readable detail, not raw JSON.

Steps:

1. Add `toolDetails.ts` detail builders for core categories.
2. Add `ToolDetailPanel.vue` and `DetailSectionRenderer.vue`.
3. Wire `ToolCallRow.vue` expanded content to render detail model.
4. Add `RawPayloadToggle.vue` at the bottom of every detail.
5. Preserve old `FormattedContent` only as one renderer for markdown/text/code sections, not as the whole detail strategy.

### Phase 5: Grouping

Goal: reduce repetitive context noise without hiding causality.

Steps:

1. Add `toolGrouping.ts` after `entriesToTimeline` or in `AgentRoundCard.vue`.
2. Implement deterministic group IDs.
3. Add `ToolGroupRow.vue`.
4. Group only eligible adjacent successful read-only calls.
5. Add tests for every never-group category.

### Phase 6: Navigation Enhancements

Goal: lateral paths are explicit and reliable.

Steps:

1. Add optional line support to file `InlinePart` and open-file payload if the file viewer supports it.
2. Add child conversation link type and rendering once runtime exposes child IDs.
3. Normalize `.saivage` artifact links for logs, stash files, notes, and stage artifacts.

### Phase 7: Backend And Frontend Verification

Goal: finish quality and avoid backend/frontend contract regressions.

Steps:

1. Add focused backend tests in the owning backend test areas: conversation/schema tests for entry fields and raw payload preservation; MCP runtime tests for service/original-name metadata; dispatch/runtime tests for child references; plan/stage tests for artifact paths; RAG and memory handler tests for structured result/error shapes.
2. Add focused frontend tests for display registry completeness, detail rendering, grouping, navigation, and raw payload toggles.
3. Run typecheck and focused test suites.
4. Run web build.
5. Manually inspect representative conversations with dense context, failed command, dispatch, plan mutation, RAG query, memory write, external MCP/unknown tool, and raw payload toggle.

## Migration Notes

There is no need to preserve old built-in tool names in the display registry. Old runtime conventions have zero compatibility weight. The generic unknown-tool renderer exists for future and external MCP tools, not as a compatibility layer for removed Saivage tools.

The new design should not change server payloads in its first implementation. It can consume existing `ConversationEntry.content`, `toolName`, `toolUseId`, and status. Server enhancements, such as child conversation references for dispatch results, can be added later as typed payload improvements.

## Risks And Mitigations

| Risk | Mitigation |
| --- | --- |
| Over-grouping hides causality | Only group adjacent successful read-only calls; never group mutations, dispatches, errors, pending, missing, or orphan results |
| Human detail builders become too elaborate | Build simple category-level renderers first; raw payload covers edge cases |
| Raw JSON becomes hard to find | Use a consistent `Raw` affordance in the same location in every detail panel |
| Full paths overwhelm rows | Shorten in compact row; show full path in detail and tooltip |
| External tools need special handling | Keep generic external display until repeated real usage justifies a renderer |
| Large payloads slow the UI | Lazy-render details and raw payloads; cap previews; link to stash/log files |
| Current result schemas vary | Defensive parse, category fallback, and raw payload escape hatch |

## Acceptance Criteria

This change is complete when:

1. Backend raw tool request/result/error payloads remain preserved and reachable through conversation entries.
2. Backend exposes or documents the canonical current built-in/dispatch tool inventory used by frontend completeness tests.
3. Backend returns stable structured fields for artifacts, command logs, stash paths, saved webfetch files, stage artifacts, RAG/memory results, and dispatch results where those objects exist.
4. External MCP entries retain enough metadata for generic display that Saivage can control: service and runtime tool name always; original tool name on collision and schema/description when available from the MCP source.
5. Every current canonical tool listed in this document has an explicit compact display model.
6. Every current canonical tool has a human-readable detail strategy, even if generic within its category.
7. Raw request and response payloads are reachable from every expanded tool detail.
8. File and URL navigation still work.
9. Dispatch rows remain first-class and ungrouped, and child-conversation links render only when backend references exist.
10. Plan mutations, stage artifact writes, memory mutations, RAG admin/mutations, git mutations, filesystem mutations, notes, and errors are not grouped.
11. Read-only repetitive context calls can be grouped with deterministic expansion state.
12. Future/external MCP tools display through the generic unknown/external renderer without breaking the conversation view.
13. Desktop and mobile layouts remain readable.
14. Focused backend and frontend tests cover contract data, display registry completeness, grouping rules, navigation, and raw payload access.
15. Typecheck and relevant web/backend tests/build pass or any unrelated pre-existing failures are documented.
