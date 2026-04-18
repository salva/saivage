# Skill: Git Commit Conventions

## When to Use
Every time you commit files via the MCP git tool.

## Rules

### Use MCP Git Only
All git operations go through the MCP git server. **Never** use shell `git` commands directly (`git add`, `git commit`, `git push`, etc.). The MCP server serializes access and prevents conflicts between agents.

### Commit Message Format
```
[<entity-id>] <concise description>
```

Entity ID by agent:
- **Coder/Researcher**: `[tsk-<id>]` — the task ID you are working on.
- **Inspector**: `[insp-<id>]` — the inspection report ID.
- **Manager**: `[stg-<id>]` — the stage ID.
- **Planner**: `[planner]` — no specific entity.

Examples:
```
[tsk-x4y5z6] implement user authentication middleware
[tsk-a1b2c3] research: OAuth2 provider comparison
[insp-p0q1r2] test coverage analysis
[stg-m7n8o9] stage tasks and summary
[planner] update plan after stage completion
```

### Commit Scope
Only commit files that you modified for the current task/operation:

| Agent      | Conventional scope                                           |
|------------|--------------------------------------------------------------|
| Coder      | Project source code, tests, docs, config + task report       |
| Researcher | Files under `research/` + task report                        |
| Inspector  | Report under `inspections/` + tools under `tools/inspector/` |
| Manager    | Task list + stage summary under `stages/<id>/`               |
| Planner    | `plan.json`, `plan-history.json`                             |

### Commit Timing
- Commit **after** verifying your work, not before.
- Record the returned commit SHA in your report's `commits` field.
- If `git_commit` returns a conflict error, report it as a task failure — do not attempt to resolve conflicts yourself.

### Atomic Commits
- Prefer one commit per task with all related changes.
- If a task has logically separate parts (e.g., implementation + tests), two commits are acceptable.
- Do not make empty commits or commits with unrelated changes.
