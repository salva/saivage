# F22 — Document Store Sync FS — Analysis r2

## Changes from r1

- Completed the caller inventory the r1 review flagged as understated: added the public barrel re-export in [src/index.ts](src/index.ts#L27-L37), every CLI command that calls `loadProject`/`discoverProject`/`writeShutdownRequest`/`readDocOrNull`/`writeDoc`/`ensureDir`, the fatal-handler write path in [src/server/bootstrap.ts](src/server/bootstrap.ts#L688-L700), all `buildHandoffContext` constructor call sites with their pre-`super()` constraint, and the standalone `createUserNote` plus full `NoteManager` surface that r1 misnamed.
- Corrected the notes-API facts: there is no `NoteManager.createNote` / `loadNote`. The real surface is the free function `createUserNote` plus the `NoteManager` methods `listNotes`, `getUnacknowledgedNotes`, `peekUnacknowledgedNotes`, `getPermanentNotes`, `acknowledgeNote`, `acknowledgeNotes`, `deleteNote`, `clearNotes`, `cleanupStaleNotes`. The urgent-note read path is `scanForUrgentNotes` in [src/runtime/abort.ts](src/runtime/abort.ts#L42-L56).
- Replaced the "two one-line awaits" knowledge claim with the real cascade: `writeDoc` is consumed inside `writeRecordAtomic`, `rebuildIndex`, and (indirectly via `readFileSync`/`existsSync`/`readdirSync`) several other functions in [src/knowledge/store.ts](src/knowledge/store.ts), all of which are then called from [src/knowledge/lifecycle.ts](src/knowledge/lifecycle.ts) at 9 sites. This is a hard cross-team boundary, not a touch-up.
- Documented the three non-trivial async construction paths the r1 plan left abstract (`PlanService` constructor, agent constructors that call `buildHandoffContext` before `super()`, fatal handler that cannot await).

## Problem restated

[src/store/documents.ts](src/store/documents.ts#L1-L156) exposes a small CRUD facade (`readDoc`, `readDocOrNull`, `readDocLenient`, `readJsonOrNull`, `writeDoc`, `appendDoc`, `listDir`, `listDocs`, `deleteDoc`, `ensureDir`, `sweepStaleTempFiles`) that performs **every** filesystem operation synchronously: `readFileSync`, `writeFileSync`, `renameSync`, `unlinkSync`, `readdirSync`, `mkdirSync`, `existsSync`, `openSync`/`closeSync`/`fsyncSync`, `statSync`.

These primitives are invoked from four classes of caller that share the Node event loop:

1. **Fastify HTTP routes** — every read in [src/server/server.ts](src/server/server.ts#L100-L709) is sync. Hot spots:
   - [/api/debug/errors](src/server/server.ts#L505-L606) and [/api/debug/timeline](src/server/server.ts#L608-L662): O(N·M) sync reads across every archived stage's `summary.json` and every report.
   - [/api/chats](src/server/server.ts#L295-L334) and [/api/chats/:sessionId](src/server/server.ts#L336-L358): `readdirSync` of every channel directory plus `readDocOrNull` per session file.
   - [/api/files](src/server/server.ts#L420-L466) and [/api/files/content](src/server/server.ts#L468-L502): sync `readdirSync`, `statSync`, `readFileSync` up to 1 MiB.
   - [/api/plan/stages/:id](src/server/server.ts#L155-L177): `readDocLenient` for tasks, summary, and every report.
   - [/health](src/server/server.ts#L128-L138), [/api/state](src/server/server.ts#L180-L189), [/api/plan](src/server/server.ts#L143-L153), [/api/inspections](src/server/server.ts#L248-L258), [/api/debug/state](src/server/server.ts#L474-L502): each does 1-3 `readDocOrNull` calls per request.

2. **CLI commands** — the entry point in [src/server/cli.ts](src/server/cli.ts#L1-L552) opens an interactive Commander loop. Every command that reaches a `.saivage/` directory does so through sync helpers:
   - `init`: [cli.ts#L68](src/server/cli.ts#L68) → `initProject` (sync `existsSync` + sync `ensureDir` + sync `writeDoc` + sync knowledge tree seed).
   - `start`: [cli.ts#L84](src/server/cli.ts#L84) → `bootstrap` → `discoverProject` + `loadProject`.
   - `status`: [cli.ts#L130-L141](src/server/cli.ts#L130-L141) → `discoverProject` + `loadProject` + two `readDocOrNull` calls.
   - `note`: [cli.ts#L173-L201](src/server/cli.ts#L173-L201) → `loadProject` + `ensureDir` + `writeDoc`.
   - `request-shutdown`: [cli.ts#L207-L233](src/server/cli.ts#L207-L233) → `loadProject` + `writeShutdownRequest` (which is sync `writeDoc`).
   - `inspect`: [cli.ts#L237-L283](src/server/cli.ts#L237-L283) → `bootstrap`.
   - `models`: [cli.ts#L289-L321](src/server/cli.ts#L289-L321) → `discoverProject`.
   - `serve`: [cli.ts#L326-L406](src/server/cli.ts#L326-L406) → `bootstrap` + signal-handler `shutdown()` (already async).
   - `login`/`logout`: [cli.ts#L410-L546](src/server/cli.ts#L410-L546) → `discoverProject` plus raw `writeFileSync(auth-profiles.json)` (already direct `node:fs`, untouched by F22).

3. **Bootstrap + shutdown** — [src/server/bootstrap.ts](src/server/bootstrap.ts#L107-L260):
   - `loadProject(projectRoot)` at [bootstrap.ts#L117](src/server/bootstrap.ts#L117).
   - `isAnotherInstanceRunning(...)` at [bootstrap.ts#L164](src/server/bootstrap.ts#L164) reads `runtime.json` sync via `readDocOrNull`.
   - `acquireRuntimeLock(saivageDir)` at [bootstrap.ts#L170](src/server/bootstrap.ts#L170) does `ensureDir` + the deliberate `openSync(lockPath, "wx")` lockfile primitive.
   - `recoverFromCrash(project, planService)` at [bootstrap.ts#L173](src/server/bootstrap.ts#L173) walks the stage tree sync.
   - `cleanupStaleNotes()` at [bootstrap.ts#L185](src/server/bootstrap.ts#L185).
   - `await writeRuntimeState(project.paths.runtimeState, runtimeState)` at [bootstrap.ts#L199](src/server/bootstrap.ts#L199), [bootstrap.ts#L235](src/server/bootstrap.ts#L235) (final idle write), and inside `installFatalHandlers` at [bootstrap.ts#L688-L700](src/server/bootstrap.ts#L688-L700).
   - `writeShutdownSummary(project)` at [bootstrap.ts#L226](src/server/bootstrap.ts#L226) and `consumeShutdownHandoff(project)` at [bootstrap.ts#L255](src/server/bootstrap.ts#L255).

4. **Hot agent and supervisor loops**:
   - `RuntimeTracker.flush()` at [src/runtime/recovery.ts](src/runtime/recovery.ts#L398-L411) is called from `agentStarted`, `agentStopped`, `agentActivity`, `setCurrentStage` on every tick.
   - `PlanService` re-reads `plan.json` and `plan-history.json` on every plan operation invoked by tool dispatch — see [src/mcp/plan-server.ts](src/mcp/plan-server.ts#L82-L264).
   - `NoteManager` writes a fresh note JSON on every `acknowledgeNote` / `deleteNote` / `clearNotes` / `acknowledgeNotes`, called from [src/agents/planner.ts#L204](src/agents/planner.ts#L204), [src/runtime/dispatcher.ts#L317](src/runtime/dispatcher.ts#L317), [src/server/server.ts#L262-L289](src/server/server.ts#L262-L289).
   - Agents at construction read `plan.json`/`plan-history.json` via `buildHandoffContext(ctx)` — see "buildHandoffContext constructor cascade" below.

## Why the blocking matters

Every `writeDoc` performs, on the same OS thread that runs Fastify and the WS pings, four steps: `JSON.stringify`, `openSync(tmp,"w") → writeFileSync → fsyncSync → closeSync`, `renameSync`, then `openSync(dirname,"r") → fsyncSync → closeSync`. On a typical SSD that is 1-5 ms; under the LXC bind-mount/VM topology this deployment runs on it routinely hits 30-200 ms. The fan-out routes (`/api/debug/errors`, `/api/debug/timeline`) compound this to seconds of total wall time per request, all on the event loop, while the supervisor and chat WebSocket starve.

## Contract

Current public API of [src/store/documents.ts](src/store/documents.ts):

| Function                      | Caller files                                                                                   |
|-------------------------------|-----------------------------------------------------------------------------------------------|
| `readDoc<S>(path, schema)`    | [src/runtime/recovery.ts](src/runtime/recovery.ts#L16), [src/runtime/abort.ts](src/runtime/abort.ts#L10), [src/runtime/notes.ts](src/runtime/notes.ts#L11), [src/index.ts](src/index.ts#L29) (public barrel) |
| `readDocOrNull<S>(...)`       | [src/server/server.ts](src/server/server.ts#L13), [src/server/cli.ts](src/server/cli.ts#L131), [src/runtime/recovery.ts](src/runtime/recovery.ts#L16), [src/runtime/shutdown-handoff.ts](src/runtime/shutdown-handoff.ts#L16), [src/agents/chat.ts](src/agents/chat.ts#L19), [src/mcp/plan-server.ts](src/mcp/plan-server.ts#L11), [src/index.ts](src/index.ts#L30) |
| `readDocLenient<S>(...)`      | [src/server/server.ts](src/server/server.ts#L13), [src/agents/chat.ts](src/agents/chat.ts#L19), [src/agents/handoff.ts](src/agents/handoff.ts#L2) |
| `readJsonOrNull(path)`        | [src/server/server.ts](src/server/server.ts#L13) (one site, `/api/debug/state` raw config dump) |
| `writeDoc<T>(...)`            | [src/server/cli.ts](src/server/cli.ts#L177), [src/runtime/recovery.ts](src/runtime/recovery.ts#L16), [src/runtime/notes.ts](src/runtime/notes.ts#L11), [src/runtime/shutdown-handoff.ts](src/runtime/shutdown-handoff.ts#L16), [src/agents/chat.ts](src/agents/chat.ts#L19), [src/mcp/plan-server.ts](src/mcp/plan-server.ts#L12), [src/knowledge/store.ts](src/knowledge/store.ts#L250), [src/knowledge/store.ts](src/knowledge/store.ts#L414), [src/index.ts](src/index.ts#L31) |
| `appendDoc<T>(...)`           | tests only |
| `listDocs(...)`               | [src/server/server.ts](src/server/server.ts#L13) |
| `listDir(...)`                | re-exported in [src/index.ts](src/index.ts#L32); only used internally by `documents.ts` |
| `deleteDoc(...)`              | [src/runtime/shutdown-handoff.ts](src/runtime/shutdown-handoff.ts#L16), [src/runtime/notes.ts](src/runtime/notes.ts#L11), [src/index.ts](src/index.ts#L34) |
| `ensureDir(...)`              | [src/server/cli.ts](src/server/cli.ts#L176), [src/runtime/recovery.ts](src/runtime/recovery.ts#L16), [src/runtime/notes.ts](src/runtime/notes.ts#L11), [src/mcp/plan-server.ts](src/mcp/plan-server.ts#L13), [src/agents/chat.ts](src/agents/chat.ts#L19), [src/store/project.ts](src/store/project.ts#L8), [src/knowledge/store.ts](src/knowledge/store.ts#L249), [src/knowledge/store.ts](src/knowledge/store.ts#L268), [src/index.ts](src/index.ts#L35) |
| `sweepStaleTempFiles(...)`    | [src/runtime/recovery.ts](src/runtime/recovery.ts#L16) (boot only) |

### Public barrel

[src/index.ts](src/index.ts#L27-L37) re-exports `readDoc`, `readDocOrNull`, `writeDoc`, `listDir`, `listDocs`, `deleteDoc`, `ensureDir`. Any signature change to those names is a **public API shape change**; downstream consumers (other workspaces that import `saivage`) see the async signatures. We accept this consequence per the project guideline — there is one shape, not two.

### `store/project.ts` callers

`loadProject` callers (cascades async into 4 files):

- [src/store/project.ts](src/store/project.ts#L127) (re-entry inside `initProject`).
- [src/server/bootstrap.ts](src/server/bootstrap.ts#L117) (already `await`-able — `bootstrap` is async).
- [src/server/cli.ts](src/server/cli.ts#L141) (`status` command — already inside `.action(async ...)`).
- [src/server/cli.ts](src/server/cli.ts#L181) (`note` command — async action).
- [src/server/cli.ts](src/server/cli.ts#L221) (`request-shutdown` command — async action).
- [src/store/project.test.ts](src/store/project.test.ts#L85).

`discoverProject` callers (cascades async into 4 files):

- [src/server/bootstrap.ts](src/server/bootstrap.ts#L111).
- [src/server/cli.ts](src/server/cli.ts#L133) (`status`).
- [src/server/cli.ts](src/server/cli.ts#L303) (`models`).
- [src/server/cli.ts](src/server/cli.ts#L430) (`login`).
- [src/server/cli.ts](src/server/cli.ts#L506) (`logout`).

`initProject` callers:

- [src/server/cli.ts](src/server/cli.ts#L68) (`init` command — async action).
- [src/store/project.test.ts](src/store/project.test.ts).

All `.action(...)` callbacks in [src/server/cli.ts](src/server/cli.ts) are already declared `async`, so adding `await` is mechanical and does not require changing Commander's API surface.

### `buildHandoffContext` constructor cascade

[src/agents/handoff.ts#L18](src/agents/handoff.ts#L18) is the synchronous read path. Every agent subclass calls it while assembling its `initialMessage` **before** the `super(...)` call, because the message is passed into the base-class config object:

- [src/agents/planner.ts#L173-L182](src/agents/planner.ts#L173-L182): `const initialMessage = buildPlannerMessage(ctx); super(ctx, { ..., initialMessage });`. `buildPlannerMessage` calls `buildHandoffContext(ctx)` at [planner.ts#L289](src/agents/planner.ts#L289).
- [src/agents/manager.ts](src/agents/manager.ts#L372): `buildHandoffContext(ctx, { stage })`.
- [src/agents/coder.ts](src/agents/coder.ts#L249): `buildHandoffContext(ctx, { stageId, includeTasks: true })`.
- [src/agents/researcher.ts](src/agents/researcher.ts#L245).
- [src/agents/reviewer.ts](src/agents/reviewer.ts#L186).
- [src/agents/designer.ts](src/agents/designer.ts#L176).
- [src/agents/data-agent.ts](src/agents/data-agent.ts#L159).
- [src/agents/inspector.ts](src/agents/inspector.ts#L204).

JavaScript prohibits `await` before `super(...)`. Once `buildHandoffContext` is async, the construction sites cannot just gain an `await`; the design (see r2) chooses a concrete pattern (static async factory `create()` per agent class) that pre-builds the message and passes it as a plain string into a synchronous constructor. Every site listed above is touched.

### Notes API

[src/runtime/notes.ts](src/runtime/notes.ts) real surface:

| Symbol                              | Role                                                                                  | Callers requiring `await` after r2 |
|-------------------------------------|---------------------------------------------------------------------------------------|------------------------------------|
| `createUserNote(input)` (free fn, [notes.ts#L30](src/runtime/notes.ts#L30)) | writes `<id>.json` via `writeDoc` + `ensureDir`                       | [src/agents/chat.ts#L315](src/agents/chat.ts#L315), [src/agents/chat.ts#L465](src/agents/chat.ts#L465), [src/mcp/notes-server.ts#L26](src/mcp/notes-server.ts#L26) |
| `NoteManager.listNotes()` ([notes.ts#L96](src/runtime/notes.ts#L96))         | `readdirSync` + `readDoc` per file                                                    | [src/server/server.ts#L263](src/server/server.ts#L263) |
| `NoteManager.getUnacknowledgedNotes()` ([notes.ts#L69](src/runtime/notes.ts#L69)) | reads all notes, mutates `pendingAcknowledgment`                                  | [src/agents/planner.ts#L256](src/agents/planner.ts#L256) (already `await`-shape today) |
| `NoteManager.peekUnacknowledgedNotes()` ([notes.ts#L80](src/runtime/notes.ts#L80)) | reads all notes, no mutation                                                       | [src/runtime/dispatcher.ts#L317](src/runtime/dispatcher.ts#L317) |
| `NoteManager.getPermanentNotes()` ([notes.ts#L89](src/runtime/notes.ts#L89))  | reads all notes                                                                       | [src/agents/planner.ts#L257](src/agents/planner.ts#L257) |
| `NoteManager.acknowledgeNote(id)` ([notes.ts#L99](src/runtime/notes.ts#L99)) | reads + writeDoc-or-deleteDoc per call                                                | [src/server/server.ts#L269](src/server/server.ts#L269) |
| `NoteManager.acknowledgeNotes()` ([notes.ts#L143](src/runtime/notes.ts#L143)) | iterates `pendingAcknowledgment` and updates each on disk                            | [src/agents/planner.ts#L204](src/agents/planner.ts#L204) |
| `NoteManager.deleteNote(id)` ([notes.ts#L120](src/runtime/notes.ts#L120))    | deleteDoc                                                                             | (internal) |
| `NoteManager.clearNotes()` ([notes.ts#L132](src/runtime/notes.ts#L132))      | iterates + deleteNote per file                                                        | [src/server/server.ts#L286](src/server/server.ts#L286) |
| `NoteManager.cleanupStaleNotes(ttl?)` ([notes.ts#L210](src/runtime/notes.ts#L210)) | iterates notes dir, expires stale entries                                            | [src/server/bootstrap.ts#L185](src/server/bootstrap.ts#L185) |
| `scanForUrgentNotes(notesDir)` (free fn, [src/runtime/abort.ts#L42](src/runtime/abort.ts#L42)) | reads all notes for the first urgent unacknowledged                                  | tests only ([src/runtime/runtime.test.ts#L976](src/runtime/runtime.test.ts#L976), [#L1000](src/runtime/runtime.test.ts#L1000)) |

The r1 design referred to `NoteManager.createNote` and `loadNote`; neither exists. Every entry above is touched by F22.

### Shutdown handoff

[src/runtime/shutdown-handoff.ts](src/runtime/shutdown-handoff.ts#L1-L100) exports:

- `writeShutdownRequest(project, reason, requestedBy)` — one `writeDoc` ([shutdown-handoff.ts#L22-L32](src/runtime/shutdown-handoff.ts#L22-L32)). Called by `cli.ts` `request-shutdown` at [cli.ts#L229](src/server/cli.ts#L229) and by the test at [shutdown-handoff.test.ts#L121](src/runtime/shutdown-handoff.test.ts#L121).
- `writeShutdownSummary(project)` — five `readDocOrNull` + one `writeDoc` + one `deleteDoc` ([shutdown-handoff.ts#L34-L78](src/runtime/shutdown-handoff.ts#L34-L78)). Called by `bootstrap.shutdown()` at [bootstrap.ts#L226](src/server/bootstrap.ts#L226).
- `consumeShutdownHandoff(project)` — two `readDocOrNull` + two conditional `deleteDoc` ([shutdown-handoff.ts#L79-L99](src/runtime/shutdown-handoff.ts#L79-L99)). Called by `bootstrap()` at [bootstrap.ts#L255](src/server/bootstrap.ts#L255).

All three become async. The bootstrap call sites are inside an `async` function; the only non-trivial flow is `bootstrap.shutdown()` which is already declared `async` and awaits other shutdown steps — the `writeShutdownSummary` call gains a single `await`.

### Fatal handler

[src/server/bootstrap.ts#L674-L703](src/server/bootstrap.ts#L674-L703) installs `process.on("uncaughtException", ...)` and `process.on("unhandledRejection", ...)`. Both handlers run in synchronous error contexts and end with `setImmediate(() => process.exit(1))`. They currently call `writeRuntimeState(...)` synchronously. Once `writeRuntimeState` returns a `Promise`, awaiting from inside a fatal handler is unreliable — `process.exit(1)` is scheduled on the next macrotask, but if the event loop is jammed (which is the most common reason `unhandledRejection` fires), the awaited fsync may never run before `process.exit` tears down the loop.

This is the one place where the architecture-first rule conflicts with reality. We resolve it in the design (Proposal A, "Fatal-handler escape hatch") by **not** going through `documents.ts` for this single call: the fatal handler does an inline `writeFileSync(runtime.project.paths.runtimeState, JSON.stringify({...}))` (no tmp+rename, no fsync — the process is already dying; the worst case is that a different reader sees the previous "running" state, which is exactly what happens today if the process is SIGKILL'd). This is one direct `node:fs` call with a one-line justification comment; it is **not** a parallel sync API in `documents.ts`.

### Knowledge subsystem (out-of-scope, hard cross-team dependency)

`writeDoc` is called inside the knowledge store at two sites that the r1 design counted as one-liners:

- [src/knowledge/store.ts#L250](src/knowledge/store.ts#L250) inside `writeRecordAtomic` (atomicity-critical record write).
- [src/knowledge/store.ts#L414](src/knowledge/store.ts#L414) inside `rebuildIndex` (index file rewrite).

Those two functions are then called from [src/knowledge/lifecycle.ts](src/knowledge/lifecycle.ts) at nine sites: `writeRecordAtomic` at [lifecycle.ts#L265](src/knowledge/lifecycle.ts#L265), [L310](src/knowledge/lifecycle.ts#L310), [L327](src/knowledge/lifecycle.ts#L327), [L406](src/knowledge/lifecycle.ts#L406), [L414](src/knowledge/lifecycle.ts#L414), [L498](src/knowledge/lifecycle.ts#L498), [L534](src/knowledge/lifecycle.ts#L534), [L551](src/knowledge/lifecycle.ts#L551), [L620](src/knowledge/lifecycle.ts#L620), [L628](src/knowledge/lifecycle.ts#L628); `rebuildIndex` at [lifecycle.ts#L117](src/knowledge/lifecycle.ts#L117). Adding `await` to the two sites in `store.ts` makes `writeRecordAtomic` and `rebuildIndex` async, which cascades the same shape through `lifecycle.ts`.

`writeRecordAtomic` is the atomicity primitive — a fire-and-forget unawaited write inside it would break the contract documented at [store.ts#L211-L218](src/knowledge/store.ts#L211-L218) ("validates first; rejects … before any byte hits disk"). The clean architecture has no shortcut: the knowledge subsystem must become async at the same boundary.

There is **also** other sync `node:fs` use inside the knowledge subsystem (`existsSync`, `readdirSync`, `readFileSync` in [store.ts#L260-L267](src/knowledge/store.ts#L260-L267), [store.ts#L344-L348](src/knowledge/store.ts#L344-L348), [store.ts#L420-L437](src/knowledge/store.ts#L420-L437); `appendJsonlAtomic` at [store.ts#L274-L296](src/knowledge/store.ts#L274-L296) uses `openSync`/`writeSync`/`fsyncSync`/`closeSync`). F22 does not modify those — they are not on the `documents.ts` path. The skills/memory subsystem can independently choose to convert them when their own async pass is done.

We therefore treat the knowledge boundary as a **mandatory cross-team handshake**: F22 lands at the same time as a coordinated knowledge-subsystem change that awaits the two `writeDoc` calls and propagates `async` through `writeRecordAtomic`, `rebuildIndex`, and the nine `lifecycle.ts` callers. The handshake list is enumerated in the plan; if the skills/memory agent has not signed off, F22 does not land — there is no signature-compatible escape.

### Error modes

- `readFileSync` → `ENOENT` is rejected by `readDoc`, swallowed by the `OrNull` variants.
- `writeDoc` validates with `schema.parse` first (throws ZodError) before any disk I/O.
- `fsyncSync` failures are caught and silently ignored (tmpfs / Windows tolerance).
- Atomic write contract: post-condition is "file at `path` is either the previous valid content or the new validated content". The `*.tmp` sidecar may survive a crash, hence `sweepStaleTempFiles` at boot.

### Lifecycle

- `documents.ts` has no state — pure functions over `fs`.
- The implicit lock model is single-writer-per-path; nothing in the module enforces it. Concurrency between, say, `RuntimeTracker.flush` and `recoverFromCrash` is currently prevented by the runtime lockfile (`runtime.lock`) acquired in [src/runtime/recovery.ts](src/runtime/recovery.ts#L82-L143), not by `documents.ts`.

## Call sites & dependencies

- Schemas used by every consumer come from [src/types.ts](src/types.ts) (`ProjectConfigSchema`, `PlanSchema`, `PlanHistorySchema`, `TaskListSchema`, `TaskReportSchema`, `StageSummarySchema`, `UserNoteSchema`, `InspectionReportSchema`, `ChatLogSchema`, `RuntimeStateSchema`, `ShutdownRequestSchema`, `ShutdownSummarySchema`, etc.). Switching to async does not affect schema validation — it stays synchronous CPU work.
- `RuntimeTracker.flush()` is currently sync-fire-and-forget; if it becomes async, every `agentStarted` / `agentStopped` / `agentActivity` / `setCurrentStage` callsite needs either to `await` (breaks the agent loop's signature) or to enqueue via a coalescing single-writer queue (chosen — see design).
- `await writeRuntimeState(...)` is already in place at [bootstrap.ts#L199](src/server/bootstrap.ts#L199) and [bootstrap.ts#L235](src/server/bootstrap.ts#L235); the `await` becomes meaningful.
- `await writeDoc(...)` is already at [src/agents/chat.ts#L550](src/agents/chat.ts#L550) and similar — same observation.
- The runtime lock file (`runtime.lock`) at [src/runtime/recovery.ts#L83-L143](src/runtime/recovery.ts#L83-L143) uses `openSync(lockPath, "wx")` for `O_CREAT|O_EXCL` atomicity. This call **stays sync** because (a) `fs.promises.open(path,"wx")` is also atomic at the syscall level but (b) the bootstrap path must complete the lock acquisition before any agent runs, so an inline sync open is acceptable and consistent with the existing code shape. The design picks the async-`open` form anyway; the lock semantics are unchanged.

## Constraints any solution must respect

1. **Architecture-first, no compat shims.** No "old sync function + new async function" parallel APIs. Whichever name a function has after this change is the only one.
2. **Atomicity contract preserved.** Any rewrite keeps tmp-file + rename + fsync-of-data + fsync-of-directory. Removing fsync to make migration easier is forbidden.
3. **Schema validation stays synchronous.** Zod has no async equivalent we want.
4. **No new layers of abstraction.** Free-function shape, plus the `RuntimeTracker` coalescer (one in-flight Promise + one queued state — ~30 lines).
5. **`RuntimeTracker.flush` cannot drop writes silently.** If `flush` becomes async, the design must coalesce pending writes so a queued newer state supersedes an in-flight older state without losing the final "idle" write that `freeze()` relies on.
6. **Knowledge cross-team handshake.** The skills/memory agent owns `src/knowledge/store.ts` and `src/knowledge/lifecycle.ts`. F22 lands only with a coordinated change there — not via a fire-and-forget unawaited Promise inside `writeRecordAtomic`, and not via a parallel sync `documents.ts` API.
7. **Fatal handler escape hatch.** The single `writeRuntimeState` call inside `installFatalHandlers` is replaced by an inline `writeFileSync` so the dying process can stamp `"error"` without depending on the event loop running. This is one direct `node:fs` call, documented with a one-line justification — not a new API in `documents.ts`.
8. **Constructor-time `buildHandoffContext`.** JS forbids `await` before `super(...)`. Each agent class gains a static `async create(...)` factory that pre-builds the handoff string and forwards it into the synchronous constructor.
9. **Tests.** [src/store/documents.test.ts](src/store/documents.test.ts), [src/runtime/runtime.test.ts](src/runtime/runtime.test.ts), [src/runtime/shutdown-handoff.test.ts](src/runtime/shutdown-handoff.test.ts), [src/store/project.test.ts](src/store/project.test.ts), and [src/knowledge/store.test.ts](src/knowledge/store.test.ts) / [src/knowledge/integration.test.ts](src/knowledge/integration.test.ts) must be updated coherently. Vitest supports async `it` callbacks; no infra change required.

## Cross-references

- **F08** (legacy runtime-state mirror): `writeRuntimeState` writes the same payload twice. Whatever we pick here, F08 should be applied first or in the same change so we do not pay 2× fsync per heartbeat. The recommendation in the plan assumes F08 has already removed the legacy mirror; if not, this change accepts that ordering.
- **F34** (`plan-server.ts` re-reads from disk on every operation): every planner tool call hits `readDocOrNull(plan.json)` + `readDocOrNull(plan-history.json)`. Async I/O alone does not fix this — F34 introduces a cache. F34 must land after F22 so the cache writes go through the async path.
- **F06** (oversized `server.ts`): the worst sync hotspots live in `server.ts` debug routes. Whatever split F06 produces, the per-route handlers stay the unit of change for F22.
