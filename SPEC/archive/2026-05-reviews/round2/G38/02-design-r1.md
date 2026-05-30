# G38 — Design r1

Two genuine architectural options, then a recommendation. Both close
the gap identified in `01-analysis-r1.md`; they differ on whether
Saivage should *support* multi-process access to one `.saivage/` or
*hard-prevent* it.

---

## Proposal A — Advisory POSIX `flock(2)` on lock files in `.saivage/locks/`

### Sketch

- Introduce `.saivage/locks/` (per-project directory).
- Replace the in-process `recordLocks` / `scopeLocks` maps with
  per-key files: `<saivage>/locks/records/<kind>:<scope>:<scope_ref>:<id>.lock`
  and `<saivage>/locks/scopes/<kind>:<scope>:<scope_ref>.lock`.
- `acquireRecordLock` / `acquireScopeLock` become:
  1. `open(path, O_CREAT|O_RDWR, 0o600)`
  2. `flock(fd, LOCK_EX)` via `proper-lockfile` (already deterministic
     across Linux/macOS) or via a thin `node:fs` + `node:dgram` wrapper.
     `proper-lockfile` adds ~50 KB and gives us stale-lock detection
     identical in spirit to `runtime.lock`.
  3. Return `release = async () => { await flock(fd, LOCK_UN); close(fd); }`.
- `acquireTwoRecordLocks` keeps lex-order acquisition, now over file
  locks instead of `Map` slots.
- The single-process FIFO ordering currently provided by the
  `Map<Promise>` chain is preserved by adding a thin in-process queue
  *inside* each `acquire*` call, layered above the file lock, so
  concurrent same-process callers don't all race on the kernel lock.
  (Without this layer, in-process ordering becomes lottery-driven
  because `flock` does not guarantee FIFO between threads/event-loop
  ticks.)
- `supersedeSkill` is extended to take its per-record lock the same
  way `supersedeMemory` does (closing a pre-existing gap noted in the
  analysis).

### Files touched

- [src/knowledge/store.ts](../../../../src/knowledge/store.ts) — replace `recordLocks`/`scopeLocks` and the `acquire`/`acquireRecordLock`/`acquireScopeLock`/`acquireTwoRecordLocks` helpers with the file-lock implementation; add `flock` wrapper + per-key in-process queue.
- [src/knowledge/lifecycle.ts](../../../../src/knowledge/lifecycle.ts) — add the missing `acquireRecordLock` call in `supersedeSkill`; thread `release` into the `try/finally` to interlock with G39.
- [src/store/project.ts](../../../../src/store/project.ts) — `seedProject` creates `<saivageDir>/locks/{records,scopes}/` and includes the path in `paths`.
- [src/types.ts](../../../../src/types.ts) — no schema change (the lock files are not Zod documents).
- [src/knowledge/concurrency.test.ts](../../../../src/knowledge/concurrency.test.ts) — rewrite primitive tests to assert cross-process behaviour using `node:child_process` workers; keep the FIFO test for in-process callers.
- [src/knowledge/store.test.ts](../../../../src/knowledge/store.test.ts) — same.
- [package.json](../../../../package.json) — add `proper-lockfile` (or write a tiny `node:fs.flock` shim, see below).
- [SPEC/v2/skills-memory/01-DESIGN.md](../../skills-memory/01-DESIGN.md) — §K rewritten: cross-process concurrency becomes a *supported* mode; document the `flock` strategy in §C.3.

### Public API impact

- `acquireRecordLock` / `acquireScopeLock` return signature changes
  from `() => void` to `() => Promise<void>` (release must `flock(UN)`
  and close the fd asynchronously). Every caller updates accordingly.
  Today only `supersedeMemory` and the test files call them.
- `acquireTwoRecordLocks` already returns a Promise-shaped release;
  unchanged signature.
- New runtime dependency on `proper-lockfile` (or maintained shim).

### Deletion list

- Module-scoped `recordLocks` and `scopeLocks` `Map`s.
- The internal `acquire(map, key)` helper.
- The poison-chain construction `map.set(key, prev.then(...))` —
  removing this also retires G39 mechanically.

### Test impact

- Concurrency tests must spawn child processes to demonstrate the new
  guarantee (no equivalent in-process assertion exists).
- Existing FIFO-ordering tests still pass because of the per-key
  in-process queue layered above `flock`.
- Adds platform variability to CI: `flock(2)` semantics on overlayfs,
  NFS, and Windows differ. Saivage targets Linux/macOS on local FS, so
  we accept Linux/macOS only and document that.

### Cost vs benefit

- **Cost**: 150-200 LoC of net new code, a new npm dependency (or a
  hand-rolled `flock` shim through `node:fs.promises` + `node:dgram`
  + Linux `O_CREAT|O_EXCL` fallback), a non-trivial test rewrite, and
  reversal of a documented design decision (§K).
- **Benefit**: protects a failure mode that **does not occur on any
  current deployment** and that `acquireRuntimeLock` already prevents
  for the supported entry points.

---

## Proposal B — Formalise single-writer-per-project as a runtime-enforced contract

### Sketch

- Lift the existing `runtime.lock` primitive from "boot-time only" to
  "boot-time + load-time invariant the knowledge store checks".
- At every public entry point of `src/knowledge/lifecycle.ts`
  (the only legitimate writers), call a new
  `assertRuntimeLockHeld(saivageRoot)` that confirms
  `<saivageRoot>/tmp/state/runtime.lock` exists and its `pid` matches
  `process.pid`. If not, throw a new typed error
  `KnowledgeStoreError("NO_RUNTIME_LOCK", …)`. This makes the
  documented non-goal a runtime contract: any code path attempting
  to write knowledge without holding the project's runtime lock fails
  fast with an explicit, code-grepable error instead of silently
  racing.
- Delete the misleading lock primitives. The two-key `supersedeMemory`
  serialisation that they provide today is preserved by:
  - keeping a much smaller, single-purpose `supersedeLocks` `Map`
    *local to `supersedeMemory`* (used only to interlock concurrent
    same-process supersede calls on the same record id), and
  - adding the identical interlock to `supersedeSkill` (which lacks
    it today, see analysis).
- The runtime-lock primitive at
  [src/runtime/recovery.ts](../../../../src/runtime/recovery.ts#L83-L150)
  gains a tiny `readRuntimeLockOwner(saivageDir): { pid: number } | null`
  helper used by `assertRuntimeLockHeld`. It is sync (matches the
  existing primitive's discipline) and reads ≤200 bytes.
- The skills/memory design §K is *strengthened*: the non-goal becomes
  a code-enforced contract. The §K text changes from "may corrupt
  indexes/audits — documented here so it is not assumed in Phase C"
  to "rejected at runtime by the store layer; second daemon refuses
  to boot via `runtime.lock`, second non-daemon writer refuses via
  `assertRuntimeLockHeld`."
- Update the store-layer header comment in
  [src/knowledge/store.ts](../../../../src/knowledge/store.ts#L1-L11)
  to describe the actual contract, not the aspirational one.

### Files touched

- [src/knowledge/store.ts](../../../../src/knowledge/store.ts) — delete `recordLocks`, `scopeLocks`, `acquire`, `acquireRecordLock`, `acquireScopeLock`, `acquireTwoRecordLocks`, `recordLockKey`, `scopeLockKey`. Replace with a single private `supersedeLocks` map used only by `supersedeMemory`/`supersedeSkill`. Rewrite the header comment.
- [src/knowledge/lifecycle.ts](../../../../src/knowledge/lifecycle.ts) — every public function (`createSkill`, `updateSkill`, `archiveSkill`, `deleteSkill`, `supersedeSkill`, `createMemory`, `updateMemory`, `archiveMemory`, `deleteMemory`, `supersedeMemory`, `archiveStage`, `archiveSession`) opens with `assertRuntimeLockHeld(saivageRoot)`. `supersedeSkill` gains the per-record interlock that `supersedeMemory` already has. Imports of the deleted helpers are removed.
- [src/runtime/recovery.ts](../../../../src/runtime/recovery.ts) — add `readRuntimeLockOwner(saivageDir): { pid: number; started_at: string } | null` and `assertRuntimeLockHeld(saivageDir): void`. Both sync, both read-only.
- [src/knowledge/store.ts](../../../../src/knowledge/store.ts) → introduce typed error `KnowledgeStoreError("NO_RUNTIME_LOCK", …)` (`NO_RUNTIME_LOCK` added to `KnowledgeErrorCode` union at [src/knowledge/store.ts](../../../../src/knowledge/store.ts#L31-L46)).
- [src/knowledge/concurrency.test.ts](../../../../src/knowledge/concurrency.test.ts) — drop primitive tests for deleted helpers; add a test that asserts `createMemory` rejects with `NO_RUNTIME_LOCK` when called without a runtime lock; keep parallel-lifecycle tests, but wrap each `beforeEach` so the temp project has a `runtime.lock` written for `process.pid`.
- [src/knowledge/store.test.ts](../../../../src/knowledge/store.test.ts) — drop lock-primitive tests; keep `writeRecordAtomic` and `appendJsonlAtomic` tests.
- [src/knowledge/regression.test.ts](../../../../src/knowledge/regression.test.ts) — `beforeEach` writes a fake `runtime.lock` for `process.pid` after `initProjectTree`.
- [src/knowledge/lifecycle.archive.test.ts](../../../../src/knowledge/lifecycle.archive.test.ts) — same `beforeEach` adjustment.
- [SPEC/v2/skills-memory/01-DESIGN.md](../../skills-memory/01-DESIGN.md) §K — rewrite the bullet on cross-process concurrency to reference `assertRuntimeLockHeld`; remove the "may corrupt" hedge.

### Public API impact

- Knowledge tools called outside of a `bootstrap()` context (today:
  none in production, several in tests) now require either:
  - going through `bootstrap()`, which calls `acquireRuntimeLock`; or
  - calling the new `acquireRuntimeLock(saivageRoot)` directly before
    the first write.
- All tests that touch `lifecycle.ts` add one line in `beforeEach` to
  acquire (or fake) the lock.
- `recordLockKey`, `scopeLockKey`, `acquireRecordLock`,
  `acquireScopeLock`, `acquireTwoRecordLocks` are no longer exported
  from `store.ts`. Any external consumer breaks at compile time
  (workspace-wide grep shows only tests).

### Deletion list

- `recordLocks: Map<string, Promise<void>>` and `scopeLocks: Map<…>`
  module state ([src/knowledge/store.ts](../../../../src/knowledge/store.ts#L67-L82)).
- `acquire(map, key)` helper ([src/knowledge/store.ts](../../../../src/knowledge/store.ts#L88-L100)) — also retires G39 because the poisonable chain is gone.
- `acquireRecordLock`, `acquireScopeLock`, `acquireTwoRecordLocks`,
  `recordLockKey`, `scopeLockKey` exports.
- Their import lines in
  [src/knowledge/lifecycle.ts](../../../../src/knowledge/lifecycle.ts#L23-L34),
  [src/knowledge/concurrency.test.ts](../../../../src/knowledge/concurrency.test.ts#L21),
  [src/knowledge/store.test.ts](../../../../src/knowledge/store.test.ts#L10-L12).
- Primitive lock tests at
  [src/knowledge/concurrency.test.ts](../../../../src/knowledge/concurrency.test.ts#L38-L98)
  and [src/knowledge/store.test.ts](../../../../src/knowledge/store.test.ts#L80-L120).

### Test impact

- Concurrency tests for the *real* invariant the store provides
  (single-process FIFO serialisation of two `supersedeMemory` on the
  same id) are kept and re-pinned to the new internal `supersedeLocks`
  map.
- New test: `lifecycle.runtime-lock.test.ts` (or rolled into
  `regression.test.ts`) asserts `createMemory` and friends reject with
  `NO_RUNTIME_LOCK` when no lock is present.
- All existing lifecycle tests that use `initProjectTree(projectRoot)`
  add one line: `await acquireRuntimeLock(join(projectRoot, ".saivage"))`
  in their `beforeEach`, and release in `afterEach`. ~10 test files.

### Cost vs benefit

- **Cost**: ~80-100 LoC net (more deletions than additions); +1 line
  in ~10 `beforeEach` blocks; one design-doc rewrite (§K).
- **Benefit**: turns a documented non-goal into a runtime-enforced
  contract; deletes a misleading abstraction (the public lock
  helpers); failure mode becomes a typed `NO_RUNTIME_LOCK` error
  before any bytes are written, instead of silent corruption later;
  G39 is dissolved as a side effect (no chain to poison).

---

## Proposal C (sketched and rejected) — Move knowledge store to SQLite-WAL

- Single SQLite file under `.saivage/knowledge.db`; WAL mode handles
  cross-process concurrency natively; per-record locking falls out of
  SQLite's row-level transactions.
- **Rejected**: violates FR-20 ("Markdown bodies, JSON records,
  cat/grep-friendly") and FR-26 ("loader/store unit-testable in
  isolation"). Conflicts with the
  [SPEC/v2/skills-memory/01-DESIGN.md](../../skills-memory/01-DESIGN.md#L1003-L1009)
  decision matrix for B.4 file layout. Massive scope creep (every
  reader rewritten, every test rewritten, MCP/eager-loader rewritten).
  This is a different system, not a remediation.

---

## Recommendation: Proposal B

The finding diagnoses a real misalignment between the lock helpers'
naming and their actual guarantee. The right fix is to align the code
with the design — not to import an inter-process locking layer that
the design explicitly rejects and that no current deployment needs.

Proposal B:

- **Honours the existing architectural decision** in §K (single-writer
  per `.saivage/`), and turns it into a typed runtime check instead
  of a documentation footnote.
- **Deletes more than it adds** (architecture-first guideline).
- **Subsumes G39**: the poisonable `Map<Promise>` chain disappears.
- **Closes the only real same-process gap the analysis surfaced**
  (`supersedeSkill` had no interlock).
- **Avoids platform-specific `flock` quirks** (overlayfs, NFS,
  Windows) entirely.
- **Costs less to operate**: no new dependency, no per-key fd open
  on every write, no stale-lock-file cleanup logic beyond the one
  `runtime.lock` already has.

Proposal A becomes the right answer only if Saivage ever decides to
support multi-process workers against one `.saivage/`. When and if
that happens, the §K decision is the natural starting point and
Proposal A is documented here as the migration path. Today it is
over-engineering.

Coordination with G39 under Proposal B: G39 dissolves because the
poisonable construct (`map.set(key, prev.then(() => next))` with an
unconditional `.then`) is deleted. The small `supersedeLocks` map
introduced for in-process supersede interlocking uses
`prev.catch(() => {}).then(() => next)` — i.e. it incorporates G39's
fix from the start.
