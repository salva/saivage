# Implementation Plan: Layered Planning (Spec 14)

## Overview

Replace the flat `PlanDocsManager` + ad-hoc `generateTasks()` with a structured
three-tier planning system: Master Plan → Stage Plans → Tasks.

**Estimated scope:** ~600-800 lines of new/modified code across 6 files.

---

## Phase 1: `PlanManager` core (replaces `PlanDocsManager`)

**File:** `src/orchestrator/planManager.ts` (new, replaces `planDocs.ts`)

### Types to define:
```typescript
interface StageInfo {
  id: number;
  title: string;
  goal: string;
  status: "pending" | "active" | "completed" | "skipped";
  entryCriteria: string;
  exitCriteria: string;
  started?: string;    // ISO date
  completed?: string;  // ISO date
}

interface MasterPlan {
  version: number;
  created: string;
  lastUpdated: string;
  activeStage: number | null;
  vision: string;
  objectives: string[];
  successCriteria: string[];
  stages: StageInfo[];
}

interface StageTask {
  ref: string;        // "Task N.M"
  title: string;
  goal: string;
  agentType: string;
  dependsOn: string[];  // refs within stage
  status: string;
  result?: string;
}

interface StagePlan {
  stageId: number;
  title: string;
  status: string;
  created: string;
  lastUpdated: string;
  goal: string;
  approach: string;
  tasks: StageTask[];
  notes: string;
}
```

### Methods:
1. `isBootstrapped(): boolean` — check for master-plan.md
2. `readMasterPlan(): MasterPlan` — parse YAML frontmatter + markdown
3. `writeMasterPlan(plan: MasterPlan): void` — serialize back
4. `getActiveStage(): StageInfo | null` — from master plan
5. `advanceStage(): StageInfo | null` — mark current done, activate next
6. `readStagePlan(stageId: number): StagePlan` — parse stage file
7. `writeStagePlan(stageId: number, plan: StagePlan): void`
8. `updateTaskInStagePlan(stageId, taskRef, update): void` — write-through
9. `appendJournal(entry: string): void`
10. `readJournalTail(lines: number): string`
11. `readExploration(): string`
12. `writeExploration(content: string): void`
13. `bootstrap(objectives, description): Promise<void>` — legacy migration + init

### Implementation notes:
- Parse YAML frontmatter with a minimal regex parser (no extra deps)
- Stage plan tasks are parsed from markdown H3 sections
- Write-through updates use simple regex replacement in the markdown

---

## Phase 2: TodoItem changes

**File:** `src/orchestrator/state.ts`

### Add fields:
```typescript
interface TodoItem {
  // ... existing ...
  stageId?: number;     // Which stage
  taskRef?: string;     // "Task 2.3" — human-readable
}
```

### Add backfill in `loadState()`:
- Default `stageId` and `taskRef` to undefined for existing todos

---

## Phase 3: Orchestrator integration

**File:** `src/orchestrator/orchestrator.ts`

### Remove:
- `PlanDocsManager` import and usage → replace with `PlanManager`
- `generateTasks()` — replaced by stage-plan-based task import
- `maybeAutoPlan()` — replaced by structured stage-based planning

### Add/modify:

1. **`initializePlanning(): Promise<void>`** (called from `start()`)
   - Check if bootstrapped
   - If not: call LLM to generate master plan, write it
   - Find/validate active stage
   - If active stage has no stage plan: generate it via LLM
   - Import stage tasks into state.json

2. **`importStageTasks(stagePlan: StagePlan): void`**
   - Convert stage tasks → TodoItem entries
   - IDs: `stage-{N}-task-{M}`
   - Set dependencies, agentType, stageId, taskRef
   - Only import tasks not already in state.json

3. **`checkStageCompletion(): Promise<void>`** (called from `onAgentCompleted`)
   - Check if all tasks for active stage are terminal
   - If yes: LLM evaluates exit criteria
   - If exit criteria met: advance stage, generate next stage plan
   - If not met: LLM generates remediation tasks, add to stage plan

4. **Modified `onAgentCompleted()`:**
   - Existing: mark completed, journal, prune, retrospective
   - Add: write-through update to stage plan file
   - Add: check stage completion

5. **Modified `onAgentFailed()`:**
   - Existing: retry logic, cascade-fail
   - Add: write-through update to stage plan file

6. **Modified `replan()`:**
   - Now does scoped replanning (task/stage/plan level)
   - LLM classifies scope from user request + current state
   - Executes appropriate level of change

7. **Modified `processQueue()`:**
   - Instead of calling `maybeAutoPlan()` when empty,
     calls `checkStageCompletion()` which handles advancement

### LLM prompt methods:
- `generateMasterPlan(objectives, description): Promise<MasterPlan>`
- `generateStagePlan(masterPlan, stageInfo, previousResults): Promise<StagePlan>`
- `evaluateExitCriteria(masterPlan, stagePlan): Promise<{met: boolean, remediation?: StageTask[]}>`
- `classifyReplanScope(request, masterPlan, stagePlan, agents): Promise<ReplanResult>`

---

## Phase 4: MCP tools

**File:** `src/orchestrator/mcpService.ts`

### Add tools:
- `orch_get_plan` — returns master plan summary with stage statuses
- `orch_get_stage` — returns current stage plan with task statuses

### Modify `orch_replan`:
- Now triggers scoped replanning (response includes scope classification)

---

## Phase 5: Chat agent updates

**File:** `src/agents/chat.ts`

### System prompt changes:
- Include current stage info in state summary
- Show master plan progress (completed/active/pending stages)

---

## Phase 6: Legacy migration

**In `PlanManager.bootstrap()`:**

1. Check for legacy files (`objectives.md`, `long-term-plan.md`, etc.)
2. If found: parse them to seed the master plan and initial stage plan
3. Move legacy files to `.saivage/planning/legacy/`
4. Generate proper structured files

---

## Execution Order

| Step | What | Depends on | Risk |
|------|------|------------|------|
| 1 | Types + PlanManager core (parse/write) | — | Low |
| 2 | TodoItem.stageId/taskRef fields | — | Low |
| 3 | Master plan generation LLM prompt | 1 | Medium |
| 4 | Stage plan generation LLM prompt | 1, 3 | Medium |
| 5 | importStageTasks() | 1, 2 | Low |
| 6 | initializePlanning() in start() | 1, 3, 4, 5 | Medium |
| 7 | Stage completion check + advancement | 1, 4, 5 | Medium |
| 8 | Write-through in onAgentCompleted/Failed | 1, 5 | Low |
| 9 | Scoped replan | 1, 3, 4 | Medium |
| 10 | MCP tools (orch_get_plan, orch_get_stage) | 1 | Low |
| 11 | Chat agent system prompt update | 10 | Low |
| 12 | Legacy migration | 1, 3, 4 | Low |

**Recommended implementation order:** 1 → 2 → 3 → 4 → 5 → 6 → 8 → 7 → 9 → 10 → 11 → 12

---

## Testing Strategy

- Unit tests for PlanManager (parse/write/round-trip)
- Unit tests for stage task import (mapping correctness)
- Integration tests: mock LLM responses for plan/stage generation
- Manual testing: deploy, verify planning cycle works end-to-end

---

## What NOT to change

- Scheduler (priority ranking, user idle gating) — unchanged
- Agent registry and agent types — unchanged
- SubAgent ReAct loop — unchanged
- Event bus, WebSocket protocol — unchanged
- Git branch management — unchanged
- Transcript persistence — unchanged
