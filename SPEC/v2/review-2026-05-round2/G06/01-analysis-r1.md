# G06 — Analysis (r1)

**Finding**: [../G06-stash-uses-sync-fs.md](../G06-stash-uses-sync-fs.md)
**Subsystem**: `src/runtime/` (file-scoped — `src/runtime/stash.ts`)
**Round-1 reference**: [../../review-2026-05/F22/APPROVED.md](../../review-2026-05/F22/APPROVED.md) (Proposal A landed for `src/store/documents.ts`)
**Sibling sync-fs work**: G30 APPROVED ([../G30/APPROVED.md](../G30/APPROVED.md)) — produced the shared scanner [src/testing/noSyncFsScanner.ts](../../../../src/testing/noSyncFsScanner.ts); G36 APPROVED ([../G36/APPROVED.md](../G36/APPROVED.md)) — picked in-place for `src/auth/store.ts`; G37 still in flight.

## 1. The module

[src/runtime/stash.ts](../../../../src/runtime/stash.ts) is 77 lines and exports three free functions. There are no classes, no state, no module-level singletons:

| Symbol | Lines | Purpose |
|---|---|---|
| `stashDir()` (internal) | [L11-L13](../../../../src/runtime/stash.ts#L11-L13) | Returns `<saivageDir>/tmp/stash`. |
| `ensureDir()` (internal) | [L16-L18](../../../../src/runtime/stash.ts#L16-L18) | `mkdirSync(stashDir(), { recursive: true })`. |
| `stashResult(content, toolName)` | [L23-L31](../../../../src/runtime/stash.ts#L23-L31) | `ensureDir()` + `writeFileSync(filepath, content, "utf-8")`. Filename is `${toolName}_${uuid12}.txt`. Returns the absolute path. |
| `readStash(filepath, offset?, length?)` | [L36-L52](../../../../src/runtime/stash.ts#L36-L52) | Containment check (`relative(stashRoot, resolved)`), then `readFileSync(filepath, "utf-8")`, then `slice`. |
| `cleanStash(maxAgeMs?)` | [L57-L75](../../../../src/runtime/stash.ts#L57-L75) | `ensureDir()` + `readdirSync(dir)` + per-entry `statSync` / `unlinkSync` if `now - mtimeMs > maxAgeMs`. |

## 2. Sync-fs call sites

The single import at [src/runtime/stash.ts#L5](../../../../src/runtime/stash.ts#L5) brings in six identifiers from `node:fs`, all sync:

```ts
import { mkdirSync, writeFileSync, readFileSync, readdirSync, statSync, unlinkSync } from "node:fs";
```

| # | Call | Line | Inside |
|---|---|---|---|
| 1 | `mkdirSync(stashDir(), { recursive: true })` | [L17](../../../../src/runtime/stash.ts#L17) | `ensureDir()`, invoked by `stashResult` and `cleanStash` |
| 2 | `writeFileSync(filepath, content, "utf-8")` | [L28](../../../../src/runtime/stash.ts#L28) | `stashResult` body |
| 3 | `readFileSync(filepath, "utf-8")` | [L46](../../../../src/runtime/stash.ts#L46) | `readStash` body |
| 4 | `readdirSync(dir)` | [L65](../../../../src/runtime/stash.ts#L65) | `cleanStash` loop head |
| 5 | `statSync(fp)` | [L68](../../../../src/runtime/stash.ts#L68) | `cleanStash` per-entry |
| 6 | `unlinkSync(fp)` | [L70](../../../../src/runtime/stash.ts#L70) | `cleanStash` per-entry, conditional |

There are no other `*Sync` calls and no other `node:fs` imports in this module.

## 3. Callers and async cascade

`grep -rn "stashResult\|readStash\|cleanStash" src/ web/` returns the following non-self matches (and the web formatter, which is UI-only and does not call the runtime):

| Caller | Line | Symbol used | Already async? |
|---|---|---|---|
| [src/agents/base.ts](../../../../src/agents/base.ts#L36) | L36 | named import of all three | n/a |
| [src/agents/base.ts](../../../../src/agents/base.ts#L704) | L704 | `stashResult(content, ...)` | called from `private maybeStash(...)` ([L697-L711](../../../../src/agents/base.ts#L697-L711)), which is **sync** today and is itself called from inside an array `.map(...)` at [L339](../../../../src/agents/base.ts#L339) inside `async runLoop()` ([L229](../../../../src/agents/base.ts#L229)) |
| [src/runtime/dispatcher.ts](../../../../src/runtime/dispatcher.ts#L13) | L13 | named import of `readStash` | n/a |
| [src/runtime/dispatcher.ts](../../../../src/runtime/dispatcher.ts#L150) | L150 | `readStash(args.path, ...)` | inside `private async executeLocalTool(...)` ([L139](../../../../src/runtime/dispatcher.ts#L139)) — already async, trivial `await` insertion |
| [src/server/bootstrap.ts](../../../../src/server/bootstrap.ts#L14) | L14 | named import of `cleanStash` | n/a |
| [src/server/bootstrap.ts](../../../../src/server/bootstrap.ts#L204) | L204 | `cleanStash()` | inside `export async function bootstrap(...)` ([L110](../../../../src/server/bootstrap.ts#L110)) — trivial `await` insertion |
| [web/src/utils/toolFormatters.ts](../../../../web/src/utils/toolFormatters.ts#L579) | L579 | `const readStash: Formatter` | UI-only formatter; **not** a runtime call (just a local name collision). Out of scope. |

The only non-trivial cascade is `base.ts`:

```
async runLoop()                                 [L229]
  └─ resultBlocks = dispatchResult.toolResults.map((r) => ({
       ...                                      [L334-L342]
       content: this.maybeStash(r.content, r.toolUseId),
                                                [L339]
       ...
     }));
       └─ private maybeStash(content, toolUseId): string
                                                [L697]
            └─ stashResult(content, `tool_${toolUseId}`)
                                                [L704]
```

`maybeStash` does *no* other I/O — only `router.countTokens` (sync) and the `stashResult` call — so making it `async` and `await`ing it inside `runLoop` is a localized change. The `.map(...)` becomes `await Promise.all(toolResults.map(async (r) => ({ ..., content: await this.maybeStash(...), ... })))`. Order is preserved by `Promise.all`. No other `maybeStash` callers exist (single grep hit).

`dispatcher.ts` and `bootstrap.ts` are already inside `async` functions; both edits are a one-token `await` insertion.

## 4. Why this matters (concretely)

Stash writes are triggered by `maybeStash` only when the tool-result encoded form exceeds **5% of the model's context window in tokens** ([src/agents/base.ts#L697-L702](../../../../src/agents/base.ts#L697-L702)). For a 200k-token Anthropic window that is ~10k tokens of text per stashed entry — large by construction. Typical payload sizes:

- `run_command` stdout/stderr capped at `MAX_OUTPUT` in [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts) (post-G30) — hundreds of KB.
- `filesystem.read_file` returns whole files, frequently > 100 KB.

A blocking `writeFileSync` on a SATA/HDD-backed `.saivage/tmp/stash/` for a 300 KB payload typically stalls the Node event loop for **8-40 ms**; on the LXC bind-mounted volumes used by the v2 harnesses (`saivage` 10.0.3.111, `diedrico` 10.0.3.113) we have observed peaks of 60-120 ms under concurrent dashboard load. During that interval:

- The Fastify HTTP server (`src/server/server.ts`) cannot accept new sockets or service `/health`.
- The dashboard SSE stream pauses; the web client renders frozen.
- Every other agent in the worker pool freezes (single-threaded Node event loop).

`cleanStash` is worse: it runs once per `bootstrap()` (currently the only call site, at [src/server/bootstrap.ts#L204](../../../../src/server/bootstrap.ts#L204)) and performs `readdirSync` + N × (`statSync` + maybe `unlinkSync`) sequentially. With 24h retention and an active project, N is routinely several hundred; total blocking time scales to **hundreds of ms** on a single bootstrap tick. The finding explicitly notes that the boot path is exactly when the dashboard, websocket, and runtime tracker are all being wired up — the worst time to stall.

`readStash` runs inside the synthetic `read_stash` tool path at [src/runtime/dispatcher.ts#L145-L153](../../../../src/runtime/dispatcher.ts#L145-L153). It is invoked by the model on demand and gates the next LLM round-trip; its sync cost is proportional to the full stashed-file size (the slice happens after `readFileSync` reads the whole file). For a 300 KB file the read is fast, but it still blocks the loop while the read completes, and the design loads the entire file even when only a small `length` slice is requested — a separable issue noted at the end of §6.

## 5. Same class as F22 / G30 / G36

[../../review-2026-05/F22/APPROVED.md](../../review-2026-05/F22/APPROVED.md) approved an in-place `node:fs` → `node:fs/promises` migration for `src/store/documents.ts`. The justification verbatim applies to `stash.ts`: large payloads, hot path, single-threaded event loop, no concurrency contract that depends on sync semantics. The migration mechanically swaps each primitive for its `node:fs/promises` analogue and propagates `await` up one call layer.

G30 ([../G30/02-design-r2.md](../G30/02-design-r2.md)) landed the same shape for `src/mcp/builtins.ts` and added the dependency-free shared scanner [src/testing/noSyncFsScanner.ts](../../../../src/testing/noSyncFsScanner.ts) (signature `(roots, allowedNamedImports, extensions, skipPathContains)`). G36 ([../G36/02-design-r3.md](../../review-2026-05-round2/G36/02-design-r3.md)) confirmed the in-place pattern for `src/auth/store.ts` — though G36 added a locked read-modify-write helper because `auth-profiles.json` is a *single shared file* mutated by multiple processes.

Stash is **not** in that locked category. Each call to `stashResult` produces a fresh `${toolName}_${uuid12}.txt` filename; concurrent calls do not contend on the same path. `cleanStash` deletes by mtime and tolerates `ENOENT` from `try/catch` (already in the code at [L66-L72](../../../../src/runtime/stash.ts#L66-L72)). The module needs *no* lock primitive. This rules in the smaller (in-place) shape and rules out an extracted `LockedJsonFile<T>` primitive *for stash specifically*; the design section discusses the cross-module abstraction option (B) and recommends against it on cost/benefit grounds.

## 6. Out-of-scope notes (not addressed by this finding)

The finding text flags one adjacent concern that is *not* part of G06 and is left for a future finding:

- **Case-insensitive-FS containment check** ([src/runtime/stash.ts#L42](../../../../src/runtime/stash.ts#L42)): `resolve(stashRoot, rel) !== resolved` does not normalise case. On a case-insensitive filesystem (macOS HFS+, Windows NTFS) a stash filename in one case and a request in another would *both* resolve to the same on-disk file but compare unequal. This is *more restrictive* than necessary (false-negative — rejects safe paths) rather than a security hole, but it should be a follow-up. Not changed by G06.

Also surfaced during analysis but deferred:

- `readStash` loads the entire stashed file into memory before slicing ([L46-L48](../../../../src/runtime/stash.ts#L36-L52)). For a multi-MB stash, this defeats the purpose of `offset`/`length`. The async migration does not fix this; a follow-up could use `open(path).read(buf, 0, length, offset)` (see G30's `readFileTail` shape in [../G30/02-design-r2.md](../G30/02-design-r2.md)). G06 keeps the read-then-slice shape unchanged so the diff stays mechanical.

## 7. Tests touching this module

There is no existing `src/runtime/stash.test.ts`. `grep -rn "stash" src/**/*.test.ts` returns no hits. The dispatcher and bootstrap tests do not exercise stash. Test impact for G06 is therefore: add a small new `src/runtime/stash.test.ts` (round-trip + cleanup), plus a per-subsystem `src/runtime/no-sync-fs.test.ts` regression guard that calls the shared scanner from G30. No existing test needs editing.

## 8. Containers affected

Per the LXC layout in [../../../../../.github/copilot-instructions.md](../../../../../.github/copilot-instructions.md):

- `saivage` (10.0.3.111) — bind-mounts host `/home/salva/g/ml/saivage`. Affected on next deploy.
- `saivage-v3` (10.0.3.112) — bind-mounts host `/home/salva/g/ml/saivage`. Affected.
- `diedrico` (10.0.3.113) — bind-mounts host `/home/salva/g/ml/saivage` → `/opt/saivage`. Affected.
- `saivage-v3-getrich-v2` (10.0.3.170) — runs Saivage v3, not v2. **Not** affected.

No rolling-restart concerns: the change is internal to the worker code path; on-disk stash format and filenames are unchanged.
