# G38 - Review r1

## Findings

### 1. Proposal B does not close the same-process writer race the analysis itself identifies

The recommendation says Proposal B "closes the only real same-process gap" by adding a `supersedeSkill` interlock ([SPEC/v2/review-2026-05-round2/G38/02-design-r1.md](SPEC/v2/review-2026-05-round2/G38/02-design-r1.md#L221-L222)). That is not true. The analysis explicitly calls out same-process duplicate `createSkill` as reachable and unprotected ([SPEC/v2/review-2026-05-round2/G38/01-analysis-r1.md](SPEC/v2/review-2026-05-round2/G38/01-analysis-r1.md#L233)), and the same shape exists for `createMemory`: both functions collect active records, check uniqueness, then write and rebuild the index without any critical section ([src/knowledge/lifecycle.ts](src/knowledge/lifecycle.ts#L230-L267), [src/knowledge/lifecycle.ts](src/knowledge/lifecycle.ts#L466-L500)). A runtime process lock prevents a second Node process; it does not serialize two async tool calls inside the one daemon.

This matters because B removes the public `scopeLocks` instead of replacing them with a used, private lifecycle-level scope mutation queue. That is right for deleting misleading public API, but not enough for the actual invariant: active `name` / `topic` uniqueness and full-scope `index.json` rebuilds are scope-level read-modify-write operations. The existing concurrency test only proves distinct-topic creates both appear in the index ([src/knowledge/concurrency.test.ts](src/knowledge/concurrency.test.ts#L101-L122)); it does not prove duplicate-topic or duplicate-name callers serialize.

Required change: either include a private, G39-safe lifecycle queue for collision-sensitive scope mutations (`createSkill`, `createMemory`, and any mutation whose correctness depends on a whole-scope read plus rebuild), or explicitly split that same-process scope race into a separate finding and remove B's "only real same-process gap" claim. If the queue is added here, its promise chain must use the same `prev.catch(() => {})` discipline and must have tests for concurrent duplicate `createSkill` / `createMemory` where exactly one caller wins with `NAME_COLLISION` / `TOPIC_COLLISION`.

### 2. The `supersedeSkill` step can still race if it uses stale `oldFound`

The plan says to wrap `supersedeSkill` in `withSupersedeLock(oldFound.record.id, ...)` ([SPEC/v2/review-2026-05-round2/G38/03-plan-r1.md](SPEC/v2/review-2026-05-round2/G38/03-plan-r1.md#L62-L65)). As written, that requires finding `oldFound` before entering the lock, and the plan does not say to re-read the old record inside the critical section. That would leave the exact stale-read bug intact: two callers can both observe an active old skill, queue on the same id, and the second can proceed using its pre-lock `oldFound.record.status` after the first has already superseded it.

`supersedeMemory` avoids this by doing a pre-find only to compute the lock key, then re-reading the old record after the lock is acquired ([src/knowledge/lifecycle.ts](src/knowledge/lifecycle.ts#L584-L595)). `supersedeSkill` needs the same shape, not a mechanical wrapper around the current body ([src/knowledge/lifecycle.ts](src/knowledge/lifecycle.ts#L357-L424)).

Required change: specify a `supersedeSkill` implementation that pre-finds for the key, enters the lock, re-runs `findSkillById`, re-checks scope/status, and only then writes the new/old pair. Add the parallel `supersedeSkill` test mirroring the existing `supersedeMemory` race test so exactly one caller succeeds and the rest fail with `INVALID_SUPERSEDE_TARGET`.

### 3. The runtime-lock guard path is wrong for stage/session archival

Design B says every public lifecycle writer opens with `assertRuntimeLockHeld(saivageRoot)` ([SPEC/v2/review-2026-05-round2/G38/02-design-r1.md](SPEC/v2/review-2026-05-round2/G38/02-design-r1.md#L129)), and the plan lists `archiveStage` and `archiveSession` in that same one-line guard step ([SPEC/v2/review-2026-05-round2/G38/03-plan-r1.md](SPEC/v2/review-2026-05-round2/G38/03-plan-r1.md#L37-L38)). But those two functions accept `projectRoot`, not `.saivage`, and delegate to `archiveScope`, which derives `saivageRoot = join(projectRoot, ".saivage")` internally ([src/knowledge/lifecycle.ts](src/knowledge/lifecycle.ts#L869-L877), [src/knowledge/lifecycle.ts](src/knowledge/lifecycle.ts#L947-L957)).

If the guard is inserted literally as the first statement with the function argument, it will check `<projectRoot>/tmp/state/runtime.lock` instead of `<projectRoot>/.saivage/tmp/state/runtime.lock` and reject legitimate production archival. This is a correctness bug in the implementation plan, not just prose imprecision.

Required change: spell out the path conversion. Either guard inside `archiveScope` after deriving `saivageRoot`, or guard `archiveStage` / `archiveSession` with `assertRuntimeLockHeld(join(projectRoot, ".saivage"))`. Add an archival test that acquires the real runtime lock for the temp project and proves `archiveStage` and `archiveSession` still work.

### 4. The test migration misses writer call sites and does not test the runtime lock contract hard enough

The plan says to add runtime-lock acquisition to tests found by `grep -l "initProjectTree"` and names [src/agents/knowledge.agent.test.ts](src/agents/knowledge.agent.test.ts) as a target ([SPEC/v2/review-2026-05-round2/G38/03-plan-r1.md](SPEC/v2/review-2026-05-round2/G38/03-plan-r1.md#L83-L88)). That search criterion misses MCP handler tests that create temp project roots without `initProjectTree` and then call lifecycle writers through the handlers: [src/mcp/knowledgeSkills.test.ts](src/mcp/knowledgeSkills.test.ts#L45-L58), [src/mcp/knowledgeSkills.test.ts](src/mcp/knowledgeSkills.test.ts#L70-L83), [src/mcp/knowledgeMemory.test.ts](src/mcp/knowledgeMemory.test.ts#L37-L43), [src/mcp/knowledgeMemory.test.ts](src/mcp/knowledgeMemory.test.ts#L76-L104). It also over-includes [src/agents/knowledge.agent.test.ts](src/agents/knowledge.agent.test.ts), which only exercises loader-side records and does not call lifecycle writers.

The runtime-lock side also needs direct tests. Current runtime tests cover `isAnotherInstanceRunning` stale/idle state ([src/runtime/runtime.test.ts](src/runtime/runtime.test.ts#L1228-L1261)), but the hard contract in B depends on `acquireRuntimeLock`, owner inspection, release, stale/malformed lock handling, and `NO_RUNTIME_LOCK` conversion. The source has the lock implementation in [src/runtime/recovery.ts](src/runtime/recovery.ts#L83-L147) and release in [src/runtime/recovery.ts](src/runtime/recovery.ts#L150-L157), but the plan only adds one negative lifecycle test.

Required change: build the test migration from actual writer usage, not just `initProjectTree`. Update the direct lifecycle tests, MCP handler tests, and MCP runtime integration tests that perform authorized writes. Add runtime-lock tests for: acquiring writes a pid owner, second acquisition fails while the first lock is live, release removes the lock, stale or malformed locks follow the chosen policy, and lifecycle/MCP writer calls without the lock surface `NO_RUNTIME_LOCK` rather than an untyped error.

### 5. Dead-code removal is mostly right, but the new lock helper should not become another public store primitive

The plan correctly deletes `recordLocks`, `scopeLocks`, `acquire*`, and key-construction exports, which also removes the poisonable `map.set(key, prev.then(...))` chain ([src/knowledge/store.ts](src/knowledge/store.ts#L67-L92), [src/knowledge/store.ts](src/knowledge/store.ts#L102-L125)). That direction subsumes G39 if every replacement chain uses `prev.catch(() => {})` and is covered by a rejection test.

However, the design calls the replacement a "private `supersedeLocks` map" ([SPEC/v2/review-2026-05-round2/G38/02-design-r1.md](SPEC/v2/review-2026-05-round2/G38/02-design-r1.md#L128-L129)), while the plan says to export `withSupersedeLock` from `store.ts` ([SPEC/v2/review-2026-05-round2/G38/03-plan-r1.md](SPEC/v2/review-2026-05-round2/G38/03-plan-r1.md#L49-L52)). That keeps a lock-shaped public store primitive immediately after the plan's main architectural point is that the store should not advertise lock ownership. The store comments also need more than the header rewrite: `writeRecordAtomic` still tells callers to acquire `acquireRecordLock(recordLockKey(record))`, and `rebuildIndex` still says the caller holds a per-scope lock ([src/knowledge/store.ts](src/knowledge/store.ts#L211-L212), [src/knowledge/store.ts](src/knowledge/store.ts#L379-L380)).

Required change: keep the replacement lock helpers private to the lifecycle module if possible, or at least make them narrowly internal and not part of the store's public lock surface. Update all stale comments that mention per-record/per-scope caller-held locks, and extend the hygiene sweep to fail on prose references to the deleted lock contract, not just import identifiers.

## Non-blocking notes

- The writer is right that `supersedeMemory` is the only production user of the current public lock helpers. Grep finds the lock imports/calls in tests plus the single production call in [src/knowledge/lifecycle.ts](src/knowledge/lifecycle.ts#L587-L592).
- The runtime-lock claim is substantially correct for supported CLI/server entry points: `start`, `inspect`, and `serve` call `bootstrap` ([src/server/cli.ts](src/server/cli.ts#L70-L73), [src/server/cli.ts](src/server/cli.ts#L229-L252), [src/server/cli.ts](src/server/cli.ts#L318-L324)), and `bootstrap` acquires the exclusive `.saivage/tmp/state/runtime.lock` before returning the runtime ([src/server/bootstrap.ts](src/server/bootstrap.ts#L172-L180)). The lock itself uses `openSync(lockPath, "wx")` and rejects a live owner ([src/runtime/recovery.ts](src/runtime/recovery.ts#L83-L147)).
- Choosing B over `flock` is the right architectural direction for the current supported deployment model: make the existing single-process-per-project invariant explicit, delete the misleading public lock surface, and avoid supporting a multi-process mode the design already rejects. The requested changes above are about making B honest for in-process concurrency and implementation details, not about switching to Proposal A.
- No backward-compat shim is being preserved. The plan deletes old exports and old primitive tests, which matches the project guideline.

## Required change count

5

VERDICT: CHANGES_REQUESTED