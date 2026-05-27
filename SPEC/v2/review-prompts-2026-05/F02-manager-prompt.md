# F02 — manager.md

**File under review:** [prompts/manager.md](../../../prompts/manager.md) (253 lines — longest prompt)
**Agent:** Manager — [src/agents/manager.ts](../../../src/agents/manager.ts)
**Runtime contract:** roster entry [manager](../../../src/agents/roster.ts#L94), tool filter `worker`.

## Summary

The manager prompt is the longest one and the most likely to be over-featured.
Review against the project-wide axes in
[00-SUBSYSTEM-MAP.md](00-SUBSYSTEM-MAP.md#project-wide-review-axes-apply-to-every-issue),
with special attention to:

- Length vs retention — 253 lines is a lot for a per-stage manager that must
  also read its task context.
- Dispatch-tool list — verify each `run_*` tool against the manager's
  `dispatchableBy` set in [roster.ts](../../../src/agents/roster.ts) and the
  generic `stageWorkers` map in
  [src/server/bootstrap.ts](../../../src/server/bootstrap.ts).
- Return shape — must match `StageSummary` in
  [src/types.ts](../../../src/types.ts).
- The escalation / retry sections — verify they match `MAX_RETRIES`,
  abort-priority logic, and the supervisor behaviour, not invent new rules.
- The Reviewer/Critic/Designer follow-up semantics — these are now described
  generically as stage-scoped follow-ups (`stageScoped: true` in roster) and
  the prompt must not contradict that lift.

## Category

Review (over-featurism is the most likely finding).

## Severity / Transversality

Severity: high.
Transversality: local (one prompt file).
