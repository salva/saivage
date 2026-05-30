# F22 — Document Store Sync FS — Design r1

Three proposals, ordered by blast radius (smallest first).

---

## Proposal A — Full async conversion of `documents.ts` and every caller

### Scope

Rewrite [src/store/documents.ts](src/store/documents.ts) to use `fs/promises` (`fs.readFile`, `fs.writeFile`, `fs.rename`, `fs.unlink`, `fs.readdir`, `fs.mkdir`, `fs.stat`, `fs.open`, `FileHandle.sync`, `FileHandle.close`) for every operation. Every exported function becomes `async`. Replace `existsSync` checks with `fs.access` / `fs.stat` catches, or — preferably — let the read itself produce the `ENOENT` and convert it in the `OrNull` helpers. Keep schema parsing synchronous.

Touched files in `src/` (every importer of `documents.ts`, excluding tests, the out-of-scope `src/knowledge/*`, and `src/store/project.ts` knowledge-seeding paths that use `writeFileSync` directly):

- [src/store/documents.ts](src/store/documents.ts) — full rewrite, ~180 lines.
- [src/store/project.ts](src/store/project.ts#L62-L91): `loadProject` and `initProject` become async. `discoverProject` becomes async (it uses `existsSync` only — change to `fs.access`).
- [src/server/server.ts](src/server/server.ts): every handler that calls `readDocOrNull` / `readDocLenient` / `readJsonOrNull` / `listDocs` becomes `async`. Fastify handlers can already return promises, so this is mostly adding `await`. The raw `readFileSync` / `readdirSync` / `statSync` calls in [/api/files](src/server/server.ts#L420-L502), [/api/debug/errors](src/server/server.ts#L505-L606), [/api/debug/timeline](src/server/server.ts#L608-L662), [/api/chats](src/server/server.ts#L295-L358) must also migrate to `fs.promises`. ~30 call sites.
- [src/runtime/recovery.ts](src/runtime/recovery.ts): `recoverFromCrash`, `writeRuntimeState`, `RuntimeTracker.flush`, `acquireRuntimeLock` (only the `ensureDir(stateDir)` call — the actual `O_EXCL` open stays sync, see Risk below). All become async. ~7 call sites + tracker plumbing.
- [src/runtime/notes.ts](src/runtime/notes.ts): `NoteManager.createNote`, `acknowledgeNote`, `deleteNote`, `listNotes`, `clearNotes`, `loadNote` all become async. ~5 sites. Note: `NoteManager` is constructed per-HTTP-call in [src/server/server.ts](src/server/server.ts#L264-L292), so async fits naturally there.
- [src/runtime/abort.ts](src/runtime/abort.ts): the one `readDoc` call becomes `await`.
- [src/runtime/shutdown-handoff.ts](src/runtime/shutdown-handoff.ts): the 3 calls become `await`.
- [src/agents/chat.ts](src/agents/chat.ts): already uses `await writeDoc(...)` and `await ensureDir(...)` shape in places; the read sites need `await`. ~5 sites.
- [src/agents/handoff.ts](src/agents/handoff.ts): the one `readDocLenient` becomes `await`.
- [src/mcp/plan-server.ts](src/mcp/plan-server.ts#L82-L264): every method (`plan_get`, `plan_history`, `stage_add`, `stage_update`, `task_*`, `plan_complete_stage`, etc.) becomes async. ~14 sites. The dispatcher already invokes plan tools through `await`, so the callers don't need further updates.
- [src/server/bootstrap.ts](src/server/bootstrap.ts): the 3 `await writeRuntimeState(...)` calls already work. The `RuntimeTracker` callers in `bootstrap` and the per-role spawn paths need to switch to fire-and-forget through a coalescing queue (see Risk).
- **Cross-issue coupling**: [src/knowledge/store.ts](src/knowledge/store.ts#L250) and [L414](src/knowledge/store.ts#L414) need `await writeDoc(...)`. This is the only required change in the out-of-scope subsystem; deferring it breaks compilation. Coordinate with the skills/memory agent: either land F22 with a one-line `await` in those two sites (signature-compatible, no logic change), or block F22 on their explicit go-ahead.

### What gets added/removed

- Added: `async`/`await` everywhere, a small `RuntimeTracker` write coalescer (one pending write at a time, the next state replaces the queued state — needed so that 100 rapid `agentActivity` calls don't queue 100 fsyncs).
- Removed: every `*Sync` import from `node:fs` inside `documents.ts`, `project.ts`, and the server handlers above; the `await`-on-sync no-ops in `chat.ts` and `bootstrap.ts` become real awaits.
- **NOT added**: parallel sync API. No `readDocSync`. Per the project guideline there is one API, and it is async.

### Risk

1. **Runtime lock atomicity**: `acquireRuntimeLock`'s `openSync(lockPath, "wx")` is the *only* primitive that gives us `O_CREAT|O_EXCL` atomically. The `fs.promises.open(path, "wx")` equivalent does exist and is atomic at the syscall level; we keep using `wx`, just async. Low risk, but needs explicit test for two concurrent `acquireRuntimeLock` calls (already covered by [src/runtime/runtime.test.ts](src/runtime/runtime.test.ts)).
2. **`RuntimeTracker.flush` race**: today `flush` is sync, so the order of writes equals the order of calls. Async writes need a single-writer queue (one in-flight `Promise<void>`; on completion, if a newer state was set, write that — collapsing intermediate states). Otherwise rapid `agentActivity` ticks can interleave and an older state can land last. The good news: the existing `freeze()` already protects the final "idle" write — `freeze()` sets `frozen = true` *and* the bootstrap's final `await writeRuntimeState(...)` (with the literal final state) replaces whatever was queued. The queue design just has to honour `frozen` on dequeue.
3. **WebSocket / HTTP handler authoring discipline**: a route that forgets to `await` a `readDocOrNull` now returns a `Promise` instead of data. TypeScript catches this only if the helper's return type is `Promise<T>` and the handler's expected return is `T` — which it is. Compile-time safe.
4. **Test churn**: every test that calls `writeDoc(...)` / `readDoc(...)` synchronously must be updated. The Vitest suite has ~40 such sites. Mechanical change. No test runner changes.
5. **Cross-issue blast**: per the analysis, two `await` insertions in [src/knowledge/store.ts](src/knowledge/store.ts) are forced. The skills/memory agent must approve.

### What it enables

- Unblocks F11 (supervisor) from accidental "stuck" verdicts caused by disk waits.
- Unblocks F34 in-memory plan cache: the cache write becomes a real async fsync that we can batch.
- Frees the `/api/debug/*` endpoints to scale linearly with the project tree without freezing the SPA.
- Makes the existing `await writeDoc(...)` / `await writeRuntimeState(...)` calls semantically correct rather than aspirational.

### What it forbids

- No sync escape hatch. If something needs sync I/O in the future (e.g., a signal handler), it imports from `node:fs` directly with an inline justification — it does NOT call `documents.ts`. This keeps the contract one-way.
- No partial async ("async for HTTP, sync for agents"). That is Proposal C; A and C are mutually exclusive.

### Recommendation note

A is the architecturally correct end state. Its cost is one large mechanical commit + tracker queue. It is not high risk per change site — each site is `await` + signature change — but the total number of sites is large.

---

## Proposal B — Keep sync; add atomicity hardening and a fast-path read cache

### Scope

Acknowledge that the *atomicity* contract is fine and the *fsync* cost is fine for writes, but the **HTTP read fan-out** is what kills the event loop. Solve only that:

- Keep `documents.ts` fully synchronous; no signature change.
- Add an in-memory LRU cache keyed by absolute path + last-known mtime, populated on `readDoc*` and invalidated on `writeDoc` / `deleteDoc` of the same path. Bound by entry count (e.g. 256) and by total bytes (e.g. 32 MiB).
- For the heavy debug endpoints, pre-aggregate at write time: when a stage's `summary.json` lands via `writeDoc`, eagerly index its `result`/`completed_at`/`issues` into a sidecar `.saivage/tmp/state/error-index.json` and `timeline-index.json`. `/api/debug/errors` and `/api/debug/timeline` then read one small file instead of fan-out.
- Add per-write locking via the existing runtime lock + per-path lock map for the few writers that are not under the runtime lock (planner tool calls run inside the locked runtime; chat persistence runs in the same process; tests use fresh tmpdirs). The "lock map" is one `Map<string, Promise<void>>` chained per path.

### Files touched

- [src/store/documents.ts](src/store/documents.ts): add cache + per-path serialiser. ~120 added lines, no signature change.
- New file `src/store/error-index.ts` (or fold into `recovery.ts` near `RuntimeTracker`): write-side hook that maintains `error-index.json` and `timeline-index.json`. ~150 lines.
- [src/agents/manager.ts](src/agents/manager.ts) (or wherever `summary.json` and reports are written — actually [src/agents/reviewer.ts](src/agents/reviewer.ts) and [src/agents/manager.ts](src/agents/manager.ts) via tool calls; need a single chokepoint, probably a new `writeStageArtifact` helper in `store/`): one call per write to update the indices.
- [src/server/server.ts](src/server/server.ts): `/api/debug/errors` and `/api/debug/timeline` switch to read the pre-aggregated index files. ~80 lines deleted, ~10 added.

### What gets added/removed

- Added: file cache, write-side index maintainer, two index JSON files.
- Removed: the O(N·M) fan-out loops in `/api/debug/errors` and `/api/debug/timeline`.
- **NOT** added: any async. The whole module stays sync. Existing `await writeDoc(...)` in `chat.ts` / `bootstrap.ts` is left as-is (await-on-sync is a JS no-op).

### Risk

1. **Cache invalidation correctness.** Anyone bypassing the helpers and writing directly via `fs` (e.g., the `writeFileSync` in [src/store/project.ts](src/store/project.ts#L160-L165), [src/knowledge/store.ts](src/knowledge/store.ts) for `audit.jsonl`) skirts invalidation. Either: (a) make those go through `writeDoc`; or (b) stamp every cache entry with `mtimeMs` and re-`statSync` on read. (b) defeats the purpose because the `statSync` itself is what we're trying to avoid in HTTP routes. (a) is feasible for `project.ts` but the knowledge subsystem is out-of-scope.
2. **The index file becomes another bottleneck.** Every stage-write or report-write now ALSO has to atomically rewrite `error-index.json` and `timeline-index.json`. Those become hotspots — same problem moved sideways unless we accept lossy indices.
3. **`/api/files/content` is still sync** and still reads up to 1 MiB inside the handler. The cache doesn't help arbitrary user files. We'd have to either size-limit aggressively or accept the block.
4. **`RuntimeTracker.flush` still blocks** on every agent activity tick. The cache doesn't help writes. Heartbeats still synchronously fsync the disk twice (until F08 lands). Proposal B improves HTTP latency but does NOT fix the agent-loop-blocking-supervisor problem the F22 issue file explicitly calls out.
5. **Atomicity addition for partial-writes.** The issue file mentions "partial-write risk" as a B-flavoured concern, but the current `writeDoc` already does tmp+rename+fsync+fsync-dir. There is no extra atomicity to add. The "atomic-write" framing of B as stated in the prompt is a strawman — atomicity is already there. What B can add is the **per-path serialiser** so two writers to the same path can't interleave (today no such case exists; would be a hedge against future bugs).

### What it enables

- Targeted reduction in HTTP route latency without touching agents.
- Index-file pattern can be reused for any future "sweep all stages" query (e.g. F11 supervisor health view).

### What it forbids

- A future move to async would have to throw the cache and the index sidecars away.
- The index sidecars become the canonical source for the debug views; if they drift from the underlying `summary.json` (because someone edits a summary by hand or restores from a backup), the views are wrong until the next write triggers a re-aggregation. F22 issue does not weight this risk.

### Recommendation note

B is a smaller change. It does **not** solve the issue as stated. The issue file explicitly calls out the agent activity loop and the supervisor disk-wait as failure modes. B leaves both of those untouched. B is acceptable only if we deliberately scope F22 to "HTTP debug routes only" and re-open agent-loop blocking as a separate issue.

---

## Proposal C — Mixed: sync at boot/init paths, async for runtime hot paths

### Scope

Split `documents.ts` along a clear axis: keep sync helpers (`readDocSync`, `writeDocSync`) only inside `src/store/` and only for boot/init paths (`loadProject`, `initProject`, `acquireRuntimeLock`'s `ensureDir`, `recoverFromCrash` — which only runs at startup). Expose async helpers as the *primary* API used everywhere else (HTTP, agents, MCP, runtime tracker).

In practice this means:

- [src/store/documents.ts](src/store/documents.ts): exposes async `readDoc`, `writeDoc`, etc. (Proposal A bodies).
- New `src/store/documents-sync.ts`: exposes `readDocSync`, `writeDocSync`, `ensureDirSync`, `readJsonOrNullSync` — same implementations as today.
- `loadProject` / `initProject` / `discoverProject` use the `-Sync` variants. `recoverFromCrash` uses the `-Sync` variants because it runs at boot before any HTTP listener exists.
- Everything else (server.ts, plan-server.ts, chat.ts, notes.ts, RuntimeTracker.flush, abort.ts, shutdown-handoff.ts, handoff.ts) uses async.

### Risk

1. **Two APIs for the same operation is exactly the "transitional alias" the project guidelines forbid.** A sync helper and an async helper that both exist *as a permanent design*, with a per-call-site choice of which to use, is over-engineering: it makes "which one do I call here" a recurring decision, and every wrong choice (sync in a hot path) re-introduces F22 incrementally.
2. **`writeRuntimeState` straddles both worlds.** It's called from `recoverFromCrash` (boot, sync OK) AND from `RuntimeTracker.flush` (runtime, must be async). Either two flavours of `writeRuntimeState` exist, or one of them adopts the async signature and `recoverFromCrash` does too — at which point we're back to Proposal A for runtime/recovery.ts but with an extra parallel API in store/.
3. **`recoverFromCrash` is small enough to convert.** It runs once, awaiting is trivial. The argument "keep it sync because it's boot-only" doesn't pay for itself.

### What it enables

Nothing that A doesn't enable, except marginally less mechanical change to `project.ts` and `recovery.ts`.

### What it forbids

Nothing that A doesn't forbid. It adds, not removes, the constraint "pick the right variant per site".

### Recommendation note

C is rejected: it violates "no parallel APIs for the same operation, do not preserve old code paths". It exists in this design only to show we considered it.

---

## Recommendation

**Proposal A**. It is the only proposal that actually solves the problem the issue file describes (sync I/O on the agent/supervisor loop and on HTTP routes). The blast radius is wide but each site is a mechanical `await` insertion plus signature change; TypeScript will refuse to compile any miss. The one piece of genuinely new logic is the `RuntimeTracker` write coalescer, which is ~30 lines and replaces nothing — it just adds the queue that ought to have existed once `flush()` started writing on every heartbeat.

B is a defensible alternative *if* we deliberately re-scope F22 to "HTTP debug routes only". We do not: the issue file lists the agent loop and supervisor as core failure modes. B leaves them broken.

C is a non-starter under the project guidelines.

Ordering: F22 (this) → F34 (plan cache, depends on async writeDoc) and lands cleanly only after F08 (legacy mirror removed) so we don't double the number of `await` sites in `writeRuntimeState`. If F08 is not yet ready, F22 can ship first and F08 deletes one `await writeDoc(legacyPath, ...)` line in its own commit.
