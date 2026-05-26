# On-Disk Layout

The complete on-disk layout of a Saivage-managed project, with each entry's
producer and lifecycle.

## Project tree

```
<project>/
├── .saivage/                       # Saivage-managed (mostly committed)
│   ├── config.json                 # ProjectConfig
│   ├── plan.json                   # active PlanDocument with history
│   ├── auth-profiles.json          # OAuth profiles (sensitive — gitignored)
│   ├── notes/                      # user notes (one file per note)
│   │   └── note-<id>.json
│   ├── stages/<stage-id>/          # per-stage directory
│   │   ├── tasks.json              # TaskList
│   │   ├── summary.json            # StageSummary (after completion)
│   │   └── reports/<task-id>.json  # TaskReport
│   ├── inspections/                # Inspection reports
│   │   └── insp-<id>.json
│   ├── skills/                     # project-specific skills
│   │   ├── index.json
│   │   └── <skill-id>.md
│   ├── tools/inspector/            # persistent inspector helpers
│   ├── .gitignore                  # gitignores tmp/
│   └── tmp/                        # gitignored runtime state
│       ├── state/
│       │   ├── runtime.json        # PID, status, current agent tree
│       │   ├── shutdown-request.json
│       │   └── shutdown-summary.json
│       ├── chats/                  # chat session logs (informational)
│       ├── inspector-workspace/    # per-investigation scratch
│       ├── work/                   # agent working directories
│       └── logs/saivage.log        # JSONL daemon log
├── research/                       # Researcher territory
│   └── <topic>/...
└── (project source)
```

## Daemon-host tree (when not project-scoped)

```
~/.saivage/
├── saivage.json                    # SaivageConfig (runtime)
└── auth-profiles.json              # OAuth profiles
```

When `SAIVAGE_ROOT` points at a project's `.saivage/` directory, both
`saivage.json` and `auth-profiles.json` live there instead.

## Producer / lifecycle table

| Path | Producer | Committed? | Survives restart? | Notes |
|------|----------|------------|-------------------|-------|
| `.saivage/config.json` | Operator (`saivage init`) | yes | yes | Source of objectives. |
| `.saivage/plan.json` | Plan MCP service | yes | yes | Authoritative plan and embedded history. |
| `.saivage/notes/*` | CLI / Chat agent | yes | yes | Cleaned up by runtime after Planner ack. |
| `.saivage/stages/<id>/tasks.json` | Manager | yes | yes | One per active stage. |
| `.saivage/stages/<id>/reports/<tid>.json` | Worker | yes | yes | One per task. |
| `.saivage/stages/<id>/summary.json` | Manager | yes | yes | Written on stage close. |
| `.saivage/inspections/<id>.json` | Inspector | yes | yes | Optional `expires_at`. |
| `.saivage/skills/*` | Workers / operator | yes | yes | Auto-attached by triggers. |
| `.saivage/tools/inspector/*` | Inspector | yes | yes | Promoted from workspace. |
| `.saivage/tmp/state/runtime.json` | Daemon | no | partial | Reconstructed on recovery. |
| `.saivage/tmp/state/shutdown-*.json` | Daemon / CLI | no | partial | Used for handoff. |
| `.saivage/tmp/chats/*` | Web/Telegram channels | no | no | Informational. |
| `.saivage/tmp/inspector-workspace/*` | Inspector | no | no | Cleared on garbage sweep. |
| `.saivage/tmp/logs/saivage.log` | Logger | no | yes | Rotate via logrotate. |
| `research/*` | Researcher | yes | yes | Territory: Researcher only. |
| `auth-profiles.json` | Auth flows | no | yes | Sensitive — back up encrypted. |

## Why `tmp/` is gitignored

The runtime treats anything under `tmp/` as recoverable from durable state
above it. Committing it would couple repository history to runtime
implementation details. The default `.saivage/.gitignore` written by
`initProject()` is `tmp/`.

## Garbage collection

`sweepStaleTempFiles(root, ttlMs)` is invoked at startup by the recovery
module. It removes orphan `*.tmp.*` files from interrupted atomic writes
and clears the inspector workspace older than its TTL.
