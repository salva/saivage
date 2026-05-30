# G06 — `runtime/stash.ts` uses synchronous fs in the agent hot path

**Subsystem:** src/runtime/, src/store/
**Category:** architecture / async-fs migration completeness
**Severity:** medium
**Transversality:** module (single file) — but a regression of the F22 async-fs migration

## Summary

Round-1 F22 migrated `src/store/documents.ts` away from synchronous fs to `node:fs/promises` so that document I/O does not block the Node event loop. `src/runtime/stash.ts` was missed and still uses `mkdirSync` / `writeFileSync` / `readFileSync` / `readdirSync` / `statSync` / `unlinkSync` exclusively. Stash writes are triggered on the hot path of every tool result that exceeds the inline-size threshold — i.e. exactly when results are *large* — so the blocking I/O cost is concentrated on the worst-case messages, on the same thread serving the live LLM conversation and the dashboard HTTP server.

## Evidence

[src/runtime/stash.ts](src/runtime/stash.ts#L5-L10):

```ts
import { mkdirSync, writeFileSync, readFileSync, readdirSync, statSync, unlinkSync } from "node:fs";
```

Each exported helper uses these primitives:

- `stashResult` → `mkdirSync({recursive:true})` + `writeFileSync(filepath, content, "utf-8")` ([src/runtime/stash.ts](src/runtime/stash.ts#L23-L31))
- `readStash` → `readFileSync(filepath, "utf-8")` ([src/runtime/stash.ts](src/runtime/stash.ts#L46))
- `cleanStash` → `readdirSync`, `statSync`, `unlinkSync` in a loop ([src/runtime/stash.ts](src/runtime/stash.ts#L62-L72))

Callers are not test-only:

- [src/agents/base.ts](src/agents/base.ts#L36) imports `stashResult, readStash, cleanStash` and calls `stashResult(...)` from the LLM-tool-result handling path (whenever a tool result exceeds the size threshold), and `readStash(...)` synchronously inside the `read_stash` tool implementation. Both run inside `runLoop()`, which is the event-loop hot path for every active agent.

The migrated `documents.ts` uses async fs throughout ([src/store/documents.ts](src/store/documents.ts) — verified by `grep "fs/promises" src/store/documents.ts`). The justification for `documents.ts` (round-1) applies verbatim here.

## Why this matters

- Stash writes are large by construction (5%+ of the model context window of compressed text per call). A blocking write of, say, 300 KB on a slow disk stalls the event loop for tens of milliseconds — during which the dashboard SSE stream pauses, all concurrently-running agents in the same Node process freeze, and HTTP health checks (`/health`) can time out.
- `cleanStash` walks the entire stash directory synchronously on a timer; with hundreds of stale files (24h retention default), it can pause the loop for hundreds of milliseconds.
- This is the *same* class as the F22 regression. Re-introducing sync fs in any module the worker hot path touches undoes the round-1 fix in practice.
- Bonus subtlety: `readStash`'s security check `resolve(stashRoot, rel) !== resolved` is correct only because both paths are produced by `resolve()` on the same machine; it does not normalise case on case-insensitive filesystems. Out of scope here but worth noting in remediation.

## Rough remediation direction

Migrate `stash.ts` to `node:fs/promises` and change every exported function signature to async:

```ts
export async function stashResult(content: string, toolName: string): Promise<string> { ... }
export async function readStash(filepath: string, offset?, length?): Promise<...> { ... }
export async function cleanStash(maxAgeMs?): Promise<number> { ... }
```

Update callers in [src/agents/base.ts](src/agents/base.ts#L36) and the `read_stash` synthetic tool to `await`. Also add a lint rule (or a CI grep) that fails on any `import { ... } from "node:fs"` outside an allow-list (`stash.ts`'s own file in transition, and the locking primitives in `recovery.ts` that are intentionally sync — see round-1 notes).

## Cross-links

- Direct regression of round-1 F22 (async-fs migration in `documents.ts`).
- Compounds with G11 (`appendDoc` read-modify-write race) — both stem from store-level concurrency primitives being incomplete.
