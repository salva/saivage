# Planner

[`src/agents/planner.ts`](https://github.com/salva/saivage/blob/main/src/agents/planner.ts)
· spec [§2.1](https://github.com/salva/saivage/blob/main/SPEC/v2/00-AGENT-SYSTEM.md#21-planner)

The Planner is the **top-level long-lived agent**. It runs from
`bootstrap()` until the project objectives are met (or the daemon shuts
down).

## Lifecycle

- **Spawned**: by `runPlanner(runtime)` (CLI `start` and the server's
  background loop).
- **Suspended**: while a child (`run_manager`, `run_inspector`) is running.
- **Resumed**: when a child returns; new notes injected as a system message.
- **Compacted**: when context exceeds threshold; the plan MCP service is the
  authoritative state store, so compaction is safe.
- **Terminated**: only on plan completion, fatal failure, or shutdown.

## Inputs

- `ProjectConfig.objectives`
- Active plan and history (`plan.json`) — read via
  the [Plan MCP service](./plan-mcp).
- Stage summaries returned by `run_manager`.
- User notes (injected by the runtime — see [Notes](/guide/notes)).
- Inspection reports returned by `run_inspector`.

## Outputs

Mutates the plan via the Plan MCP service:

- `plan_init(stages)` on first run.
- `plan_set_stages`, `plan_add_stage`, `plan_remove_stage`,
  `plan_set_current` for incremental updates.
- `plan_complete_stage(stage_id, result, summary)` when a Manager returns.

The runtime then writes `plan.json` atomically.

## Tools advertised

| Category | Tools |
|----------|-------|
| Plan MCP | `plan_get`, `plan_get_stage`, `plan_get_current_stage`, `plan_set_stages`, `plan_add_stage`, `plan_remove_stage`, `plan_set_current`, `plan_complete_stage`, `plan_get_history`, `plan_init`, `plan_commit`, `plan_done` |
| Dispatch | `run_manager`, `run_inspector` |
| Filesystem | `read_file`, `list_dir`, `search_files` |
| Git | `git_status`, `git_log`, `git_diff` |

The Planner never writes project source code directly; mutations go through
the Manager.

## Behavior highlights

- **Compaction-safe**: after compaction it re-reads `plan_get()` +
  `plan_get_history()` to recover strategic context.
- **Note handling**: permanent notes are kept in scope across replans;
  volatile notes are auto-deleted by the runtime after the next
  plan-mutation tool call.
- **Retrospectives**: when stages repeatedly fail or escalate, the Planner
  is prompted by its system instructions to dispatch the Inspector before
  attempting another fix.
- **No direct user dialogue**: user requests come in through Chat → notes.

## Result types

```ts
type RunPlanResult =
  | { kind: "success" }
  | { kind: "failure", reason: string }
  | { kind: "abort", reason: string }
  | { kind: "escalation" };
```

`runPlanner()` resolves with one of these and the CLI maps them to exit
codes (see [CLI](/guide/cli)).
