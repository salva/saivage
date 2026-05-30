# Chat

[`src/agents/chat.ts`](https://github.com/salva/saivage/blob/main/src/agents/chat.ts),
[`prompts/chat.md`](https://github.com/salva/saivage/blob/main/prompts/chat.md)

The Chat agent is the **user-facing interface**. One instance runs per channel
+ session — one for each connected web UI tab and one per Telegram user.

## Purpose

User-facing interface for queries, status updates, and steering.

## Lifecycle

One Chat instance per channel (web UI, Telegram, etc.). Multiple channels can
be active simultaneously.

## Inputs

- User messages (via web UI or Telegram)
- System events (stage completions, failures, inspector results)

## Outputs

- Responses to user queries
- **User notes** (`.saivage/notes/<note-id>.json`) — forwarded to Planner for
  consideration
- Push notifications for significant events on the active channel
- **Chat logs** (`.saivage/tmp/chats/<channel>/<session-id>.json`) — complete
  dialogue history saved to disk

## Capabilities

- Read project state (plan, stage, tasks, files) — read-only.
- Stream LLM responses back to the channel.
- Push runtime events (system events filtered through subscription).
- Create user notes (`create_note`) with optional `permanent` / `urgent`
  flags.
- Handle local slash commands before LLM turns (`/status`, `/plan`,
  `/history`, `/replan`, `/restart-planner`, notes, skills, and memories).

It **cannot** write to project source, modify the plan, or execute shell
commands.

## Behaviors

- Can inspect: active plan, current stage, task list, task reports, inspector
  reports.
- **Does not stop execution** unless user explicitly requests
  replan/pause/stop.
- Creates notes for the Planner when user provides direction or feedback. To
  request an investigation, Chat creates a note (with `urgent: true` if it
  must interrupt the active chain); only the Planner dispatches the
  Inspector.
- Pushes notifications to user for:
  - Stage completion
  - Unexpected errors (Manager/Planner handling failures)
  - Inspector report completion events
- Notifications are **fire-and-forget** — no response is required. They
  remain in the chat history so the user can ask follow-up questions about
  them later.
- User can configure notification filters (opt-out of categories, severity
  thresholds).
- All dialogues are **persisted to disk** so that the Chat agent maintains
  conversation continuity across user sessions. Chat logs are gitignored and
  not accessible to other agents — they exist for user-facing context only.

## Tools advertised

| Category | Tools |
|----------|-------|
| Filesystem (read-only) | `read_file`, `list_dir`, `search_files` |
| Git / skills (read-only) | `git_status`, `git_log`, `git_diff`, `list_skills`, `read_skill` |
| Web | `web_search`, `fetch_url`, `fetch_page_text` |
| Stash | `read_stash` |
| Notes | `create_note(content, permanent?, urgent?)` |

Plan/history/status and memory slash commands are handled by local command
code before the LLM turn; they are not Planner or Inspector dispatch tools.

## Channels

- **Web** —
  [`src/channels/websocket.ts`](https://github.com/salva/saivage/blob/main/src/channels/websocket.ts)
  — one Chat per connected client.
- **Telegram** —
  [`src/channels/telegram.ts`](https://github.com/salva/saivage/blob/main/src/channels/telegram.ts)
  — one Chat per Telegram user, allow-listed via `telegram.allowedUserIds`.

The `saivage inspect <project> <scope>` CLI command does not use a channel; it
constructs an `InspectorAgent` directly against the runtime (see
[`src/server/cli.ts`](https://github.com/salva/saivage/blob/main/src/server/cli.ts)).

## Notification subscription

Each Chat instance subscribes to the [Event Bus](../runtime/events) with a
filter derived from `notifications.filters` (project config or runtime
fallback). Events that pass the filter are streamed to the channel as system
messages.

## Concurrency with the execution hierarchy

Chat is **independent** of the Planner. It runs on the same Node.js event loop
but its tool calls do not block the Planner's progress. Chat does not receive
dispatch tools; deep-analysis requests are relayed to the Planner through
notes, and `/restart-planner` uses `PlannerControl` to request a fresh Planner
run.

## Sessions

Web sessions are identified by `chatSessionId` from `src/ids.ts`. Logs are
written to `.saivage/tmp/chats/<channel>/<sessionId>.json` for debugging — this
file is informational only.
