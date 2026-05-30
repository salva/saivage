# F22 — Document store is fully synchronous; called from HTTP handlers

**Category**: bad-design
**Severity**: high
**Transversality**: architectural

## Summary

`src/store/documents.ts` uses synchronous `fs` for every operation: `readFileSync`, `writeFileSync`, `mkdirSync`, `unlinkSync`, `fsyncSync` on the file, then `openSync`/`fsyncSync` on the parent directory. These functions are called from Fastify HTTP handlers (e.g. `/api/debug/errors`, `/api/debug/timeline`), from the WebSocket session bootstrap, from the agent's per-message `runtimeState` updater, and from the planner's note acknowledgement loop. Every call blocks the Node event loop for the duration of the disk round-trip plus two fsyncs.

## Evidence

- All-sync helpers: [src/store/documents.ts](src/store/documents.ts) (`readDoc`, `writeDoc`, `listDocs`, `sweepStaleTempFiles`).
- Called inside an HTTP route reading every stage's `summary.json` and every report `.json`: [src/server/server.ts](src/server/server.ts#L560-L598).
- Called inside the WebSocket route to set up a chat session: [src/server/server.ts](src/server/server.ts#L661-L704).
- Called from agents on every activity tick (runtime state write): [src/runtime/recovery.ts](src/runtime/recovery.ts#L299-L308).

## Why this matters

A single `/api/debug/timeline` call iterates every stage directory and every task report on disk, synchronously, blocking the entire process — including its WebSocket pings and its supervisor loop. Under realistic load (50+ stages with 10 reports each) this manifests as the WS clients reconnecting every few seconds, the supervisor reporting "stuck" because the LLM call timed out behind disk I/O, and the planner appearing to stall.

Switching to `fs/promises` is a deep change (Zod parse is synchronous, agents push runtime state synchronously, the lock is acquired with `openSync` for `O_EXCL`) but the HTTP routes at minimum should not call into the synchronous store.

## Related

- F08 (legacy mirror doubles the fsync cost)
- F11 (`MAX_NUDGES` etc. — the supervisor reading is what unmasks this issue)
