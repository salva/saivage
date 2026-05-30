# G27 — `plan_complete_stage` writes `started_at = completed_at`

**Subsystem**: mcp
**Category**: half-implemented
**Severity**: medium
**Transversality**: local

## Summary

When the MCP `plan_complete_stage` tool moves a stage into plan history
it stamps `started_at` with `new Date().toISOString()` — the same value
used for `completed_at` a few lines later. The active `Stage` schema in
[src/types.ts](src/types.ts) carries no `started_at`, so the
information is genuinely unavailable; the handler hides that gap by
writing a synthetic timestamp that makes every completed stage look
instantaneous in the history JSON and any UI built on it.

## Evidence (with line-linked refs)

- Synthetic `started_at` in `plan_complete_stage`:
  [src/mcp/plan-server.ts](src/mcp/plan-server.ts#L218-L235).
- `Stage` schema with no `started_at`:
  [src/types.ts](src/types.ts#L32-L43).
- `CompletedStage` schema demanding the field:
  [src/types.ts](src/types.ts#L54-L75).

## Why this matters

Plan history is the durable record of how long stages actually take,
feeding supervisor dashboards and post-mortems. A `started_at` that is
silently identical to `completed_at` makes every completed stage look
like a zero-duration event and ruins any analytics derived from the
history file. It is the kind of half-implementation that is more
harmful than a missing field, because consumers cannot tell the data is
fake.

## Rough remediation direction (one bullet "one conceptual level up")

- Track stage start time as state in the planner/runtime (e.g. capture
  on `plan_start_stage`, persist on the live plan or in
  `runtime-state.json`), and have `plan_complete_stage` consume that
  recorded value; reject completion if no start time was ever recorded
  rather than synthesising one.

## Cross-links

- G28 (plan-server cross-doc atomicity gap — same file).
- Round 1: F34 (plan-server in-memory cache), F19 (runtime/plan
  coherence).
