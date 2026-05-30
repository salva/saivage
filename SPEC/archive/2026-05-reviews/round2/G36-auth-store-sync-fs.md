# G36 — Auth profile store reads/writes credentials with blocking sync fs

**Subsystem**: auth
**Category**: bad-design
**Severity**: high
**Transversality**: module

## Summary

`src/auth/store.ts` loads and persists `auth-profiles.json` using
`readFileSync`/`writeFileSync`. The store is touched on every provider
construction (to resolve `authProfile`) and on every OAuth refresh, so
the synchronous I/O happens on the chat server's hot path. This is the
exact pattern F22 already cleaned up in `store/documents.ts`; the auth
store was missed.

## Evidence (with line-linked refs)

- Sync `readFileSync` import and use:
  [src/auth/store.ts](src/auth/store.ts#L1-L20),
  [src/auth/store.ts](src/auth/store.ts#L40-L80).
- Sync `writeFileSync` on profile persistence:
  [src/auth/store.ts](src/auth/store.ts#L80-L120).

## Why this matters

Auth profile reads happen during every `ModelRouter.send` call, while
writes happen on background OAuth refreshes — both paths now stall
the event loop. A concurrent OAuth refresh during a chat turn can
freeze every other in-flight request for the duration of the
filesystem write. The store also holds bearer tokens; non-atomic
sync writes risk truncating a profile file mid-write on crash, which
can lock the user out of their providers.

## Rough remediation direction (one bullet "one conceptual level up")

- Migrate `auth/store.ts` to `fs/promises` and route writes through
  the same atomic `writeDoc` helper that F22 already provides, plus
  add an in-memory cache invalidated only on disk mtime change so the
  hot read path becomes a synchronous map lookup.

## Cross-links

- Round 1: F22 (store/documents async migration).
- G30 (mcp builtins sync fs), G37 (config sync fs) — same class.
