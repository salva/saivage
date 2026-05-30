# Planner

[`src/agents/planner.ts`](https://github.com/salva/saivage/blob/main/src/agents/planner.ts),
[`prompts/planner.md`](https://github.com/salva/saivage/blob/main/prompts/planner.md)

The Planner is the **top-level long-lived agent**. It runs from `bootstrap()`
until the project objectives are met (or the daemon shuts down).

## Purpose

Strategic long-term planning and course correction.

## Lifecycle

The Planner is a **long-lived agent** that persists for the entire project
run. It is the top-level agent — all other agents are invoked by the Planner
(directly or transitively) as tool calls. The Planner's LLM conversation is
**suspended** while subordinate agents run and **resumed** when their tool
calls return.

- **Spawned:** CLI `start` calls `runPlanner(runtime)`; server mode calls
  `runPlannerWithRecovery(runtime)`, which repeatedly starts Planner runs.
- **Suspended:** while a child (`run_manager`, `run_inspector`,
  `run_librarian`) is running.
- **Resumed:** when a child returns; new notes injected as a system message.
- **Compacted:** when context exceeds threshold; the plan MCP service is the
  authoritative state store, so compaction is safe.
- **Run exits:** on `plan_done`, abort/cancel, max compactions, LLM/runtime
  error, or the 15-nudge stall guard. `runPlannerWithRecovery()` decides
  whether to restart the Planner after that run exits.

When the conversation context grows too large (many stages completed), the
Planner performs a **context compaction**: it summarizes the conversation so
far into a condensed state and continues from there. The plan state managed by
the plan MCP service serves as the authoritative state, so compaction is safe.

## Inputs

- `ProjectConfig.objectives` (from config)
- Stage completion reports (returned by Manager tool calls)
- Issue escalations (returned by Manager tool calls with `result: "escalated"`)
- User notes (injected into context when Planner resumes)
- Inspector reports (returned by Inspector tool calls)
- Active plan and history (`plan.json`) — read via the
  [Plan MCP service](../mcp/plan-service).

## Outputs

The Planner mutates the plan via the Plan MCP service.

- **Active plan** (`plan.json`): ordered list of stages remaining to be done.
  Each stage has:
  - `id` — unique stage identifier
  - `objective` — what the stage should accomplish
  - `starting_points` — current state of affairs relevant to this stage
  - `expected_outcomes` — concrete, verifiable deliverables
  - `acceptance_criteria` — how to know the stage is done
  - `references` — list of document paths the Manager should read before
    planning tasks
  - `tags` — string array for skill matching (may be empty)
  - `started_at` — set once when the stage becomes current
- **Plan history** (`plan.json` `history` field): terminal stages (completed,
  failed, escalated, aborted) with their summaries, archived from the active
  plan via `plan_complete_stage()`.

Mutation tools used: `plan_init(stages)` on first run; `plan_set_stages`,
`plan_add_stage`, `plan_remove_stage`, `plan_set_current` for incremental
updates; `plan_complete_stage(stage_id, result, summary)` when a Manager
returns. The Plan MCP service writes `plan.json` atomically.

## Execution model

1. **Initial planning** — reads project objectives + current project state →
   calls `plan_init(stages)` via the plan MCP service.
2. **Stage dispatch** — calls `run_manager(stage)` as a tool. The Planner's
   conversation suspends.
3. **Stage result** — Manager returns `StageSummary` as the tool result;
   Planner resumes.
4. **Plan update** — calls `plan_complete_stage()` to archive the stage,
   updates remaining stages via `plan_set_stages()` if needed, picks next
   stage.
5. **Loop** — calls `run_manager(next_stage)` → goto 3.
6. At any point, can call `run_inspector(request)` as a tool for deep analysis.

User notes arriving while the Planner is suspended are queued and **injected as
additional context** when the Planner next resumes. The `urgent` flag marks a
note high-priority; it does not interrupt running work by itself. Explicit
Planner restart requests (`/replan` through `PlannerControl`) abort the current
Planner run and queue a restart directive. See
[abort & recovery](../runtime/abort-recovery).

## Behaviors

- Creates the initial plan via `plan_init(stages)` from project objectives and
  current project state.
- Updates the plan via `plan_complete_stage()` and `plan_set_stages()` after
  each stage completes (informed by Manager's summary returned as tool result).
- Handles escalations (tool result with `result: "escalated"`) by revising
  stages via `plan_add_stage()`, `plan_remove_stage()`, or `plan_set_stages()`.
- When something is not going as expected (repeated failures, stalled progress,
  escalations), the Planner **schedules a full retrospective** — calling the
  Inspector for deep analysis before deciding on corrective action.
- Schedules corrective/refactoring actions only when they unblock or accelerate
  progress toward objectives.
- Processes **user notes** injected into its context by the runtime.
  **Permanent notes** represent lasting adjustments to the project's direction
  — they serve as lightweight objective modifications and are preserved and
  factored into all future planning decisions. Volatile notes are processed
  once and deleted by the runtime after the Planner completes its next
  planning action. The Planner does not write to note files — acknowledgment
  and cleanup are runtime-managed.
- Calls the **Inspector** via tool call to analyze project state before making
  planning decisions.
- **Compaction-safe**: after compaction it re-reads `plan_get()` +
  `plan_get_history()` to recover strategic context.
- **No direct user dialogue**: user requests come in through Chat → notes.

## Tools advertised

| Category | Tools |
|----------|-------|
| Plan MCP | `plan_get`, `plan_get_stage`, `plan_get_current_stage`, `plan_set_stages`, `plan_add_stage`, `plan_remove_stage`, `plan_set_current`, `plan_complete_stage`, `plan_get_history`, `plan_init`, `plan_commit`, `plan_done` |
| Dispatch | `run_manager`, `run_inspector`, `run_librarian` |
| Filesystem | `read_file`, `list_dir`, `search_files` |
| Git | `git_status`, `git_log`, `git_diff` |
| Knowledge read | `list_skills`, `read_skill` |
| Stash | `read_stash` |

The Planner never writes project source code directly; mutations go through
the Manager.

## Result types

```ts
type PlannerPlanDone = {
  kind: "success";
  data: { completion: "plan_done"; summary: string };
};
```

Other exits use the shared `AgentResult` failure, abort, or escalation shapes.
`runPlanner()` resolves with `AgentResult`; `runPlannerWithRecovery()` restarts
after non-terminal exits and, in continuous-improvement mode, after
`plan_done`. CLI `start` maps the returned kind to exit codes (see
[CLI](/guide/cli)).
