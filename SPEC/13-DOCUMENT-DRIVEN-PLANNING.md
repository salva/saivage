# 13 — Document-Driven Autonomous Planning

## Problem

The current autonomous planner operates statelessly: each planning cycle sees only
a flat list of config objectives plus the last 20 completed / 5 failed task summaries.
This causes:

1. **No long-term memory** — the planner forgets strategic context between cycles.
2. **Repetitive planning** — generates variants of already-completed tasks.
3. **No learning** — no record of what worked vs what didn't.
4. **No progressive refinement** — objectives are static strings; no phased roadmap.
5. **No exploration tracking** — new ideas discovered during work are lost.

## Solution: Living Planning Documents

The orchestrator maintains a set of **living markdown documents** that persist across
planning cycles and provide rich context to every planning decision.

### Document Set

All stored in `{project.root}/.saivage/planning/`:

| Document | Purpose | Updated By |
|---|---|---|
| `objectives.md` | Project vision, goals, success criteria | Orchestrator (retrospective) |
| `long-term-plan.md` | Phased roadmap, milestones, dependencies | Orchestrator (retrospective) |
| `short-term-plan.md` | Current focus, ready tasks, blockers | Orchestrator (every planning cycle) |
| `exploration.md` | Future ideas, hypotheses, deferred work | Agents + Orchestrator |
| `journal.md` | What was tried, results, learnings | Agents + Orchestrator |

### Document Lifecycle

```
Bootstrap (first run)
  │
  ├─ Seed objectives.md from config.autonomy.objectives
  ├─ Generate initial long-term-plan.md (LLM call)
  └─ Create empty short-term-plan.md, exploration.md, journal.md
  │
  ▼
Planning Cycle (when queue is empty)
  │
  ├─ Read ALL planning documents
  ├─ Read recent task history
  ├─ LLM generates: tasks + short-term-plan update
  └─ Write updated short-term-plan.md, submit tasks
  │
  ▼
Task Completion
  │
  ├─ Orchestrator appends journal entry (task goal + result summary)
  └─ (Agent may have already written detailed journal entries via tools)
  │
  ▼
Retrospective (every N completed tasks)
  │
  ├─ Read ALL documents + full history since last retrospective
  ├─ LLM analyzes progress, identifies patterns
  ├─ Updates: long-term-plan.md, objectives.md (if needed)
  ├─ Appends retrospective summary to journal.md
  └─ Resets retrospective counter
```

### Agent Integration

All agents receive instructions in their initial prompt to:

1. **Update `journal.md`** — append what they tried, what worked/didn't, key findings.
2. **Update `exploration.md`** — add new ideas, hypotheses, or investigation lines
   discovered during work.

These are soft instructions ("when relevant, update..."), not hard requirements.
The orchestrator also writes journal entries from task results as a fallback.

## Config Changes

```typescript
autonomy: {
  // ... existing fields ...
  planDocsPath: string;           // default: ".saivage/planning"
  retrospectiveInterval: number;  // default: 10 (every N completed tasks)
}
```

## Planning LLM Prompt

The `generateTasks()` call now includes all planning documents as context:

```
## Planning Documents

### Objectives
{objectives.md content}

### Long-Term Plan
{long-term-plan.md content}

### Short-Term Plan
{short-term-plan.md content}

### Exploration
{exploration.md content}

### Recent Journal
{last ~50 lines of journal.md}

## Task History
{completed/failed tasks}

## Instructions
1. Based on the planning documents and history, decide what to work on next.
2. Generate 0-N concrete tasks as a JSON array.
3. Also provide an updated short-term plan (markdown).
4. Focus on end-to-end progress first, then iterative improvement.
```

## Retrospective LLM Prompt

```
## All Planning Documents
{full content of all 5 documents}

## Work Since Last Retrospective
{all completed/failed tasks with results}

## Instructions
Analyze the progress made. Consider:
1. Which objectives are advancing? Which are stalled?
2. What patterns do you see in failures?
3. Should the long-term plan be revised?
4. Are there new objectives or exploration lines to add?

Output a JSON object:
{
  "longTermPlan": "updated markdown...",
  "objectives": "updated markdown... (or null if no changes)",
  "exploration": "updated markdown... (or null if no changes)",
  "journalEntry": "retrospective summary markdown...",
  "analysis": "brief text summary of findings"
}
```

## Implementation

### New File: `src/orchestrator/planDocs.ts`

Manages reading, writing, and bootstrapping planning documents.

### Modified: `src/orchestrator/orchestrator.ts`

- `generateTasks()` → reads planning docs, includes in prompt, parses response
  with both tasks and short-term plan update.
- New `updateJournal()` → called on task completion/failure.
- New `maybeRetrospective()` → checks counter, runs retrospective LLM call.
- New `bootstrapPlanDocs()` → called on first start if docs don't exist.

### Modified: `src/agents/base.ts`

- `buildInitialPrompt()` → adds instructions about updating journal and exploration docs.

### Modified: `src/config.ts`

- Add `planDocsPath` and `retrospectiveInterval` to autonomy schema.
