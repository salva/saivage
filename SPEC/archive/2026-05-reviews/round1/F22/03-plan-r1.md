# F22 — Document Store Sync FS — Plan r1 (Proposal A)

Single-commit conversion to async I/O across `src/store/`, the runtime, the MCP plan server, the agents, and the Fastify routes.

## Ordering vs. other issues

- **Before**: F34 (plan cache) — it depends on async `writeDoc`/`readDoc`.
- **Independent of**: F11 (supervisor constants) — they don't share code paths.
- **Prefer after**: F08 (legacy runtime-state mirror removed). If F08 has not landed when F22 starts, the `writeRuntimeState` body simply has two `await writeDoc(...)` lines instead of one; F08 deletes the legacy one in its own commit. Not blocking either way.
- **Cross-team handshake**: the skills/memory agent must accept two one-line `await` insertions in [src/knowledge/store.ts](src/knowledge/store.ts#L250) and [L414](src/knowledge/store.ts#L414). No other change to that subsystem.

## Edit steps

### 1. Rewrite [src/store/documents.ts](src/store/documents.ts)

- Replace the `node:fs` import block with `import { open, readFile, writeFile, rename, unlink, readdir, mkdir, stat, access } from "node:fs/promises";` and `import { constants } from "node:fs";` for `F_OK`.
- Convert every exported function to `async`. Replace `existsSync(path)` in `readDocOrNull`, `readJsonOrNull`, `readDocLenient`, `deleteDoc`, `appendDoc`, `listDir`, `ensureDir`, `sweepStaleTempFiles` with `try { await access(path, constants.F_OK); } catch { return ... }` or — preferably for the read paths — let `readFile` throw `ENOENT` and catch it:
  ```ts
  export async function readDocOrNull<S extends ZodTypeAny>(path: string, schema: S): Promise<z.output<S> | null> {
    let raw: string;
    try { raw = await readFile(path, "utf-8"); }
    catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
    return schema.parse(JSON.parse(raw));
  }
  ```
- `writeDoc`: use `await open(tmp, "w")` to get a `FileHandle`, then `await handle.writeFile(payload, "utf-8")`, `await handle.sync().catch(() => {})`, `await handle.close()`, `await rename(tmp, path)`, then open the parent directory for fsync via `await open(dirname(path), "r")` + `await handle.sync().catch(() => {})` + `await handle.close()`. The two `.catch(() => {})` calls preserve the tmpfs/Windows tolerance from the current code.
- `ensureDir`: `await mkdir(dirPath, { recursive: true })`. `mkdir` with `recursive` is idempotent — no `existsSync` precheck needed; drop it.
- `appendDoc`: same structure, `await readDoc` / `await writeDoc` calls become awaited.
- `listDir` / `listDocs`: `await readdir(dirPath)`. Return `[]` on `ENOENT`.
- `sweepStaleTempFiles`: `await readdir` + `await stat` per entry + `await unlink`. Same outer try/catch shape.
- Remove the `existsSync`, `openSync`, `closeSync`, `fsyncSync`, `statSync`, `readFileSync`, `writeFileSync`, `renameSync`, `unlinkSync`, `readdirSync`, `mkdirSync` imports — all gone from this file.

### 2. Update [src/store/project.ts](src/store/project.ts)

- `loadProject` → `async function loadProject(projectRoot: string): Promise<ProjectContext>`. Replace the sync `readDoc` with `await readDoc`.
- `initProject` → `async`. Every `ensureDir` and `writeDoc` becomes awaited. The `if (existsSync(configPath))` precheck becomes `try { await stat(configPath); throw new Error(...) } catch (err) { if (code !== "ENOENT") throw }` — or, more simply, attempt the write with `flag: "wx"` semantics in `writeDoc` (we don't currently support that; do it in `initProject` itself with an `await access` precheck).
- `initProjectTree`: keep `writeFileSync` for `index.json` / `audit.jsonl` seeding only if we leave knowledge-tree seeding out of scope. **Better**: convert these to `await writeFile` from `node:fs/promises`. They are part of an async function now anyway.
- `discoverProject`: keep sync. It's pure path walking and runs once before any I/O matters. It uses `existsSync(join(candidate, "config.json"))`; replace with `await access(...)` if we want full purity, or leave as sync — `discoverProject` is the one place where the cost of sync `access` is negligible (microseconds, called once). **Decision**: convert to async for consistency. Returns `Promise<string | null>`.

### 3. Update [src/runtime/recovery.ts](src/runtime/recovery.ts)

- `isAnotherInstanceRunning` → async (uses `readDocOrNull`).
- `acquireRuntimeLock`: convert the `ensureDir` call to `await`. **Keep the `O_EXCL` lock acquisition itself sync** via `openSync(lockPath, "wx")` — this is the one deliberate exception; it runs once at boot, before any HTTP listener, and must complete before any other code touches `.saivage/`. Document this with a one-line comment that does NOT contradict the "no docstrings on unrelated code" rule because the comment explains the deliberate sync usage in this function.
- `recoverFromCrash` → async. Every `readDocOrNull`, `existsSync`, `readDoc`, `writeDoc` call becomes awaited; the `existsSync(stageDir)` / `existsSync(reportsDir)` / `existsSync(tasksPath)` checks become `await access(...).then(() => true).catch(() => false)` helpers or are folded into the read by tolerating `ENOENT` via `readDocOrNull`.
- `writeRuntimeState` → async. Two `await writeDoc(...)` calls inside (or one once F08 lands).
- `createRuntimeState` stays sync (pure).
- `RuntimeTracker`:
  - Add private fields `private pendingState: RuntimeState | null = null;` and `private inFlight: Promise<void> | null = null;`.
  - Replace `flush()` body with:
    ```ts
    private flush(): void {
      if (this.frozen) return;
      const state = this.snapshot();
      this.pendingState = state;
      if (this.inFlight) return; // existing in-flight write will pick up pendingState on completion
      this.inFlight = this.drain();
    }
    private snapshot(): RuntimeState { /* current flush body, no write */ }
    private async drain(): Promise<void> {
      while (this.pendingState && !this.frozen) {
        const next = this.pendingState;
        this.pendingState = null;
        try { await writeRuntimeState(this.statePath, next); }
        catch (err) { log.warn(`[recovery] RuntimeTracker write failed: ${String(err)}`); }
      }
      this.inFlight = null;
    }
    ```
  - `freeze()` stays sync; it only sets `frozen = true`. The final "idle" state write is performed explicitly from `bootstrap.shutdown()` via `await writeRuntimeState(...)` — already in place.
  - **Important**: the callers (`agentStarted`, `agentStopped`, `agentActivity`, `setCurrentStage`) remain sync — they just enqueue. No signature change for the agent loop. This is the central design point of Proposal A.

### 4. Update [src/runtime/notes.ts](src/runtime/notes.ts)

- `NoteManager.createNote`, `acknowledgeNote`, `deleteNote`, `clearNotes`, `listNotes`, `loadNote` all become `async`.
- Update the three callers in [src/server/server.ts](src/server/server.ts#L261-L291) (`/api/notes`, `/api/notes/:noteId/acknowledge`, `/api/notes/:noteId`, `/api/notes` DELETE) to `await` the calls. The route handlers are already `async` to Fastify.
- Update internal callers in agents (planner pending-notes loop, dispatcher's `attachPendingNotesNotice`) — search via `grep_search "new NoteManager"` and add `await`.

### 5. Update [src/runtime/shutdown-handoff.ts](src/runtime/shutdown-handoff.ts)

- All three exported functions become `async`. The bootstrap call sites already use `await` (verify with `grep_search`).

### 6. Update [src/runtime/abort.ts](src/runtime/abort.ts)

- The one `readDoc` call becomes `await`. Containing function becomes `async`.

### 7. Update [src/agents/handoff.ts](src/agents/handoff.ts)

- The one `readDocLenient` call becomes `await`. Function becomes `async`. Cascade `await` into the agents that call it (planner / manager initial-message build).

### 8. Update [src/agents/chat.ts](src/agents/chat.ts)

- `await writeDoc(...)` and `await ensureDir(...)` are already awaited shape — they now actually do something.
- Read sites (`readDocOrNull` / `readDocLenient`) become `await`. The containing methods are already async (Fastify WS chat loop).

### 9. Update [src/mcp/plan-server.ts](src/mcp/plan-server.ts)

- Every public method becomes `async`. The MCP dispatcher already awaits tool returns, so callers are unaffected.
- Constructor's `ensureDir(projectSaivageDir)` — if the constructor cannot be async, hoist to a static `async create(...)` factory or a lazy `init()` called from `bootstrap`. Inspect [src/mcp/plan-server.ts](src/mcp/plan-server.ts#L58-L72) to confirm shape; if `ensureDir` is the only async-needing call in the constructor, replace it with an `async init()` method invoked once from `bootstrap`.

### 10. Update [src/server/server.ts](src/server/server.ts)

- Every handler that calls `readDocOrNull` / `readDocLenient` / `readJsonOrNull` / `listDocs` gains `await` on those calls.
- The raw `readFileSync` / `readdirSync` / `statSync` / `existsSync` in `/api/files`, `/api/files/content`, `/api/debug/state`, `/api/debug/errors`, `/api/debug/timeline`, `/api/chats`, `/api/chats/:sessionId` migrate to `await readFile` / `await readdir` / `await stat` / `await access`. Drop the `existsSync` import.
- For the heavy fan-out in `/api/debug/errors` and `/api/debug/timeline`, run the per-stage reads in parallel with `Promise.all(stageIds.map(async (id) => { ... }))`. This is allowed by the issue (it's what makes async actually win on these handlers) and does not change the result set. Limit concurrency only if profiling shows fd exhaustion — for the expected workload (≤ thousands of files) `Promise.all` is fine.

### 11. Update [src/server/bootstrap.ts](src/server/bootstrap.ts)

- The three `await writeRuntimeState(...)` calls already use `await` — they now actually fsync asynchronously.
- The planner recovery loop and OAuth-token-injection paths get `await` on any newly-async helpers they consume.

### 12. Cross-issue: [src/knowledge/store.ts](src/knowledge/store.ts) (out-of-scope subsystem, minimal touch)

- Add `await` to the two `writeDoc(...)` call sites at [L250](src/knowledge/store.ts#L250) and [L414](src/knowledge/store.ts#L414). Cascade `async` up to whoever calls those functions in the knowledge subsystem. **This is a one-line change per call site; do not refactor anything else.** Coordinate with the skills/memory agent before opening the PR.

### 13. Update tests

- [src/store/documents.test.ts](src/store/documents.test.ts): every `it` callback becomes `async`; every `readDoc` / `writeDoc` / `appendDoc` / `listDocs` / `deleteDoc` / `ensureDir` / `sweepStaleTempFiles` call gains `await`.
- [src/runtime/runtime.test.ts](src/runtime/runtime.test.ts): the four `writeRuntimeState(...)` calls become `await writeRuntimeState(...)` inside `async` `it` blocks. The "writeRuntimeState mirrors the compatibility runtime-state path" test must still pass (verifies the legacy mirror; depends on F08).
- [src/runtime/shutdown-handoff.test.ts](src/runtime/shutdown-handoff.test.ts), [src/agents/agents.test.ts](src/agents/agents.test.ts), [src/agents/conversation-snapshot.test.ts](src/agents/conversation-snapshot.test.ts), [src/knowledge/integration.test.ts](src/knowledge/integration.test.ts): same mechanical update.
- No new tests required for correctness of the rewrite itself — the existing tests cover read/write round-trips, atomicity, and tmp sweeping.
- **New test required for `RuntimeTracker` coalescing**: add to [src/runtime/runtime.test.ts](src/runtime/runtime.test.ts):
  - "RuntimeTracker coalesces rapid heartbeats" — call `agentActivity` 100 times in a row, await one microtask, verify exactly one or two `writeRuntimeState` invocations occurred (not 100). Mock the write or spy via `fs/promises`.
  - "RuntimeTracker.freeze stops the drain loop" — schedule a write, call `freeze()` synchronously before the drain awakens; verify no further writes after freeze observed time.

## Test commands

Local dev loop:

```bash
cd /home/salva/g/ml/saivage
npm run typecheck
npm run build
npx vitest run src/store/documents.test.ts
npx vitest run src/runtime/runtime.test.ts
npx vitest run src/runtime/shutdown-handoff.test.ts
npx vitest run src/agents
npx vitest run   # full suite
```

A clean run is required for all of the above.

Smoke check post-build (optional, only if a v2 deployment is up):

```bash
curl -fsS http://10.0.3.111:8080/health
curl -fsS http://10.0.3.111:8080/api/debug/timeline | head -c 200
```

Expected: `/health` returns immediately; `/api/debug/timeline` completes without blocking parallel `/health` calls (manual check: open two terminals, hit both endpoints in parallel, neither should serialise behind the other).

## Rollback

Single commit. `git revert <sha>` returns the entire file set to sync. The on-disk format of every JSON document is unchanged — no data migration to undo. The `RuntimeTracker` queue is created from in-memory state at startup, so reverting cannot strand any pending write on disk.

## Out-of-scope guards

- Do NOT change atomicity semantics (tmp+rename+fsync stays).
- Do NOT remove `sweepStaleTempFiles` or its boot-time invocation.
- Do NOT touch [src/skills/](src/skills/), [SPEC/v2/skills-memory/](SPEC/v2/skills-memory/), or [SPEC/v2/skills/](SPEC/v2/skills/).
- Do NOT introduce a `DocumentStore` class, dependency-injection container, or any abstraction over `node:fs/promises`. The free-function shape is preserved.
