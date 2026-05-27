# Addendum APPROVED

- Approved file: [04-addendum-r2.md](04-addendum-r2.md)
- Approval verdict file: [04-addendum-review-r2.md](04-addendum-review-r2.md)

Implementers reading this dance should treat the addendum as a delta on top of the base design and plan:
- Facade-vs-primitives boundary policy: both layers are first-class entry points; facade is RAG-only; consumer-convenience shortcuts are forbidden.
- External-change handling: dataset config gains a `sources` field (canonical root declaration) and a `watch` field (opt-in chokidar watcher); new operations `dataset.watch()`, `dataset.unwatch()`, `dataset.reconcile()`; watcher waits indefinitely on `proper-lockfile` contention while coalescing into a single pending batch.
- Librarian agent is recorded as a future, separately-specified consumer (not a gateway, not an MCP host inside the library).
- Plan delta: B12 (Directory watcher) inserted between B10 and B11; B11 docs amended.
