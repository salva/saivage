# F24 — Shutdown handoff deletes its own summary after one consumer reads it

**Category**: unsafe-pattern
**Severity**: medium
**Transversality**: module

## Summary

`shutdown-handoff.ts` writes a `shutdown-summary.json` describing why and how the runtime stopped, then deletes it after the first consumer reads it. If the first consumer (the new runtime instance's planner-recovery path) crashes before processing the summary, the file is gone and the next attempt has zero context about why the previous shutdown happened.

## Evidence

- The write + read-then-delete dance: [src/runtime/shutdown-handoff.ts](src/runtime/shutdown-handoff.ts#L1-L147).
- The schema records a lot of state worth preserving: [src/types.ts](src/types.ts#L325-L355).
- The user's own memory note records hitting this in production: a stale `shutdown-summary.json` causes the *next* startup to replay old SYSTEM RESTART HANDOFF work — i.e. the file persists when it should be cleared, and disappears when it should persist.

## Why this matters

Either (a) keep the summaries forever in an `archive/` subdir keyed by timestamp, or (b) mark them consumed (rename to `.consumed.json`) instead of deleting. The current "delete on read" pattern combines the worst of both: log forensics impossible, but file still survives if the consumer skips the read path.

## Related

- F08 (runtime state mirror has similar dead-write semantics)
