# G38 — Design r2

Changes from r1 (driven by [04-review-r1.md](04-review-r1.md)):

1. Proposal B's in-process interlock is widened: it now covers
   `createSkill`, `createMemory`, the supersede pair, and the archive
   sweeps — every operation whose correctness depends on a whole-scope
   read-modify-write. This closes the same-process race the analysis
   surfaces.
2. `supersedeSkill` is specified as a mirror of `supersedeMemory`:
   pre-find for the key, enter the lock, **re-find** under the lock,
   re-check status / scope, then write.
3. The runtime-lock guard for `archiveStage` and `archiveSession`
   converts `projectRoot` → `join(projectRoot, ".saivage")` *inside*
   `archiveScope` so the guard runs on the correct directory.
4. Test migration drops `agents/knowledge.agent.test.ts` (loader-only)
   and adds the two MCP writer test files
   ([src/mcp/knowledgeSkills.test.ts](../../../../src/mcp/knowledgeSkills.test.ts),
   [src/mcp/knowledgeMemory.test.ts](../../../../src/mcp/knowledgeMemory.test.ts))
   plus a direct contract test file for
   [src/runtime/recovery.ts](../../../../src/runtime/recovery.ts).
5. The new in-process queue is **module-private to
   `src/knowledge/lifecycle.ts`** (not re-exported from `store.ts`)
   and the stale `writeRecordAtomic` / `rebuildIndex` caller-locks-it
   prose is rewritten.

The two-proposal split (A: `flock`, B: runtime-lock + private queue,
C: SQLite-WAL — rejected) is unchanged. Proposal B is still the
recommendation. Only the B sketch / files-touched / deletion list /
test impact below are restated.

---

## Proposal A — Advisory POSIX `flock(2)` on lock files in `.saivage/locks/`

Unchanged from r1; see [02-design-r1.md](02-design-r1.md). Carried
forward only as the future migration path if Saivage ever supports
multi-process workers.

## Proposal C — SQLite-WAL

Unchanged from r1; rejected for the same reasons.

---

## Proposal B (revised) — Runtime-lock contract + private in-process queue

### Sketch

Two layers, both fail-fast:

1. **Cross-process** (already exists, now made explicit at the store
   boundary): the `runtime.lock` primitive in
   [src/runtime/recovery.ts](../../../../src/runtime/recovery.ts#L83-L150).
   Every public lifecycle writer opens with a
   `assertRuntimeLockHeld(saivageRoot)` guard. If the current process
   does not own the lock, the writer throws a typed
   `KnowledgeStoreError("NO_RUNTIME_LOCK", …)` before any byte is
   written. The §K non-goal becomes a runtime contract.
2. **In-process** (new): a private queue keyed per **scope** for
   collision-sensitive scope mutations, and per **record id** for
   supersedes. Both live inside `src/knowledge/lifecycle.ts`. Neither
   helper is re-exported from `store.ts`. Both use the
   `prev.catch(() => {}).then(() => next)` chain shape so a thrown
   holder cannot poison the slot (G39 dissolves at construction).

#### Per-scope `withScopeLifecycleLock`

- Key shape: `<kind>:<scope>:<scope_ref|_>` (re-using the discarded
  `scopeLockKey` shape but as a string built in-place, not exported).
- Wraps every operation whose correctness depends on a whole-scope
  read of active records:
  - `createSkill` (`NAME_COLLISION` check + record write + index rebuild)
  - `createMemory` (`TOPIC_COLLISION` check + record write + index rebuild)
  - `archiveStage` (per kind, per scope: archive sweep + index rebuild)
  - `archiveSession` (same)
- `updateSkill`, `updateMemory`, `archiveSkill`, `archiveMemory`,
  `deleteSkill`, `deleteMemory` operate on a single record id and do
  not need the scope queue; the runtime-lock guard plus
  `writeDoc` rename atomicity is sufficient. They do **not** acquire
  the scope queue.

#### Per-record-id `withSupersedeLock`

- Key shape: `<old_id>` (uuid).
- Used by `supersedeMemory` and `supersedeSkill`.
- The caller does a **pre-find** (lock-free) only to obtain
  `oldFound.record.id` for the key, then enters the lock and
  **re-reads** the old record via `findSkill/MemoryById` inside the
  critical section before re-checking `scope` / `status` and writing.
  This is the exact shape `supersedeMemory` uses today
  ([src/knowledge/lifecycle.ts](../../../../src/knowledge/lifecycle.ts#L584-L600));
  `supersedeSkill` is rewritten to match.

#### Chain shape (G39-safe by construction)

```ts
// Inside src/knowledge/lifecycle.ts, module-private:
const scopeLifecycleLocks = new Map<string, Promise<void>>();
const supersedeLocks = new Map<string, Promise<void>>();

async function withChainLock<T>(
  map: Map<string, Promise<void>>,
  key: string,
  fn: () => Promise<T>,
): Promise<T> {
  const prev = map.get(key) ?? Promise.resolve();
  let release!: () => void;
  const next = new Promise<void>((res) => { release = res; });
  map.set(key, prev.catch(() => undefined).then(() => next));
  await prev.catch(() => undefined);
  try {
    return await fn();
  } finally {
    release();
    if (map.get(key) === next) map.delete(key);
  }
}
```

Two thin wrappers (`withScopeLifecycleLock(kind, scope, scope_ref, fn)`
and `withSupersedeLock(oldId, fn)`) build the key and call
`withChainLock`. Neither map nor helper is exported.

#### `assertRuntimeLockHeld` for archive paths

`archiveStage(projectRoot, …)` and `archiveSession(projectRoot, …)`
accept `projectRoot`, not `saivageRoot`. The guard is therefore
placed **inside `archiveScope`** immediately after
`const saivageRoot = join(projectRoot, ".saivage")`
([src/knowledge/lifecycle.ts](../../../../src/knowledge/lifecycle.ts#L869-L877)),
so both entry points share the conversion and there is no risk of a
guard call on the wrong path. Every other public writer in
`lifecycle.ts` already receives `saivageRoot` directly and calls the
guard as its first statement.

#### Deletions

- `recordLocks`, `scopeLocks` maps.
- `acquire(map, key)` helper.
- `acquireRecordLock`, `acquireScopeLock`, `acquireTwoRecordLocks`,
  `recordLockKey`, `scopeLockKey` exports.
- `concurrency.test.ts` "Lock-primitive tests" block.
- `store.test.ts` lock-primitive block.
- Stale prose in
  [src/knowledge/store.ts](../../../../src/knowledge/store.ts#L1-L11),
  [src/knowledge/store.ts](../../../../src/knowledge/store.ts#L211-L212),
  [src/knowledge/store.ts](../../../../src/knowledge/store.ts#L379-L380).

G39's poisonable construct disappears with these deletions; the
replacement helpers ship with the rejection-tolerant chain from the
start.

### Files touched

- [src/knowledge/store.ts](../../../../src/knowledge/store.ts) —
  delete `recordLocks`, `scopeLocks`, `acquire`, `acquireRecordLock`,
  `acquireScopeLock`, `acquireTwoRecordLocks`, `recordLockKey`,
  `scopeLockKey`. Rewrite the header comment block, the
  `writeRecordAtomic` doc, and the `rebuildIndex` doc to describe the
  new contract: "single-writer per project enforced by `runtime.lock`;
  in-process serialisation of collision-sensitive scope mutations
  and supersedes is owned privately by `src/knowledge/lifecycle.ts`."
  Add `NO_RUNTIME_LOCK` to `KnowledgeErrorCode`.
- [src/knowledge/lifecycle.ts](../../../../src/knowledge/lifecycle.ts)
  — drop imports of the deleted helpers. Add module-private
  `withScopeLifecycleLock` / `withSupersedeLock` / `withChainLock`.
  Add `assertRuntimeLockHeld(saivageRoot)` as the first statement of
  every public writer that takes `saivageRoot` directly
  (`createSkill`, `updateSkill`, `archiveSkill`, `deleteSkill`,
  `supersedeSkill`, `createMemory`, `updateMemory`, `archiveMemory`,
  `deleteMemory`, `supersedeMemory`). Place the guard inside
  `archiveScope` for `archiveStage` / `archiveSession`. Wrap
  `createSkill` / `createMemory` body in `withScopeLifecycleLock`.
  Wrap `archiveScope` per-kind work in `withScopeLifecycleLock`
  (key built from the derived `saivageRoot` + kind + scope +
  scope_ref). Rewrite `supersedeSkill` to: pre-find for key, enter
  `withSupersedeLock`, **re-find inside the lock**, re-check
  scope/status, write new + rewrite old. Convert the existing
  `supersedeMemory` from `acquireRecordLock`/`recordLockKey` to
  `withSupersedeLock`; its re-find-after-lock shape is already
  correct and stays.
- [src/runtime/recovery.ts](../../../../src/runtime/recovery.ts) —
  add `readRuntimeLockOwner(saivageDir): { pid: number; started_at:
  string } | null` (sync, ≤20 LoC) and
  `assertRuntimeLockHeld(saivageDir): void` (sync, throws plain
  `Error` if missing or owned by another pid; the lifecycle layer
  converts the failure to `KnowledgeStoreError("NO_RUNTIME_LOCK",
  …)`). Both are re-exported from the module.
- [src/knowledge/concurrency.test.ts](../../../../src/knowledge/concurrency.test.ts)
  — drop the lock-primitive block. Rewrite remaining lifecycle
  concurrency tests to (a) acquire `runtime.lock` in `beforeEach`,
  (b) add **duplicate-name** `createSkill` and **duplicate-topic**
  `createMemory` race tests asserting exactly one caller wins with
  `NAME_COLLISION` / `TOPIC_COLLISION`, (c) add a **same-id**
  `supersedeSkill` race test mirroring the existing
  `supersedeMemory` race test, asserting exactly one caller wins
  with `INVALID_SUPERSEDE_TARGET` and the chain head points to the
  winner.
- [src/knowledge/store.test.ts](../../../../src/knowledge/store.test.ts)
  — drop the lock-primitive block. Keep `writeRecordAtomic` and
  `appendJsonlAtomic` tests.
- [src/knowledge/regression.test.ts](../../../../src/knowledge/regression.test.ts)
  — `beforeEach` acquires the runtime lock for the temp project after
  `initProjectTree`; `afterEach` releases it.
- [src/knowledge/lifecycle.archive.test.ts](../../../../src/knowledge/lifecycle.archive.test.ts)
  — same `beforeEach` adjustment. Adds an explicit test that
  `archiveStage` and `archiveSession` succeed while the runtime lock
  is held and reject with `NO_RUNTIME_LOCK` when no lock is held
  (catches the r1 path-conversion bug if it ever regresses).
- [src/mcp/knowledgeSkills.test.ts](../../../../src/mcp/knowledgeSkills.test.ts)
  — acquire the runtime lock in `beforeEach` (the temp project root
  does not go through `initProjectTree`; the helper must create
  `<saivage>/tmp/state/` before calling `acquireRuntimeLock`).
- [src/mcp/knowledgeMemory.test.ts](../../../../src/mcp/knowledgeMemory.test.ts)
  — same.
- New: `src/runtime/runtimeLock.test.ts` — direct contract tests for
  `acquireRuntimeLock` / `readRuntimeLockOwner` /
  `assertRuntimeLockHeld` / releaser: writes pid owner; second
  acquisition rejects while first is live; release removes the file;
  stale (dead pid) lock is removed and re-acquired; malformed lock
  body is treated as stale; `assertRuntimeLockHeld` throws when no
  lock exists, throws when another pid owns it, returns silently
  when the current pid owns it.
- New (or appended to `regression.test.ts`): a negative-path test
  that calls `createMemory` after `initProjectTree` **without**
  acquiring the runtime lock and asserts a `KnowledgeStoreError` with
  `code === "NO_RUNTIME_LOCK"`.
- [SPEC/v2/skills-memory/01-DESIGN.md](../../skills-memory/01-DESIGN.md)
  §K — rewrite the cross-process bullet to reference
  `assertRuntimeLockHeld` and the new typed error; FR-29 row in §L is
  cross-referenced; the `flock(2)` alternative is retained as the
  documented migration path to Proposal A.

[src/agents/knowledge.agent.test.ts](../../../../src/agents/knowledge.agent.test.ts)
is **not** modified — it exercises only the loader-side records and
does not call lifecycle writers, contrary to the r1 plan.

### Public API impact

- Knowledge tools called outside of a `bootstrap()` context (today:
  none in production, several in tests) now require either:
  - going through `bootstrap()`, which calls `acquireRuntimeLock`; or
  - calling `acquireRuntimeLock(saivageRoot)` directly before the
    first write.
- All tests that touch `lifecycle.ts` writers add one line in
  `beforeEach` to acquire the lock and release in `afterEach`.
- `recordLockKey`, `scopeLockKey`, `acquireRecordLock`,
  `acquireScopeLock`, `acquireTwoRecordLocks` are no longer exported
  from `store.ts`. Workspace-wide grep shows only tests use them, so
  this is a clean delete.
- The new `withScopeLifecycleLock` / `withSupersedeLock` /
  `withChainLock` helpers are module-private to
  `src/knowledge/lifecycle.ts`. **Nothing lock-shaped is exported
  from `store.ts`.** This is the change reviewer change #5 demands.

### Test impact

- New collision-race tests cover the same-process gaps the analysis
  surfaces (reviewer change #1).
- New `supersedeSkill` race test mirrors `supersedeMemory`'s
  (reviewer change #2).
- New `archive*` runtime-lock tests cover the
  `projectRoot` / `saivageRoot` conversion (reviewer change #3).
- New direct runtime-lock contract tests in
  `src/runtime/runtimeLock.test.ts` plus MCP writer-test migrations
  cover reviewer change #4.
- Hygiene sweep extended to fail on prose references to deleted
  contract phrases ("per-record mutex", "per-scope lock",
  "two-key supersede lock", "acquireRecordLock", "acquireScopeLock"),
  not just on import identifiers (reviewer change #5).

### Cost vs benefit

- **Cost**: ~120-150 LoC net (deletions plus the two private wrappers
  plus the new runtime-lock helpers and tests); +1 line in ~10
  `beforeEach` blocks; one design-doc rewrite (§K); one new test
  file (`runtimeLock.test.ts`).
- **Benefit**: turns a documented non-goal into a typed runtime
  contract; closes the same-process collision races on
  `createSkill` / `createMemory` and the `supersedeSkill` stale-read
  bug; deletes the misleading public lock surface (nothing
  lock-shaped is exported from `store.ts`); subsumes G39 by
  construction.

---

## Recommendation: Proposal B (revised)

The reviewer changes do not change the architectural direction; they
sharpen Proposal B so it actually delivers what it claims:

- The new per-scope queue closes the analysis's same-process
  collision gap instead of waving at it (#1).
- The mirrored `supersedeSkill` shape closes the stale-read window
  the r1 wrapper would have left open (#2).
- The guard sits in `archiveScope` after the path conversion, not on
  the raw `projectRoot` (#3).
- The test migration is driven by writer usage, not by an
  `initProjectTree` grep, and runtime-lock semantics are pinned by
  direct contract tests (#4).
- The replacement helpers are module-private to `lifecycle.ts`; the
  store's public surface no longer advertises any lock, and the
  stale prose in `writeRecordAtomic` / `rebuildIndex` is rewritten
  (#5).

Proposal A becomes the right answer only if Saivage ever decides to
support multi-process workers against one `.saivage/`. Today it is
still over-engineering. G39 is still subsumed by construction.
