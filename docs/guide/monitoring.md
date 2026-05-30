# Monitoring & Logs

## Logs

Saivage uses a structured logger (`src/log.ts`) that writes formatted entries
to stdout/stderr and keeps the most recent entries in an in-memory buffer for
runtime checks such as the supervisor.

Agent tool calls can also write full command stdout/stderr to project-local log
files when the caller passes `stdout_path` or `stderr_path` to `run_command`.

For the LXC deployment use the helper:

```bash
make -C deploy logs
```

Which is `journalctl -u saivage -f` inside the container.

## Live state

- **Web dashboard** (`/`) — the canonical observability surface.
- **`GET /health`** — liveness, project name, and runtime status.
- **`GET /api/state`** — JSON snapshot.
- **`GET /api/debug/state`** — runtime, active plan, plan history, and loaded
  project/runtime configuration.
- **`GET /api/debug/timeline`** — timeline derived from plan history and task
  reports.
- **`GET /api/debug/errors`** — recent error log.
- **`GET /api/providers`** — registered providers and their available models.

## CLI snapshots

```bash
saivage status /path/to/project        # plan + stage + PID
saivage models /path/to/project        # registered providers + models
```

## Event categories

The Event Bus emits typed `SystemEvent` objects (`src/types.ts`):

| Category | Severity | Meaning |
|----------|----------|---------|
| `stage_completed` | info | A stage finished cleanly. |
| `stage_failed` | error | A stage was archived as failed. |
| `escalation` | warning | Manager escalated to Planner. |
| `task_failed` | warning | A worker task returned a failure report. |
| `inspector_complete` | info | An inspection report was written. |
| `plan_updated` | info | Planner mutated the plan. |

These flow into both the web dashboard and the configured notification
channels (`web`, `telegram`).

## Supervisor verdicts

The supervisor (`src/runtime/supervisor.ts`) periodically reviews recent
in-memory log entries and asks an LLM whether the system is making progress.
After `consecutiveStuckVerdicts` consecutive *stuck* verdicts, it cancels the
lowest-priority abortable running agent. Verdicts and cancellations are written
as `[supervisor]` logger entries.

## Rotating logs

The daemon logger does not create a project-local rotating log file. In the LXC
deployment, service output goes through `journald`; configure retention there or
capture command-specific tool output with `stdout_path` / `stderr_path` when a
stage needs durable logs.
