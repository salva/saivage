# G50 — Design (Round 1)

**Issue**: [../G50-note-manager-per-request-instantiation.md](../G50-note-manager-per-request-instantiation.md)
**Analysis**: [01-analysis-r1.md](01-analysis-r1.md)

## 1. Goals

- One `NoteManager` per Saivage process, owned by `SaivageRuntime`.
- All five existing consumers (HTTP handlers ×4, bootstrap cleanup,
  Planner's `NoteChannel`) read from that shared instance.
- The `delivered` set ([src/runtime/notes.ts](../../../../src/runtime/notes.ts#L60)) lives in one place so the
  contract "after compaction, `resetDelivered` re-enables permanent
  notes" continues to hold across the lifetime of the process.
- No backward-compatibility shims, per workspace rules.

## 2. Non-goals

- Atomic write/read-modify-write for `acknowledgeNote`. (Out of scope.)
- Read caches / file watchers / write coalescers. (This design only
  makes them possible; it does not add them.)
- Touching the on-disk note format or the MCP `NoteService`.

## 3. Proposals considered

### Proposal A — Singleton on `SaivageRuntime` (recommended)

- Construct one `NoteManager` in `bootstrap`, store it on
  `runtime.noteManager`, and have every consumer read it from the
  runtime.
- Planner receives the manager through its existing `AgentContext`
  (which already carries `ctx.project`), via a new
  `ctx.noteManager` field, and drops its `new NoteManager(...)`.
- Bootstrap's startup cleanup call uses `runtime.noteManager` instead of
  building `noteCleanup` locally — but only **after** the runtime
  literal is constructed; alternatively, build the manager before the
  runtime literal and reference the same variable.

  **Concretely**: build `const noteManager = new NoteManager(project.paths.notes)`
  right before step 7b at [src/server/bootstrap.ts](../../../../src/server/bootstrap.ts#L188); call
  `noteManager.cleanupStaleNotes(...)` there; pass it into the runtime
  literal at [src/server/bootstrap.ts](../../../../src/server/bootstrap.ts#L216-L249) as `noteManager`.

  **Pros**:
  - Matches the established pattern for shared services
    (`planService`, `tracker`, `mcpRuntime`).
  - `delivered` semantics are unambiguous and survive any future cache.
  - HTTP handlers shrink from 3 lines to 1.
  - Planner's constructor stops touching `ctx.project.paths` for note
    state; the runtime decides ownership.
  - Symmetric with G45 / runtime-autodispatch memory note.

  **Cons**:
  - Touches `AgentContext` shape (small ripple into agent base / tests
    that fabricate contexts). See §5 for the audit.
  - `SaivageRuntime` interface gains one field — the very kind of drift
    G45 is also tracking, so doc update is mandatory.

### Proposal B — Module-scoped lazy singleton keyed by `notesDir`

- Add `function getNoteManager(notesDir: string): NoteManager` to
  [src/runtime/notes.ts](../../../../src/runtime/notes.ts) with a `Map<string, NoteManager>` cache.

  **Pros**:
  - Zero changes to `SaivageRuntime` or `AgentContext`.

  **Cons (rejected)**:
  - Hides ownership; the manager outlives any individual project context
    and is never explicitly disposed.
  - Multiple processes / test harnesses share the same `notesDir` and
    therefore the same in-memory `delivered` set, violating test
    isolation.
  - Conflicts with workspace rule "actively remove code supporting old
    structures": adds a parallel registry alongside `SaivageRuntime`.

### Proposal C — Per-handler local memoization helper

- Add `function noteManagerFor(runtime): NoteManager` inside
  [src/server/server.ts](../../../../src/server/server.ts) that lazily attaches to `runtime` on first call.

  **Pros**:
  - Smallest diff in `server.ts`.

  **Cons (rejected)**:
  - Doesn't fix Planner or bootstrap cleanup.
  - Mutates `SaivageRuntime` at runtime via a back-door property, which
    defeats the point of having a typed interface.

### Decision

**Proposal A**.

## 4. Resulting shape

`SaivageRuntime` ([src/server/bootstrap.ts](../../../../src/server/bootstrap.ts#L47-L66)) gains:

```ts
/** Shared notes store; owns the in-memory `delivered` cursor. */
noteManager: NoteManager;
```

`AgentContext` (defined in `src/agents/base.ts`; see §5) gains:

```ts
noteManager: NoteManager;
```

`PlannerAgent` constructor ([src/agents/planner.ts](../../../../src/agents/planner.ts#L52-L70)) becomes:

```ts
const noteManager = ctx.noteManager;
// …
inputChannels: [new NoteChannel(noteManager)],
```

(Equivalent to deleting the `new NoteManager(...)` call; storing
`this.noteManager = noteManager` is preserved for any in-class use.)

Bootstrap ([src/server/bootstrap.ts](../../../../src/server/bootstrap.ts#L192-L198)) becomes:

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

…with `noteManager` then included in the runtime literal at
[src/server/bootstrap.ts](../../../../src/server/bootstrap.ts#L216-L249).

HTTP handlers ([src/server/server.ts](../../../../src/server/server.ts#L254-L283)) collapse to:

```ts
app.get("/api/notes", async () => ({ notes: await runtime.noteManager.listNotes() }));

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

app.delete("/api/notes", async () => ({ deleted: await runtime.noteManager.clearNotes() }));
```

The `import { NoteManager } from "../runtime/notes.js";` at
[src/server/server.ts](../../../../src/server/server.ts#L28) is removed.

## 5. AgentContext propagation audit

`AgentContext` is the conduit `bootstrap` → `BaseAgent` → `PlannerAgent`.
We need to verify where it is constructed so the new field is set
exactly once. Pre-implementation step in the plan: `grep -n "AgentContext" src/`
and confirm every constructor literal sets `noteManager: runtime.noteManager`.
Known shape today: `ctx.project.paths.notes` is used by the Planner
([src/agents/planner.ts](../../../../src/agents/planner.ts#L52)), so all `AgentContext` builders necessarily
have access to a runtime / project; threading `noteManager` through them
is local.

If `AgentContext` is constructed for agents that don't need notes (Coder,
Worker, etc.), we still set the field — the manager is cheap to reference
and consumers that don't use it stay silent. This avoids splitting
`AgentContext` into "has-notes" / "no-notes" variants.

## 6. Risks

- **Test isolation regression**: tests that construct a fake
  `SaivageRuntime` (e.g. [src/server/telegram-bot.test.ts](../../../../src/server/telegram-bot.test.ts#L91)) must add
  the new field or use a permissive cast. The cast is already in place;
  audit during the plan.
- **`delivered` set semantics under concurrent HTTP+Planner**: HTTP
  handlers never call `pullDeliverables` or `resetDelivered`, so the
  set's behaviour is unchanged. Documented in the analysis.
- **Bootstrap ordering**: the manager must be constructible before the
  runtime literal but after `project` exists. It already is — `project`
  is available at step 7b ([src/server/bootstrap.ts](../../../../src/server/bootstrap.ts#L188)).

## 7. Acceptance criteria

1. `grep -rn "new NoteManager" src/` returns matches **only** in:
   - [src/server/bootstrap.ts](../../../../src/server/bootstrap.ts) (the single construction site), and
   - [src/runtime/runtime.test.ts](../../../../src/runtime/runtime.test.ts) (unit tests for the class itself).
2. `SaivageRuntime` exposes `noteManager: NoteManager`.
3. The four `/api/notes*` handlers reference `runtime.noteManager`.
4. The Planner uses `ctx.noteManager` (no `new NoteManager` in the
   constructor).
5. Bootstrap's startup cleanup uses the same shared manager.
6. New regression test asserts cross-request identity (see plan §3).
7. `npm run build` and `npm test` pass.
