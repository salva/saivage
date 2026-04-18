# Saivage Web Board v2 — Feature Specification

## Overview

The Saivage web dashboard is the primary interface for monitoring, understanding,
and debugging an autonomous AI agent system. It must provide complete visibility
into project state, agent activity, planning, execution history, and internal
data structures — at a level comparable to the GitHub Copilot VS Code plugin's
conversation panels.

## Architecture

- **Frontend**: Vue 3 + Vite, single-page app, GitHub-style dark theme
- **Backend**: Fastify HTTP + WebSocket (server.ts)
- **Data**: JSON files in `.saivage/` read synchronously via `readDocOrNull`
- **Update strategy**: REST polling (4-8s) for state data; WebSocket for chat

## Navigation Structure

```
Header:  [Saivage v2] [Dashboard] [Plan] [Agents] [Files] [Debug]
```

### Tabs

| Tab | Purpose |
|-----|---------|
| **Dashboard** | Real-time overview: status, agents, current stage, queue |
| **Plan** | Full plan view: overview, stages, history |
| **Agents** | Agent conversation viewer (Copilot-style) |
| **Files** | Browse generated documents in `.saivage/` |
| **Debug** | Internal state, errors, raw data structures |

---

## Tab 1: Dashboard (existing — StatusPanel + ChatWindow)

Already implemented. Right sidebar with status, left panel with chat.

### Components
- **RuntimeBar**: status dot + label + uptime
- **StatsBar**: active / done / failed / queued counters
- **CurrentStage**: stage ID, objective, tags
- **ActiveAgents**: role-colored cards with elapsed time, task ID
- **StageQueue**: remaining stages list
- **CompletedHistory**: last 10 completed stages with result badges

No changes needed for this iteration.

---

## Tab 2: Plan (existing — PlanView)

Already implemented with Overview/Stages/History sub-tabs.

### Components
- **Overview**: project name, provider, objectives, plan summary, pipeline viz
- **Stages**: expandable stage cards with tasks, criteria, reports
- **History**: completed stages with summaries and outcomes

No changes needed for this iteration.

---

## Tab 3: Agents (NEW)

### Purpose
View all agent activity — currently-running and historical conversations.
Similar to GitHub Copilot's conversation panel in VS Code, showing the full
LLM conversation thread with tool calls, thinking, and results.

### Data Sources
- **Live agents**: `GET /api/state` → `active_agents[]`
- **Chat logs**: `GET /api/chats` → session list (NEW endpoint)
- **Chat detail**: `GET /api/chats/:sessionId` → full message history (NEW endpoint)
- **Task reports**: `GET /api/plan/stages/:id` → reports per agent task

### Layout
```
┌─────────────────────────────────────────────────────────────┐
│ [Active ▼] [Chat History ▼]                                 │
├────────────────┬────────────────────────────────────────────┤
│ Session List   │ Conversation Thread                        │
│                │                                            │
│ ▶ planner      │ [system] You are the Saivage planner...   │
│   47s running  │                                            │
│                │ [assistant] I'll analyze the project...    │
│ ▶ manager      │                                            │
│   38s running  │ [tool_call] read_file(...)                 │
│                │ [tool_result] { content: "..." }           │
│ ─────────────  │                                            │
│ Chat Sessions  │ [assistant] Based on the analysis...       │
│                │                                            │
│ chat-abc123    │                                            │
│ 2m ago · 3 msg │                                            │
│                │                                            │
│ chat-def456    │                                            │
│ 15m ago · 12   │                                            │
└────────────────┴────────────────────────────────────────────┘
```

### Sub-features

**F3.1 — Active Agents Panel**
- List currently running agents from `runtime-state.json`
- Show: role (colored), agent_id, elapsed time, current_task_id
- Click to select → show live conversation in right panel (if available)

**F3.2 — Chat Session List**
- List all stored chat sessions from `/api/chats`
- Show: session_id (short), timestamp, message count, channel
- Sort: most recent first
- Click to load full conversation

**F3.3 — Conversation Thread Viewer**
- Display messages in a threaded view like VS Code Copilot:
  - **system**: gray background, smaller text
  - **user**: blue bubble, right-aligned
  - **assistant**: dark background, left-aligned
  - **tool_call**: collapsible code block showing function name + args
  - **tool_result**: collapsible code block showing result
- Messages show timestamp
- Auto-scroll-to-bottom option
- System event messages highlighted (escalation, stage_completed, etc.)

### New API Endpoints

```
GET /api/chats
→ { sessions: [{ session_id, channel, started_at, updated_at, message_count }] }

GET /api/chats/:sessionId
→ { session_id, channel, started_at, updated_at, messages: [...] }
```

**Implementation**: Scan `project.paths.chats` directory recursively,
read each JSON file, return metadata for list or full content for detail.

---

## Tab 4: Files (NEW)

### Purpose
Browse all generated documents and artifacts in the `.saivage/` directory.
Provides a file-tree view of the project's AI-generated content.

### Data Sources
- **Stage artifacts**: `.saivage/stages/<id>/artifacts/*`
- **Task reports**: `.saivage/stages/<id>/reports/*.json`
- **Stage summaries**: `.saivage/stages/<id>/summary.json`
- **Task lists**: `.saivage/stages/<id>/tasks.json`
- **Inspection reports**: `.saivage/inspections/*.json`
- **User notes**: `.saivage/notes/*.json`
- **Stash files**: `.saivage/tmp/stash/*.txt`

### Layout
```
┌─────────────────────────────────────────────────────────────┐
│ Files                                                        │
├────────────────┬────────────────────────────────────────────┤
│ 📁 stages/     │ File content viewer                        │
│  📁 stage-1/   │                                            │
│   📄 tasks.json│ {                                          │
│   📄 summary   │   "stage_id": "stage-1-project-audit",    │
│   📁 reports/  │   "result": "completed",                  │
│    📄 t1-...   │   "summary": "...",                       │
│   📁 artifacts/│   ...                                     │
│    📄 log.md   │ }                                          │
│  📁 stage-2/   │                                            │
│ 📁 inspections/│                                            │
│ 📁 notes/      │                                            │
│ 📁 stash/      │                                            │
└────────────────┴────────────────────────────────────────────┘
```

### Sub-features

**F4.1 — File Tree**
- Hierarchical tree of `.saivage/` contents
- Folders expandable/collapsible
- File type icons (JSON=blue, MD=green, TXT=gray)
- Click file to view content

**F4.2 — Content Viewer**
- JSON files: syntax-highlighted, pretty-printed
- Markdown files: rendered as HTML
- Text files: monospace pre-formatted
- Large files: truncated with "Show more" button

### New API Endpoints

```
GET /api/files?path=stages
→ { entries: [{ name, type: "file"|"dir", size?, modified? }] }

GET /api/files/content?path=stages/stage-1/summary.json
→ { path, content, size, type: "json"|"md"|"txt" }
```

**Implementation**: Read from `project.saivageDir` with path traversal
protection (must stay within `.saivage/`). Resolve relative paths only.

**Security**: Validate that resolved path is within `.saivage/` to prevent
directory traversal. Reject paths containing `..` or starting with `/`.
Never expose `auth-profiles.json`.

---

## Tab 5: Debug (NEW)

### Purpose
Platform debugging view showing internal data structures, errors,
raw runtime state, and system health — for developers troubleshooting
the Saivage platform itself.

### Layout
```
┌─────────────────────────────────────────────────────────────┐
│ [State] [Errors] [Config] [Timeline]                        │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│ State sub-tab:                                               │
│ ┌─ runtime-state.json ─────────────────────────────────────┐│
│ │ { status: "running", pid: 102814, ... }                  ││
│ └──────────────────────────────────────────────────────────┘│
│ ┌─ plan.json ──────────────────────────────────────────────┐│
│ │ { current_stage_id: "stage-4r1a3", stages: [...] }       ││
│ └──────────────────────────────────────────────────────────┘│
│ ┌─ plan-history.json ─────────────────────────────────────┐ │
│ │ { stages: [{ id: "stage-1", result: "completed" }, ...] }│ │
│ └──────────────────────────────────────────────────────────┘│
│                                                              │
│ Errors sub-tab:                                              │
│ ┌ stage-2a | escalated | Tooling/runtime mismatch ─────────┐│
│ │ reason: ...  remediation attempts: ...                   ││
│ └──────────────────────────────────────────────────────────┘│
│ ┌ t1-baseline | failed | ImportError in baseline runner ───┐│
│ │ failure_reason: ...  issues_found: [...]                 ││
│ └──────────────────────────────────────────────────────────┘│
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

### Sub-tabs

**F5.1 — State** (raw internal data structures)
- Show `runtime-state.json` as formatted JSON with live refresh
- Show `plan.json` as formatted JSON
- Show `plan-history.json` as formatted JSON
- Show `saivage.json` (runtime config)
- Show `config.json` (project config)
- Each collapsible, syntax-highlighted

**F5.2 — Errors** (aggregated error view)
- Collect all errors from:
  - Plan history: stages with `result === "failed" || "escalated"`
  - Task reports: tasks with `status === "failed"`
  - Stage summaries: `issues[]` arrays
- Show each error with: source (stage/task), severity, description,
  failure_reason, remediation attempts, timestamp
- Sort: most recent first

**F5.3 — Config**
- Display full `config.json` and `saivage.json` formatted
- Show provider, model overrides, failover chains
- Show notification filters, skills config

**F5.4 — Timeline** (event chronology)
- Merge events from all data sources into a single chronological feed:
  - Stage started/completed/failed (from plan-history)
  - Task completed/failed (from reports)
  - Escalations (from plan-history escalation objects)
  - Chat events (from chat logs with event fields)
- Each entry: timestamp, event type (icon+color), source, description
- Auto-refresh

### New API Endpoints

```
GET /api/debug/state
→ { runtime: {...}, plan: {...}, history: {...} }

GET /api/debug/errors
→ { errors: [{ source, type, severity, message, details, timestamp }] }

GET /api/debug/timeline
→ { events: [{ timestamp, type, source, description }] }
```

---

## New API Endpoints Summary

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `GET /api/chats` | GET | List all chat sessions with metadata |
| `GET /api/chats/:sessionId` | GET | Get full chat session messages |
| `GET /api/files` | GET | List files/dirs in `.saivage/` |
| `GET /api/files/content` | GET | Read a specific file's content |
| `GET /api/debug/state` | GET | All internal JSON state files |
| `GET /api/debug/errors` | GET | Aggregated errors from all sources |
| `GET /api/debug/timeline` | GET | Chronological event feed |

## New Vue Components

| Component | Tab | Purpose |
|-----------|-----|---------|
| `AgentsView.vue` | Agents | Session list + conversation thread viewer |
| `FilesView.vue` | Files | File tree + content viewer |
| `DebugView.vue` | Debug | State/Errors/Config/Timeline sub-tabs |

## Implementation Plan

### Phase 1: Backend APIs
1. Add `/api/chats` and `/api/chats/:sessionId` endpoints
2. Add `/api/files` and `/api/files/content` endpoints
3. Add `/api/debug/state`, `/api/debug/errors`, `/api/debug/timeline`

### Phase 2: Frontend — Agents tab
1. Create `AgentsView.vue` with session list + thread viewer
2. Add "Agents" tab to App.vue navigation
3. Style conversation messages (system/user/assistant/tool patterns)

### Phase 3: Frontend — Files tab
1. Create `FilesView.vue` with tree + content panels
2. Add "Files" tab to App.vue navigation
3. JSON syntax highlighting, markdown rendering

### Phase 4: Frontend — Debug tab
1. Create `DebugView.vue` with State/Errors/Config/Timeline sub-tabs
2. Add "Debug" tab to App.vue navigation
3. Error aggregation and timeline generation

### Phase 5: Build, Deploy, Verify
1. Build frontend (`cd web && npm run build`)
2. Build backend (`npx tsup`)
3. Deploy (`ssh saivage "sudo systemctl restart saivage"`)
4. Verify all tabs with Playwright
