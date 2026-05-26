# G50 — Implementation Plan (Round 2)

**Issue**: [../G50-note-manager-per-request-instantiation.md](../G50-note-manager-per-request-instantiation.md)
**Analysis**: [01-analysis-r2.md](01-analysis-r2.md)
**Design**: [02-design-r2.md](02-design-r2.md)
**Round 1 plan**: [03-plan-r1.md](03-plan-r1.md)
**Round 1 review**: [04-review-r1.md](04-review-r1.md)

Round 2 keeps the r1 ordering and substantive edits, and adds the two
items the round-1 review required:

- A real multi-request HTTP regression test that proves the
  `/api/notes*` handlers route through `runtime.noteManager` (plan §3).
- An exhaustive, file-by-file enumeration of every live `AgentContext`
  construction site, so none is left implicit (plan §2.5).

## 1. Pre-flight

1. Re-run `rg -n "AgentContext" src/` and confirm the live-construction
   list matches analysis §3.1 (5 sites) and §3.2 (6 sites). Any new
   site found here is added to the edit list before code edits start.
2. Re-run `rg -n "new NoteManager" src/` and confirm the current
   construction sites match analysis §1 (4 in `server.ts`, 1 in
   `bootstrap.ts`, 1 in `planner.ts`, plus the unit tests in
   `runtime.test.ts`).
3. Open [src/agents/types.ts](../../../../src/agents/types.ts) to locate the `AgentContext`
   interface ([src/agents/types.ts](../../../../src/agents/types.ts#L30-L57)) and confirm the existing
   `import type` block.

## 2. Edits (in order)

### 2.1 [src/agents/types.ts](../../../../src/agents/types.ts) — add the field first

- Add `import type { NoteManager } from "../runtime/notes.js";`.
- Add required field `noteManager: NoteManager;` to `AgentContext`,
  grouped with the other shared-runtime services (`router`,
  `mcpRuntime`).

This intentionally breaks the build everywhere a literal is missing
the field. Plan §2.5 walks each break.

### 2.2 [src/server/bootstrap.ts](../../../../src/server/bootstrap.ts)

- Add `noteManager: NoteManager;` to `SaivageRuntime`
  ([src/server/bootstrap.ts](../../../../src/server/bootstrap.ts#L47-L66)) next to `planService`.
- Hoist the cleanup manager: replace the cleanup block at
  [src/server/bootstrap.ts](../../../../src/server/bootstrap.ts#L192-L198) with

  ```ts
  const noteManager = new NoteManager(project.paths.notes);
  {
    const cleaned = await noteManager.cleanupStaleNotes(
      config.runtime.notes.volatileTtlMs,
    );
    if (cleaned > 0) {
      log.info(`[v2] Cleaned ${cleaned} stale/expired notes from previous run`);
    }
  }
  ```

- Add `noteManager,` to the runtime literal at
  [src/server/bootstrap.ts](../../../../src/server/bootstrap.ts#L216-L249).
- Update `createChildSpawner` ctx literal at
  [src/server/bootstrap.ts](../../../../src/server/bootstrap.ts#L293): add
  `noteManager: runtime.noteManager,`.
- Update `runPlanner` ctx literal at
  [src/server/bootstrap.ts](../../../../src/server/bootstrap.ts#L486): add
  `noteManager: runtime.noteManager,`.

### 2.3 [src/server/server.ts](../../../../src/server/server.ts)

- Drop the `NoteManager` import at [src/server/server.ts](../../../../src/server/server.ts#L28).
- Replace the four notes-route blocks at
  [src/server/server.ts](../../../../src/server/server.ts#L254-L283) with a single call
  `registerNotesRoutes(app, runtime);` and add the exported helper
  near the bottom of the file (see design §4.6 for the helper body).
  Export the helper so the test can import it.
- Update the `/ws` chat ctx literal at
  [src/server/server.ts](../../../../src/server/server.ts#L672): add
  `noteManager: runtime.noteManager,`. Keep the literal untyped (matches
  current style); the field is still type-checked at
  `ChatAgent.create(ctx, …)` because `AgentContext` is the parameter
  type.

### 2.4 [src/server/telegram-bot.ts](../../../../src/server/telegram-bot.ts) and [src/server/cli.ts](../../../../src/server/cli.ts)

- [src/server/telegram-bot.ts](../../../../src/server/telegram-bot.ts#L72): add
  `noteManager: runtime.noteManager,` to the chat ctx literal.
- [src/server/cli.ts](../../../../src/server/cli.ts#L241): add
  `noteManager: runtime.noteManager,` to the inspector ctx literal.

### 2.5 Test helpers (compile-required after §2.1)

For each helper, add the field; build the manager from the tmpdir the
helper already uses for `project.paths.notes`.

- [src/agents/agents.test.ts](../../../../src/agents/agents.test.ts#L569) — `makeReviewerContext`:
  `noteManager: new NoteManager(...)` using `project.paths.notes`.
- [src/agents/agents.test.ts](../../../../src/agents/agents.test.ts#L614) — `makeChatContext`: same.
- [src/agents/chat.lifecycle.test.ts](../../../../src/agents/chat.lifecycle.test.ts#L53) —
  `makeContext`: same.
- [src/agents/planner.nudge.test.ts](../../../../src/agents/planner.nudge.test.ts#L28) —
  `makePlannerContext`: same.
- [src/agents/base.compaction.test.ts](../../../../src/agents/base.compaction.test.ts#L43) — local
  helper: same.
- [src/agents/conversation-snapshot.test.ts](../../../../src/agents/conversation-snapshot.test.ts#L45) —
  `makeContext`: same.

In each file, add `import { NoteManager } from "../runtime/notes.js";`
beside the existing imports.

### 2.6 [src/agents/planner.ts](../../../../src/agents/planner.ts)

- Line [src/agents/planner.ts](../../../../src/agents/planner.ts#L52): replace
  `const noteManager = new NoteManager(ctx.project.paths.notes);` with
  `const noteManager = ctx.noteManager;`.
- Line [src/agents/planner.ts](../../../../src/agents/planner.ts#L14): remove `NoteManager` from the
  import statement (keep `NoteChannel`).
- `this.noteManager = noteManager;` stays — it backs
  `this.noteManager.acknowledgeNotes()` at
  [src/agents/planner.ts](../../../../src/agents/planner.ts#L81).

## 3. Regression tests

### 3.1 New HTTP regression test — [src/server/server.notes.test.ts](../../../../src/server/server.notes.test.ts)

Create the new file with the exact body shown in design §7. Three
cases:

- `routes every GET /api/notes through the runtime instance` —
  `vi.spyOn(noteManager, "listNotes")`; two `app.inject({ method:
  "GET", url: "/api/notes" })` calls; assert `toHaveBeenCalledTimes(2)`.
  This **fails** if the handler reverts to per-request
  `new NoteManager(...)`.
- `routes ack/delete/clear through the runtime instance` — spies on
  `acknowledgeNote`, `deleteNote`, `clearNotes`; one `app.inject` each;
  assert each spy fired. Uses the existing `createUserNote` helper to
  pre-seed a note on disk.
- `preserves delivered-set state across HTTP requests` — keeps the
  r1 cursor-identity check, anchored on the same runtime-owned
  instance the routes mount.

All three cases use Fastify's `app.inject()` (the same request-dispatch
path production traffic uses) and a `Pick<SaivageRuntime,
"noteManager">` runtime stub built directly in the test (no full
bootstrap, no MCP, no router).

### 3.2 Static guard

Keep the r1 grep guard in a small new test or in the new file:

```ts
it("only constructs NoteManager in bootstrap and unit tests", async () => {
  const { execFileSync } = await import("node:child_process");
  const out = execFileSync(
    "grep",
    ["-rln", "new NoteManager", "src/"],
    { encoding: "utf8" },
  );
  const lines = out.split("\n").filter(Boolean).sort();
  expect(lines).toEqual([
    "src/agents/agents.test.ts",
    "src/agents/base.compaction.test.ts",
    "src/agents/chat.lifecycle.test.ts",
    "src/agents/conversation-snapshot.test.ts",
    "src/agents/planner.nudge.test.ts",
    "src/runtime/runtime.test.ts",
    "src/server/bootstrap.ts",
    "src/server/server.notes.test.ts",
  ]);
});
```

(Order matches `sort`. The list reflects analysis §3.2 plus the new
test file and the existing unit suite. Update the literal if a test
helper is consolidated.)

### 3.3 Existing tests

- [src/runtime/runtime.test.ts](../../../../src/runtime/runtime.test.ts#L682-L970) — `NoteManager` /
  `NoteChannel` unit suites — unchanged.
- [src/server/server.test.ts](../../../../src/server/server.test.ts) — `isPathInside` suite — unchanged.
- The six test helpers updated in §2.5 — should pass once their
  literals carry the new field.

## 4. Validation

1. `npm run build` — must pass; build errors here surface any missed
   ctx literal.
2. `npx vitest run src/server/server.notes.test.ts` — must pass.
3. `npx vitest run src/runtime/runtime.test.ts` — must pass
   (no changes expected; ensures `NoteManager` semantics untouched).
4. `npm test` — full suite.
5. `grep -rn "new NoteManager" src/` — output matches §3.2.
6. Manual smoke against `saivage-v3` LXC harness (workspace memory):

   ```bash
   curl -fsS http://10.0.3.112:8080/api/notes
   # create a note via the dashboard or createUserNote helper, then:
   curl -X POST http://10.0.3.112:8080/api/notes/<id>/acknowledge
   curl -X DELETE http://10.0.3.112:8080/api/notes/<id>
   curl -X DELETE http://10.0.3.112:8080/api/notes
   ```

   Confirm 200/404 as appropriate, no stack traces in
   `journalctl -u saivage`.

## 5. Rollout

Single PR; no migration; no config flag. Workspace rule "no backward
compatibility" applies — the redundant `new NoteManager(...)` lines
are removed outright.

## 6. Follow-ups (tracked, not in this PR)

- Atomic `acknowledgeNote` write (per-id serialisation).
- Optional in-process cache / inotify watcher now that ownership is
  single.
- G45: keep the internals/runtime doc in sync with the new
  `SaivageRuntime` field.
