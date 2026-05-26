# G50 — Analysis (Round 1)

**Issue**: [../G50-note-manager-per-request-instantiation.md](../G50-note-manager-per-request-instantiation.md)
**Subsystem**: server / runtime (notes)
**Severity**: low (design smell, latent correctness risk)

## 1. What the issue actually says

`NoteManager` is constructed ad hoc by every consumer that needs to read or
mutate notes on disk. The four `/api/notes*` Fastify handlers each `new`
their own instance, [src/server/server.ts](../../../../src/server/server.ts#L256), [src/server/server.ts](../../../../src/server/server.ts#L262), [src/server/server.ts](../../../../src/server/server.ts#L272), [src/server/server.ts](../../../../src/server/server.ts#L280); bootstrap builds a one-shot cleanup
instance at [src/server/bootstrap.ts](../../../../src/server/bootstrap.ts#L193); and the Planner agent creates yet another
in its constructor at [src/agents/planner.ts](../../../../src/agents/planner.ts#L52), then wraps it in a `NoteChannel`
at [src/agents/planner.ts](../../../../src/agents/planner.ts#L63).

`SaivageRuntime` ([src/server/bootstrap.ts](../../../../src/server/bootstrap.ts#L47-L66)) does not surface a shared
manager, so each call site rebuilds one from `project.paths.notes`.

## 2. Why the contract is shaped wrong

`NoteManager` is not pure. It carries an in-memory `delivered: Set<string>`
([src/runtime/notes.ts](../../../../src/runtime/notes.ts#L60)) that gates `pullDeliverables` ([src/runtime/notes.ts](../../../../src/runtime/notes.ts#L75-L88))
and is cleared by `resetDelivered()` after compaction ([src/runtime/notes.ts](../../../../src/runtime/notes.ts#L91-L93)).
That set is the whole reason `NoteChannel` exists ([src/runtime/notes.ts](../../../../src/runtime/notes.ts#L291-L303)) — it
is per-process delivery state, not "free, stateless wrapping".

Today the HTTP handlers never touch `pullDeliverables` / `resetDelivered`,
so each fresh handler-side instance is observationally correct. The smell
is the **shape of the API**, not a current bug:

- The exported contract says "construct anywhere, no shared state", which
  is exactly the contract a future cache / debouncer / inotify watcher
  must violate to be useful. The first such optimisation silently splits
  the world into per-handler caches.
- Two writers (HTTP `acknowledgeNote` and Planner's `NoteChannel`
  consuming a `delivered` cursor) already touch the same JSON files via
  different objects; only the per-file `writeDoc`/`pathExists` atomicity
  saves us.
- The cleanup `NoteManager` in bootstrap is built, used once, and dropped
  ([src/server/bootstrap.ts](../../../../src/server/bootstrap.ts#L192-L198)) — it cannot be reused for warming
  caches or holding watchers because there is no place to store it.

## 3. Concurrency / race surface (current)

- HTTP `ack`/`delete`/`clear` and Planner's `NoteChannel.drain` read the
  same files. They are serialised by Node's single-threaded event loop
  per await-boundary, but `acknowledgeNote` does
  read → modify → `writeDoc` non-atomically ([src/runtime/notes.ts](../../../../src/runtime/notes.ts#L102-L130)). Two
  concurrent HTTP acks on the same note id can race; a singleton does
  not by itself fix this, but **adding any in-process write-coalescing
  buffer (the natural next optimisation) requires a single manager**.
- Planner's `delivered` set is invisible to HTTP `clearNotes`: clearing
  notes through the dashboard leaves stale ids in the Planner's
  `delivered` set until the next `resetDelivered()`. This is benign
  (filtered by file existence on next drain) but is the kind of skew
  that a singleton would eliminate.

## 4. Scope of "every other stateless-looking service"

Issue cross-references `runtime-autodispatch` repo memory and asks to
audit other per-request constructions. From a quick scan of
[src/server/server.ts](../../../../src/server/server.ts):

- `runtime.tracker` — already shared.
- `runtime.planService` — already shared.
- `runtime.routing.resolve(...)` — pure lookup over a shared resolver,
  safe.
- `NoteManager` — the outlier.
- `NoteService` ([src/mcp/notes-server.ts](../../../../src/mcp/notes-server.ts#L10)) — built once in bootstrap and
  registered with the MCP runtime ([src/server/bootstrap.ts](../../../../src/server/bootstrap.ts#L252-L258)); already
  follows the desired pattern but does not itself depend on `NoteManager`
  (it uses `createUserNote` directly).

So the concrete fix is bounded: surface one `NoteManager` on the runtime,
delete the four handler-local constructions, fold the bootstrap cleanup
call onto it, and have the Planner consume the same instance.

## 5. Out of scope (kept as follow-ups)

- Reworking `NoteManager.acknowledgeNote` write to be atomic
  (read-modify-write under a per-note lock). Tracked separately; not a
  precondition for this fix.
- Adding an in-process cache / watcher to `NoteManager`. This fix makes
  it possible; we do not introduce it here.
- Updating the runtime/internals doc to match the new
  `SaivageRuntime` shape — covered by G45.

## 6. Files implicated

- [src/server/bootstrap.ts](../../../../src/server/bootstrap.ts) — `SaivageRuntime` shape ([src/server/bootstrap.ts](../../../../src/server/bootstrap.ts#L47-L66)),
  one-shot cleanup ([src/server/bootstrap.ts](../../../../src/server/bootstrap.ts#L192-L198)), runtime literal
  ([src/server/bootstrap.ts](../../../../src/server/bootstrap.ts#L216-L249)).
- [src/server/server.ts](../../../../src/server/server.ts) — four handler-local `new NoteManager(...)`
  ([src/server/server.ts](../../../../src/server/server.ts#L254-L283)).
- [src/agents/planner.ts](../../../../src/agents/planner.ts) — Planner constructor builds its own
  ([src/agents/planner.ts](../../../../src/agents/planner.ts#L52-L70)).
- [src/runtime/notes.ts](../../../../src/runtime/notes.ts) — `NoteManager` itself ([src/runtime/notes.ts](../../../../src/runtime/notes.ts#L50-L65))
  and `NoteChannel` ([src/runtime/notes.ts](../../../../src/runtime/notes.ts#L291-L303)).
- [src/runtime/runtime.test.ts](../../../../src/runtime/runtime.test.ts) — `NoteManager`/`NoteChannel` unit suites
  ([src/runtime/runtime.test.ts](../../../../src/runtime/runtime.test.ts#L682-L690), [src/runtime/runtime.test.ts](../../../../src/runtime/runtime.test.ts#L961-L970)). These exercise the class
  directly and are not affected by the runtime wiring change.
