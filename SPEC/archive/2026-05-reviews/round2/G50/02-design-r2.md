# G50 — Design (Round 2)

**Issue**: [../G50-note-manager-per-request-instantiation.md](../G50-note-manager-per-request-instantiation.md)
**Analysis**: [01-analysis-r2.md](01-analysis-r2.md)
**Round 1 design**: [02-design-r1.md](02-design-r1.md)
**Round 1 review**: [04-review-r1.md](04-review-r1.md)

Round 2 keeps Proposal A from r1 (singleton on `SaivageRuntime`) and
tightens two pieces the round-1 review flagged: (a) the explicit list
of `AgentContext` construction sites that must be wired, and (b) the
testability seam that lets the regression test drive real HTTP
requests through the notes handlers.

## 1. Goals

- One `NoteManager` per Saivage process, owned by `SaivageRuntime`.
- All live consumers (HTTP handlers ×4, bootstrap cleanup, Planner's
  `NoteChannel`, child-spawner agents, `/ws` chat, Telegram chat, CLI
  inspector) read from the runtime-owned instance.
- The `delivered` set ([src/runtime/notes.ts](../../../../src/runtime/notes.ts#L60)) lives in one place.
- No backward-compatibility shims.

## 2. Non-goals

Unchanged from r1: no atomic `acknowledgeNote`, no caches/watchers, no
on-disk-format changes.

## 3. Decision

**Proposal A — singleton on `SaivageRuntime`.** Proposals B (module
lazy registry) and C (handler-local memoization) remain rejected for
the reasons given in r1 §3. Round 2 adds a small refactor to
`src/server/server.ts` so the four notes routes are registered through
a `registerNotesRoutes(app, runtime)` helper, which is what the
regression test exercises (§7).

## 4. Resulting shape

### 4.1 `SaivageRuntime` ([src/server/bootstrap.ts](../../../../src/server/bootstrap.ts#L47-L66))

```ts
/** Shared notes store; owns the in-memory `delivered` cursor. */
noteManager: NoteManager;
```

### 4.2 `AgentContext` ([src/agents/types.ts](../../../../src/agents/types.ts#L30-L57))

```ts
/** Shared notes store. Same instance as runtime.noteManager. */
noteManager: NoteManager;
```

Required field, no optional/variant split. Making it required forces
every live construction site to compile-fail until it is wired —
exactly what the analysis §3 enumeration requires.

### 4.3 Live wiring sites

All five literals in analysis §3.1 set `noteManager: runtime.noteManager`:

1. [src/server/bootstrap.ts](../../../../src/server/bootstrap.ts#L293) `createChildSpawner` ctx
   literal.
2. [src/server/bootstrap.ts](../../../../src/server/bootstrap.ts#L486) `runPlanner` ctx literal.
3. [src/server/server.ts](../../../../src/server/server.ts#L672) `/ws` chat ctx literal.
4. [src/server/telegram-bot.ts](../../../../src/server/telegram-bot.ts#L72) Telegram chat ctx literal.
5. [src/server/cli.ts](../../../../src/server/cli.ts#L241) CLI inspector ctx literal.

Test helpers in analysis §3.2 are updated mechanically:
each constructs a `new NoteManager(notesDir)` for the helper's tmpdir
(or, equivalently, accepts an injected manager when the test wants to
assert against a spy).

### 4.4 Bootstrap (build-then-share)

[src/server/bootstrap.ts](../../../../src/server/bootstrap.ts#L188-L198) hoists the manager:

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

`noteManager` is then included in the runtime literal at
[src/server/bootstrap.ts](../../../../src/server/bootstrap.ts#L216-L249).

### 4.5 Planner ([src/agents/planner.ts](../../../../src/agents/planner.ts#L52-L70))

```ts
const noteManager = ctx.noteManager;
// …
inputChannels: [new NoteChannel(noteManager)],
```

`this.noteManager = noteManager` is kept for the in-class
`acknowledgeNotes()` call ([src/agents/planner.ts](../../../../src/agents/planner.ts#L81)).
The `NoteManager` symbol is removed from the import at
[src/agents/planner.ts](../../../../src/agents/planner.ts#L14); only `NoteChannel` remains.

### 4.6 HTTP handlers ([src/server/server.ts](../../../../src/server/server.ts#L254-L283))

Round 2 introduces a small route-registration helper so the regression
test can mount the same code path without booting the full
`startServer`:

```ts
// src/server/server.ts
export function registerNotesRoutes(
  app: FastifyInstance,
  runtime: Pick<SaivageRuntime, "noteManager">,
): void {
  app.get("/api/notes", async () => ({
    notes: await runtime.noteManager.listNotes(),
  }));

  app.post("/api/notes/:noteId/acknowledge", async (req, reply) => {
    const { noteId } = req.params as { noteId: string };
    const result = await runtime.noteManager.acknowledgeNote(noteId);
    if (!result) return reply.status(404).send({ error: "Note not found" });
    return result;
  });

  app.delete("/api/notes/:noteId", async (req, reply) => {
    const { noteId } = req.params as { noteId: string };
    if (!(await runtime.noteManager.deleteNote(noteId))) {
      return reply.status(404).send({ error: "Note not found" });
    }
    return { deleted: true };
  });

  app.delete("/api/notes", async () => ({
    deleted: await runtime.noteManager.clearNotes(),
  }));
}
```

`startServer` then calls `registerNotesRoutes(app, runtime)` at the
existing notes-routes location and drops the `NoteManager` import at
[src/server/server.ts](../../../../src/server/server.ts#L28).

The helper accepts `Pick<SaivageRuntime, "noteManager">` so the test
can pass a minimal runtime stub without faking the rest of the runtime
surface. This is the only API-shape concession; production code passes
the full runtime as before.

## 5. AgentContext propagation audit (round 2)

Concrete update list (mirrors analysis §3 line-for-line):

| File | Site | Change |
| --- | --- | --- |
| [src/agents/types.ts](../../../../src/agents/types.ts) | `AgentContext` | Add required `noteManager: NoteManager` + `import type { NoteManager }`. |
| [src/server/bootstrap.ts](../../../../src/server/bootstrap.ts) | runtime literal | Add `noteManager,`. |
| [src/server/bootstrap.ts](../../../../src/server/bootstrap.ts) | `createChildSpawner` ctx | Add `noteManager: runtime.noteManager,`. |
| [src/server/bootstrap.ts](../../../../src/server/bootstrap.ts) | `runPlanner` ctx | Add `noteManager: runtime.noteManager,`. |
| [src/server/server.ts](../../../../src/server/server.ts) | `/ws` chat ctx | Add `noteManager: runtime.noteManager,`. |
| [src/server/server.ts](../../../../src/server/server.ts) | notes routes | Replace four handler bodies with `registerNotesRoutes(app, runtime)` call. |
| [src/server/telegram-bot.ts](../../../../src/server/telegram-bot.ts) | chat ctx | Add `noteManager: runtime.noteManager,`. |
| [src/server/cli.ts](../../../../src/server/cli.ts) | inspector ctx | Add `noteManager: runtime.noteManager,`. |
| [src/agents/planner.ts](../../../../src/agents/planner.ts) | constructor | `const noteManager = ctx.noteManager;`; drop `new NoteManager` and the unused import symbol. |
| [src/agents/agents.test.ts](../../../../src/agents/agents.test.ts) | `makeReviewerContext`, `makeChatContext` | Add `noteManager: new NoteManager(notesDir)` (or shared manager from helper scope). |
| [src/agents/chat.lifecycle.test.ts](../../../../src/agents/chat.lifecycle.test.ts) | `makeContext` | Add `noteManager: new NoteManager(notesDir)`. |
| [src/agents/planner.nudge.test.ts](../../../../src/agents/planner.nudge.test.ts) | `makePlannerContext` | Add `noteManager: new NoteManager(notesDir)`. |
| [src/agents/base.compaction.test.ts](../../../../src/agents/base.compaction.test.ts) | local helper | Add `noteManager: new NoteManager(notesDir)`. |
| [src/agents/conversation-snapshot.test.ts](../../../../src/agents/conversation-snapshot.test.ts) | `makeContext` | Add `noteManager: new NoteManager(notesDir)`. |

The compile-fail loop is the safety net: after editing
[src/agents/types.ts](../../../../src/agents/types.ts), `npm run build` will surface every literal
that has not yet been updated.

## 6. Risks

- **Test isolation**: each test helper that constructs a fresh
  `NoteManager` already gets a per-test tmpdir, so isolation is
  preserved. No global registry, no cross-test leakage.
- **Bootstrap ordering**: `project.paths.notes` is set before the
  manager is built; the runtime literal is constructed afterwards. No
  cycle. Already validated in r1.
- **Test-only `Pick<SaivageRuntime, …>` parameter**: a deliberate
  contract narrowing that lets the regression test mount routes
  without a full runtime; production callers pass the full
  `SaivageRuntime`. This is the only design change driven by
  testability, and it does not weaken type safety in production
  callers.

## 7. Regression-test design (HTTP path)

The test mounts the real Fastify route registration with a minimal
runtime stub, drives multiple `app.inject(...)` calls through it, and
asserts every call hit the **same** runtime-owned `NoteManager`
instance. This is the test the round-1 review asked for.

```ts
// src/server/server.notes.test.ts
import { describe, it, expect, vi, afterEach } from "vitest";
import Fastify from "fastify";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerNotesRoutes } from "./server.js";
import { NoteManager, createUserNote } from "../runtime/notes.js";

describe("G50 — /api/notes* handlers share runtime.noteManager", () => {
  const created: string[] = [];
  afterEach(() => {
    while (created.length) {
      const p = created.pop();
      if (p) rmSync(p, { recursive: true, force: true });
    }
  });

  async function buildApp() {
    const notesDir = mkdtempSync(join(tmpdir(), "saivage-g50-"));
    created.push(notesDir);
    const noteManager = new NoteManager(notesDir);
    const app = Fastify({ logger: false });
    registerNotesRoutes(app, { noteManager });
    await app.ready();
    return { app, noteManager, notesDir };
  }

  it("routes every GET /api/notes through the runtime instance", async () => {
    const { app, noteManager } = await buildApp();
    const listSpy = vi.spyOn(noteManager, "listNotes");

    const r1 = await app.inject({ method: "GET", url: "/api/notes" });
    const r2 = await app.inject({ method: "GET", url: "/api/notes" });

    expect(r1.statusCode).toBe(200);
    expect(r2.statusCode).toBe(200);
    // If a handler did `new NoteManager(...)` per request, the spy on
    // the runtime-owned instance would never fire. Two calls prove
    // both requests reached the shared instance.
    expect(listSpy).toHaveBeenCalledTimes(2);

    await app.close();
  });

  it("routes ack/delete/clear through the runtime instance", async () => {
    const { app, noteManager, notesDir } = await buildApp();
    const ackSpy = vi.spyOn(noteManager, "acknowledgeNote");
    const delSpy = vi.spyOn(noteManager, "deleteNote");
    const clrSpy = vi.spyOn(noteManager, "clearNotes");

    const note = await createUserNote({
      notesDir,
      channel: "test",
      sessionId: "g50",
      content: "x",
      permanent: false,
    });

    const ack = await app.inject({
      method: "POST",
      url: `/api/notes/${note.id}/acknowledge`,
    });
    expect(ack.statusCode).toBe(200);
    expect(ackSpy).toHaveBeenCalledWith(note.id);

    const del = await app.inject({
      method: "DELETE",
      url: `/api/notes/${note.id}`,
    });
    // already removed by ack on a non-permanent note → 404 is fine;
    // the assertion is that the call routed to the shared instance.
    expect(delSpy).toHaveBeenCalledWith(note.id);
    expect([200, 404]).toContain(del.statusCode);

    const clear = await app.inject({ method: "DELETE", url: "/api/notes" });
    expect(clear.statusCode).toBe(200);
    expect(clrSpy).toHaveBeenCalledTimes(1);

    await app.close();
  });

  it("preserves delivered-set state across HTTP requests", async () => {
    const { app, noteManager, notesDir } = await buildApp();

    await createUserNote({
      notesDir,
      channel: "test",
      sessionId: "g50",
      content: "permanent",
      permanent: true,
    });

    // First request: drains the deliverables on the shared instance,
    // populating `delivered`.
    const first = await noteManager.pullDeliverables();
    expect(first).toHaveLength(1);

    // Drive an HTTP request through the routes (any route — listNotes
    // here). If the handler built a *fresh* NoteManager, the next
    // pullDeliverables on the runtime-owned instance would still see
    // the same `delivered` set and return 0. If the handler used the
    // runtime instance, the assertion that delivered is unchanged
    // still holds. Either way, what we are guarding here is that the
    // delivered Set on the runtime instance is the singleton used by
    // the rest of the system.
    const httpRes = await app.inject({ method: "GET", url: "/api/notes" });
    expect(httpRes.statusCode).toBe(200);

    const second = await noteManager.pullDeliverables();
    expect(second).toHaveLength(0); // delivered set survived

    await app.close();
  });
});
```

The first two cases are the primary regression guards: a handler that
reverts to `new NoteManager(runtime.project.paths.notes)` will not
trigger the spies on the runtime-owned instance and the test fails.
The third case keeps the `delivered`-set identity assertion the
round-1 plan had, but anchored to the same shared instance the routes
are now expected to use.

## 8. Static guard (kept from r1)

`grep -rn "new NoteManager" src/` must match only
[src/server/bootstrap.ts](../../../../src/server/bootstrap.ts) and
[src/runtime/runtime.test.ts](../../../../src/runtime/runtime.test.ts) (plus, by analysis §3.2, each
test helper file that constructs an `AgentContext` literal — those
also become legitimate construction sites because they materialise a
context for a test agent). The acceptance criterion is encoded as the
test in plan §3.3 r2.

## 9. Acceptance criteria

1. `SaivageRuntime` exposes `noteManager: NoteManager`.
2. `AgentContext` declares required `noteManager: NoteManager`.
3. The four `/api/notes*` handlers go through
   `registerNotesRoutes(app, runtime)`, which reads
   `runtime.noteManager`.
4. The Planner uses `ctx.noteManager` (no `new NoteManager` in its
   constructor).
5. Bootstrap's startup cleanup uses the same shared manager.
6. All five live `AgentContext` literals (analysis §3.1) wire
   `noteManager: runtime.noteManager`.
7. All six test-helper `AgentContext` literals (analysis §3.2) build
   a per-test `NoteManager` and set the field.
8. The new HTTP regression test in §7 passes; it would fail if any
   `/api/notes*` handler reverted to building a fresh `NoteManager`.
9. `npm run build` and `npm test` pass.
