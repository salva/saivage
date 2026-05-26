# F22 — Document Store Sync FS — Plan r2 (Proposal A)

## Changes from r1

- Expanded edit steps to enumerate every CLI command, the bootstrap async cascade, the notes API (correct names), the shutdown handoff functions, the fatal-handler escape hatch, the `buildHandoffContext` factory pattern (per-agent static `async create(...)`), and the `PlanService.init()` change.
- Replaced the "two one-line awaits" knowledge note with the complete coordinated handshake list (10 sites in lifecycle.ts + 2 sites in store.ts + the cascade through `writeRecordAtomic`/`rebuildIndex` signatures).
- Added the missing test files to validation: `src/store/project.test.ts`, `src/knowledge/store.test.ts`, `src/knowledge/integration.test.ts`, plus a new test for the fatal-handler inline write and `RuntimeTracker` coalescing.

Single-commit conversion (or a paired-commit landing with the knowledge-subsystem PR — see step 14).

## Ordering vs. other issues

- **Before**: F34 (plan cache) — it depends on async `writeDoc`/`readDoc`.
- **Independent of**: F11 (supervisor constants).
- **Prefer after**: F08 (legacy runtime-state mirror removed). If F08 has not landed when F22 starts, `writeRuntimeState` body simply has two `await writeDoc(...)` lines instead of one.
- **Hard cross-team handshake**: skills/memory agent must land the knowledge-subsystem async pass listed in step 14 in the same merge window. F22 does NOT unilaterally rewrite the knowledge subsystem.

## Edit steps

### 1. Rewrite [src/store/documents.ts](src/store/documents.ts)

- Replace the `node:fs` sync imports with `import { open, readFile, writeFile, rename, unlink, readdir, mkdir, stat, access } from "node:fs/promises";` and `import { constants } from "node:fs";` for `F_OK`.
- Convert every exported function to `async`. Drop `existsSync` precheck: let `readFile`/`readdir`/`stat` throw `ENOENT` and catch it in the `OrNull` helpers. Example:
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
- `writeDoc`: `await open(tmp, "w")` → `await handle.writeFile(payload, "utf-8")` → `await handle.sync().catch(() => {})` → `await handle.close()` → `await rename(tmp, path)` → `await open(dirname(path), "r")` → `await dirHandle.sync().catch(() => {})` → `await dirHandle.close()`. The two `.catch(() => {})` preserve tmpfs/Windows tolerance.
- `ensureDir`: `await mkdir(dirPath, { recursive: true })`; drop the existsSync precheck.
- `appendDoc`, `listDir`, `listDocs`, `sweepStaleTempFiles`, `deleteDoc`: same shape. Return `[]` on `ENOENT` for the list helpers.
- Delete all `*Sync` imports from this file.

### 2. Update [src/store/project.ts](src/store/project.ts)

- `discoverProject(startDir)` → `async function discoverProject(startDir: string): Promise<string | null>`. Replace `existsSync(join(candidate, "config.json"))` with `await access(...).then(() => true).catch(() => false)`.
- `loadProject(projectRoot)` → `async`. `readDoc(...)` gains `await`.
- `initProject(projectRoot, config)` → `async`. The `existsSync(configPath)` precheck becomes `try { await access(configPath, constants.F_OK); throw new Error(`Project already initialized at ${saivageDir}`); } catch (err) { if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err; }`. All `ensureDir` calls and the `writeDoc` call gain `await`. The final `return loadProject(projectRoot);` becomes `return await loadProject(projectRoot);`.
- `initProjectTree(projectRoot)` → `async`. Replace each `writeFileSync(path, content, "utf-8")` with `await writeFile(path, content, "utf-8")` (from `node:fs/promises`).

### 3. Update [src/server/cli.ts](src/server/cli.ts)

Every `.action(async ...)` already runs in async context. Add `await`:

- `init` ([cli.ts#L42-L80](src/server/cli.ts#L42-L80)): `const ctx = await initProject(path, config);`.
- `start` ([cli.ts#L84-L120](src/server/cli.ts#L84-L120)): unchanged at the `bootstrap` boundary (already awaited).
- `status` ([cli.ts#L124-L162](src/server/cli.ts#L124-L162)): `const root = projectPath ? resolve(projectPath) : await discoverProject(process.cwd()); ... const project = await loadProject(root); const plan = await readDocOrNull(project.paths.plan, PlanSchema); const state = await readDocOrNull(project.paths.runtimeState, RuntimeStateSchema);`.
- `note` ([cli.ts#L166-L202](src/server/cli.ts#L166-L202)): `const project = await loadProject(root); ... await ensureDir(project.paths.notes); ... await writeDoc(notePath, note, UserNoteSchema);`.
- `request-shutdown` ([cli.ts#L207-L233](src/server/cli.ts#L207-L233)): `const project = await loadProject(resolve(projectPath)); ... await writeShutdownRequest(project, reason, opts.requestedBy ?? "external");`.
- `inspect` ([cli.ts#L237-L283](src/server/cli.ts#L237-L283)): `bootstrap` already awaited. The `new InspectorAgent(ctx, { request })` becomes `await InspectorAgent.create(ctx, { request })` (see step 8 for the factory).
- `models` ([cli.ts#L289-L321](src/server/cli.ts#L289-L321)): `const root = projectPath ? resolve(projectPath) : await discoverProject(process.cwd());`.
- `serve` ([cli.ts#L326-L406](src/server/cli.ts#L326-L406)): unchanged — `bootstrap` awaited, `startServer` awaited.
- `login` ([cli.ts#L410-L488](src/server/cli.ts#L410-L488)) and `logout` ([cli.ts#L492-L546](src/server/cli.ts#L492-L546)): `const root = projectPath ? resolve(projectPath) : await discoverProject(process.cwd());`. The raw `writeFileSync(fp, ...)` for `auth-profiles.json` stays as direct `node:fs` — not part of `documents.ts`.

### 4. Update [src/runtime/recovery.ts](src/runtime/recovery.ts)

- `isAnotherInstanceRunning(...)` → async. `await readDocOrNull(...)`.
- `acquireRuntimeLock(saivageDir)` → keep sync. It internally calls `await ensureDir(stateDir)` (so the function body has one `await`) — therefore the function signature must become `async function acquireRuntimeLock(...): Promise<RuntimeLock>`. The `openSync(lockPath, "wx")` lock primitive stays sync inside the async body (it is microseconds, runs once, must complete before any other code touches `.saivage/`). One-line comment in the function body explaining the deliberate sync `openSync` use.
- `recoverFromCrash(project, planService)` → async. Every `readDocOrNull`, `existsSync(...)`, `readDoc`, `writeDoc` call gains `await`; `existsSync(stageDir)` / `existsSync(reportsDir)` / `existsSync(tasksPath)` checks are folded into the read by tolerating `ENOENT` via `readDocOrNull` or replaced with `await access(...).then(() => true).catch(() => false)`.
- `writeRuntimeState(path, state)` → async. Two `await writeDoc(...)` calls inside (or one once F08 lands).
- `createRuntimeState()` stays sync (pure).
- `RuntimeTracker`:
  - Add `private pendingState: RuntimeState | null = null;` and `private inFlight: Promise<void> | null = null;`.
  - Replace `flush()`:
    ```ts
    private flush(): void {
      if (this.frozen) return;
      this.pendingState = this.snapshot();
      if (this.inFlight) return;
      this.inFlight = this.drain();
    }
    private snapshot(): RuntimeState { /* current flush body, but returns the snapshot instead of writing */ }
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
  - `freeze()` stays sync. `bootstrap.shutdown()` already awaits the final `writeRuntimeState(...)` explicitly.
  - Callers `agentStarted` / `agentStopped` / `agentActivity` / `setCurrentStage` stay sync — they enqueue.

### 5. Update [src/runtime/notes.ts](src/runtime/notes.ts)

- `createUserNote(input)` → async. `await ensureDir(...)` and `await writeDoc(...)`.
- `NoteManager` private helper `readAllNotes()` → async. Replace `existsSync(this.notesDir)` and `readdirSync(this.notesDir)` with `try { const files = (await readdir(this.notesDir)).filter(f => f.endsWith(".json")); } catch (err) { if ((err as NodeJS.ErrnoException).code === "ENOENT") return []; throw err; }`.
- Public methods all become async: `listNotes`, `getUnacknowledgedNotes`, `peekUnacknowledgedNotes`, `getPermanentNotes`, `acknowledgeNote`, `acknowledgeNotes`, `deleteNote`, `clearNotes`, `cleanupStaleNotes`. Replace each `existsSync(path)` with the same `await access(...).catch(() => false)` pattern. `readDoc` / `writeDoc` / `deleteDoc` calls gain `await`.

### 6. Update [src/runtime/abort.ts](src/runtime/abort.ts)

- `scanForUrgentNotes(notesDir)` → async. `await readdir(notesDir)`, `await readDoc(...)`.

### 7. Update [src/runtime/shutdown-handoff.ts](src/runtime/shutdown-handoff.ts)

- `writeShutdownRequest(project, reason, requestedBy)` → async. `await writeDoc(...)`.
- `writeShutdownSummary(project)` → async. Five `await readOptionalDoc(...)`, one `await writeDoc(...)`, one conditional `await deleteDoc(...)`.
- `consumeShutdownHandoff(project)` → async. Two `await readOptionalDoc(...)`, two conditional `await deleteDoc(...)`.
- Internal `readOptionalDoc<S>(path, schema, label)` → async.
- Bootstrap call sites at [bootstrap.ts#L226](src/server/bootstrap.ts#L226) and [bootstrap.ts#L255](src/server/bootstrap.ts#L255) gain `await`. CLI call at [cli.ts#L229](src/server/cli.ts#L229) gains `await`.

### 8. Update [src/agents/handoff.ts](src/agents/handoff.ts) and every agent class that consumes it

- `buildHandoffContext(ctx, options)` → async. Two `await readDocLenient(...)` for plan + history; one conditional `await readDocLenient(...)` for tasks when `options.includeTasks`.
- For each agent class below, add a static `async create` factory and remove the `buildHandoffContext` call from the constructor body. Constructors stay sync and accept the pre-built `initialMessage: string`.

  Pattern (illustrated on `PlannerAgent`):
  ```ts
  // before (planner.ts ~L168-L188)
  constructor(ctx: AgentContext, childSpawner: ChildSpawner, config?: Partial<BaseAgentConfig>) {
    const initialMessage = buildPlannerMessage(ctx);
    super(ctx, { systemPrompt: PLANNER_PROMPT, ..., initialMessage, ...config });
    this.noteManager = new NoteManager(ctx.project.paths.notes);
  }
  // after
  static async create(ctx: AgentContext, childSpawner: ChildSpawner, config?: Partial<BaseAgentConfig>): Promise<PlannerAgent> {
    const initialMessage = await buildPlannerMessage(ctx);
    return new PlannerAgent(ctx, childSpawner, initialMessage, config);
  }
  constructor(ctx: AgentContext, childSpawner: ChildSpawner, initialMessage: string, config?: Partial<BaseAgentConfig>) {
    super(ctx, { systemPrompt: PLANNER_PROMPT, ..., initialMessage, ...config });
    this.noteManager = new NoteManager(ctx.project.paths.notes);
  }
  ```
  `buildPlannerMessage(ctx)` itself becomes async because it calls `await buildHandoffContext(ctx)`.

  Apply the same shape (with the role-specific input arguments) to: [src/agents/planner.ts](src/agents/planner.ts#L168-L188), [src/agents/manager.ts](src/agents/manager.ts#L372), [src/agents/coder.ts](src/agents/coder.ts#L249), [src/agents/researcher.ts](src/agents/researcher.ts#L245), [src/agents/reviewer.ts](src/agents/reviewer.ts#L186), [src/agents/designer.ts](src/agents/designer.ts#L176), [src/agents/data-agent.ts](src/agents/data-agent.ts#L159), [src/agents/inspector.ts](src/agents/inspector.ts#L204).

- Update construction call sites:
  - [src/server/bootstrap.ts createChildSpawner](src/server/bootstrap.ts#L266-L390): every `new ManagerAgent(...)`, `new CoderAgent(...)`, `new ResearcherAgent(...)`, `new DataAgent(...)`, `new ReviewerAgent(...)`, `new InspectorAgent(...)` becomes `await XAgent.create(...)`. The `createChildSpawner` is already `async`-returning, so adding `await` is local. Note: the reviewer cache at [bootstrap.ts#L323-L328](src/server/bootstrap.ts#L323-L328) keeps using the cached instance after first construction; only the first construction goes through `await ReviewerAgent.create(...)`.
  - [src/server/bootstrap.ts runPlanner](src/server/bootstrap.ts#L420-L440): `const planner = await PlannerAgent.create(ctx, childSpawner, { abortSignal: ..., onActivity: ... });`.
  - [src/server/cli.ts inspect](src/server/cli.ts#L265-L283): `const inspector = await InspectorAgent.create(ctx, { request });`.

### 9. Update [src/agents/chat.ts](src/agents/chat.ts)

- Read sites (`readDocOrNull` / `readDocLenient`) gain `await`. `await writeDoc(...)` / `await ensureDir(...)` already in place become meaningful.
- `createUserNote(...)` calls at [chat.ts#L315](src/agents/chat.ts#L315) and [chat.ts#L465](src/agents/chat.ts#L465) gain `await`.

### 10. Update [src/mcp/notes-server.ts](src/mcp/notes-server.ts#L26)

- `createUserNote(...)` call gains `await`. The enclosing tool handler is already `async`.

### 11. Update [src/mcp/plan-server.ts](src/mcp/plan-server.ts)

- Every public method becomes `async`. The MCP dispatcher already awaits tool returns.
- Constructor at [plan-server.ts#L65-L70](src/mcp/plan-server.ts#L65-L70): remove the `ensureDir(projectSaivageDir)` call. Add a new method:
  ```ts
  async init(): Promise<void> {
    await ensureDir(dirname(this.planPath));
  }
  ```
- Update bootstrap at [bootstrap.ts#L148-L155](src/server/bootstrap.ts#L148-L155):
  ```ts
  const planService = new PlanService(project.saivageDir);
  await planService.init();
  ```

### 12. Update [src/server/server.ts](src/server/server.ts)

- Every handler that calls `readDocOrNull` / `readDocLenient` / `readJsonOrNull` / `listDocs` gains `await`.
- Raw `readFileSync` / `readdirSync` / `statSync` / `existsSync` in `/api/files`, `/api/files/content`, `/api/debug/state`, `/api/debug/errors`, `/api/debug/timeline`, `/api/chats`, `/api/chats/:sessionId` migrate to `await readFile` / `await readdir` / `await stat` / `await access`. Drop the `existsSync` import.
- `/api/notes` handlers ([server.ts#L261-L289](src/server/server.ts#L261-L289)): each `new NoteManager(...)` stays the same; `.listNotes()`, `.acknowledgeNote(...)`, `.deleteNote(...)`, `.clearNotes()` calls gain `await`.
- For `/api/debug/errors` and `/api/debug/timeline`, run the per-stage reads with `Promise.all(stageIds.map(async (id) => { ... }))`.

### 13. Update [src/server/bootstrap.ts](src/server/bootstrap.ts)

- [bootstrap.ts#L111](src/server/bootstrap.ts#L111): `const projectRoot = projectPath ?? await discoverProject(process.cwd());`.
- [bootstrap.ts#L117](src/server/bootstrap.ts#L117): `const project = await loadProject(projectRoot);`.
- [bootstrap.ts#L164](src/server/bootstrap.ts#L164): `if (await isAnotherInstanceRunning(project.paths.runtimeState)) { ... }`.
- [bootstrap.ts#L170](src/server/bootstrap.ts#L170): `const runtimeLock = await acquireRuntimeLock(project.saivageDir);` (now async).
- [bootstrap.ts#L183-L188](src/server/bootstrap.ts#L183-L188): `const cleaned = await noteCleanup.cleanupStaleNotes();`.
- [bootstrap.ts#L199](src/server/bootstrap.ts#L199), [bootstrap.ts#L235](src/server/bootstrap.ts#L235): `await writeRuntimeState(...)` already in place, now meaningful.
- [bootstrap.ts#L226](src/server/bootstrap.ts#L226): `await writeShutdownSummary(project);` inside the existing `try { ... }`.
- [bootstrap.ts#L255](src/server/bootstrap.ts#L255): `const shutdownHandoff = await consumeShutdownHandoff(project);`.
- **Fatal handler** at [bootstrap.ts#L674-L703](src/server/bootstrap.ts#L674-L703): replace the `writeRuntimeState(runtime.project.paths.runtimeState, failState)` call with an inline best-effort sync stamp. New body (replacing the inner try-block):
  ```ts
  // Inline writeFileSync (not via documents.ts) because the fatal
  // handler cannot rely on the event loop running to await an async
  // write before process.exit. Best-effort: no tmp+rename, no fsync.
  // Loss of this stamp is no worse than today's SIGKILL behaviour.
  try {
    const failState = createRuntimeState();
    failState.status = "error";
    writeFileSync(
      runtime.project.paths.runtimeState,
      JSON.stringify(failState, null, 2) + "\n",
      "utf-8",
    );
  } catch (writeErr) {
    log.warn(`[fatal] Failed to mark runtime state as error: ${writeErr instanceof Error ? writeErr.message : String(writeErr)}`);
  }
  ```
  Add `import { writeFileSync } from "node:fs";` at the top of `bootstrap.ts`. This is the **only** sync filesystem write outside of `documents.ts` and `initProjectTree`'s knowledge-tree seed; it is documented inline.

### 14. Cross-team handshake — knowledge subsystem (out-of-scope; coordinated landing required)

The skills/memory agent owns these files. F22 ships in lockstep with their async pass; the touch list (which they apply, not us) is:

- [src/knowledge/store.ts](src/knowledge/store.ts):
  - [L249](src/knowledge/store.ts#L249), [L268](src/knowledge/store.ts#L268): `ensureDir(...)` → `await ensureDir(...)`.
  - [L250](src/knowledge/store.ts#L250): `writeDoc(...)` inside `writeRecordAtomic` → `await writeDoc(...)`. `writeRecordAtomic` signature becomes `async function writeRecordAtomic<S>(...): Promise<z.output<S>>`.
  - [L414](src/knowledge/store.ts#L414): `writeDoc(...)` inside `rebuildIndex` → `await writeDoc(...)`. `rebuildIndex` signature becomes `async function rebuildIndex<S>(...): Promise<{ entries: IndexSummary[] }>`.
- [src/knowledge/lifecycle.ts](src/knowledge/lifecycle.ts):
  - [L117](src/knowledge/lifecycle.ts#L117): `rebuildIndex(...)` → `await rebuildIndex(...)`. Enclosing function becomes async.
  - [L265](src/knowledge/lifecycle.ts#L265), [L310](src/knowledge/lifecycle.ts#L310), [L327](src/knowledge/lifecycle.ts#L327), [L406](src/knowledge/lifecycle.ts#L406), [L414](src/knowledge/lifecycle.ts#L414), [L498](src/knowledge/lifecycle.ts#L498), [L534](src/knowledge/lifecycle.ts#L534), [L551](src/knowledge/lifecycle.ts#L551), [L620](src/knowledge/lifecycle.ts#L620), [L628](src/knowledge/lifecycle.ts#L628): `writeRecordAtomic(...)` → `await writeRecordAtomic(...)`. Each enclosing function becomes async.
- The skills/memory agent cascades `async` through their callers in `src/skills/` and the memory tool surface. F22 does not write those edits.

**Gate**: F22 does not land without skills/memory sign-off. If they need more time, F22 waits — there is no signature-compatible escape hatch (a fire-and-forget unawaited promise inside `writeRecordAtomic` would break atomicity).

### 15. Update tests

- [src/store/documents.test.ts](src/store/documents.test.ts): every `it` callback becomes `async`; every `readDoc` / `writeDoc` / `appendDoc` / `listDocs` / `deleteDoc` / `ensureDir` / `sweepStaleTempFiles` call gains `await`.
- [src/store/project.test.ts](src/store/project.test.ts): `loadProject` / `initProject` calls gain `await`. Any `it(() => { ... })` becomes `it(async () => { ... })`.
- [src/runtime/runtime.test.ts](src/runtime/runtime.test.ts): `writeRuntimeState(...)` calls become `await writeRuntimeState(...)` inside `async` `it`. `scanForUrgentNotes(notesDir)` at [runtime.test.ts#L976](src/runtime/runtime.test.ts#L976) and [#L1000](src/runtime/runtime.test.ts#L1000) gains `await`. `noteManager` method calls in the notes-related `it` blocks gain `await`. Add two new tests:
  - "RuntimeTracker coalesces rapid heartbeats": call `agentActivity` 100 times; await one microtask; verify exactly one or two `writeRuntimeState` invocations (spy via `vi.spyOn` on the runtime-state file write).
  - "RuntimeTracker.freeze stops the drain loop": schedule a write; call `freeze()` before the drain settles; verify no further writes after freeze.
- [src/runtime/shutdown-handoff.test.ts](src/runtime/shutdown-handoff.test.ts): `writeShutdownRequest` ([L121](src/runtime/shutdown-handoff.test.ts#L121), [L152](src/runtime/shutdown-handoff.test.ts#L152), [L164](src/runtime/shutdown-handoff.test.ts#L164)), `writeShutdownSummary` ([L122](src/runtime/shutdown-handoff.test.ts#L122)), `consumeShutdownHandoff` ([L140](src/runtime/shutdown-handoff.test.ts#L140), [L153](src/runtime/shutdown-handoff.test.ts#L153), [L167](src/runtime/shutdown-handoff.test.ts#L167)) calls gain `await`.
- [src/agents/agents.test.ts](src/agents/agents.test.ts), [src/agents/conversation-snapshot.test.ts](src/agents/conversation-snapshot.test.ts): agent constructions become `await XAgent.create(...)`.
- [src/knowledge/store.test.ts](src/knowledge/store.test.ts) and [src/knowledge/integration.test.ts](src/knowledge/integration.test.ts): updated by the skills/memory agent as part of step 14; F22's responsibility is to leave the tests passing once both PRs land.
- New focused CLI smoke test (if none exists today): one Vitest case per CLI command that calls `loadProject`/`discoverProject`/`writeShutdownRequest` and asserts no rejected promise. Search the suite first; only add if coverage is missing.

## Test commands

```bash
cd /home/salva/g/ml/saivage
npm run typecheck
npm run build
npx vitest run src/store/documents.test.ts
npx vitest run src/store/project.test.ts
npx vitest run src/runtime/runtime.test.ts
npx vitest run src/runtime/shutdown-handoff.test.ts
npx vitest run src/agents
npx vitest run src/knowledge/store.test.ts
npx vitest run src/knowledge/integration.test.ts
npx vitest run   # full suite
```

A clean run is required for all of the above.

Smoke check post-build (optional, only if a v2 deployment is up):

```bash
curl -fsS http://10.0.3.111:8080/health
curl -fsS http://10.0.3.111:8080/api/debug/timeline | head -c 200
```

Open two terminals in parallel: `/health` must not serialise behind `/api/debug/timeline`.

Fatal-handler manual verification (optional, easy to script): write a one-off test that throws inside an `unhandledRejection`-producing path, inspect `runtime.json` after, confirm `status: "error"` was stamped.

## Rollback

Single commit (or paired commit with the knowledge-subsystem PR). `git revert <sha>` returns the entire file set to sync. The on-disk format of every JSON document is unchanged — no data migration. The `RuntimeTracker` queue is created from in-memory state at startup, so reverting cannot strand any pending write on disk. The fatal-handler inline `writeFileSync` survives revert as the original synchronous `writeRuntimeState` call.

## Out-of-scope guards

- Do NOT change atomicity semantics (tmp+rename+fsync stays).
- Do NOT remove `sweepStaleTempFiles` or its boot-time invocation.
- Do NOT touch [src/skills/](src/skills/), [SPEC/v2/skills-memory/](SPEC/v2/skills-memory/), or [SPEC/v2/skills/](SPEC/v2/skills/). The knowledge-subsystem touches in step 14 are applied by the skills/memory agent, not by F22.
- Do NOT introduce a `DocumentStore` class, dependency-injection container, or any abstraction over `node:fs/promises`. The free-function shape is preserved; the only new abstractions are the per-agent static `create()` factories (mechanical, ~6 lines each) and the `RuntimeTracker` coalescer (~30 lines).
- Do NOT add a parallel sync helper in `documents.ts`. The single inline `writeFileSync` in the fatal handler is a direct `node:fs` call with a justification comment — not an API.
