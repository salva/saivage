# Monitoring & Logs

## Logs

Saivage uses a structured logger (`src/log.ts`) that writes to:

- **stdout** — text format suitable for `journalctl`/`docker logs`.
- **`<project>/.saivage/tmp/logs/saivage.log`** — JSON Lines format
  (one event per line).

For the LXC deployment use the helper:

```bash
make -C deploy logs
```

Which is `journalctl -u saivage -f` inside the container.

## Live state

- **Web dashboard** (`/`) — the canonical observability surface.
- **`GET /api/state`** — JSON snapshot.
- **`GET /api/debug/timeline`** — recent runtime events (agent dispatches,
  compactions, aborts).
- **`GET /api/debug/errors`** — recent error log.
- **`GET /api/providers`** — provider health, rate-limit headers, current
  active model assignments.

## CLI snapshots

```bash
saivage status /path/to/project        # plan + stage + PID
saivage models /path/to/project        # resolved model per role
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

The supervisor (`src/runtime/supervisor.ts`) periodically reviews a tail of
the log file and asks an LLM whether the system is making progress. After
N consecutive *stuck* verdicts it triggers an abort. Verdicts are logged
under category `supervisor_verdict`.

## Rotating logs

Saivage does not rotate `saivage.log` itself. On the LXC deployment use
`logrotate`:

```
/home/youruser/myproject/.saivage/tmp/logs/saivage.log {
    daily
    rotate 7
    compress
    missingok
    copytruncate
    notifempty
}
```
