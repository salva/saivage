# G38 — Knowledge store mutexes are process-local; no inter-process file lock

**Subsystem**: knowledge
**Category**: race-condition
**Severity**: high
**Transversality**: architectural

## Summary

`recordLocks` and `scopeLocks` in `src/knowledge/store.ts` are
module-scoped `Map` instances. They serialise concurrent in-process
writers correctly, but they cannot see writers from a second Node
process touching the same `.saivage/skills` or `.saivage/memory` tree.
Saivage already runs in scenarios with multiple processes against one
project (v2 harness + chat server, CI runner + dev server, the
saivage-v3 dual-process harness), so the locks fail to provide the
guarantee callers assume.

## Evidence (with line-linked refs)

- Module-scope lock maps:
  [src/knowledge/store.ts](src/knowledge/store.ts#L67-L82).
- Comments and call-sites treat the locks as the single source of
  mutual exclusion (no advisory file locks in sight):
  [src/knowledge/store.ts](src/knowledge/store.ts#L200-L260),
  [src/knowledge/lifecycle.ts](src/knowledge/lifecycle.ts).

## Why this matters

Two processes can simultaneously rewrite the same skill record JSON
or rebuild the same `index.json`, and the on-disk rename-based
"atomic" write only guarantees per-file consistency — not the
two-key supersede invariant the design spec calls out. Worst case is a
silently lost supersede or an `index.json` that lags reality, and
because lock acquisition succeeds in both processes there is no
diagnostic.

## Rough remediation direction (one bullet "one conceptual level up")

- Layer an advisory POSIX file lock (`flock` or `proper-lockfile`) on
  top of the in-process Map, keyed by the same `recordLockKey` /
  `scopeLockKey` strings, so the second writer blocks on a real
  filesystem object instead of an in-memory map only it can see.

## Cross-links

- G39 (lock chain poisoned on error — same file).
- Saivage skills-memory design §C.3 (transaction order).
