# Board & Chat Functional Analysis — v2

## Current State

### Dashboard (StatusPanel)
- **Runtime bar**: Status dot + label + elapsed time. Works.
- **Stats bar**: 4 counters (active/done/failed/queued). Works.
- **Current Stage**: Card with ID, objective, tags. Clickable → Plan tab. Works.
- **Active Agents**: Cards with role, elapsed, task ID. Clickable → Agents tab. Works.
- **Stage Queue**: Vertical list with ID + objective. Clickable → Plan/Stages. Works.
- **Completed**: Shows last 10 history entries. **BROKEN**:  
  - Stage IDs not showing (field mismatch: `entry.stage_id` vs actual `entry.id`)
  - Click sends `undefined` as focusStageId, so navigation is a no-op
  - No summary text shown — just icon + result status
  - No indication of *what* was completed/escalated

### Chat (ChatWindow)
- Session tracking with session ID badge
- Thinking dots animation during LLM processing
- Markdown rendering for assistant messages (code blocks, bold, italic, headers, lists)
- History loading on reconnect
- **Missing**: No display of work events (stage transitions, task dispatches, agent activity)
- **Missing**: System messages appear as plain text with no visual distinction for event types

### Plan View
- Overview tab: Project info, pipeline visualization
- Stages tab: Expandable cards with tasks, reports, acceptance criteria
- History tab: Stage history with summary and actual outcomes
- **Bug**: Stage detail API (`/api/plan/stages/:id`) returns 500 for most stages due to strict Zod schema validation on task data that doesn't match (type "researcher" vs "research", missing fields)
- **Missing**: No way to distinguish active stages from history stages when navigating via cross-link

### Agents View
- Active agents list with role colors, elapsed time
- Chat history browser with full conversation threads
- **Working well**, no critical issues

### Files View
- Directory browser with breadcrumbs
- File content viewer with JSON highlighting
- **Working well**, no critical issues

### Debug View
- State/Errors/Timeline tabs with JSON highlighting
- Collapsible sections
- **Working well**

## Bugs Found

| # | Bug | Impact | Root Cause |
|---|-----|--------|------------|
| 1 | Completed section shows no stage IDs | High | Interface uses `stage_id` but API returns `id` |
| 2 | Completed click navigation broken | High | Sends `undefined` as stage ID |
| 3 | Stage detail API 500s for most stages | High | Strict Zod schema rejects real task data |
| 4 | No summary shown in Completed | Medium | Template only shows icon + result |

## Improvements Implemented

1. **Fix Completed section data binding** — use `entry.id` instead of `entry.stage_id`
2. **Show stage ID + summary** in Completed items  
3. **Fix stage detail API** — use `safeParse` to return raw data when schema fails
4. **Improve PlanView history** — when navigating to a history stage, switch to History tab and scroll to it
5. **Enrich chat** — show work/planning events with visual distinction
