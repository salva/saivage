# G50 — `NoteManager` re-instantiated on every `/api/notes*` request

- **Subsystem**: server (`src/server/server.ts`)
- **Category**: design smell, latent correctness risk
- **Severity**: low

## Summary

The four `/api/notes*` HTTP handlers each construct a fresh `NoteManager`
instance, pointing at `runtime.project.paths.notes`. The bootstrap path
already constructs its own `noteCleanup` `NoteManager` for the runtime's
unread-note injection logic, and the runtime object does not expose either.
Today `NoteManager` is stateless enough that the pattern is "merely
wasteful", but it bakes in the assumption that the manager is cheap and
side-effect-free — which the API does not guarantee, and which the moment
the manager grows a write-coalescing buffer / cache / inotify watcher will
silently introduce a correctness bug (each request sees a half-cold cache,
writes don't observe each other's pending state).

## Evidence

Per-handler instantiation, four times:

```ts
fastify.get("/api/notes", async () => {
  const noteManager = new NoteManager(runtime.project.paths.notes);
  return { notes: await noteManager.listNotes() };
});

fastify.post("/api/notes/:id/ack", async (req, reply) => {
  …
  const noteManager = new NoteManager(runtime.project.paths.notes);
  const result = await noteManager.acknowledgeNote(noteId);
  …
});

fastify.delete("/api/notes/:id", async (req, reply) => {
  …
  const noteManager = new NoteManager(runtime.project.paths.notes);
  if (!(await noteManager.deleteNote(noteId))) { … }
  …
});

fastify.delete("/api/notes", async () => {
  const noteManager = new NoteManager(runtime.project.paths.notes);
  return { deleted: await noteManager.clearNotes() };
});
```

[src/server/server.ts](src/server/server.ts#L255-L282)

Bootstrap also makes a *separate* `NoteManager` instance for runtime-side
cleanup:

[src/server/bootstrap.ts](src/server/bootstrap.ts#L193)

And `SaivageRuntime` does not expose a shared `noteManager` — every consumer
constructs its own.

## Why this matters

The handlers happen to be correct today because `NoteManager` is a thin
wrapper over append/read/write of the notes JSON file. The exposed
contract, though, is "free construction; no shared state" — which is
exactly the contract that gets violated the first time someone adds any of:

- a cached read of the notes file (next request reads stale state);
- a debounced write (concurrent acks lose updates);
- an in-process subscriber list (the runtime's note-injection logic and the
  HTTP API don't see each other's changes).

In other words, the API is shaped to forbid the very optimisations that
would make notes performant. That's the smell.

## Rough remediation direction

Add `noteManager: NoteManager` to `SaivageRuntime` (constructed once in
`bootstrap`) and have `server.ts` route handlers consume `runtime.noteManager`
directly. Delete the four per-handler `new NoteManager(...)` lines. Update
the runtime-side `noteCleanup` in `bootstrap` to use the same shared
instance so all consumers share one source of truth.

**Level up**: audit every other "stateless" service the server builds
per-request. `routing.resolve(...)` is called from multiple handlers and
agent constructors; `runtime.tracker` is shared; but `NoteManager`,
`PlanService` (already shared), and any future doc-manager subclasses should
all be created once in bootstrap and surfaced on the runtime. Repo memory
note `runtime-autodispatch` already captures the pattern; extend it to cover
note management.

## Cross-links

- G45 — internals doc lists a `SaivageRuntime` shape that does not match
  reality; the fix here adds another field that the doc will need to track.
