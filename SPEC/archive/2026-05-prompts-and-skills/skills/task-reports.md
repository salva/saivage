# Skill: Task Report Writing

## When to Use
Every time you (Coder or Researcher) complete or fail a task.

## Report Schema

Write to `stages/<stage-id>/reports/<task-id>.json` with these fields:

```json
{
  "task_id": "tsk-...",
  "stage_id": "stg-...",
  "agent": "coder" | "researcher",
  "status": "completed" | "failed",
  "summary": "...",
  "checklist_results": [...],
  "files_modified": [...],
  "files_created": [...],
  "tests_added": [...],
  "tests_run": [...],
  "commits": [...],
  "issues_found": [...],
  "failure_reason": "..." | null,
  "started_at": "...",
  "completed_at": "...",
  "duration_ms": 0
}
```

## Guidelines

### Honesty is Mandatory
- Set `status: "completed"` **only** if every `required: true` checklist item passes.
- If any required item fails, set `status: "failed"` with a clear `failure_reason`.
- Do not rationalize failures as partial successes. The Manager needs accurate information.

### Checklist Assessment
For each checklist item from the task:
```json
{
  "description": "same text as the checklist item",
  "passed": true | false,
  "notes": "how you verified this / why it failed"
}
```
- Provide evidence in `notes`: "ran `npm test` — 14/14 passed", not just "tests pass".
- For items you could not verify, set `passed: false` and explain why in `notes`.

### File Tracking
- `files_modified`: files that existed before and you changed. Paths relative to project root.
- `files_created`: new files you created. Paths relative to project root.
- Be exhaustive — include every file you touched, even config or documentation.

### Issues
Report anything unexpected, even if it didn't block completion:
```json
{
  "severity": "info" | "warning" | "error",
  "description": "...",
  "file": "path/to/file",
  "suggestion": "..."
}
```
- `info`: observations, potential improvements, things to note.
- `warning`: problems that didn't block this task but might cause issues later.
- `error`: problems that should be addressed before proceeding.

### Failure Reports
When `status: "failed"`:
- Explain what you tried and what went wrong in `failure_reason`.
- Include the exact error messages or test output.
- If you have a theory about the root cause, include it.
- If you partially completed some work, describe what was done and what remains.
- **Still fill in all other fields** — even failed tasks may have modified files or found issues.

### Timestamps
- `started_at`: when you began working on the task (ISO 8601).
- `completed_at`: when you finish writing the report.
- `duration_ms`: difference in milliseconds.
