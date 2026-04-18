# 14 — Layered Planning & Multi-Horizon Orchestration

**Replaces:** Spec 13 (Document-Driven Planning) — which defined flat planning docs.
This spec introduces a structured **three-tier planning hierarchy** with explicit state
tracking, user-driven replanning at any level, and plan documents maintained as
version-controlled project files.

## 1. Problem

The current planning system has a single horizon: a flat TODO list of tasks generated
by an LLM planner from static objectives. Planning documents exist (objectives,
long-term plan, short-term plan, exploration, journal) but they are loosely structured
prose with no formal status tracking, no stage decomposition, and no mechanism to
propagate user changes across planning levels.

Specific weaknesses:

1. **No stage decomposition** — The long-term plan lists phases as prose, but stages
   are never formalized into trackable entities with status, tasks, and completion criteria.
2. **Flat task generation** — Tasks are generated ad-hoc from the full objective list.
   There's no structured connection between "which stage are we in" and "what tasks to
   generate."
3. **No scoped replanning** — User direction changes (`orch_replan`) regenerate the
   entire task queue without distinguishing whether the change affects the current task,
   the current stage, or the entire project direction.
4. **No progress tracking across levels** — Completion of tasks doesn't roll up into
   stage progress, which doesn't roll up into plan progress.
5. **Prose docs drift** — Planning documents can become inconsistent because they're
   free-form markdown updated by different LLM calls without structural constraints.

## 2. Solution: Three-Tier Planning Hierarchy

```
┌──────────────────────────────────────────────────────────┐
│                     MASTER PLAN                          │
│  Project vision, objectives, success criteria            │
│  Divided into ordered STAGES                             │
│  File: .saivage/planning/master-plan.md                  │
│  Updated: on user direction change, retrospective        │
├──────────────────────────────────────────────────────────┤
│                   STAGE PLAN (one active)                 │
│  Concrete goals for current phase                        │
│  Broken into TASKS with dependencies                     │
│  File: .saivage/planning/stages/stage-<N>.md             │
│  Updated: when all tasks done, or user redirects         │
├──────────────────────────────────────────────────────────┤
│                     TASKS                                │
│  Atomic units of work assigned to agents                 │
│  Tracked in orchestrator state (state.json)              │
│  Status: pending → in-progress → completed/failed        │
│  Created from stage plan, dispatched by scheduler        │
└──────────────────────────────────────────────────────────┘
```

### 2.1 Master Plan

The top-level strategic document. Contains:

- **Vision** — What the project aims to achieve (from config)
- **Objectives** — Measurable goals (from config, refined by retrospectives)
- **Success criteria** — How to know when we're done
- **Stages** — Ordered list of phases, each with:
  - `id`: sequential number
  - `title`: short name
  - `goal`: what this stage achieves
  - `status`: `pending` | `active` | `completed` | `skipped`
  - `entry_criteria`: conditions to start (usually: previous stage complete)
  - `exit_criteria`: conditions to consider it done
- **Iterative** — Whether to regenerate the plan when all stages complete (see §3.1)

The master plan is a structured markdown file with YAML frontmatter for machine-
readable stage metadata.

**File:** `.saivage/planning/master-plan.md`

### 2.2 Stage Plan

A detailed plan for one stage. Created when a stage becomes `active`. Contains:

- **Stage goal** — Restated from master plan
- **Approach** — Strategy and constraints
- **Tasks** — Ordered list with dependencies, each with:
  - `id`: unique within the stage
  - `title`: short description
  - `goal`: detailed description
  - `agent_type`: coder | researcher | executor
  - `depends_on`: list of task IDs within this stage
  - `status`: pending | in-progress | completed | failed | cancelled
  - `result`: outcome summary (filled on completion)
- **Notes** — Observations, blockers, decisions made during execution

Each stage plan is a separate file so history is preserved.

**File:** `.saivage/planning/stages/stage-<N>.md`

### 2.3 Tasks

The bottom tier. Tasks are the atomic work units that get dispatched to agents.
They live in the orchestrator's state.json (as `TodoItem`) and are also reflected
in the stage plan file for readability.

Tasks are dual-tracked:
- **state.json** — The source of truth for runtime status, assignment, retry count
- **stage plan file** — Updated after task completion/failure for human readability
  and LLM context

## 3. Planning Lifecycle

```
┌──────────────────────────────────────────────────────────┐
│                    INITIALIZATION                        │
│                                                          │
│  1. Read config.autonomy.objectives                      │
│  2. If no master-plan.md exists:                         │
│     a. LLM generates master plan with stages             │
│     b. Write master-plan.md                              │
│  3. Find first pending stage → set to active             │
│  4. If no stage plan exists for active stage:            │
│     a. LLM generates stage plan with tasks               │
│     b. Write stages/stage-<N>.md                         │
│  5. Import tasks from stage plan into state.json         │
└──────────────┬───────────────────────────────────────────┘
               │
               ▼
┌──────────────────────────────────────────────────────────┐
│                   EXECUTION LOOP                         │
│                                                          │
│  1. processQueue() picks pending tasks by priority       │
│  2. dispatchAgent() runs task                            │
│  3. On completion:                                       │
│     a. Mark task completed in state.json                 │
│     b. Update stage plan file with result                │
│     c. Append journal entry                              │
│     d. Check if all tasks in stage are done              │
│        → If yes: advance to next stage                   │
│  4. On failure:                                          │
│     a. Retry up to maxRetries                            │
│     b. If exhausted: mark failed, continue other tasks   │
│     c. If blocking: may trigger stage-level replan       │
└──────────────┬───────────────────────────────────────────┘
               │
               ▼
┌──────────────────────────────────────────────────────────┐
│               STAGE ADVANCEMENT                          │
│                                                          │
│  When all tasks in a stage are terminal                  │
│  (completed/failed/cancelled):                           │
│                                                          │
│  1. Evaluate stage exit criteria (LLM check)             │
│  2. If exit criteria met:                                │
│     a. Mark stage completed in master-plan.md            │
│     b. Activate next pending stage                       │
│     c. Generate stage plan for new active stage          │
│     d. Import new tasks into state.json                  │
│  3. If exit criteria NOT met:                            │
│     a. LLM generates remediation tasks                   │
│     b. Add to current stage plan                         │
│     c. Continue execution loop                           │
│  4. If NO more pending stages:                           │
│     a. If plan.iterative → regenerate master plan (§3.1) │
│     b. Otherwise → plan complete, stop                   │
└──────────────┬───────────────────────────────────────────┘
               │
               ▼
┌──────────────────────────────────────────────────────────┐
│                  RETROSPECTIVE                           │
│                                                          │
│  Triggered every N completed tasks (configurable):       │
│                                                          │
│  1. Read master plan + current stage plan + journal      │
│  2. LLM analyzes progress patterns                       │
│  3. May update:                                          │
│     - Master plan (adjust future stages)                 │
│     - Current stage plan (adjust remaining tasks)        │
│     - Exploration doc (new ideas)                        │
│  4. Append retrospective entry to journal                │
└──────────────────────────────────────────────────────────┘
```

### 3.1 Iterative Plan Regeneration

Some projects are inherently cyclic: research → implement → evaluate → repeat.
When a master plan is marked `iterative: true`, completing all stages does NOT
end the plan. Instead, the orchestrator generates a **new master plan** that
builds on the results of the previous cycle:

1. The LLM receives the previous plan's completed stages, task results, journal,
   and exploration ideas as context
2. It generates a new set of stages for the next iteration cycle
3. The plan version is incremented (v1 → v2 → v3...)
4. The first stage of the new plan is immediately activated

The `iterative` flag is determined by the LLM at initial plan generation based
on the project objectives. Objectives describing ongoing, cyclical processes
(continuous data collection, iterative model improvement, research cycles)
trigger `iterative: true`. One-shot projects with a definite end state get
`iterative: false`.

Regenerated plans inherit `iterative: true` from their predecessor.

## 4. User-Initiated Replanning

Users can change direction at any time via `orch_replan`. The orchestrator must
determine the **scope** of the change and replan at the appropriate level(s).

### 4.1 Replan Scope Detection

When a user submits a replan request, the orchestrator LLM evaluates the
scope of impact:

```
User request → LLM classifies scope:

  TASK-LEVEL    "Fix the test that's failing"
                "Use pytest instead of unittest"
                → Cancel/modify current tasks only
                → Stage plan unchanged, master plan unchanged

  STAGE-LEVEL   "Skip the test coverage work, move to documentation"
                "Add a performance benchmarking step to this phase"
                → Regenerate current stage plan
                → Master plan stages unchanged

  PLAN-LEVEL    "Change project focus from ML to data engineering"
                "Add a new phase for CI/CD setup"
                → Regenerate master plan stages
                → Current stage may be replaced
                → New stage plan generated
```

### 4.2 Replan LLM Prompt

The replan call provides the LLM with:
- The user's change request
- Current master plan (with stage statuses)
- Current stage plan (with task statuses)
- Currently running agents and their tasks
- Recent journal entries

The LLM returns a structured response:

```json
{
  "scope": "task" | "stage" | "plan",
  "reasoning": "Why this scope was chosen",
  "taskChanges": {
    "cancel": ["task-id-1"],
    "add": [{"goal": "...", "agentType": "coder"}],
    "modify": [{"id": "task-id-2", "goal": "updated goal"}]
  },
  "stagePlanUpdate": "full new stage plan markdown (if stage/plan scope)",
  "masterPlanUpdate": "full new master plan markdown (if plan scope)",
  "journalEntry": "what changed and why"
}
```

### 4.3 Replan Execution

1. **Task-level:** Cancel/add/modify specific tasks. Update stage plan file.
2. **Stage-level:** Cancel all pending tasks in current stage. Write new stage plan.
   Import new tasks. Running agents may be messaged or cancelled.
3. **Plan-level:** Cancel all pending tasks. Write new master plan. Mark current
   stage as `skipped`. Activate next appropriate stage. Generate new stage plan.
   Running agents are cancelled.

## 5. File Format

### 5.1 Master Plan (`master-plan.md`)

```markdown
---
version: 1
created: 2026-04-13
last_updated: 2026-04-13
active_stage: 2
iterative: false
---

# Master Plan

## Vision
{project description from config}

## Objectives
1. {objective 1}
2. {objective 2}
...

## Success Criteria
- {criterion 1}
- {criterion 2}

## Stages

### Stage 1: Understanding & Assessment
- **Status:** completed
- **Goal:** Understand codebase structure and current state
- **Entry criteria:** Project configured
- **Exit criteria:** Architecture documented, baseline established
- **Completed:** 2026-04-10

### Stage 2: Core Pipeline Reliability
- **Status:** active
- **Goal:** Get all core workflows running reliably
- **Entry criteria:** Stage 1 complete
- **Exit criteria:** All pipelines pass, tests green
- **Started:** 2026-04-10

### Stage 3: Test Coverage & Documentation
- **Status:** pending
- **Goal:** Improve test coverage and documentation quality
- **Entry criteria:** Stage 2 complete
- **Exit criteria:** 80% coverage, docs up-to-date

### Stage 4: Advanced Features
- **Status:** pending
- **Goal:** Explore new capabilities and research directions
- **Entry criteria:** Stage 3 complete
- **Exit criteria:** Defined per investigation
```

### 5.2 Stage Plan (`stages/stage-2.md`)

```markdown
---
stage: 2
title: "Core Pipeline Reliability"
status: active
created: 2026-04-10
last_updated: 2026-04-13
---

# Stage 2: Core Pipeline Reliability

## Goal
Get all core data pipelines and workflows running reliably with deterministic,
reproducible results.

## Approach
Work bottom-up: fix data imports first, then processing, then training pipeline.
Each task should be independently testable.

## Tasks

### Task 2.1: Fix SEC EDGAR import
- **Status:** completed
- **Agent:** coder
- **Result:** Fixed date parsing, added retry logic, tests pass

### Task 2.2: Fix EOD market data pipeline
- **Status:** completed
- **Agent:** coder
- **Result:** Standardized SQLite schema, added validation

### Task 2.3: SQLite schema validation
- **Status:** in-progress
- **Agent:** coder
- **Depends on:** 2.1, 2.2
- **Result:** (pending)

### Task 2.4: End-to-end smoke test
- **Status:** pending
- **Agent:** executor
- **Depends on:** 2.3

## Notes
- CNMV pipeline intentionally blocked (no committed snapshots)
- Using offline data only for reproducibility
```

### 5.3 Supporting Documents

These files continue to exist as semi-structured markdown:

| File | Purpose | Updated by |
|---|---|---|
| `exploration.md` | Future ideas, hypotheses | Agents + retrospective |
| `journal.md` | Timestamped log of work and decisions | Orchestrator + agents |

## 6. State Synchronization

### 6.1 Stage Plan → State.json (Import)

When a new stage plan is generated, its tasks are imported into `state.json`
as `TodoItem` entries:

```typescript
stageTask → TodoItem mapping:
  id:        "stage-{N}-task-{M}"  (predictable, stable)
  goal:      task.goal
  stageId:   N
  taskRef:   "Task {N}.{M}"
  status:    "pending" (or "blocked" if has unmet deps)
  priority:  1 (foreground)
  agentType: task.agent_type
  dependsOn: mapped task IDs
```

### 6.2 State.json → Stage Plan (Sync-back)

After task completion/failure, the stage plan file is updated:
- Task status field updated
- Result/error summary appended
- Last-updated timestamp in frontmatter bumped

This is a **write-through** operation — state.json remains the runtime authority,
the stage plan file is updated for human readability and LLM context.

### 6.3 TodoItem Changes

The `TodoItem` interface gains:

```typescript
interface TodoItem {
  // ... existing fields ...
  stageId?: number;     // Which stage this task belongs to
  taskRef?: string;     // Human-readable reference (e.g., "Task 2.3")
}
```

## 7. Orchestrator Changes

### 7.1 New: `PlanManager` (replaces `PlanDocsManager`)

Manages the three-tier hierarchy:

```typescript
class PlanManager {
  // Master plan
  readMasterPlan(): MasterPlan;
  writeMasterPlan(plan: MasterPlan): void;
  getActiveStage(): StageInfo | null;
  advanceStage(): StageInfo | null;

  // Stage plans
  readStagePlan(stageId: number): StagePlan;
  writeStagePlan(stageId: number, plan: StagePlan): void;
  updateTaskInStagePlan(stageId: number, taskRef: string, update: TaskUpdate): void;

  // Supporting docs
  appendJournal(entry: string): void;
  readJournalTail(lines: number): string;
  readExploration(): string;
  writeExploration(content: string): void;

  // Initialization
  isBootstrapped(): boolean;
  bootstrap(objectives: string[], description: string): Promise<void>;
}
```

### 7.2 Modified: Planning Cycle

The autonomous planner changes from "generate tasks from objectives" to:

1. Check if there's an active stage with pending tasks → do nothing (work exists)
2. If active stage has no pending tasks and all are terminal → advance stage
3. If no active stage → plan is complete (or generate master plan)
4. When generating tasks for a new stage, read master plan + previous stage
   results + journal for context

### 7.3 Modified: Replan

The `replan()` method changes from a flat "regenerate task queue" to the
scoped replanning described in §4.

### 7.4 Modified: Task Completion

`onAgentCompleted()` now also:
1. Updates the stage plan file with the task result
2. Checks if all stage tasks are terminal → triggers stage advancement
3. Stage advancement includes exit criteria check and next stage planning

### 7.5 New MCP Tools

```typescript
// Query the planning hierarchy
{ name: "orch_get_plan",     description: "Get master plan with stage statuses" }
{ name: "orch_get_stage",    description: "Get current stage plan with task statuses" }
```

These let the chat agent show users where things stand in the big picture.

## 8. LLM Prompts

### 8.1 Master Plan Generation

Called once at bootstrap or on plan-level replan:

```
You are planning a software project for autonomous AI agents to execute.

## Project
{config.project.description}

## Objectives
{config.autonomy.objectives}

## Instructions
Create a phased master plan. Each stage should be:
- Achievable in 5-15 tasks
- Independently valuable (the project improves even if we stop here)
- Ordered from most critical to least critical

Output a structured master plan with 3-6 stages. For each stage:
- title, goal, entry_criteria, exit_criteria

Format as markdown with the frontmatter and structure specified.
```

### 8.2 Stage Plan Generation

Called when a stage becomes active:

```
You are creating a detailed task plan for Stage {N}: {title}.

## Master Plan Context
{master plan — summarized: vision, objectives, completed stages, current stage}

## Previous Stage Results
{summary of previous stage's journal entries and outcomes}

## Current Stage
Goal: {stage.goal}
Exit criteria: {stage.exit_criteria}

## Project State
{list of files, recent git log, key directories — gathered by a quick scan}

## Instructions
Break this stage goal into 3-{maxTasksPerCycle} concrete, atomic tasks.
Each task must be achievable by a single agent in one session.
Specify dependencies between tasks.
Order from highest priority to lowest.

Output the stage plan as markdown with the structure specified.
```

### 8.3 Scoped Replan

```
The user wants to change direction. Determine the scope of this change.

## User Request
{replan requirements}

## Current Master Plan
{master plan with stage statuses}

## Current Stage Plan
{active stage plan with task statuses}

## Running Agents
{active agents and what they're working on}

## Instructions
1. Classify the scope: task | stage | plan
2. Explain your reasoning
3. Generate the appropriate changes

Respond with the JSON structure specified in §4.2.
```

## 9. Config Changes

```typescript
autonomy: {
  enabled: boolean;
  objectives: string[];
  planDocsPath: string;              // default: ".saivage/planning"
  retrospectiveInterval: number;     // default: 10
  maxTasksPerCycle: number;          // default: 5
  planningCooldownMs: number;        // default: 30000
  // Removed: no longer needed with structured planning
  // The planner doesn't free-associate tasks; it follows the stage plan
}
```

## 10. Migration from Spec 13

The transition from the current flat planning documents:

1. Existing `objectives.md` → seeded into master plan objectives
2. Existing `long-term-plan.md` → seeded into master plan stages
3. Existing `short-term-plan.md` → becomes the initial stage plan for the active stage
4. Existing `journal.md` → preserved as-is
5. Existing `exploration.md` → preserved as-is

The migration happens automatically on first boot after the upgrade:
- `PlanManager.bootstrap()` checks for legacy docs and converts them
- Legacy files are moved to `.saivage/planning/legacy/` for reference

## 11. Concurrency Rules

### 11.1 Coder Serialization

Only **one coder agent** may be active at any time. This prevents file-system
collisions when multiple agents try to edit the same codebase simultaneously.

Non-coding agents (researcher, executor, planner) may run in parallel with each
other and with the single active coder. The `maxConcurrentAgents` config still
applies as an overall ceiling.

| Agent type   | Max concurrent | Rationale |
|-------------|---------------|-----------|
| coder       | 1             | Avoids file collisions |
| researcher  | ∞ (up to max) | Read-only, no file writes |
| executor    | ∞ (up to max) | Runs commands, typically non-overlapping |
| planner     | 1             | Single planning context |

The scheduler enforces this: when selecting tasks to dispatch, it skips coder
tasks if a coder agent is already running. Coder tasks remain `pending` and are
dispatched as soon as the active coder slot frees up.

## 12. Invariants

1. **Exactly one active stage** at any time (or zero if plan is complete)
2. **Tasks only exist for the active stage** — no speculative task generation
3. **State.json is runtime truth** — stage plan files are write-through copies
4. **Replan scope is explicit** — every replan is classified before execution
5. **Stage advancement is validated** — exit criteria checked before moving on
6. **History is preserved** — completed stage plans are never deleted
7. **User changes propagate downward** — plan-level changes invalidate stages;
   stage-level changes invalidate tasks; task-level changes are local
8. **At most one coder agent runs at a time** — coding is serialized10. **Iterative plans are opt-in** — plan regeneration only happens when
   `iterative: true` is set in the master plan, determined by the LLM based
   on project objectives