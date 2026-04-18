# Saivage Web Board — Functional Specification

## Current State Analysis

### Architecture
- **Framework**: Vue 3 + Vite + Pinia (Pinia unused), dark theme (GitHub-style)
- **Backend**: Fastify HTTP + WebSocket, serves Vue SPA from `web/dist/`
- **Data flow**: REST polling (4-8s) for state/plan, WebSocket for chat only

### Critical Bugs
1. **Duplicate `<script setup>` blocks** in all three components — only the first
   block renders, everything below is dead code from v1 prototypes
2. **StatusPanel** mixes v1 (todos, `api/agents/:id/log`) and v2 (runtime state,
   plan stages) — v1 endpoints don't exist, so half the UI is invisible
3. **Agent cards** show only truncated agent IDs, no role labels or colors
4. **`current_stage_id`** mismatch — plan's `current_stage_id` is often `null`
   while `runtime-state.json` has it set; the board checks plan first

### API Endpoints Available
| Endpoint | Returns |
|---|---|
| `GET /health` | `{ status, version, project, runtime }` |
| `GET /api/state` | `{ state: RuntimeState, plan: Plan }` |
| `GET /api/plan` | `{ plan: Plan, history: PlanHistory }` |
| `GET /api/plan/stages/:id` | `{ stage_id, tasks, summary, reports }` |
| `GET /api/inspections` | `{ reports: InspectionReport[] }` |
| `WS /ws` | Chat messages (`{ type, content }`) |

### Data Model (from runtime-state.json)
```ts
RuntimeState {
  status: "idle" | "running" | "suspended" | "error"
  current_stage_id: string | null
  active_agents: AgentState[]  // agent_type, agent_id, status, current_task_id, started_at
  started_at: string
  updated_at: string
  pid: number
}
```

---

## Functional Requirements

### F1: Dashboard View (default tab)
The primary real-time monitoring view.

**F1.1 — Runtime Status Bar**
- Show system status (running/idle/error) with colored dot
- Show total uptime since `started_at`
- Show project name from health endpoint

**F1.2 — Summary Counters**
- **Active**: count of non-chat agents currently running
- **Done**: completed stages from plan history
- **Failed**: failed/escalated stages from plan history
- **Queued**: remaining stages in plan

**F1.3 — Current Stage Card**
- Source: prefer `state.current_stage_id`, fallback to `plan.current_stage_id`
- Display: stage ID (monospace, blue), full objective, tags
- Show stage progress if tasks are loaded (x/y tasks done)

**F1.4 — Active Agents List**
- Each agent card shows: **role** (colored label), elapsed time, task ID
- Role colors: planner=purple, manager=blue, coder=green, researcher=amber, inspector=orange
- Sort: planner first, then manager, then workers

**F1.5 — Stage Queue**
- List remaining plan stages with ID + truncated objective
- Current stage highlighted

**F1.6 — Completed History** (new — stage history section)
- Last 10 completed stages with result badge (✓/✗/⬆) and timestamp
- Expandable to see summary text

### F2: Plan View (second tab)
Structured view of the full plan.

**F2.1 — Overview sub-tab**
- Project name + objectives from config
- Plan summary: active stages count, completed count, last updated
- Stage pipeline: vertical timeline with dot markers

**F2.2 — Stages sub-tab**
- Expandable stage cards with: expected outcomes, acceptance criteria, references, tags
- Expanded view loads task list + reports from `/api/plan/stages/:id`

**F2.3 — History sub-tab**
- All completed stages with result, summary, actual outcomes, completion time

### F3: Chat Window
- WebSocket-based chat with the Saivage assistant
- Connection indicator (green/red badge)
- Message types: user (blue), assistant (dark), system (amber)
- Markdown rendering for assistant messages (stretch goal)

### F4: Layout
- Full-height viewport, header + main content
- Dashboard: chat (flex-1) + status panel (400px sidebar)
- Plan: full-width with sub-tabs

---

## Implementation Plan

### Phase 1: Clean up SFC files (remove dead code)
- Remove duplicate `<script setup>` blocks from all components
- Keep only the v2-compatible implementations
- Fix `current_stage_id` resolution logic

### Phase 2: Improve StatusPanel
- Add role label + color to agent cards
- Add stage history section
- Widen sidebar from 340px to 400px
- Improve agent card information density

### Phase 3: Improve PlanView
- Show project objectives from config endpoint
- Add config API endpoint to expose objectives/provider

### Phase 4: Add /api/config endpoint
- Expose project config (name, objectives, provider) to the frontend
