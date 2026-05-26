# Chat

[`src/agents/chat.ts`](https://github.com/salva/saivage/blob/main/src/agents/chat.ts)
· spec [§2.6](https://github.com/salva/saivage/blob/main/SPEC/v2/00-AGENT-SYSTEM.md#26-chat)

The Chat agent is the **user-facing interface**. One instance runs per
channel + session — one for each connected web UI tab and one per Telegram
user.

## Capabilities

- Read project state (plan, stage, tasks, files) — read-only.
- Stream LLM responses back to the channel.
- Push runtime events (system events filtered through subscription).
- Create user notes (`create_note`) with optional `permanent` / `urgent`
  flags.
- Dispatch the Inspector (`run_inspector`).

It **cannot** write to project source, modify the plan, or execute shell
commands.

## Tools advertised

| Category | Tools |
|----------|-------|
| Plan MCP (read-only) | `plan_get`, `plan_get_stage`, `plan_get_history` |
| Filesystem (read-only) | `read_file`, `list_dir`, `search_files` |
| Notes | `create_note(content, permanent?, urgent?)` |
| Dispatch | `run_inspector` |

## Channels

- **Web** —
  [`src/channels/websocket.ts`](https://github.com/salva/saivage/blob/main/src/channels/websocket.ts)
  — one Chat per connected client.
- **Telegram** —
  [`src/channels/telegram.ts`](https://github.com/salva/saivage/blob/main/src/channels/telegram.ts)
  — one Chat per Telegram user, allow-listed via
  `telegram.allowedUserIds`.

The `saivage inspect <project> <scope>` CLI command does not use a
channel; it constructs an `InspectorAgent` directly against the runtime
(see
[`src/server/cli.ts`](https://github.com/salva/saivage/blob/main/src/server/cli.ts#L219-L252)).

## Notification subscription

Each Chat instance subscribes to the [Event Bus](./events) with a filter
derived from `notifications.filters` (project config or runtime fallback).
Events that pass the filter are streamed to the channel as system messages.

## Concurrency with the execution hierarchy

Chat is **independent** of the Planner. It runs on the same Node.js event
loop but its tool calls do not block the Planner's progress (with one
exception: an Inspector dispatch from Chat shares the global Inspector
queue with the Planner).

## Sessions

Web sessions are identified by `chatSessionId` from `src/ids.ts`. Logs
are written to `.saivage/tmp/chats/<channel>/<sessionId>.json` for
debugging — the per-channel directory is set in
[`src/agents/chat.ts`](https://github.com/salva/saivage/blob/main/src/agents/chat.ts#L98-L104)
and the `<sessionId>.json` filename in
[`src/agents/chat.ts`](https://github.com/salva/saivage/blob/main/src/agents/chat.ts#L398-L400);
this file is informational only.
