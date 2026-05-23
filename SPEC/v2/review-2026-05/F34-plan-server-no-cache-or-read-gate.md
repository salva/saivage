# F34 — `plan-server` re-reads every plan document on every operation; mutationQueue does not gate reads

**Category**: bad-design
**Severity**: medium
**Transversality**: module

## Summary

`PlanService` reads `plan.json`, `plan-history.json`, and per-stage `tasks.json` / reports / summary directly from disk on every tool call. There is no in-memory cache. The `mutationQueue` serialises *writes* but reads bypass it, so a read concurrent with a write can observe a partial file (or the synchronous-fs invariant of "no concurrent observer" is what saves us today — but only as long as everything stays sync, see F22).

## Evidence

- `readDocOrNull`-per-operation pattern in plan operations: [src/mcp/plan-server.ts](src/mcp/plan-server.ts#L1-L200).
- `mutationQueue` exists but only wraps writes (search for `mutationQueue.push` / `await` patterns in the same file).
- Atomic write + fsync in the store: [src/store/documents.ts](src/store/documents.ts).

## Why this matters

Today the architecture works only because `documents.ts` is fully synchronous (F22). If anyone migrates a single write to `fs/promises` to unblock the event loop, the plan-server reads will start seeing torn files and Zod parse failures (which `readDocLenient` swallows as "no plan", causing the Planner to call `plan_init` and clobber the real plan). Reads should go through the same queue, or there should be an in-memory `Plan` cache updated transactionally on each write.

## Related

- F22 (sync fs)
- F08 (legacy mirror)
