# G28 — `plan_complete_stage` lacks cross-document atomicity (acknowledged in code)

**Subsystem**: mcp
**Category**: race-condition
**Severity**: high
**Transversality**: architectural

## Summary

`plan_complete_stage` mutates two on-disk documents — `plan.json` and
`plan-history.json` — in sequence using `writeDoc`. Each individual
write is atomic, but the pair is not: a crash, power loss, or process
kill between the two writes leaves the plan empty while the history has
no entry, or the history written while the plan still lists the stage
as current. A comment in the file explicitly acknowledges the gap, so
the design defect is known but unaddressed.

## Evidence (with line-linked refs)

- Two-step write with no cross-doc transaction, comment acknowledging
  the gap: [src/mcp/plan-server.ts](src/mcp/plan-server.ts#L243-L255).
- `writeDoc` is per-file atomic only:
  [src/store/documents.ts](src/store/documents.ts).

## Why this matters

The plan and its history are the only durable record of what the
runtime has done. A crash window that drops a stage from both
documents simultaneously means the planner restarts and either re-runs
the just-completed stage or treats it as never having existed. Because
the plan-server now caches plan state in memory (F34), the divergence
can persist for the lifetime of the process before anyone notices.

## Rough remediation direction (one bullet "one conceptual level up")

- Introduce a small write-ahead journal next to `plan.json` (e.g.
  `.saivage/plan/pending-completion.json`) that records the intent
  before either document is touched, then drive a recovery step at
  plan-server startup that replays or rolls back any half-applied
  completion; alternatively merge the two documents into one persisted
  blob so atomicity falls out of `writeDoc`.

## Cross-links

- G27 (started_at bug — same handler).
- Round 1: F34 (plan-server cache), F19 (runtime/plan coherence).
