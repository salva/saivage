# On-Disk Layout

The complete on-disk layout of a Saivage-managed project, with each entry's
producer and lifecycle.

## Project tree

```
<project>/
├── .saivage/                       # Saivage-managed (mostly committed)
│   ├── config.json                 # ProjectConfig
│   ├── saivage.json                # SaivageConfig runtime/provider routing
│   ├── plan.json                   # active PlanDocument with history
│   ├── auth-profiles.json          # OAuth profiles (sensitive — gitignored)
│   ├── telegram-subscriptions.json # Telegram notification destinations
│   ├── repo-layout.json            # optional tracked layout contract
│   ├── notes/                      # user notes (one file per note)
│   │   └── note-<id>.json
│   ├── stages/<stage-id>/          # per-stage directory
│   │   ├── tasks.json              # TaskList
│   │   ├── summary.json            # StageSummary (after completion)
│   │   └── reports/<task-id>.json  # TaskReport
│   ├── inspections/                # Inspection reports
│   │   └── insp-<id>.json
│   ├── knowledge/                  # SQLite sidecar for skills + memory
│   │   └── store.sqlite
│   ├── rag/                        # RAG registry and dataset stores
│   │   ├── registry.json
│   │   └── <dataset-id>/...
│   ├── tools/inspector/            # persistent inspector helpers
│   ├── .gitignore                  # gitignores tmp/
│   └── tmp/                        # gitignored runtime state
│       ├── state/
│       │   ├── runtime.json        # PID, status, current agent tree
│       │   ├── shutdown-request.json
│       │   └── shutdown-summary.json
│       ├── chats/                  # chat session logs (informational)
│       ├── command-logs/           # full stdout/stderr from run_command
│       ├── inspector-workspace/    # per-investigation scratch
│       └── work/                   # agent working directories
├── research/                       # Researcher territory
│   └── <topic>/...
└── (project source)
```

`saivage.json` and `auth-profiles.json` are project-local under the target
project's `.saivage/`. `SAIVAGE_ROOT`, when set, points at that project
`.saivage/` directory.

## Producer / lifecycle table

| Path | Producer | Committed? | Survives restart? | Notes |
|------|----------|------------|-------------------|-------|
| `.saivage/config.json` | Operator (`saivage init`) | yes | yes | Source of objectives. |
| `.saivage/saivage.json` | Operator (`saivage init`) | yes | yes | Runtime config, provider/model routing, MCP/RAG settings. |
| `.saivage/plan.json` | Plan MCP service | yes | yes | Authoritative plan and embedded history. |
| `.saivage/telegram-subscriptions.json` | Telegram bot | yes | yes | Notification destinations. |
| `.saivage/notes/*` | CLI / Chat agent | yes | yes | Cleaned up by runtime after Planner ack. |
| `.saivage/stages/<id>/tasks.json` | Manager | yes | yes | One per active stage. |
| `.saivage/stages/<id>/reports/<tid>.json` | Worker | yes | yes | One per task. |
| `.saivage/stages/<id>/summary.json` | Manager | yes | yes | Written on stage close. |
| `.saivage/inspections/<id>.json` | Inspector | yes | yes | Optional `expires_at`. |
| `.saivage/knowledge/store.sqlite` | Knowledge lifecycle | yes | yes | Canonical skills + memory sidecar. |
| `.saivage/rag/registry.json` | RAG manager | yes | yes | Operator-visible cache of configured collections. |
| `.saivage/rag/<dataset-id>/*` | RAG dataset store | yes | yes | Vector/index artifacts for a collection. |
| `.saivage/tools/inspector/*` | Inspector | yes | yes | Promoted from workspace. |
| `.saivage/tmp/state/runtime.json` | Daemon | no | partial | Reconstructed on recovery. |
| `.saivage/tmp/state/shutdown-*.json` | Daemon / CLI | no | partial | Used for handoff. |
| `.saivage/tmp/chats/*` | Web/Telegram channels | no | no | Informational. |
| `.saivage/tmp/command-logs/*` | Shell MCP service | no | no | Full stdout/stderr for `run_command`. |
| `.saivage/tmp/inspector-workspace/*` | Inspector | no | no | Cleared on garbage sweep. |
| `research/*` | Researcher | yes | yes | Territory: Researcher only. |
| `auth-profiles.json` | Auth flows | no | yes | Sensitive — back up encrypted. |

## Why `tmp/` is gitignored

The runtime treats anything under `tmp/` as recoverable from durable state
above it. Committing it would couple repository history to runtime
implementation details. The default `.saivage/.gitignore` written by
`initProject()` is `tmp/`.

## Garbage collection

`sweepStaleTempFiles(root, ttlMs)` is invoked at startup by the recovery
module for `.saivage/` and `.saivage/tmp/state/`. It removes orphan
`*.tmp` files left by interrupted atomic writes; inspector scratch and
command logs remain ordinary `tmp/` artifacts.
