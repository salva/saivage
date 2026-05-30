# F22 — Document Store Sync FS — Analysis r1

## Problem restated

`src/store/documents.ts` exposes a small CRUD facade (`readDoc`, `readDocOrNull`, `readDocLenient`, `readJsonOrNull`, `writeDoc`, `appendDoc`, `listDir`, `listDocs`, `deleteDoc`, `ensureDir`, `sweepStaleTempFiles`) that performs **every** filesystem operation synchronously: `readFileSync`, `writeFileSync`, `renameSync`, `unlinkSync`, `readdirSync`, `mkdirSync`, `existsSync`, `openSync`/`closeSync`/`fsyncSync`, `statSync`.

These primitives are invoked from three classes of caller that share the Node event loop:

1. **Fastify HTTP routes** — every read in [src/server/server.ts](src/server/server.ts#L100-L598) is sync. The two worst handlers iterate the entire stage tree and every report file:
   - [`/api/debug/errors`](src/server/server.ts#L505-L606): for every `stages/<id>/` calls `existsSync`, `statSync`, `readFileSync(summary.json)`, `readdirSync(reports)`, then `readFileSync` on every `*.json`. With N stages × M reports per stage this is O(N·M) blocking reads in a single tick.
   - [`/api/debug/timeline`](src/server/server.ts#L608-L662): same shape.
   - [`/api/chats`](src/server/server.ts#L295-L334) and [`/api/chats/:sessionId`](src/server/server.ts#L336-L358): `readdirSync` of every channel directory + `readDocOrNull` per session file.
   - [`/api/files`](src/server/server.ts#L420-L466) and [`/api/files/content`](src/server/server.ts#L468-L502): sync `readdirSync`, `statSync`, `readFileSync` (up to 1 MiB).
   - [`/api/plan/stages/:id`](src/server/server.ts#L155-L177): `readDocLenient` for tasks, summary, and every report.
   - [`/health`](src/server/server.ts#L128-L138), [`/api/state`](src/server/server.ts#L180-L189), [`/api/plan`](src/server/server.ts#L143-L153), [`/api/inspections`](src/server/server.ts#L248-L258), [`/api/debug/state`](src/server/server.ts#L474-L502): each does 1-3 `readDocOrNull` calls per request.

2. **WebSocket bootstrap and chat persistence** — every chat-write goes through `writeDoc`: [src/agents/chat.ts](src/agents/chat.ts#L550) writes the entire `ChatLog` after each user/agent turn (`await writeDoc(...)` — the await is currently a no-op because `writeDoc` is sync, but it pins the caller signature to "promise-shaped"). The WebSocket route in [src/server/server.ts](src/server/server.ts#L666-L709) reads runtime state and spawns the chat agent on the same tick.

3. **Hot agent and supervisor loops**:
   - `RuntimeTracker.flush()` at [src/runtime/recovery.ts](src/runtime/recovery.ts#L398-L411) is called from `agentStarted`, `agentStopped`, `agentActivity`, and `setCurrentStage`. Every activity tick produces **two** `writeDoc` calls (primary + legacy mirror — see F08) which means **two fsync-of-file + two fsync-of-directory** syscalls per heartbeat.
   - `bootstrap.ts` calls `await writeRuntimeState(...)` at [src/server/bootstrap.ts](src/server/bootstrap.ts#L199), [L235](src/server/bootstrap.ts#L235), [L695](src/server/bootstrap.ts#L695). Same `await`-on-sync pattern as chat.
   - `PlanService` ([src/mcp/plan-server.ts](src/mcp/plan-server.ts#L82-L264)) re-reads `plan.json` and `plan-history.json` on every plan operation invoked by tool dispatch — see F34 (no caching) — and writes back atomically. Every planner tool call is one blocking read + one blocking atomic write.
   - `NoteManager` ([src/runtime/notes.ts](src/runtime/notes.ts#L42-L165)) writes a fresh note JSON on every `create_note` / acknowledge.
   - `recoverFromCrash` ([src/runtime/recovery.ts](src/runtime/recovery.ts#L207-L294)) reads task list, every per-task report, then possibly writes back. Acceptable at boot, problematic only if invoked at request time (it is not).

## Why the blocking matters

Every `writeDoc` performs, on the same OS thread that runs Fastify and the WS pings:

1. `JSON.stringify` of the validated document (CPU bound, can be MBs for a long `ChatLog` or a fat `PlanHistory`).
2. `openSync(tmp, "w")` → `writeFileSync(fd, payload)` → `fsyncSync(fd)` → `closeSync(fd)`.
3. `renameSync(tmp, path)`.
4. `openSync(dirname, "r")` → `fsyncSync(dirFd)` → `closeSync(dirFd)`.

On a typical SSD an fsync is 1-5 ms; on a busy disk or networked FS (the Saivage v2 deployment frequently runs over an LXC bind mount and inside a VM) it routinely hits 30-200 ms. The runtime tracker flushes at least once per agent activity tick, and the supervisor (F11) calls `recoverFromCrash`/state reads at its own cadence. The compound effect cited in the F22 issue file matches what we see: WebSocket pings miss their interval, the SPA reports the socket as dead and reconnects, supervisor wall-clock for an LLM call slips because the dispatcher tick waited on disk.

`/api/debug/errors` and `/api/debug/timeline` are the most acute: a project with 50 archived stages × 10 reports each performs ~550 synchronous file reads inside the handler — over a slow FS that's seconds of total wall time, all of it on the event loop.

## Contract

Current public API of [src/store/documents.ts](src/store/documents.ts) (consumers in `src/`, excluding tests):

| Function                      | Caller files                                                                                   |
|-------------------------------|-----------------------------------------------------------------------------------------------|
| `readDoc<S>(path, schema)`    | [src/runtime/recovery.ts](src/runtime/recovery.ts#L16), [src/runtime/abort.ts](src/runtime/abort.ts#L10), [src/runtime/notes.ts](src/runtime/notes.ts#L11) |
| `readDocOrNull<S>(...)`       | [src/server/server.ts](src/server/server.ts#L13), [src/runtime/recovery.ts](src/runtime/recovery.ts#L16), [src/runtime/shutdown-handoff.ts](src/runtime/shutdown-handoff.ts#L16), [src/agents/chat.ts](src/agents/chat.ts#L19), [src/mcp/plan-server.ts](src/mcp/plan-server.ts#L11) |
| `readDocLenient<S>(...)`      | [src/server/server.ts](src/server/server.ts#L13), [src/agents/chat.ts](src/agents/chat.ts#L19), [src/agents/handoff.ts](src/agents/handoff.ts#L2) |
| `readJsonOrNull(path)`        | [src/server/server.ts](src/server/server.ts#L13) (one site, `/api/debug/state` raw config dump) |
| `writeDoc<T>(...)`            | [src/runtime/recovery.ts](src/runtime/recovery.ts#L16), [src/runtime/notes.ts](src/runtime/notes.ts#L11), [src/runtime/shutdown-handoff.ts](src/runtime/shutdown-handoff.ts#L16), [src/agents/chat.ts](src/agents/chat.ts#L19), [src/mcp/plan-server.ts](src/mcp/plan-server.ts#L12), [src/knowledge/store.ts](src/knowledge/store.ts#L27) (out of scope per `_LOOP-CONVENTIONS.md`) |
| `appendDoc<T>(...)`           | tests only; production code uses `writeDoc` after a manual read-modify-write |
| `listDocs(...)`               | [src/server/server.ts](src/server/server.ts#L13) |
| `listDir(...)`                | internal to `documents.ts` |
| `deleteDoc(...)`              | [src/runtime/shutdown-handoff.ts](src/runtime/shutdown-handoff.ts#L16), [src/runtime/notes.ts](src/runtime/notes.ts#L11) |
| `ensureDir(...)`              | [src/runtime/recovery.ts](src/runtime/recovery.ts#L16), [src/runtime/notes.ts](src/runtime/notes.ts#L11), [src/mcp/plan-server.ts](src/mcp/plan-server.ts#L13), [src/agents/chat.ts](src/agents/chat.ts#L19), [src/store/project.ts](src/store/project.ts#L8) |
| `sweepStaleTempFiles(...)`    | [src/runtime/recovery.ts](src/runtime/recovery.ts#L16) (boot only) |

Out of scope (per `_LOOP-CONVENTIONS.md` `## Out-of-scope`):
- [src/knowledge/store.ts](src/knowledge/store.ts#L27) imports `writeDoc`. Any API rename that touches the knowledge subsystem must be coordinated with the skills/memory agent; this proposal restricts changes to a strictly additive or signature-compatible rename if it has to.
- Knowledge tree initial seeding in [src/store/project.ts](src/store/project.ts#L132-L173) uses `writeFileSync`/`readFileSync` directly (not the helpers) — it is part of `initProject`, which runs once at boot and is safe to leave sync.

### Error modes

- `readFileSync` → `ENOENT` is rejected by `readDoc`, swallowed by the `OrNull` variants.
- `writeDoc` validates with `schema.parse` first (throws ZodError) before any disk I/O.
- `fsyncSync` failures are caught and silently ignored (tmpfs / Windows tolerance).
- Atomic write contract: post-condition is "file at `path` is either the previous valid content or the new validated content". The `*.tmp` sidecar may survive a crash, hence `sweepStaleTempFiles` at boot.

### Lifecycle

- `documents.ts` has no state — pure functions over `fs`.
- The implicit lock model is single-writer-per-path; nothing in the module enforces it. Concurrency between, say, `RuntimeTracker.flush` and `recoverFromCrash` is currently prevented by the runtime lockfile (`runtime.lock`) acquired in [src/runtime/recovery.ts](src/runtime/recovery.ts#L82-L143), not by `documents.ts`.

## Call sites & dependencies

- Schemas used by every consumer come from [src/types.ts](src/types.ts) (`ProjectConfigSchema`, `PlanSchema`, `PlanHistorySchema`, `TaskListSchema`, `TaskReportSchema`, `StageSummarySchema`, `UserNoteSchema`, `InspectionReportSchema`, `ChatLogSchema`, `RuntimeStateSchema`, etc.). Switching to async does not affect schema validation — it stays synchronous CPU work.
- `RuntimeTracker.flush()` is currently sync-fire-and-forget; if it becomes async, every `agentStarted` / `agentStopped` / `agentActivity` / `setCurrentStage` callsite needs to either `await` the write (turning agent lifecycle into async chains) or accept a "fire-and-forget Promise" model (which can interleave writes and lose updates without a queue).
- `await writeRuntimeState(...)` is already written at [src/server/bootstrap.ts](src/server/bootstrap.ts#L199) — the `await` is currently a no-op on a sync return but the signature is forward-compatible.
- `await writeDoc(...)` is already at [src/agents/chat.ts](src/agents/chat.ts#L550) — same observation.
- The runtime lock file (`runtime.lock`) at [src/runtime/recovery.ts](src/runtime/recovery.ts#L83-L143) uses `openSync(lockPath, "wx")` for `O_CREAT|O_EXCL` atomicity. **This file is not opened via `documents.ts`** — it stays sync regardless of which option we pick, because the bootstrap path must complete the lock acquisition before any agent runs.

## Constraints any solution must respect

1. **Architecture-first, no compat shims.** No "old sync function + new async function" parallel APIs. Whichever name a function has after this change is the only one.
2. **Atomicity contract preserved.** Any rewrite keeps tmp-file + rename + fsync-of-data + fsync-of-directory. Removing fsync to make migration easier is forbidden — that's a different proposal under a different issue.
3. **Schema validation stays synchronous.** Zod has no async equivalent we want to introduce; CPU validation is fine on the loop.
4. **No new layers of abstraction.** A `DocumentStore` interface or a single-writer queue object would be over-engineering unless the proposal genuinely needs one (Proposal C does, and justifies it). The current free-function shape is sufficient for A and B.
5. **`RuntimeTracker.flush` cannot drop writes silently.** If `flush` becomes async, the design must either (a) `await` from every caller path, or (b) coalesce pending writes so a queued newer state supersedes an in-flight older state without losing the final "idle" write that `freeze()` relies on.
6. **Out-of-scope code.** Do not modify [src/knowledge/store.ts](src/knowledge/store.ts) or [src/knowledge/lifecycle.ts](src/knowledge/lifecycle.ts) signatures beyond the minimum needed to consume an unchanged or signature-compatible `writeDoc`. If `writeDoc` becomes async, the knowledge import line at [src/knowledge/store.ts](src/knowledge/store.ts#L27) and its two call sites at [L250](src/knowledge/store.ts#L250) and [L414](src/knowledge/store.ts#L414) need an `await` — coordinate with the skills/memory agent.
7. **Tests.** [src/store/documents.test.ts](src/store/documents.test.ts) and [src/runtime/runtime.test.ts](src/runtime/runtime.test.ts) (which calls `writeRuntimeState` synchronously inside `it` blocks) must be updated coherently. Vitest supports async `it` callbacks; no infra change required.

## Cross-references

- **F08** (legacy runtime-state mirror): `writeRuntimeState` writes the same payload twice. Whatever we pick here, F08 should be applied first or in the same change so we do not pay 2× fsync per heartbeat. The recommendation in §Plan assumes F08 has already removed the legacy mirror; if not, this change must accept that ordering.
- **F34** (`plan-server.ts` re-reads from disk on every operation): every planner tool call hits `readDocOrNull(plan.json)` + `readDocOrNull(plan-history.json)`. Async I/O alone does not fix this — F34 introduces a cache. The two changes are independent but compound; F34 should land after F22 so the cache writes go through whichever async path F22 settles on.
- **F06** (oversized `server.ts`): the worst sync hotspots live in `server.ts` debug routes. Whatever split F06 produces, the per-route handlers stay the unit of change for F22.
