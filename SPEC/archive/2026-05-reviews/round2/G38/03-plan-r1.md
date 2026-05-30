# G38 — Plan r1 (implements Proposal B)

## Scope

Formalise single-writer-per-project as a runtime-enforced contract
for the knowledge store. Delete the misleading lock primitives.
Subsume G39 (lock-chain poisoning) by removing the poisonable chain.

## Cross-finding coordination with G39

G38 and G39 are the **same lock manager**. Land them together as a
single change set: the deletions required by G38 remove the construct
G39 patches, so attempting G39 in isolation would write code that
G38 then deletes. Order of work below assumes the combined landing.

If for any reason G39 must ship first (smaller blast radius, urgent
hotfix), apply only G39's `catch(() => {})` patch and add a deprecation
comment pointing at this plan; do not introduce any new callers of
the deprecated lock helpers.

## Numbered steps

1. **Add the runtime-lock inspection helpers in
   [src/runtime/recovery.ts](../../../../src/runtime/recovery.ts).**
   - Add `readRuntimeLockOwner(saivageDir: string): { pid: number; started_at: string } | null` — sync, reads `.saivage/tmp/state/runtime.lock`, parses JSON, returns `null` on any failure.
   - Add `assertRuntimeLockHeld(saivageDir: string): void` — calls `readRuntimeLockOwner`; if missing or `pid !== process.pid`, throws `new Error("knowledge-store: this process does not hold runtime.lock for " + saivageDir)`. Sync, ≤20 LoC.
   - Re-export both from the module.

2. **Add `NO_RUNTIME_LOCK` to the error taxonomy in
   [src/knowledge/store.ts](../../../../src/knowledge/store.ts#L31-L46).**
   - Extend `KnowledgeErrorCode` union with `"NO_RUNTIME_LOCK"`.
   - No other change in this step.

3. **Wire `assertRuntimeLockHeld` into every public writer in
   [src/knowledge/lifecycle.ts](../../../../src/knowledge/lifecycle.ts).**
   - Import `assertRuntimeLockHeld` from `../runtime/recovery.js`.
   - Add a one-line guard as the first statement of: `createSkill`, `updateSkill`, `archiveSkill`, `deleteSkill`, `supersedeSkill`, `createMemory`, `updateMemory`, `archiveMemory`, `deleteMemory`, `supersedeMemory`, `archiveStage`, `archiveSession`.
   - Wrap the guard so it throws `new KnowledgeStoreError("NO_RUNTIME_LOCK", err.message)` instead of the bare error.
   - Read-only functions (`getMemory`, `findSkillById`, `listAllRecords`) are NOT guarded — readers may run in any process.

4. **Replace the misleading lock primitives in
   [src/knowledge/store.ts](../../../../src/knowledge/store.ts#L67-L100).**
   - Delete module-scoped `recordLocks` and `scopeLocks`.
   - Delete the internal `acquire(map, key)` helper, plus the public exports `acquireRecordLock`, `acquireScopeLock`, `acquireTwoRecordLocks`, `recordLockKey`, `scopeLockKey`.
   - Rewrite the header comment block at [src/knowledge/store.ts](../../../../src/knowledge/store.ts#L1-L11) to describe the actual contract: "Single-writer per project enforced by `runtime.lock`; supersede ops use a small private in-process map to serialise concurrent same-id supersedes."

5. **Introduce the private `supersedeLocks` map in
   [src/knowledge/store.ts](../../../../src/knowledge/store.ts).**
   - Export one helper `withSupersedeLock(id: string, fn: () => Promise<T>): Promise<T>` (or equivalent shape — single export, no key construction by callers).
   - Implementation builds the chain with `prev.catch(() => {}).then(() => next)` and a `try { … } finally { release(); }` discipline — this incorporates G39's fix at construction time.
   - One unit test in
     [src/knowledge/store.test.ts](../../../../src/knowledge/store.test.ts)
     asserts: (a) two callers on the same id serialise FIFO; (b) a
     thrown error in the first caller does not poison the chain for
     the second caller.

6. **Update the two supersede callers in
   [src/knowledge/lifecycle.ts](../../../../src/knowledge/lifecycle.ts).**
   - `supersedeMemory`: replace the existing `acquireRecordLock(recordLockKey(...))` block at
     [src/knowledge/lifecycle.ts](../../../../src/knowledge/lifecycle.ts#L587-L600)
     with `withSupersedeLock(preFound.record.id, async () => { … existing body … })`.
   - `supersedeSkill`: wrap the whole body (currently locks nothing,
     [src/knowledge/lifecycle.ts](../../../../src/knowledge/lifecycle.ts#L398-L450))
     in the same `withSupersedeLock(oldFound.record.id, …)`. This
     closes the same-process supersede race that the analysis flagged.

7. **Rewrite [src/knowledge/concurrency.test.ts](../../../../src/knowledge/concurrency.test.ts).**
   - Delete the "Lock-primitive tests" describe block (matches the
     deleted exports).
   - Keep the "parallel lifecycle writes" describe block; in
     `beforeEach`, after `initProjectTree(projectRoot)`, call
     `await acquireRuntimeLock(join(projectRoot, ".saivage"))` and
     store the `RuntimeLock` for release in `afterEach`.
   - Keep the "supersedeMemory — two-key atomicity & chain repair"
     describe block unchanged in behaviour; the test passes against
     the new `withSupersedeLock`.

8. **Rewrite [src/knowledge/store.test.ts](../../../../src/knowledge/store.test.ts).**
   - Delete the lock-primitive tests.
   - Add the two `withSupersedeLock` tests called out in step 5.

9. **Add `runtime.lock` acquisition to the remaining writer tests.**
   - Files: [src/knowledge/regression.test.ts](../../../../src/knowledge/regression.test.ts),
     [src/knowledge/lifecycle.archive.test.ts](../../../../src/knowledge/lifecycle.archive.test.ts),
     [src/agents/knowledge.agent.test.ts](../../../../src/agents/knowledge.agent.test.ts),
     and any other test under `src/` whose `grep -l "initProjectTree"` shows it invokes `lifecycle.ts` writers.
   - Pattern: in `beforeEach`, add `runtimeLock = await acquireRuntimeLock(saivage)`; in `afterEach`, `runtimeLock.release()`.

10. **Add the negative-path test.**
    - New test in
      [src/knowledge/regression.test.ts](../../../../src/knowledge/regression.test.ts)
      (or a new `lifecycle.runtime-lock.test.ts`):
      `await initProjectTree(projectRoot)` and then call
      `createMemory(...)` *without* acquiring the runtime lock —
      assert it rejects with `KnowledgeStoreError` whose `code` is
      `"NO_RUNTIME_LOCK"`.

11. **Rewrite [SPEC/v2/skills-memory/01-DESIGN.md](../../skills-memory/01-DESIGN.md) §K.**
    - Replace the "Cross-process concurrency on the same `.saivage/`"
      bullet with: enforced at runtime by `assertRuntimeLockHeld` in
      every public writer; second-daemon boot is rejected by
      `acquireRuntimeLock`; non-daemon writers must acquire the lock
      themselves before invoking knowledge tools.
    - Update §L FR-29 row to reference the new enforcement point.
    - Remove the "Reserved as the migration path if Saivage ever grows
      multi-process workers" comma in the `flock(2)` bullet only if
      multi-process is no longer on the roadmap; otherwise leave as
      future direction with a pointer to G38 design proposal A.

12. **Hygiene sweep.**
    - `npx tsc --noEmit` — confirm no remaining importers of the
      deleted exports.
    - `grep -nR "recordLockKey\|scopeLockKey\|acquireRecordLock\|acquireScopeLock\|acquireTwoRecordLocks" src/`
      should return zero hits.
    - Update [src/knowledge/store.ts](../../../../src/knowledge/store.ts#L1-L11)
      header to remove any reference to "per-record + per-scope
      mutexes, and the two-key supersede lock".

## Validation

Run from the saivage workspace root before pushing:

```
cd /home/salva/g/ml/saivage
npx tsc --noEmit
npx vitest run src/knowledge src/runtime src/agents
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

- All changes land on a single feature branch; if any validation step
  above fails, `git restore --source=HEAD --staged --worktree <files>`
  per-file. Do **not** `git reset --hard`.
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
  Design Proposal A, retained in `02-design-r1.md` as the future
  migration path if Saivage ever grows multi-process workers.
- SQLite/WAL — rejected as a different system, not a remediation.
- Refactoring `writeRecordAtomic` / `appendJsonlAtomic` — unrelated.
- Any change to the read path (`eagerLoader`, `loader`) — readers are
  intentionally lock-free per design §C.3 and remain so.
