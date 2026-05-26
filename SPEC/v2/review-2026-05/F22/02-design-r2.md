# F22 — Document Store Sync FS — Design r2

## Changes from r1

- Concrete pre-`super()` construction pattern for the agents that consume `buildHandoffContext` (static async `create()` factory per agent class). `buildHandoffContext` itself becomes async — no exception, no parallel sync version.
- Concrete `PlanService` async-init path: drop `ensureDir(...)` from the constructor, add `async init()` invoked once from `bootstrap`. Single edit, no factory required.
- Concrete fatal-handler behaviour: inline `writeFileSync` of the runtime-state error stamp, no tmp+rename, no fsync. Documented one-off — not a new API.
- Knowledge boundary now framed as a cross-team handshake: F22 lands only with a coordinated knowledge-subsystem async pass. Enumerated touch list in the plan.
- Correct notes-API names everywhere; r1's `NoteManager.createNote`/`loadNote` removed.

Three proposals, ordered by blast radius (smallest first). Recommendation is unchanged: **Proposal A**.

---

## Proposal A — Full async conversion of `documents.ts` and every caller

### Scope

Rewrite [src/store/documents.ts](src/store/documents.ts) to use `fs/promises`. Every exported function becomes `async`. The public barrel in [src/index.ts](src/index.ts#L27-L37) re-exports the async signatures; this is a public API shape change, accepted.

Touched files in `src/` (every importer of `documents.ts`, excluding tests, plus the constructor/initialization paths that cannot trivially `await`):

- [src/store/documents.ts](src/store/documents.ts) — full rewrite.
- [src/store/project.ts](src/store/project.ts): `loadProject`, `initProject`, `discoverProject` all become async. `initProjectTree` (knowledge tree + .gitignore seeding) also goes async; its `writeFileSync` calls become `await writeFile` from `node:fs/promises`. (It is part of an async `initProject` flow; keeping it sync would be the only sync escape hatch in this module and is rejected.)
- [src/server/cli.ts](src/server/cli.ts): every `.action(async ...)` call already runs in an async context. Each command gains `await` on `loadProject`, `discoverProject`, `initProject`, `ensureDir`, `writeDoc`, `readDocOrNull`, `writeShutdownRequest`. Affected commands: `init`, `start`, `status`, `note`, `request-shutdown`, `inspect`, `models`, `serve`, `login`, `logout`.
- [src/server/bootstrap.ts](src/server/bootstrap.ts): `discoverProject`/`loadProject` calls gain `await`. The `RuntimeTracker` callers (`agentStarted` / `agentStopped` / `agentActivity` / `setCurrentStage`) stay sync — they enqueue into the coalescer (see Risk below). The fatal handler at [bootstrap.ts#L688-L700](src/server/bootstrap.ts#L688-L700) replaces its `writeRuntimeState(...)` call with an inline `writeFileSync` (justified one-off, see "Fatal handler" below). `writeShutdownSummary`/`consumeShutdownHandoff` gain `await`. `cleanupStaleNotes()` gains `await`.
- [src/server/server.ts](src/server/server.ts): every handler that calls `readDocOrNull` / `readDocLenient` / `readJsonOrNull` / `listDocs` gains `await`. Raw `readFileSync` / `readdirSync` / `statSync` / `existsSync` in `/api/files`, `/api/files/content`, `/api/debug/state`, `/api/debug/errors`, `/api/debug/timeline`, `/api/chats`, `/api/chats/:sessionId` migrate to `await readFile` / `await readdir` / `await stat` / `await access`. `/api/notes*` handlers gain `await` on `NoteManager` methods. `/api/debug/errors` and `/api/debug/timeline` run their per-stage reads in parallel with `Promise.all(...)`.
- [src/runtime/recovery.ts](src/runtime/recovery.ts): `isAnotherInstanceRunning`, `recoverFromCrash`, `writeRuntimeState` all become async. `acquireRuntimeLock` calls `await ensureDir(...)` then keeps the `openSync(lockPath, "wx")` call sync (one deliberate exception; the lock is held for the lifetime of the process — async open is fine in principle but the surrounding boot path is sequential anyway). The `RuntimeTracker` gains a single-writer coalescer (one in-flight Promise + one queued state).
- [src/runtime/notes.ts](src/runtime/notes.ts): `createUserNote` becomes async; `NoteManager.listNotes`, `getUnacknowledgedNotes`, `peekUnacknowledgedNotes`, `getPermanentNotes`, `acknowledgeNote`, `acknowledgeNotes`, `deleteNote`, `clearNotes`, `cleanupStaleNotes`, and the private `readAllNotes` helper all become async. The `existsSync(this.notesDir)` checks become `await access(...).catch(() => null)`.
- [src/runtime/abort.ts](src/runtime/abort.ts): `scanForUrgentNotes` becomes async.
- [src/runtime/shutdown-handoff.ts](src/runtime/shutdown-handoff.ts): all three exports (`writeShutdownRequest`, `writeShutdownSummary`, `consumeShutdownHandoff`) become async. The shared `readOptionalDoc` helper becomes async.
- [src/agents/handoff.ts](src/agents/handoff.ts): `buildHandoffContext` becomes async. Two `readDocLenient` and one (`includeTasks`) `readDocLenient` call gain `await`.
- [src/agents/*.ts](src/agents): each agent that calls `buildHandoffContext` in its constructor gains a static `async create(ctx, input, ...rest): Promise<AgentClass>` factory that pre-builds the message string and forwards it into the still-synchronous constructor. The constructors are updated to accept the pre-built `initialMessage` instead of calling `buildHandoffContext` themselves. Affected classes: `PlannerAgent`, `ManagerAgent`, `CoderAgent`, `ResearcherAgent`, `ReviewerAgent`, `DesignerAgent`, `DataAgent`, `InspectorAgent`. Callers that instantiate these classes — [src/server/bootstrap.ts createChildSpawner](src/server/bootstrap.ts#L266-L390), [runPlanner](src/server/bootstrap.ts#L420-L440), [src/server/cli.ts inspect](src/server/cli.ts#L265-L283) — switch from `new XAgent(...)` to `await XAgent.create(...)`. The factory pattern adds no new abstraction; it just relocates the existing `buildHandoffContext` call from inside the constructor to immediately above the `new` site.
- [src/agents/chat.ts](src/agents/chat.ts): existing `await writeDoc` / `await ensureDir` become meaningful. Read sites (`readDocOrNull` / `readDocLenient`) gain `await`. `createUserNote` calls at [chat.ts#L315](src/agents/chat.ts#L315) and [chat.ts#L465](src/agents/chat.ts#L465) gain `await`.
- [src/mcp/notes-server.ts](src/mcp/notes-server.ts#L26): `createUserNote` call gains `await`.
- [src/mcp/plan-server.ts](src/mcp/plan-server.ts): every public method (`plan_get`, `plan_get_stage`, `plan_get_current_stage`, `plan_set_stages`, `plan_add_stage`, `plan_history`, `task_*`, `stage_*`, `plan_complete_stage`, etc.) becomes async. The constructor `ensureDir(projectSaivageDir)` at [plan-server.ts#L68](src/mcp/plan-server.ts#L68) is removed from the constructor body and replaced by a new `async init(): Promise<void>` method called once from `bootstrap` at [bootstrap.ts#L148-L155](src/server/bootstrap.ts#L148-L155) (`const planService = new PlanService(...); await planService.init();`). No factory; the change is local.
- [src/runtime/dispatcher.ts](src/runtime/dispatcher.ts#L317): `peekUnacknowledgedNotes()` gains `await`. The enclosing `attachPendingNotesNotice` method becomes async; its caller chain (already `async` higher up) gets one more `await`.
- [src/index.ts](src/index.ts#L27-L37): re-exports unchanged at the source level; consumers see new async signatures. This is the public API shape change we accept.
- **Cross-team handshake — knowledge subsystem (out-of-scope, mandatory coordinated change):**
  - [src/knowledge/store.ts](src/knowledge/store.ts#L250) and [L414](src/knowledge/store.ts#L414): the two `writeDoc` calls gain `await`. `writeRecordAtomic` and `rebuildIndex` become async. The two `ensureDir(...)` calls at [store.ts#L249](src/knowledge/store.ts#L249) and [store.ts#L268](src/knowledge/store.ts#L268) also become `await ensureDir(...)`.
  - [src/knowledge/lifecycle.ts](src/knowledge/lifecycle.ts): nine call sites of `writeRecordAtomic` ([L265](src/knowledge/lifecycle.ts#L265), [L310](src/knowledge/lifecycle.ts#L310), [L327](src/knowledge/lifecycle.ts#L327), [L406](src/knowledge/lifecycle.ts#L406), [L414](src/knowledge/lifecycle.ts#L414), [L498](src/knowledge/lifecycle.ts#L498), [L534](src/knowledge/lifecycle.ts#L534), [L551](src/knowledge/lifecycle.ts#L551), [L620](src/knowledge/lifecycle.ts#L620), [L628](src/knowledge/lifecycle.ts#L628)) and one of `rebuildIndex` ([L117](src/knowledge/lifecycle.ts#L117)) gain `await`. Their enclosing functions cascade `async`, and the consumers in `src/skills/` / memory tools cascade further.
  - **F22 does not land without skills/memory sign-off on this handshake.** The handshake list is the entire contract; F22 does not unilaterally rewrite the knowledge or skills/memory code.

### What gets added/removed

- Added:
  - `async`/`await` everywhere.
  - One small write coalescer inside `RuntimeTracker` (one in-flight `Promise<void>`, one queued `RuntimeState`; the queue collapses intermediate states to the latest one). ~30 lines.
  - Eight static `async create(...)` factories on agent classes; each is a ~6-line method that calls `buildHandoffContext(ctx, ...)` then `new XAgent(ctx, input, ..., initialMessage)`.
  - One `async init()` method on `PlanService` (~3 lines).
- Removed:
  - Every `*Sync` import from `node:fs` inside `documents.ts`, `project.ts`, the server handlers, `notes.ts`, `abort.ts`, `shutdown-handoff.ts`, `handoff.ts`.
  - The `ensureDir(projectSaivageDir)` call from the `PlanService` constructor body.
  - The `buildHandoffContext(ctx, ...)` calls from agent constructors (moved into the factories).
- **NOT added**: parallel sync API. No `readDocSync`. No sync escape hatch in `documents.ts`. One inline `writeFileSync` in the fatal handler does NOT count as a new API — it is a direct `node:fs` call with a justification comment in the file.

### Risk

1. **Runtime lock atomicity**: `acquireRuntimeLock`'s `openSync(lockPath, "wx")` is the *only* primitive that gives `O_CREAT|O_EXCL` synchronously. We keep it sync (one deliberate exception, boot-only, microseconds). The async equivalent `fs.promises.open(path,"wx")` is also atomic at the syscall level but adds no value here. Test coverage: [src/runtime/runtime.test.ts](src/runtime/runtime.test.ts) already exercises concurrent `acquireRuntimeLock`.
2. **`RuntimeTracker.flush` race**: today `flush` is sync, so write order equals call order. Async writes need the coalescer. With the coalescer, rapid `agentActivity` ticks collapse: at most one write is in flight, the next is queued, and intermediates are dropped (the runtime-state document is fully snapshot — losing the intermediate is correct, the final state is what matters). `freeze()` stays sync; `bootstrap.shutdown()` already awaits the final `writeRuntimeState` explicitly.
3. **Fatal handler can't await reliably**: solved by the inline `writeFileSync` escape hatch (~5 lines, one comment).
4. **`buildHandoffContext` cannot be awaited before `super()`**: solved by the static async factory on each agent class. The constructors stay synchronous and accept a pre-built `initialMessage: string`.
5. **TypeScript handler-author discipline**: a route that forgets to `await` an async read now returns a `Promise` instead of data. The async return type is statically incompatible with the synchronous Fastify reply shape, so `tsc` will reject the omission.
6. **Test churn**: ~40 sites across the Vitest suite need `await`. Mechanical; no test-runner change.
7. **Cross-team blast**: see the knowledge handshake list. If the skills/memory agent rejects, F22 does not land.

### What it enables

- Unblocks F11 (supervisor) from accidental "stuck" verdicts caused by disk waits on the event loop.
- Unblocks F34 in-memory plan cache: the cache write becomes a real async fsync that we can batch.
- Frees the `/api/debug/*` endpoints to scale linearly with the project tree without freezing the SPA.
- Makes the existing `await writeDoc(...)` / `await writeRuntimeState(...)` calls semantically correct rather than aspirational.

### What it forbids

- No sync escape hatch *in `documents.ts`*. The one inline `writeFileSync` in the fatal handler is direct `node:fs` use with a justification comment, not a new API.
- No partial async ("async for HTTP, sync for agents"). That is Proposal C.

### Recommendation note

A is the architecturally correct end state. Its cost is one large mechanical commit + tracker coalescer + agent factories + `PlanService.init()` + the coordinated knowledge-subsystem touch. Each individual site is a small mechanical change; the total surface is wide but contiguous.

---

## Proposal B — Keep sync; add atomicity hardening and a fast-path read cache

### Scope

Acknowledge that the atomicity contract is fine and the fsync cost is fine for writes, but the HTTP read fan-out is what kills the event loop. Solve only that:

- Keep `documents.ts` fully synchronous; no signature change.
- Add an in-memory LRU cache keyed by absolute path + last-known mtime, populated on `readDoc*` and invalidated on `writeDoc` / `deleteDoc` of the same path. Bound by entry count and total bytes.
- For the heavy debug endpoints, pre-aggregate at write time: when a stage's `summary.json` lands via `writeDoc`, eagerly index its `result`/`completed_at`/`issues` into sidecar `.saivage/tmp/state/error-index.json` and `timeline-index.json`. `/api/debug/errors` and `/api/debug/timeline` then read one small file instead of fan-out.

### Files touched

- [src/store/documents.ts](src/store/documents.ts): add cache + per-path serializer. ~120 added lines, no signature change.
- New file `src/store/error-index.ts`: write-side hook for the two sidecars. ~150 lines.
- [src/agents/manager.ts](src/agents/manager.ts) / [src/agents/reviewer.ts](src/agents/reviewer.ts) (or a new `writeStageArtifact` chokepoint): one call per write to update the indices.
- [src/server/server.ts](src/server/server.ts): `/api/debug/errors` and `/api/debug/timeline` switch to read the pre-aggregated index files.

### Risk

1. **Cache invalidation correctness.** The knowledge subsystem (out-of-scope) and `initProjectTree` write directly via `writeFileSync` from `node:fs`. Those writes bypass cache invalidation. Mitigation: stat-on-read defeats the optimization; routing those callers through `writeDoc` is also forbidden because we don't touch the out-of-scope subsystem. We accept stale reads only for `*.saivage/skills/*` / `*.saivage/memory/*` — but those are read from HTTP routes via existing `readDoc*` paths, so staleness is real.
2. **The index file becomes another sync bottleneck.** Every stage-write or report-write now ALSO synchronously rewrites `error-index.json` and `timeline-index.json`. Same problem, moved sideways.
3. **`/api/files/content` is still sync** and still reads up to 1 MiB inside the handler.
4. **`RuntimeTracker.flush` still blocks** on every agent activity tick. Cache does not help writes; heartbeats still synchronously fsync the disk. **B does NOT fix the supervisor/agent-loop blocking that the F22 issue file explicitly calls out.**
5. **Constructor-time `buildHandoffContext`** stays sync, so the agent-construction problem disappears under B — but only because we have not solved the underlying issue.
6. **Fatal handler** stays sync and easy.

### What it enables

- Targeted reduction in HTTP debug route latency.
- Index-file pattern is reusable.

### What it forbids

- A future move to async throws the cache and sidecars away.
- The sidecars become canonical for debug views; drift from `summary.json` (manual edits, restored backups) leaves the views wrong until the next write triggers re-aggregation.

### Recommendation note

B is a smaller change that does NOT solve the issue as stated. The issue file calls out the agent activity loop and supervisor disk-wait as failure modes; B leaves both untouched. B is acceptable only if F22 is deliberately re-scoped to "HTTP debug routes only" — which we are not doing.

---

## Proposal C — Mixed: sync at boot/init paths, async for runtime hot paths

### Scope

Split `documents.ts` along a boot-vs-runtime axis: keep sync helpers (`readDocSync`, `writeDocSync`) only inside `src/store/` for boot/init paths (`loadProject`, `initProject`, `acquireRuntimeLock`'s `ensureDir`, `recoverFromCrash`). Expose async helpers as the primary API used everywhere else.

### Risk

1. **Two APIs for the same operation is exactly the "transitional alias" the project guidelines forbid.** Permanently dual sync/async helpers make "which one do I call here" a recurring decision; every wrong choice re-introduces F22 incrementally.
2. **`writeRuntimeState` straddles both worlds.** Called from `recoverFromCrash` (boot, sync OK) and from `RuntimeTracker.flush` (runtime, must be async). Either two flavours or one — at which point we are back at Proposal A.
3. **`recoverFromCrash` is small enough to convert.** The argument "keep it sync because it's boot-only" doesn't pay for itself.

### Recommendation note

C is rejected: it violates "no parallel APIs for the same operation". It exists here only to show we considered it.

---

## Recommendation

**Proposal A.** It is the only proposal that solves the problem the issue file describes (sync I/O on the agent/supervisor loop and on HTTP routes). The blast radius is wide but each site is mechanical, TypeScript catches missed `await`s at compile time, the `RuntimeTracker` coalescer is the only genuinely new logic (~30 lines), and the agent factory pattern is the smallest possible change that respects JS's `super()` restriction.

**Ordering:** F22 → F34 (plan cache, depends on async `writeDoc`/`readDoc`). Prefer after F08 (legacy runtime-state mirror removed) so we don't double `await writeDoc` inside `writeRuntimeState`. **Hard cross-team dependency:** F22 lands at the same commit boundary as the knowledge-subsystem async pass enumerated above; without skills/memory sign-off, F22 does not land.
