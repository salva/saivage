# G38 — Plan r2 (implements Proposal B revised)

Changes from r1 (driven by [04-review-r1.md](04-review-r1.md)):

- Step 3 splits the writer guard: the 10 entry points that take
  `saivageRoot` directly call `assertRuntimeLockHeld(saivageRoot)`
  as their first statement; `archiveStage` / `archiveSession` are
  guarded **inside `archiveScope`** after deriving `saivageRoot`.
- Steps 5–6 keep the new lock helpers **module-private to
  `src/knowledge/lifecycle.ts`** (not exported from `store.ts`).
- Step 6 rewrites `supersedeSkill` to pre-find for the key, enter
  the lock, re-find under the lock, re-check, and only then write
  (mirror of `supersedeMemory`).
- New step 7 adds the per-scope queue
  `withScopeLifecycleLock` around `createSkill`, `createMemory`,
  and the per-kind archive sweeps inside `archiveScope`.
- Step 10 (test migration) targets MCP writer tests explicitly and
  drops the over-included `agents/knowledge.agent.test.ts`.
- New step 11 adds a direct `runtimeLock.test.ts` contract file.
- Step 14 (hygiene sweep) extends to prose references.

Numbering below is the full r2 sequence.

## Scope

Formalise single-writer-per-project as a runtime-enforced contract
for the knowledge store. Close the same-process scope-collision and
`supersedeSkill` stale-read races via module-private in-process
queues inside `src/knowledge/lifecycle.ts`. Delete the misleading
public lock primitives. Subsume G39 (lock-chain poisoning) by
removing the poisonable chain and shipping the replacement with
`prev.catch(() => {}).then(() => next)` from the start.

## Cross-finding coordination with G39

G38 and G39 are the **same lock manager**. Land them together as a
single change set: the deletions required by G38 remove the construct
G39 patches, so attempting G39 in isolation would write code that
G38 then deletes. Order of work below assumes the combined landing.

If for any reason G39 must ship first (smaller blast radius, urgent
hotfix), apply only G39's `catch(() => {})` patch and add a
deprecation comment pointing at this plan; do not introduce any new
callers of the deprecated lock helpers.

## Numbered steps

1. **Add the runtime-lock inspection helpers in
   [src/runtime/recovery.ts](../../../../src/runtime/recovery.ts).**
   - Add `readRuntimeLockOwner(saivageDir: string): { pid: number;
     started_at: string } | null` — sync, reads
     `<saivageDir>/tmp/state/runtime.lock`, parses JSON, returns
     `null` on any failure (ENOENT, malformed JSON, missing `pid`).
   - Add `assertRuntimeLockHeld(saivageDir: string): void` — sync,
     calls `readRuntimeLockOwner`; if missing or `pid !==
     process.pid`, throws a plain `Error("knowledge-store: this
     process does not hold runtime.lock for " + saivageDir)`. The
     lifecycle layer converts to the typed `KnowledgeStoreError` in
     step 3.
   - Re-export both from the module.

2. **Add `NO_RUNTIME_LOCK` to the error taxonomy in
   [src/knowledge/store.ts](../../../../src/knowledge/store.ts#L31-L46).**
   - Extend `KnowledgeErrorCode` union with `"NO_RUNTIME_LOCK"`.
   - No other change in this step.

3. **Wire `assertRuntimeLockHeld` into every public writer in
   [src/knowledge/lifecycle.ts](../../../../src/knowledge/lifecycle.ts).**
   - Import `assertRuntimeLockHeld` from `../runtime/recovery.js`.
   - Add a one-line guard as the first statement of the writers that
     receive `saivageRoot` directly: `createSkill`, `updateSkill`,
     `archiveSkill`, `deleteSkill`, `supersedeSkill`, `createMemory`,
     `updateMemory`, `archiveMemory`, `deleteMemory`,
     `supersedeMemory`.
   - **Do not** place the guard at the head of `archiveStage` /
     `archiveSession`. Those entry points take `projectRoot`, not
     `saivageRoot`. Instead, place the guard inside `archiveScope`
     immediately after
     `const saivageRoot = join(projectRoot, ".saivage")`
     ([src/knowledge/lifecycle.ts](../../../../src/knowledge/lifecycle.ts#L869-L877)).
     This keeps both archive entry points covered by exactly one
     guard call on the correct directory.
   - Wrap each guard call in
     `try { assertRuntimeLockHeld(saivageRoot); } catch (err) {
     throw new KnowledgeStoreError("NO_RUNTIME_LOCK", err.message); }`.
   - Read-only functions (`getMemory`, `findSkillById`,
     `listAllRecords`, the loader path) are NOT guarded; readers
     may run in any process.

4. **Replace the misleading lock primitives in
   [src/knowledge/store.ts](../../../../src/knowledge/store.ts#L67-L125).**
   - Delete module-scoped `recordLocks` and `scopeLocks`.
   - Delete the internal `acquire(map, key)` helper.
   - Delete the public exports `acquireRecordLock`, `acquireScopeLock`,
     `acquireTwoRecordLocks`, `recordLockKey`, `scopeLockKey`.
   - **Do not** introduce a replacement export under `store.ts`. The
     store's public surface no longer advertises any lock.

5. **Rewrite the store-layer prose that still references the deleted
   contract.**
   - File header at
     [src/knowledge/store.ts](../../../../src/knowledge/store.ts#L1-L11)
     — replace "per-record + per-scope mutexes, and the two-key
     supersede lock" with: "Single-writer per project enforced by
     `runtime.lock`; in-process serialisation of collision-sensitive
     scope mutations and supersedes is owned privately by
     `src/knowledge/lifecycle.ts`. The store layer is lock-free at
     its public surface."
   - `writeRecordAtomic` doc at
     [src/knowledge/store.ts](../../../../src/knowledge/store.ts#L211-L212)
     — remove the "Caller is responsible for acquiring the per-record
     mutex (use `acquireRecordLock(recordLockKey(record))`)"
     sentence. Replace with: "Single-writer is enforced by the
     lifecycle layer (`assertRuntimeLockHeld` + the in-process
     queues); this primitive performs only the tmp+fsync+rename
     write."
   - `rebuildIndex` doc at
     [src/knowledge/store.ts](../../../../src/knowledge/store.ts#L379-L380)
     — replace "Idempotent; caller holds the per-scope lock" with
     "Idempotent; serialised per scope by the lifecycle layer."

6. **Introduce the module-private in-process lock helpers in
   [src/knowledge/lifecycle.ts](../../../../src/knowledge/lifecycle.ts).**
   - Add module-private `scopeLifecycleLocks: Map<string,
     Promise<void>>` and `supersedeLocks: Map<string, Promise<void>>`.
   - Add module-private `withChainLock<T>(map, key, fn)`:
     ```ts
     const prev = map.get(key) ?? Promise.resolve();
     let release!: () => void;
     const next = new Promise<void>((res) => { release = res; });
     map.set(key, prev.catch(() => undefined).then(() => next));
     await prev.catch(() => undefined);
     try { return await fn(); }
     finally {
       release();
       if (map.get(key) === next) map.delete(key);
     }
     ```
     The `prev.catch(() => undefined)` discipline incorporates G39's
     fix at construction time; a thrown holder does not poison the
     slot.
   - Add module-private wrappers:
     - `withScopeLifecycleLock(kind, scope, scope_ref, fn)` — builds
       key `<kind>:<scope>:<scope_ref|_>`.
     - `withSupersedeLock(oldId, fn)` — builds key `<oldId>`.
   - Do **not** export any of these. They live in `lifecycle.ts`
     only.

7. **Wrap collision-sensitive scope mutations in
   `withScopeLifecycleLock`.**
   - `createSkill`
     ([src/knowledge/lifecycle.ts](../../../../src/knowledge/lifecycle.ts#L222-L267))
     — wrap the body **after** the `assertRuntimeLockHeld` guard,
     starting from `collectScopeActiveRecords` through `safeRebuild`,
     in `withScopeLifecycleLock("skill", input.scope,
     input.scope_ref, async () => { … })`. The active-name check now
     runs inside the critical section.
   - `createMemory`
     ([src/knowledge/lifecycle.ts](../../../../src/knowledge/lifecycle.ts#L466-L500))
     — same shape: wrap after the guard, key on `("memory",
     input.scope, input.scope_ref)`. The topic-key uniqueness check
     now runs inside the critical section.
   - `archiveScope` per-kind sweep
     ([src/knowledge/lifecycle.ts](../../../../src/knowledge/lifecycle.ts#L869-L877))
     — wrap each `archiveOneKind(...)` call in
     `withScopeLifecycleLock(kind, scope, scopeRef, …)` so a
     concurrent `createSkill` / `createMemory` cannot land a new
     active record into the scope mid-archive.

8. **Rewrite `supersedeSkill` as a mirror of `supersedeMemory`.**
   - In
     [src/knowledge/lifecycle.ts](../../../../src/knowledge/lifecycle.ts#L357-L424):
     1. Run `assertRuntimeLockHeld(saivageRoot)`.
     2. `const preFound = await findSkillById(saivageRoot,
        input.old_id)`; if missing, throw `NOT_FOUND`. **This call is
        only used to obtain the lock key.**
     3. `return withSupersedeLock(preFound.record.id, async () =>
        { … })`.
     4. Inside the lock: `const oldFound = await
        findSkillById(saivageRoot, input.old_id)`. If missing, throw
        `NOT_FOUND`. **Re-check** `isAllowedSupersedeScopePair`,
        `oldFound.record.status === "active"`, and the secret /
        blocked-path scans — all using the freshly-loaded record.
     5. Then execute the existing write sequence (new body + new
        record + rewrite old + audit + per-scope rebuilds). The
        existing rollback-on-write-failure block is preserved.

9. **Convert `supersedeMemory` to the new helper.**
   - Replace the `acquireRecordLock(recordLockKey(...))` /
     `try { … } finally { release(); }` block at
     [src/knowledge/lifecycle.ts](../../../../src/knowledge/lifecycle.ts#L587-L600)
     with `return withSupersedeLock(preFound.record.id, async () =>
     { … })`. The existing inner re-find shape is preserved; only
     the locking primitive changes.

10. **Update writer tests to acquire the runtime lock and add the
    same-process race coverage.**
    - Files that **must** acquire the lock in `beforeEach` and
      release in `afterEach` (criterion: the test invokes a
      `lifecycle.ts` writer, directly or via an MCP handler):
      - [src/knowledge/concurrency.test.ts](../../../../src/knowledge/concurrency.test.ts)
      - [src/knowledge/regression.test.ts](../../../../src/knowledge/regression.test.ts)
      - [src/knowledge/lifecycle.archive.test.ts](../../../../src/knowledge/lifecycle.archive.test.ts)
      - [src/mcp/knowledgeSkills.test.ts](../../../../src/mcp/knowledgeSkills.test.ts)
      - [src/mcp/knowledgeMemory.test.ts](../../../../src/mcp/knowledgeMemory.test.ts)
      - any other file revealed by
        `rg -l "createSkill|createMemory|updateSkill|updateMemory|archiveSkill|archiveMemory|deleteSkill|deleteMemory|supersedeSkill|supersedeMemory|archiveStage|archiveSession" src/` whose `beforeEach`
        sets up a temp project root.
    - **Excluded** (do NOT add the lock):
      [src/agents/knowledge.agent.test.ts](../../../../src/agents/knowledge.agent.test.ts)
      — exercises loader-side reads only; it does not call
      `lifecycle.ts` writers.
    - For the MCP test files (which `mkdtempSync` a project root
      *without* calling `initProjectTree`), the `beforeEach` helper
      must create `<projectRoot>/.saivage/tmp/state/` before
      `acquireRuntimeLock`; do not rely on `initProjectTree` doing it.
    - Delete the "Lock-primitive tests" describe block in
      `concurrency.test.ts` (matches the deleted exports).
    - Delete the lock-primitive block in
      [src/knowledge/store.test.ts](../../../../src/knowledge/store.test.ts).
    - Add to `concurrency.test.ts`:
      - **Duplicate-name `createSkill` race**: two parallel
        `createSkill` calls in the same scope with the same `name`;
        exactly one resolves, the other rejects with
        `NAME_COLLISION`; on-disk active set contains exactly one
        record with that name.
      - **Duplicate-topic `createMemory` race**: same shape for
        `TOPIC_COLLISION` keyed on `(domain, subject, aspect)`.
      - **Same-id `supersedeSkill` race**: two parallel
        `supersedeSkill` calls on the same old id; exactly one
        resolves; the other rejects with `INVALID_SUPERSEDE_TARGET`;
        the old record's `superseded_by` points to the winner; no
        dangling new record.
    - Add to `lifecycle.archive.test.ts`:
      - `archiveStage` succeeds while the runtime lock is held
        (positive test that the path conversion is correct).
      - `archiveStage` and `archiveSession` reject with
        `NO_RUNTIME_LOCK` when no lock is held (negative test that
        catches any future regression of the
        `projectRoot` / `saivageRoot` conversion).

11. **Add direct runtime-lock contract tests.**
    - New file `src/runtime/runtimeLock.test.ts`. Assertions:
      - Successful acquisition writes
        `{ pid: process.pid, started_at: <ISO> }` to
        `<saivageDir>/tmp/state/runtime.lock`.
      - A second `acquireRuntimeLock(saivageDir)` while the first
        lock is live rejects with the existing "Another Saivage
        instance is already running" error.
      - `release()` deletes the lock file; a subsequent
        `acquireRuntimeLock` succeeds.
      - Stale lock (dead pid written into the file) is removed and
        re-acquired.
      - Malformed lock file body (non-JSON / missing pid) is treated
        as stale.
      - `readRuntimeLockOwner` returns `null` when no file exists,
        `null` on malformed body, and `{ pid, started_at }` for a
        valid owner.
      - `assertRuntimeLockHeld` throws when no lock exists; throws
        when another pid owns the lock (simulate via writing a fake
        owner file with a foreign pid); returns silently when
        `process.pid` owns the lock.
      - Per-writer contract (one happy-path assertion): an authorized
        `createMemory` invocation rejects with a `KnowledgeStoreError`
        whose `code === "NO_RUNTIME_LOCK"` when called without
        acquiring the lock.

12. **Add `withChainLock` poisoning test.**
    - In [src/knowledge/concurrency.test.ts](../../../../src/knowledge/concurrency.test.ts):
      add a unit test that uses an exported test-only thin wrapper
      around `withChainLock` (or, preferably, asserts the same
      property end-to-end via two `createSkill` calls where the first
      throws synchronously inside `withScopeLifecycleLock` and the
      second still completes). Confirms a thrown holder does not
      poison the queue slot for the next caller. (This is the G39
      regression test, owned by this plan.)

13. **Rewrite [SPEC/v2/skills-memory/01-DESIGN.md](../../skills-memory/01-DESIGN.md) §K.**
    - Replace the "Cross-process concurrency on the same `.saivage/`"
      bullet with: enforced at runtime by `assertRuntimeLockHeld` in
      every public writer; second-daemon boot is rejected by
      `acquireRuntimeLock`; non-daemon writers must acquire the lock
      themselves before invoking knowledge tools; same-process
      collision-sensitive scope mutations and supersedes are
      serialised by module-private queues inside `lifecycle.ts`.
    - Update §L FR-29 row to reference the new enforcement point.
    - Retain the `flock(2)` alternative as the documented migration
      path to Proposal A (only if multi-process workers ever return
      to the roadmap).

14. **Hygiene sweep.**
    - `npx tsc --noEmit` — confirm no remaining importers of the
      deleted exports.
    - Identifier sweep:
      `rg -n 'recordLockKey|scopeLockKey|acquireRecordLock|acquireScopeLock|acquireTwoRecordLocks' src/`
      must return zero hits.
    - **Prose sweep** (new):
      `rg -n 'per-record mutex|per-scope lock|two-key supersede lock|caller holds the per-scope lock|caller is responsible for acquiring the per-record mutex' src/ SPEC/`
      must return zero hits.
    - `rg -n 'withChainLock|withScopeLifecycleLock|withSupersedeLock|scopeLifecycleLocks|supersedeLocks' src/`
      must show hits **only** in `src/knowledge/lifecycle.ts` and its
      test file (i.e. the helpers stay module-private).

## Validation

Run from the saivage workspace root before pushing:

```
cd /home/salva/g/ml/saivage
npx tsc --noEmit
npx vitest run src/knowledge src/runtime src/agents src/mcp
npm run build
npm run lint
```

Additionally, exercise the negative-path assertion manually:

```
node --input-type=module -e '
  import("./dist/knowledge/lifecycle.js").then(async ({ createMemory }) => {
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { initProjectTree } = await import("./dist/store/project.js");
    const root = mkdtempSync(join(tmpdir(), "g38-"));
    await initProjectTree(root);
    try {
      await createMemory(join(root, ".saivage"), {
        topic: { domain: "d", subject: "s" },
        body: "b", scope: "project", reason: "r",
      }, { role: "manager", agent_id: "x" });
      console.error("FAIL: expected NO_RUNTIME_LOCK");
      process.exit(1);
    } catch (e) {
      if (e && e.code === "NO_RUNTIME_LOCK") {
        console.log("OK"); process.exit(0);
      }
      console.error("FAIL:", e); process.exit(1);
    }
  });
'
```

Then re-check that the live daemons remain healthy (read-only probes
only — knowledge writes happen through them and would be exercised
by their normal workload):

```
curl -fsS http://10.0.3.112:8080/health
curl -fsS http://10.0.3.170:8080/health
curl -fsS http://10.0.3.113:8080/health
```

Do not redeploy to the daemons as part of this plan; deployment is
the operator's call. The change is source-tree only.

## Rollback

- All changes land on a single feature branch; if any validation
  step above fails, `git restore --source=HEAD --staged --worktree
  <files>` per-file. Do **not** `git reset --hard`.
- If the change has already been merged and a regression is detected
  in production, revert via `git revert <merge-sha>` and open a
  follow-up; do not force-push.
- The on-disk format does not change (no `.saivage/locks/` directory
  is introduced under Proposal B), so no filesystem rollback is
  needed on any project tree.

## Running daemons

- This plan touches source only. No daemon needs to be stopped or
  restarted to land it.
- After merge, operators may redeploy `saivage-v3.service`,
  `saivage-v3-getrich.service`, and `saivage.service` at their normal
  cadence. On first boot under the new build, the existing
  `runtime.lock` continues to work unchanged; nothing in
  `.saivage/tmp/state/` requires migration.
- Containers `saivage` (10.0.3.111), `saivage-v3` (10.0.3.112),
  `saivage-v3-getrich-v2` (10.0.3.170), and `diedrico` (10.0.3.113)
  each target a distinct project root and continue to do so — no
  operational change required.

## Out of scope

- Inter-process locking (`flock` / `proper-lockfile`) — covered by
  Design Proposal A, retained in `02-design-r1.md` and
  `02-design-r2.md` as the future migration path if Saivage ever
  grows multi-process workers.
- SQLite/WAL — rejected as a different system, not a remediation.
- Refactoring `writeRecordAtomic` / `appendJsonlAtomic` — unrelated.
- Any change to the read path (`eagerLoader`, `loader`) — readers
  are intentionally lock-free per design §C.3 and remain so.
- [src/agents/knowledge.agent.test.ts](../../../../src/agents/knowledge.agent.test.ts)
  — loader-only; explicitly excluded from the test migration.
