# Skill: Escalation Protocol

## When to Use
When you (Manager) need to decide whether to retry, remediate, or escalate a task failure. Also when worker agents need to report failures clearly.

**Note:** Model throttling, rate limits, and transient API errors are retried automatically by the runtime. You will never see these as task failures.

## For Worker Agents (Coder/Researcher)

### When to Report Failure
Set `status: "failed"` in your task report when:
- A required checklist item cannot be satisfied.
- You encounter an error you cannot resolve after reasonable effort.
- The task's approach is fundamentally flawed (wrong assumptions, missing dependencies).
- You lack the information or access needed to complete the task.

### How to Report Failure
- `failure_reason`: be specific. Include the exact error, what you tried, and why it didn't work.
- Still fill in all other report fields — partial work is valuable information.
- If you have a theory about what would fix it, include it in `issues_found` with a `suggestion`.

**Do not**:
- Silently skip broken parts and report "completed".
- Report "failed" without explaining what you tried.
- Attempt workarounds that violate the task's requirements.

## For the Manager

### Decision Tree

```
Task failed
  ├── attempt < max_attempts?
  │     ├── YES: Is the failure likely transient (flaky test, timeout, network)?
  │     │     ├── YES → Retry the same task
  │     │     └── NO → Create a remediation task that addresses the root cause, THEN retry
  │     └── NO: max attempts exhausted
  │           ├── Can the remaining tasks proceed without this one?
  │           │     ├── YES → Skip, note in summary, continue with remaining tasks
  │           │     └── NO → Escalate to Planner
  │           └── Is the failure fundamental (wrong approach, missing capability)?
  │                 └── YES → Escalate to Planner immediately (don't waste retries)
  └── Escalate
```

### When to Escalate
Escalate to the Planner when:
- The stage objective cannot be achieved with the current task breakdown.
- Multiple tasks fail for the same underlying reason (systemic issue).
- A fundamental assumption in the stage description has proven wrong.
- You've exhausted retries and the stage cannot proceed.

### How to Escalate
Write the `StageSummary` with `result: "escalated"` and include an `Escalation` object:

```json
{
  "stage_id": "stg-...",
  "task_id": "tsk-...",
  "reason": "Clear explanation of why the stage cannot proceed.",
  "attempted_remediations": [
    "Retried task X with modified approach",
    "Created remediation task Y to fix dependency"
  ],
  "suggested_action": "Consider splitting this stage into...",
  "created_at": "..."
}
```

- `attempted_remediations`: list everything you tried. The Planner needs to know what's already been attempted.
- `suggested_action`: your recommendation. The Planner will make the final decision, but your tactical insight is valuable.

### When NOT to Escalate
- A single task fails on first attempt — retry or remediate first.
- The failure is in a non-blocking task — skip it and continue.
- You haven't tried any remediation yet — try at least one alternative before escalating.
