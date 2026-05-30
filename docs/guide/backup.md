# Backup & Recovery

## What to back up

Saivage's durable state is split between **per-project** and **per-host**
locations.

### Per-project (`<project>/.saivage/`)

This directory is mostly durable project state. Commit the non-sensitive files
alongside the project; keep credentials encrypted and out of normal git history.

| Path | Backed up by | Notes |
|------|--------------|-------|
| `config.json`         | git | Project objectives, routing, and skill limits. |
| `saivage.json`        | git | Runtime config, providers, MCP, RAG, and notifications. |
| `plan.json`           | git | Active plan and embedded plan history. |
| `telegram-subscriptions.json` | git | Telegram notification destinations. |
| `stages/<id>/…`       | git | Per-stage tasks and reports. |
| `inspections/`        | git | Inspection reports. |
| `knowledge/store.sqlite` | git | Project skills and memories. |
| `rag/`                | git | RAG registry and dataset stores. |
| `tools/inspector/`    | git | Inspector helpers. |
| `notes/`              | git | Outstanding notes (mostly small). |
| `auth-profiles.json`  | encrypted backup | OAuth tokens. Sensitive. |
| `tmp/`                | **gitignored** | Working state — see below. |

### Project tmp (`<project>/.saivage/tmp/`)

Discardable. Contains:

- `state/runtime.json` — current PID, status.
- `state/shutdown-request.json`, `shutdown-summary.json` — shutdown handoff.
- `chats/` — chat session history.
- `command-logs/` — full stdout/stderr captured by `run_command` when requested.
- `inspector-workspace/` — Inspector scratch space.
- `work/` — agent working directories.

It can survive a reboot but does not need to — on startup the runtime
reconstructs position from durable state.

### Runtime credentials

Runtime config and credentials are project-local under `<project>/.saivage/`.
`SAIVAGE_ROOT`, when set, points at that same directory. Do not rely on
`~/.saivage/` for current deployments.

## Restoring after a crash

The runtime is designed to be crash-recoverable:

1. On boot, `bootstrap()` reads project config and runtime state.
2. The **recovery** module (`src/runtime/recovery.ts`) inspects
   `tmp/state/runtime.json`. If the previous process was active, it logs a
   crash entry, archives the partial state, and resumes from the durable
   plan.
3. The **Planner** is restarted, re-reading `plan.json` and any pending notes.
4. The current stage's directory is consulted for an in-progress
   `tasks.json`. If found, a fresh **Manager** is spawned for that stage
   (its in-memory conversation history is lost; that is by design).

Workers do **not** resume in-memory conversations. Recovery reconciles each
interrupted task from its report file: completed reports with commits become
completed tasks, reports without commits become failed tasks, and tasks without
reports are reset to pending for the Manager to dispatch again.

## Manual disaster recovery

If `tmp/` becomes corrupted:

```bash
rm -rf <project>/.saivage/tmp
saivage start <project>     # state is reconstructed from durable JSON
```

If `plan.json` itself becomes corrupted, you can:

1. Replace it with `{ "updated_at": "...", "current_stage_id": null, "stages": [], "history": [] }`.
2. Run `saivage start` — the Planner regenerates the plan from objectives.

The plan history is the `history` array inside `plan.json`; deleting or
emptying it loses the audit trail.
