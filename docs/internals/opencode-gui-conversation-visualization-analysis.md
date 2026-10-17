# OpenCode GUI Conversation Visualization Analysis

This document analyzes how OpenCode's HTML-based GUI renders agent conversations and extracts design principles that Saivage can adapt for its operator UI. OpenCode is treated as a source of inspiration, not as a final UI specification. Saivage has different needs (multi-agent autonomy, plan lifecycle, diagnostics, raw JSON inspection, file navigation) that require a specific UI design of their own. The focus is compact, friendly, expandable tool-call visualization.

## Sources Reviewed

- OpenCode public source, `anomalyco/opencode` `dev` branch:
- `packages/ui/src/components/basic-tool.tsx`
- `packages/ui/src/components/basic-tool.css`
- `packages/ui/src/components/message-part.tsx`
- `packages/ui/src/components/message-part.css`
- `packages/ui/src/components/session-turn.tsx`
- `packages/ui/src/components/tool-count-summary.tsx`
- `packages/ui/src/components/tool-status-title.tsx`
- Saivage local source:
- `web/src/components/agents/AgentConversationPane.vue`
- `web/src/components/agents/AgentRoundCard.vue`
- `web/src/components/agents/ToolCallRow.vue`
- `web/src/components/agents/timeline.ts`
- `web/src/utils/toolFormatters.ts`
- `web/src/composables/useAgentConversation.ts`
- `web/src/api/types.ts`

## OpenCode Principles

OpenCode treats tool calls as operational metadata around the conversation, not as full conversation messages. The visible default state is a compact status row. The raw input, output, diff, or command result is secondary and is revealed only when the user asks for it.

The important design principles are:

- Use friendly verbs in Title Case, not raw tool names: `read` → `Read`, `grep`/`glob` → `Search`, `bash` → `Shell`, `edit`/`write` → `Edit`/`Write`, `task` → agent name, `apply_patch` → `Patch`. Saivage already has per-tool labels (`read`, `write`, `ls`, `find`, `$`, `git status`, etc.) but they are lowercase and abbreviated; the OpenCode convention is capitalized proper nouns. Either style works for compactness; the point is to avoid exposing internal tool names verbatim.
- Show one salient argument by default: file basename, search pattern, URL, shell description, task description, or count of changed files.
- Keep rows inline and low height: tool rows are single-line triggers with ellipsis behavior, not cards unless the tool is unusually important.
- Make expansion explicit: the row is a collapsible trigger; details are hidden behind a chevron/arrow and are mounted lazily for heavy content.
- Hide low-value tools entirely when they do not help reading the timeline: OpenCode hides `todowrite` from normal message rendering.
- Group repetitive context gathering: sequential `read`, `glob`, `grep`, and `list` calls are collapsed into one `Gathered context` row with animated counts, such as reads, searches, and lists. Expanding the row shows each individual context tool.
- Distinguish status from details: pending/running tools shimmer or show active text; completed tools show stable labels; errors use an error card or error tone.
- Defer expensive rendering: `BasicTool` supports `defer`, delayed mounting, animated height, and collapsible content to avoid rendering heavy diffs or outputs until needed.
- Treat edits/diffs specially: edit/write/patch tools can default-open only when configured; final turn diffs are summarized separately as a changed-files section.
- Preserve conversation readability: user and assistant text get primary layout treatment. Tool calls visually sit between text blocks with small typography and restrained color.

## OpenCode Structure

OpenCode's `BasicTool` is the generic primitive. It takes an icon, structured trigger title, optional subtitle, optional args, status, and children. If details exist and are not hidden, it renders a collapsible arrow. The title is the human-readable action, the subtitle is the primary target, and args are at most a few short fields.

OpenCode's `getToolInfo` (equivalent to Saivage's `toolFormatters.ts`) translates raw tool names and inputs into this compact display model. OpenCode also has a `GenericTool` component for unknown tools that renders `Called {toolName}` as the title with the first interesting argument as subtitle, and remaining args as secondary tags. Saivage's `genericFormatter` does a similar job but outputs truncated JSON. Examples of OpenCode's explicit mappings:

- `read`: title `Read`, subtitle file basename.
- `list`: title `List`, subtitle directory basename.
- `glob` and `grep`: title as search action, subtitle pattern or directory.
- `webfetch` and `websearch`: title as web action, subtitle URL/query.
- `task`: title as an agent label, subtitle task description, with possible session link.
- `bash`: title `Shell`, subtitle the tool-provided description rather than the full command.
- `edit`, `write`, `apply_patch`: title as edit action, subtitle file or file count.

OpenCode's `groupParts` and `ContextToolGroup` collapse consecutive context tools into one aggregate row. This is a strong pattern for screen-space economy: a long burst of reads and searches becomes one line. When expanded, individual context tools still use compact rows.

OpenCode's default rendering also imposes strong information hierarchy. Text parts are full-width Markdown; reasoning is muted; context-gathering is summarized; edits and outputs are expandable; final changed files are summarized after the turn.

## Saivage Current State

Saivage already has much of the foundation needed for an OpenCode-style approach.

`entriesToTimeline` groups raw conversation entries into rounds, pairs `tool_call` with `tool_result`/`tool_error` by `toolUseId`, marks in-flight tools pending, and separates reasoning, diagnostics, context, and tool pairs.

`ToolCallRow.vue` already renders a one-line, clickable tool row with:

- A chevron.
- A compact label.
- A formatted input summary.
- A formatted result summary.
- An expandable detail body containing raw input and raw result rendered via `FormattedContent`.

`toolFormatters.ts` already converts many Saivage tools into compact labels and summaries. It intentionally surfaces one useful field and discards operational noise. Examples include `read`, `write`, `ls`, `find`, `$`, `git status`, `git diff`, `plan`, `→ coder`, `→ reviewer`, and `read_stash`.

The main gap is not basic collapse behavior—Saivage already has that—nor is it friendly labels or per-tool formatting. The gap is hierarchy and density: all tool pairs still render as individual rows, including repetitive context gathering, dispatch/runtime tools, and low-value operational details. The rows use a four-column grid (`chevron | label | summary | result`, declared at `ToolCallRow.vue:107`) that displays both input and result inline by default. OpenCode's trigger row is narrower: it shows a structured title+subtitle inside a single flex row without a dedicated result column; the result is shown only when status demands it (e.g., an error or a pending spinner), not as a persistent inline column.

## Adaptation Opportunities

Saivage should keep its current round-based architecture, but add one more level of semantic compression before rendering tool rows.

Recommended adaptations:

- Add a `ToolDisplayModel`: `{ category, title, subtitle, args, result, tone, detailKind }` generated by `toolFormatters.ts` or a new adjacent module.
- Add a `ToolDetailModel`: `{ request: HumanReadableDetail, response: HumanReadableDetail, links: DetailLink[] }` generated alongside the display model. `HumanReadableDetail` is a structured representation tailored per tool type (file preview, command output block, dispatch summary, diff, etc.), not a raw JSON dump. `DetailLink` entries are lateral navigation targets (file paths, URLs, child conversations). The raw JSON escape hatch is not per-tool — it is a single shared `<RawPayloadToggle>` component that renders the untouched request/response payload with syntax highlighting, lazy-mounted and only instantiated when the user explicitly activates it.
- Use friendly action names consistently: prefer `Read`, `Search`, `Shell`, `Patch`, `Commit`, `Plan`, `Coder`, `Reviewer` over raw internal tool names in the visible row. Saivage already does this for many tools; the remaining gap is ensuring unknown tools also get a friendly label rather than showing their `tool-formatters` generic JSON dump.
- Make the default row read as one sentence: `Read package.json · 120 lines`, `Search "AgentRoundCard" · 3 matches`, `Shell typecheck · exit 0`, `Coder task-123 · completed`.
- Collapse consecutive context tools into an aggregate row: `Gathered context · 4 reads, 2 searches, 1 list`. Expansion reveals the existing individual `ToolCallRow`s.
- Consider hiding or demoting low-value operational tools: plan getters, stash reads, and routine status checks can be grouped or muted unless they fail.
- Keep errors always visible enough: failed tools should stay as individual rows or be pulled out of collapsed groups with red/error tone.
- Split the expanded detail into a formatter-driven, human-readable view (the primary click target) and a universal raw-JSON escape hatch (a lightweight toggle within the detail). The current `agent-tool-detail` block renders `FormattedContent` on the raw `content` field — the formatter view should be intentionally designed per tool type, not just the raw field decorated with markdown rendering.
- Add lazy rendering for both the formatter-driven detail and the raw-JSON toggle: only instantiate when their expansion state is active. The existing `v-if="open"` covers the detail; the raw toggle needs its own conditional. Cache the `formatted()` call in a computed property so it does not re-run on every render.
- Prefer basename plus tooltip/full detail: OpenCode commonly shows the file basename and relies on context or expansion for the full path. Saivage currently shows full paths, which can dominate rows.
- Separate final artifacts from execution chatter: edited files, committed hashes, generated reports, and plan changes can get a turn-level summary row after the relevant round.

## Proposed Saivage UI Model

Saivage can implement an intermediate timeline shape without changing the API payload:

```ts
type ToolTimelineItem =
  | { kind: "tool"; pair: ToolPair; display: ToolDisplayModel }
  | { kind: "tool_group"; id: string; label: string; summary: ToolGroupSummary; pairs: ToolPair[]; status: ToolPairStatus };
```

`entriesToTimeline` can continue pairing calls and results. A second pass can group adjacent `ToolPair`s by category:

- Context: `read_file`, `list_dir`, `search_files`, `read_stash` when used as context retrieval.
- Shell: repeated safe inspection commands, if they have non-error results.
- Git: `git_status`, `git_log`, `git_diff` when they are adjacent and non-error.
- Plan: `plan_get`, `plan_get_current_stage`, `plan_get_history` when they are routine lookups.
- Dispatch: child agent calls can stay individual because they are semantically important.
- Errors: do not bury errors inside group summaries unless the group summary clearly shows the error count and expands automatically.

For the default row, prefer this visual grammar:

```text
Gathered context  5 reads, 2 searches                 ›
Read              package.json                         120 lines
Shell             typecheck                            exit 0
Coder             task-42 - fix auth flow              completed
Plan              stage G2                             updated
```

This is closer to OpenCode than the current four-column row because the user's eye reads action, target, outcome. It also avoids putting raw-ish command strings and full paths in the normal scan path.

## Coverage Analysis: What OpenCode Does Not Cover

OpenCode's UI is designed for a single-turn coding assistant where a human sends one message and the agent responds with tools plus text. Saivage is a multi-agent autonomous runtime where agents run for minutes or hours without human input. This fundamental difference means several Saivage concerns have no direct OpenCode equivalent and need their own UI treatment.

### Progressive disclosure and navigation

Both OpenCode and the current Saivage UI jump from a one-line summary directly to raw JSON. This skips the most useful intermediate: a human-readable explanation of what the tool call did. But prescribing exactly three fixed levels for every tool type would be over-featurism. The right approach is to start from use cases and let each tool type expose only the depth that is actually needed.

**Use cases and what they need:**

- *Monitoring an autonomous agent*: "What's it doing?" → The compact row is enough. `Shell typecheck · exit 0` tells you all you need without clicking anything.
- *Understanding what happened*: "What did this tool call do?" → Expand the row to see a human-readable detail. A file preview for `read_file`, terminal output for `run_command`, a diff for `write_file`, a stage list for `plan_set_stages`. This is the most common click.
- *Navigating somewhere*: "Open that file" / "See the child conversation" → Click a file path in the detail to open the editor. Click a dispatch link to navigate to a child agent's conversation. This is lateral navigation, not deeper disclosure — a different axis entirely.
- *Deep debugging*: "What exact payload was sent?" → Raw JSON. Needed rarely, and only by operators diagnosing subtle failures.

**Depth axis — what each tool type naturally needs:**

Most tools need two depth levels (compact row + human-readable detail). Raw JSON is an escape hatch, not a full per-tool UI layer:

| Tool type | Compact row | Expanded detail | Raw JSON needed? |
|-----------|-------------|----------------|-----------------|
| `read_file` | `Read package.json · 120 lines` | File path, line range, syntax-highlighted content preview | Rarely — the content preview IS the useful view |
| `run_command` | `Shell typecheck · exit 0` | Command, working directory, exit code, scrollable terminal output | Rarely — terminal output is the useful view |
| `write_file` | `Write auth.ts · +42/−7` | Diff view, with clickable file paths | Rarely — the diff is the useful view |
| `run_coder` | `→ Coder · fix auth flow · completed` | Objective, outcome, summary, link to child conversation | Almost never — the child conversation is what matters |
| `plan_set_stages` | `Plan · stage G2 · updated` | Stage list, transition description | Almost never |
| `search_files` | `Search "AgentRoundCard" · 3 matches` | Match list with clickable file+line links | Almost never |

Navigation axis — lateral paths from the detail view:

- File paths → open in editor (existing `open-file` event)
- URLs → open in browser (existing `window.open`)
- Dispatch rows → navigate to child agent conversation (a new navigation path, not a deeper level of the same row)
- Search matches → navigate to file+line (existing `InlinePart` of kind `"file"`)

**Design principle:** depth and navigation are separate. A user clicks a row to go deeper. A user clicks a link in the detail to go elsewhere. Don't conflate them.

**The raw JSON escape hatch:**

Raw JSON should be a single shared affordance — a small toggle or button within any tool's expanded detail that swaps the formatter-driven view with the raw request/response payload. It should not be per-tool-type design work. One generic `<RawPayloadToggle>` component, used everywhere, lazy-mounted, that renders the JSON with syntax highlighting. This avoids over-engineering while guaranteeing that all data is always reachable.

**What the current Saivage UI gets wrong:**

The current `ToolCallRow.vue` collapses depth and navigation into one thing. Expanding a row renders `FormattedContent` on the raw `content` field — the same data that the API returned, just formatted. There is no intentionally-designed human-readable detail view, and there is no path to raw JSON beyond what `FormattedContent` already shows. The redesign should:

1. Make the expanded detail a formatter-driven, human-readable view — not just the raw `content` field decorated with markdown rendering.
2. Add a lightweight, universal raw-JSON toggle for the escape hatch case.
3. Keep file/URL/dispatch links as navigation actions in the detail, not deeper disclosure.

### File navigation

Saivage's `ToolCallRow.vue` already emits `open-file` events with `{ path, root }` when users click `InlinePart` items of kind `"file"` or `"url"`. The `AgentConversationPane` and `AgentRoundCard` propagate these events up. OpenCode has a similar pattern in its file-link handling. Both systems need this; neither covers it without explicit wiring. A redesigned Saivage row should preserve clickable file and URL parts in both the compact row and the expanded detail. The `InlinePart` type system (`text`, `code`, `file`, `url`) in `toolFormatters.ts` already supports this.

### Multi-agent dispatch and hierarchy

OpenCode's `task` tool opens a sub-session, but the UI just shows a clickable link to that session. Saivage's `run_manager`, `run_coder`, `run_researcher`, `run_inspector` tools are first-class operations that return structured reports. The current `dispatch` formatter already gives them a clear label (`→ manager`, `→ coder`) and surfaces the objective and outcome. No OpenCode equivalent exists for this because OpenCode doesn't have persistent agent hierarchies. Saivage must design dispatch rows that convey: which agent, what objective, what outcome, and optionally a link to the child conversation. These should never be grouped or hidden.

### Long-running autonomous status

OpenCode shows a "thinking" shimmer when the model is processing. Saivage already shows `activity_status.pending_call` with in-flight/backoff state, attempt count, and retry timing. This is richer than what OpenCode provides and must be maintained. The current footer in `AgentConversationPane.vue` (lines 184-203) handles this.

### Plan lifecycle

OpenCode hides `todowrite` entirely. Saivage's plan tools (`plan_get`, `plan_set_stages`, `plan_add_stage`, `plan_complete_stage`, `plan_done`) manage durable runtime state. The `PlanView.vue` component already shows the plan tree separately. Tool rows for plan operations should not be hidden, but routine read-only queries (`plan_get`, `plan_get_current_stage`, `plan_get_history`) can be grouped. Mutations (`plan_set_current`, `plan_set_stages`, `plan_add_stage`, `plan_complete_stage`) should remain visible.

### Diagnostic entries

OpenCode has a compacted-entry marker that represents model issues. Saivage has `model_issue`, `model_repair`, and `model_recovered` conversation entries with their own tone and label system in `AgentConversationPane.vue` and `AgentRoundCard.vue`. These are already rendered as compact label + content rows. No change to their visibility is needed, but they should not be grouped with tool pairs.

### Stashed results

Saivage's `read_stash` tool and `[Result stashed … chars]` markers handle large outputs that were offloaded to disk. OpenCode truncates long outputs inline. Saivage's design is better for autonomous runs where operators need to know that a result exists and how large it is, even if they don't read it immediately. The stashed-result UX should be preserved in both the compact row (the `read_stash` formatter already shows line count and byte size) and the expanded detail.

## Differences To Respect

Saivage is not a single-turn coding assistant. It is a multi-agent runtime with planner, manager, executor, inspector, reviewer, and chat agents. This changes the right defaults.

Saivage should not hide delegation. Child-agent dispatch is central to the product and should remain visible as first-class rows, even if compact.

Saivage should keep round boundaries. OpenCode's session turn maps cleanly to one user request and assistant response; Saivage's rounds are model-call iterations inside long-lived agents. The current `AgentRoundCard` organization is useful and should remain.

Saivage should surface plan mutations more than OpenCode surfaces todos. Plan updates are durable runtime state. Reads of plan state can be grouped; writes to the plan should stay visible.

Saivage should keep diagnostics visible. Model repair/recovery information is operationally important in autonomous runs, though it can remain muted and compact.

Saivage must preserve access to all data through progressive disclosure with a dedicated escape hatch. The default row is concise (compact). Clicking it opens a human-readable, formatter-driven detail. Raw JSON is reachable via a lightweight, universal toggle within the detail view. No information is removed — only the default view is compact. Depth (more detail about this tool call) and navigation (open a file, jump to a child conversation) are separate axes and should not be conflated.

Saivage must preserve file and URL navigation. The current `InlinePart` system with `open-file` events for file parts and `window.open` for URL parts should be maintained in any redesigned row format.

## Implementation Sketch

Minimal implementation path:

1. Extend `toolFormatters.ts` with `category`, `title`, `subtitle`, and short `args` fields while preserving the existing `FormattedToolPair` fields for compatibility.
2. Add grouping in `AgentRoundCard.vue` or a small helper after `entriesToTimeline`, rather than changing server data.
3. Introduce `ToolGroupRow.vue` using the existing expansion set and rendering current `ToolCallRow`s inside its expanded body.
4. Convert `ToolCallRow.vue` from a four-column grid (`chevron | label | summary | result`) toward a more compact action-target-result row on desktop (with the result only shown on error, pending, or explicitly expanded), with mobile staying two-line.
5. Split the `ToolCallRow.vue` expansion into two parts: the primary expanded detail renders a `HumanReadableDetail` view built by each tool formatter; within that detail, a single shared `<RawPayloadToggle>` component provides access to the untouched JSON payload. The current `agent-tool-detail` block which renders `FormattedContent` on the raw `content` field should be replaced by the formatter-driven detail plus the raw toggle.
6. Add lazy rendering for both the detail and the raw toggle. The existing `v-if="open"` covers the detail; the raw toggle needs its own conditional. Cache the `formatted()` call in a computed property so it does not re-run on every render.
6. Add tests around grouping rules in `timeline.test.ts` or a new `tool-groups.test.ts`.

## Risks

- Over-grouping can hide causality. If a later assistant message refers to a specific tool result, users may need that row visible without extra clicks.
- Friendly names can become ambiguous when multiple agents use the same tool type. Internal tool names should remain in tooltips, `aria-label` attributes, or expanded details. Saivage's existing `aria-label="tool ${pair.toolName} ${pair.status}"` already preserves the raw name for accessibility.
- Hiding plan/status lookups could make autonomous behavior feel less transparent. Group routine reads, not writes or failures.
- Full paths matter in multi-project runtimes. If basename is used by default, full path must be available in tooltip, detail, or secondary text.
- Expansion state should be stable across polling refreshes. Group IDs must be deterministic from round ID and contained tool IDs.

## Recommendation

Saivage should adopt OpenCode's information hierarchy as inspiration — compact default rows, expandable details, context-tool grouping, lazy rendering — rather than copying OpenCode's component structure or defaulting to its single-turn assumptions.

The existing Saivage tool formatter and expandable row are already aligned with the core idea. The highest-value next steps, in order, are:

1. Add semantic grouping for repetitive context tools (the biggest screen-space win).
2. Convert default rows to a more compact action-target-result layout where the result column appears only on error/pending, not as a permanent inline column.
3. Design dispatch, plan-mutation, and diagnostic rows specifically for Saivage's multi-agent use case (no OpenCode equivalent exists for these).
4. Implement progressive disclosure: concise default row → human-readable formatter-driven detail on click. Raw JSON is available via a universal escape-hatch toggle, not a per-tool UI layer. Keep file/URL/dispatch navigation as lateral links within the detail, not deeper disclosure levels.

The target behavior should be: users can read the agent conversation as a narrative, with operational evidence compressed into one-line milestones. Clicking a row opens a human-readable detail tailored to that tool type; forward navigation (to files, child conversations, URLs) happens via links in that detail; raw JSON is always accessible via a lightweight toggle but never the default view. Depth and navigation are separate axes. The default view stays compact enough that dozens of tool calls do not dominate the screen. This is a Saivage-specific design problem, not an OpenCode port.
