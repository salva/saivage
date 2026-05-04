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

Three concrete channel implementations all use the same Chat agent:

- **Web** (`channels/websocket.ts`) — fastify WebSocket; one Chat per
  connected client; messages are JSON envelopes.
- **Telegram** (`channels/telegram.ts`) — grammy bot; one Chat per
  Telegram user; allow-listed via `telegram.allowedUserIds`.
- **One-shot CLI** (`channels/oneshot.ts`) — used by the `saivage inspect`
  command; the Chat is created, asked a single question, then disposed.

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
are written to `.saivage/tmp/chats/<sessionId>.json` for debugging; this
file is informational only.
