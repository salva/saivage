# G06 — APPROVED

**Chosen proposal**: Design A (per [02-design-r2.md](02-design-r2.md)) — in-place `fs/promises` migration of `src/runtime/stash.ts`. Matches F22/G30/G36 precedent. Design B (extract `LockedJsonFile<T>`) rejected: stash uses UUID-unique filenames so no lock surface needed; re-routing auth/store after G36's r3 approval is unjustified blast radius.

**Approved by**: GPT-5.5 (copilot) reviewer at round 2 — see [04-review-r2.md](04-review-r2.md). All 2 r1 changes addressed.

**Test fixture**: uses `beforeEach`/`afterEach` from `vitest`, preserves/restores `PROJECT_ROOT` and `SAIVAGE_ROOT`.

**Reuses**: `src/testing/noSyncFsScanner.ts` (G30) with `recovery.ts` carve-out.

**Implementation pointer**: [03-plan-r2.md](03-plan-r2.md).

**Daemon impact**: `saivage` (10.0.3.111), `diedrico` (10.0.3.113), `saivage-v3` (10.0.3.112) — all bind-mount.
