# Typed Artifact Submission

## Problem

Workers and managers are currently instructed to write JSON artifacts to disk and
also return the full JSON as their final model response. The runtime then parses
the final text.

This creates several problems:

- The on-disk artifact and final response can diverge.
- A model can claim success without actually writing or submitting the artifact.
- Parsing final prose as JSON is a weak success boundary.
- Runtime repair prompts are generic because the missing contract is not a tool
  result.

## Goal

Make task reports and stage summaries first-class typed submissions while still
letting agents decide how to do the work.

Agents remain autonomous. The runtime does not script their task sequence. It
only requires that terminal artifacts be submitted through validated tools.

Before adding new tools, test the simpler path: accept completion when the
expected artifact exists on disk and validates with the schema. If that is too
weak or too ambiguous, add explicit submission tools.

## New Tools

### `submit_task_report`

Allowed for TaskReport-producing workers if explicit submission tools are kept.

Input:

```ts
interface SubmitTaskReportInput {
  stage_id: string;
  task_id: string;
  report: TaskReport;
}
```

Behavior:

- Validate with `TaskReportSchema`.
- Ensure `stage_id` and `task_id` match the current worker context.
- Write `.saivage/stages/<stage>/reports/<task>.json` atomically.
- Record submission metadata in runtime diagnostics.
- Return `{ ok: true, path }` or a structured validation error.

### `submit_stage_summary`

Allowed for Manager if explicit submission tools are kept.

Input:

```ts
interface SubmitStageSummaryInput {
  stage_id: string;
  summary: StageSummary;
}
```

Behavior:

- Validate with `StageSummarySchema`.
- Ensure `stage_id` matches Manager context.
- Check referenced task/report evidence.
- Write `.saivage/stages/<stage>/summary.json` atomically.
- Return `{ ok: true, path }` or a structured validation/compliance result.

### `submit_inspection_report`

Optional for Inspector.

This can follow after task/stage submission is stable. Inspector already has a
structured report shape, but it is less central to autonomous execution.

## Terminal Semantics

After artifact validation or submission tools exist, final text is no longer the
primary artifact.

Worker success path:

1. Worker uses any tools needed.
2. Worker calls `submit_task_report`.
3. Runtime validates and persists the report.
4. Worker may provide concise final text.
5. `WorkerAgent` returns the submitted report, not parsed final prose.

If using validation-only completion, step 2 becomes: Worker writes the expected
report file and returns concise final text. Runtime then validates the file
before accepting success.

Manager success path:

1. Manager decomposes and dispatches tasks.
2. Manager reads reports and optionally dispatches Reviewer/fix loops.
3. Manager calls `submit_stage_summary`.
4. Runtime validates and persists the summary.
5. `ManagerAgent` returns the submitted summary.

Submission tools should use the existing terminal-tool pattern currently used by
Planner `plan_done` through `detectTerminalToolCall()` or a shared equivalent.

## Nudge Behavior

If a worker ends without `submit_task_report`, inject:

```text
SYSTEM COMPLIANCE NUDGE: You ended without submitting a TaskReport. Call
submit_task_report with a valid TaskReport for stage <stage_id>, task <task_id>.
If you cannot complete the task, submit a failed TaskReport with evidence and
failure_reason.
```

If a Manager ends without `submit_stage_summary`, inject:

```text
SYSTEM COMPLIANCE NUDGE: You ended without submitting a StageSummary. Inspect
the task reports under .saivage/stages/<stage_id>/reports/, dispatch any needed
repair/review work, then call submit_stage_summary.
```

## Evidence Policy

Submission tools should validate schema strictly and check evidence softly.

Hard failures:

- Schema invalid.
- Wrong stage/task id.
- Missing required timestamps/status fields.
- Attempt to write outside the expected path.

Warnings/nudges:

- No tools used before a completed report.
- Empty `tests_run` for a coding task with modified files.
- Manager summary says completed but no Reviewer report exists.
- Summary task counts disagree with reports.

## Migration Strategy

1. Add tests for validation-only artifact completion.
2. If validation-only completion is insufficient, implement submission services
   behind modular MCP built-ins.
3. Treat submission tools as terminal tools.
4. Teach prompts to use submission tools and stop asking for full final JSON.
5. Require validated on-disk artifacts for Worker and Manager success.
6. Use compliance nudges when required artifacts are missing or invalid.
7. Delete final-response artifact parsing once prompts and tests use validated
   artifacts/submission tools.

## Validation

- Worker stub test: successful task report is returned from submitted artifact.
- Worker stub test: final prose without submission receives nudge.
- Manager stub test: stage summary submission validates and persists.
- Manager stub test: summary/report count mismatch produces nudge or warning.
- Existing report schemas remain the single source of type truth.
