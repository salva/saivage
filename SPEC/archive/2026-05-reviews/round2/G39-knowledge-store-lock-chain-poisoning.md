# G39 — Knowledge `acquire()` permanently poisons a lock key if any holder rejects

**Subsystem**: knowledge
**Category**: race-condition
**Severity**: high
**Transversality**: module

## Summary

The internal `acquire()` helper builds its mutex chain as
`map.set(key, prev.then(() => next))`. If `prev` rejects (because an
earlier holder's awaited work threw before calling `release`), the
`.then()` callback never runs, so `next` is never resolved, and every
subsequent caller awaits a perpetually-pending entry. Because the map
slot is now a rejected promise, future `acquire` calls also throw
synchronously when they `await prev;`, and the key is dead for the
lifetime of the process.

## Evidence (with line-linked refs)

- Chain construction and `await prev`:
  [src/knowledge/store.ts](src/knowledge/store.ts#L89-L100).
- Lock release helper that only runs in the success path:
  [src/knowledge/store.ts](src/knowledge/store.ts#L100-L106).

## Why this matters

Any unexpected exception inside a knowledge tool handler (a Zod parse
error, a disk-full write, a Promise rejection from `writeRecordAtomic`)
will poison the per-record or per-scope lock for that record forever.
Subsequent reads or writes to that record then hang or throw "lock
unavailable", and the only recovery is a process restart. This is a
latent correctness bomb that is invisible during happy-path testing.

## Rough remediation direction (one bullet "one conceptual level up")

- Make the chain construction tolerant of rejection
  (`map.set(key, prev.catch(() => {}).then(() => next))`) and ensure
  callers wrap their work in `try { … } finally { release(); }` so the
  next holder always advances; add a unit test that throws inside a
  lock holder and asserts the next acquire still resolves.

## Cross-links

- G38 (process-local locks — same file).
