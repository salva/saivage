# Skill: File Organization Conventions

## When to Use
Whenever you create, move, or organize files within the `.saivage/` directory or the project tree.

## Directory Structure

### Persistent (committed to git)
```
.saivage/
├── config.json              # Project config — do not modify during execution
├── plan.json                # Managed by plan MCP service; includes history
├── notes/                   # Chat creates, Planner consumes
├── stages/<stage-id>/
│   ├── tasks.json           # Manager creates/updates
│   ├── summary.json         # Manager creates
│   └── reports/<task-id>.json  # Coder/Researcher creates
├── inspections/             # Inspector creates
├── research/<topic>/        # Researcher creates
├── skills/                  # Manager / Inspector author via MCP `create_skill`
│   ├── project/{index.json, audit.jsonl, records/<uuid>.{json,md}}
│   ├── stages/<stage-id>/{index.json, audit.jsonl, records/}
│   └── sessions/<channel-id>/{index.json, audit.jsonl, records/}  # gitignored
├── memory/                  # Pl/Mg/Co/Re/In author via MCP `create_memory`
│   ├── project/{index.json, audit.jsonl, records/<uuid>.json}
│   ├── stages/<stage-id>/{index.json, audit.jsonl, records/}
│   └── sessions/<channel-id>/{index.json, audit.jsonl, records/}  # gitignored
└── tools/inspector/         # Inspector creates (persistent tools)
```

### Temporary (gitignored)
```
.saivage/tmp/
├── state/runtime.json       # Runtime only
├── inspector-workspace/     # Inspector scratch space
├── chats/<channel>/<id>.json  # Chat logs
└── work/
    ├── coder/               # Coder scratch space
    └── researcher/          # Researcher scratch space
```

### .gitignore Content
The `.saivage/.gitignore` file:
```
tmp/
```

## Conventions

### Territory
Each agent has **conventional territory** — directories where it primarily writes. All agents (except Chat) have full access, but following territory conventions prevents collisions:

| Agent      | Writes to                                              |
|------------|--------------------------------------------------------|
| Planner    | Plan state via plan MCP service, notes (acknowledge)   |
| Manager    | `stages/<id>/tasks.json`, `stages/<id>/summary.json`   |
| Coder      | Project source, `stages/<id>/reports/`, `skills/`      |
| Researcher | `research/`, `stages/<id>/reports/`                    |
| Inspector  | `inspections/`, `tools/inspector/`, `tmp/inspector-workspace/` |
| Chat       | `notes/`, `tmp/chats/`                                 |

### Cross-territory Access
If you need to read files from another agent's territory: **always fine**.
If you need to write files in another agent's territory: do it if the task requires it, but note it in your task report under `issues_found` with `severity: "info"` so the Manager is aware.

### Research File Organization
- One subdirectory per topic: `research/oauth-providers/`, `research/performance-benchmarks/`.
- Use markdown (`.md`) for narrative documentation.
- Use JSON/CSV for structured data.
- Include a brief `README.md` or header in each topic directory explaining what the research covers and when it was gathered.
- Include source URLs and access dates.

### Scratch Space
- Coder: use `tmp/work/coder/` for intermediate files that don't belong in the project.
- Researcher: use `tmp/work/researcher/` for downloaded files, raw data before processing.
- Inspector: use `tmp/inspector-workspace/` for analysis scripts and intermediate results.
- Scratch spaces are gitignored — nothing here survives a clean checkout.

### ID Prefixes
When creating files with IDs, use the correct prefix:
- Stages: `stg-` (e.g., `stages/stg-a1b2c3/`)
- Tasks: `tsk-` (e.g., `reports/tsk-x4y5z6.json`)
- Notes: `note-` (e.g., `notes/note-m7n8o9.json`)
- Inspections: `insp-` (e.g., `inspections/insp-p0q1r2.json`)
- Chat sessions: `chat-` (e.g., `chats/web/chat-s3t4u5.json`)
