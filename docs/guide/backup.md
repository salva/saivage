# Backup & Recovery

## What to back up

Saivage's durable state is split between **per-project** and **per-host**
locations.

### Per-project (`<project>/.saivage/`)

This directory is meant to be **committed to git** alongside the project.
The agents commit changes to it themselves via the git MCP tool.

| Path | Backed up by | Notes |
|------|--------------|-------|
| `config.json`         | git | Project objectives & runtime knobs. |
| `plan.json`           | git | Active plan. |
| `plan-history.json`   | git | Archived stages. |
| `stages/<id>/…`       | git | Per-stage tasks and reports. |
| `inspections/`        | git | Inspection reports. |
| `skills/`             | git | Project skills. |
| `tools/inspector/`    | git | Inspector helpers. |
| `notes/`              | git | Outstanding notes (mostly small). |
| `tmp/`                | **gitignored** | Working state — see below. |

### Project tmp (`<project>/.saivage/tmp/`)

Discardable. Contains:

- `state/runtime.json` — current PID, status.
- `state/shutdown-request.json`, `shutdown-summary.json` — shutdown handoff.
- `chats/` — chat session history.
- `inspector-workspace/` — Inspector scratch space.
- `logs/saivage.log` — daemon log.
- `work/` — agent working directories.

It can survive a reboot but does not need to — on startup the runtime
reconstructs position from durable state.

### Host (`~/.saivage/` or `<runtime-root>/.saivage/`)

| Path | Notes |
|------|-------|
| `saivage.json` | Daemon runtime config. |
| `auth-profiles.json` | OAuth tokens. **Sensitive — back up encrypted.** |

## Restoring after a crash

The runtime is designed to be crash-recoverable:

1. On boot, `bootstrap()` reads project config and runtime state.
2. The **recovery** module (`src/runtime/recovery.ts`) inspects
   `tmp/state/runtime.json`. If the previous process was active, it logs a
   crash entry, archives the partial state, and resumes from the durable
   plan.
3. The **Planner** is restarted, re-reading `plan.json`, `plan-history.json`,
   and any pending notes.
4. The current stage's directory is consulted for an in-progress
   `tasks.json`. If found, a fresh **Manager** is spawned for that stage
   (its in-memory conversation history is lost; that is by design).

Workers do **not** resume — any in-progress task is treated as failed and
restarted from scratch by the Manager. This is safe because workers commit
their results before reporting; partial work is recoverable from git.

## Manual disaster recovery

If `tmp/` becomes corrupted:

```bash
rm -rf <project>/.saivage/tmp
saivage start <project>     # state is reconstructed from durable JSON
```

If `plan.json` itself becomes corrupted, you can:

1. Replace it with `{ "updated_at": "…", "current_stage_id": null, "stages": [] }`.
2. Run `saivage start` — the Planner regenerates the plan from objectives.

The plan history (`plan-history.json`) is informational; deleting it just
loses the audit trail.
