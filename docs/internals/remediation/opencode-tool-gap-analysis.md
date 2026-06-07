# OpenCode Tool Gap Analysis

Date: 2026-06-07

## Context

OpenCode supports media returned by tools by carrying tool result `attachments` through the message conversion layer. When a provider cannot represent media directly inside a tool result, OpenCode injects a synthetic user message with text `Attached media from tool result:` followed by media/file parts. Saivage v2 now follows the same pattern for image attachments returned by tools.

## OpenCode Tool Inventory

Observed from `anomalyco/opencode` `dev` branch under `packages/opencode/src/tool/`:

- `apply_patch`: structured patch application.
- `edit`: targeted string replacement editing.
- `write`: create/overwrite files.
- `read`: read files/directories, including media/PDF attachment behavior.
- `glob`: fast file pattern matching.
- `grep`: regex content search.
- `shell`: command execution.
- `webfetch`: URL fetch; image responses return media attachments.
- `websearch`: web search.
- `lsp`: language-server diagnostics/navigation style tool.
- `task`: subagent delegation.
- `todo`: session task list maintenance.
- `question`: ask operator for structured choices.
- `skill`: load specialized skill instructions.
- `plan`: enter/exit plan mode helpers.
- `mcp-websearch`: MCP-backed web search integration.
- Supporting internals: `json-schema`, `truncate`, invalid-tool handling, shell helpers.

## Saivage v2 Current Equivalent Coverage

- File read/write/list/search: covered by `read_file`, `write_file`, `list_dir`, `search_files`. `read_file` supports UTF-8 text reads and OpenCode-style local image attachments via `response_format='attachment'`; PDF/file attachments are not yet implemented.
- Shell: covered by `run_command`, with runtime-owned logs.
- Web: covered by `web_search`, `fetch_url`, `fetch_page_text`, `download_file`, `download_with_fallbacks`, `head_url`; `fetch_url` now returns image attachments for image responses.
- Git: Saivage has more explicit git tools than OpenCode: `git_status`, branch, checkout, commit, merge, diff, delete branch, log.
- Subagents: covered by Saivage role-dispatch tools (`run_manager`, `run_coder`, etc.), not generic OpenCode-style arbitrary subagents.
- Skills/memory: covered by Saivage knowledge tools rather than a single OpenCode `skill` tool.
- Todo/planning: covered by Saivage plan/stage/task artifacts, but not by a lightweight session-local todo list.
- Operator question: not covered as a general MCP tool.
- LSP: not covered.
- Apply patch/edit: partially covered by `write_file` and shell, but lacks safer targeted edit/patch tools.

## Recommended Additions

### High Priority

1. `edit_file`

Saivage agents currently use `write_file` for all file changes, which encourages full-file rewrites. Add a targeted replacement tool similar to OpenCode `edit`: path, old_string, new_string, replace_all optional. This should enforce unique matches by default and use existing path authorization.

2. `apply_patch`

Add a structured patch tool for multi-file edits. This is safer than shelling out to ad hoc patch commands and gives the runtime a clear audit trail of changed paths. It should reject edits under disallowed territories before applying.

3. `read_file` PDF/file attachments

For PDF files and other provider-supported non-image files, return concise text metadata plus `attachments` instead of rejecting as binary. Local image attachment reads are implemented; this follow-up depends on provider-native file/PDF serialization rather than mapping every attachment to an image block.

4. `capture_screenshot`

Add a first-class browser screenshot tool backed by Playwright MCP or a lightweight Playwright call. Return an image attachment, viewport metadata, and page URL. This is the most important autonomous multimodal tool: the model can ask to inspect a UI visually.

### Medium Priority

5. `grep`-style content search separate from `search_files`

Saivage `search_files` matches file paths only. Add a content regex search tool with path include filters and bounded results. This reduces shell dependence and aligns with OpenCode/Codex ergonomics.

6. `glob`

A focused glob tool can coexist with `search_files`; useful if `search_files` remains path-recursive and policy-heavy. This is lower priority if `search_files` is enough.

7. `lsp_*` tools

Add diagnostics and symbol/navigation tools only after core edit/patch stability. Recommended starting set: `lsp_diagnostics`, `lsp_references`, `lsp_definition`, `lsp_rename_preview`.

8. `ask_operator`

A structured question tool could help manager/planner escalation and reduce free-text ambiguity. It should be role-limited and suspend the agent until answered.

### Lower Priority Or Defer

9. Generic `task` subagent tool

Saivage already has role-specific dispatch, which is more aligned with its architecture. A generic subagent would duplicate Manager/Planner dispatch unless explicitly scoped to research-only exploration.

10. OpenCode-style `todo`

Saivage stage/task artifacts are more durable and structured. A lightweight todo list is useful for chat/operator sessions, but less important for autonomous runtime execution.

11. Plan mode tools

Saivage has separate Planner/Manager roles and plan artifacts. OpenCode's plan mode is a UI/session mode; copying it directly would not fit v2 unless added as an operator chat feature.

## Implementation Notes

- Tool media should remain attachments, never base64 in plain text.
- Provider routing must skip non-image-capable providers when image blocks are present.
- Attachments should be bounded by MIME, byte size, and count per model call.
- The first provider implementation can be OpenAI-compatible; Anthropic/Pi/Copilot adapters should be added deliberately and tested with provider-native formats.
- Runtime should eventually prefer provider file IDs for repeated image use, but data URLs are acceptable for first-pass image fetch/screenshot support.
