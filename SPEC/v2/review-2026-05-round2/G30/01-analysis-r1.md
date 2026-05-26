# G30 — Functional Analysis (r1)

**Finding**: [G30-builtins-filesystem-sync-fs.md](../G30-builtins-filesystem-sync-fs.md)
**Subsystem**: `src/mcp/` (builtin tool handlers)
**Class**: regression of round-1 [F22](../../review-2026-05/F22/APPROVED.md) (sync-fs migration).

## 1. What the code does today

`src/mcp/builtins.ts` registers the in-process MCP services that every
agent calls during a turn: `filesystem` (`read_file`, `write_file`,
`list_dir`, `search_files`), `shell` (`run_command`), `data` (download
helpers), and `git`. All four handlers are exported as `async`, the
`McpRuntime.callTool` dispatcher awaits them, and the round-1 store
migration (F22) already made every persistent document write async. The
single regression is that the four built-in handlers reach into
`node:fs` directly with synchronous primitives instead of
`node:fs/promises`, and so they stall the Node event loop on every disk
operation even though their public signatures are already promise-based.

The blocking primitives entered the module on three independent paths:

1. **`filesystem` handler** — the agent-facing tool surface for ad-hoc
   reads/writes/listings. `read_file`, `write_file`, and `list_dir` all
   use sync fs.
2. **`shell` handler** — the helper functions that write/read the
   stdout/stderr log files surrounding `runShellCommand` use sync fs.
   `runShellCommand` itself uses `createWriteStream` (async), but the
   pre-stream `mkdirSync`, the post-run tail reader (`openSync` /
   `readSync` / `closeSync` / `statSync`), and `safeFileSize` are sync.
3. **`data` handler** — `downloadUrl`, `download_file`, and
   `download_with_fallbacks` persist downloaded payloads and manifest
   JSON with `mkdirSync` + `writeFileSync`.

## 2. Affected code (every sync-fs call site in `builtins.ts`)

Top-of-file imports:

- [src/mcp/builtins.ts#L15-L26](../../../../src/mcp/builtins.ts#L15-L26)
  — `closeSync, createWriteStream, readFileSync, readSync, writeFileSync,
  readdirSync, mkdirSync, existsSync, openSync, statSync` from `node:fs`.
  Of these, `createWriteStream` is intentionally streaming (keep) and
  `existsSync` is currently unused in this file (dead import — verify
  during the fix). The other eight are the blocking primitives.

Call sites:

| # | Line | Tool / context | Primitive |
|---|---|---|---|
| 1 | [src/mcp/builtins.ts#L226](../../../../src/mcp/builtins.ts#L226) | `downloadUrl` — parent dir before writing payload | `mkdirSync` |
| 2 | [src/mcp/builtins.ts#L227](../../../../src/mcp/builtins.ts#L227) | `downloadUrl` — write the downloaded buffer to disk | `writeFileSync` |
| 3 | [src/mcp/builtins.ts#L276](../../../../src/mcp/builtins.ts#L276) | `filesystem.read_file` handler | `readFileSync` |
| 4 | [src/mcp/builtins.ts#L298](../../../../src/mcp/builtins.ts#L298) | `filesystem.write_file` — ensure parent dir | `mkdirSync` |
| 5 | [src/mcp/builtins.ts#L299](../../../../src/mcp/builtins.ts#L299) | `filesystem.write_file` — write content | `writeFileSync` |
| 6 | [src/mcp/builtins.ts#L304](../../../../src/mcp/builtins.ts#L304) | `filesystem.list_dir` handler | `readdirSync` |
| 7 | [src/mcp/builtins.ts#L443](../../../../src/mcp/builtins.ts#L443) | `runShellCommand` — ensure stdout log dir | `mkdirSync` |
| 8 | [src/mcp/builtins.ts#L444](../../../../src/mcp/builtins.ts#L444) | `runShellCommand` — ensure stderr log dir | `mkdirSync` |
| 9 | [src/mcp/builtins.ts#L609](../../../../src/mcp/builtins.ts#L609) | `safeFileSize` — used by `checkOutputGrowth` (polling interval) and by `readFileTail` for the post-run tail | `statSync` |
| 10 | [src/mcp/builtins.ts#L624](../../../../src/mcp/builtins.ts#L624) | `readFileTail` — open log file | `openSync` |
| 11 | [src/mcp/builtins.ts#L626](../../../../src/mcp/builtins.ts#L626) | `readFileTail` — read tail bytes | `readSync` |
| 12 | [src/mcp/builtins.ts#L628](../../../../src/mcp/builtins.ts#L628) | `readFileTail` — close fd | `closeSync` |
| 13 | [src/mcp/builtins.ts#L869](../../../../src/mcp/builtins.ts#L869) | `download_with_fallbacks` — ensure manifest dir on success | `mkdirSync` |
| 14 | [src/mcp/builtins.ts#L870](../../../../src/mcp/builtins.ts#L870) | `download_with_fallbacks` — write success manifest | `writeFileSync` |
| 15 | [src/mcp/builtins.ts#L886](../../../../src/mcp/builtins.ts#L886) | `download_with_fallbacks` — ensure manifest dir on failure | `mkdirSync` |
| 16 | [src/mcp/builtins.ts#L887](../../../../src/mcp/builtins.ts#L887) | `download_with_fallbacks` — write failure manifest | `writeFileSync` |

The `shell` polling site (#9) is the most insidious of the lot: it runs
on a `setInterval` every `OUTPUT_GROWTH_POLL_MS` (1 s by default) for
the entire duration of every shell command, executing two `statSync`
calls each tick. That is a steady drumbeat of sync I/O while a build is
running.

Callers already await the handlers — every call site is downstream of
`McpRuntime.callTool`, which is awaited by `Dispatcher`,
`BaseAgent.runLoop`, the chat HTTP routes, and the test harness. So
flipping these helpers to async does not require any new `await` chains
above the handler boundary; the change is internal to `builtins.ts`.

## 3. Constraints

- **Architecture-first, no backward compat**: project guideline forbids
  retaining sync helpers "for compatibility" or shims. The eight sync
  primitives must be removed from the imports outright; the only `fs`
  helper that survives is `createWriteStream`.
- **Round-1 F22 reference pattern**: `src/store/documents.ts` is the
  canonical async-fs migration in the codebase. Anything we do here
  should match its `import { ... } from "node:fs/promises"` style and
  its `writeDoc`-style atomic-rename semantics where applicable.
- **Sibling deletion**: round-1 already deleted `src/mcp/fsGuard.ts`
  and folded its logic into `builtins.ts` (subsystem map: "fsGuard.ts —
  write-guard logic folded into builtins.ts"). The regression test
  [src/mcp/fsGuard.test.ts](../../../../src/mcp/fsGuard.test.ts) still
  exercises the WI-15 BLOCKED_PATH guard via `registerBuiltinServices`.
  Any restructuring proposal must preserve that test's assertions.
- **Public tool surface is frozen**: every `name`, `inputSchema`, and
  result shape of the `filesystem` tools is part of the LLM prompt
  contract and the existing handler tests
  ([src/mcp/builtins.test.ts](../../../../src/mcp/builtins.test.ts),
  [src/mcp/fsGuard.test.ts](../../../../src/mcp/fsGuard.test.ts)). No
  rename, no field changes.
- **Atomic writes for `write_file` are out of scope**: G10 covers the
  `appendDoc` read-modify-write race separately. `filesystem.write_file`
  currently uses a single `writeFileSync` (last-writer-wins by design,
  matching shell `>` redirection semantics); preserve that.
- **Cross-finding overlap**: G06 migrates `runtime/stash.ts`, G36
  migrates `auth/store.ts`, G37 migrates `config.ts`. The same lint /
  CI guard (`no sync fs under src/mcp/*` and ideally `src/`-wide) is
  proposed by all four. We design the guard once and stage it after
  the last sync-fs site is gone.
- **Test ergonomics**: existing test files
  ([src/mcp/builtins.test.ts](../../../../src/mcp/builtins.test.ts#L2),
  [src/mcp/fsGuard.test.ts](../../../../src/mcp/fsGuard.test.ts#L5))
  legitimately use `node:fs` sync helpers for setup/teardown. The CI
  guard must scope to non-`*.test.ts` files only.

## 4. Open questions

1. **CI guard scope** — workspace-wide (`src/**/*.ts`, excluding tests)
   or only `src/mcp/**`? Workspace-wide is the only option that holds
   the regression class shut; per-module bans are what let G06/G30/G36/
   G37 all re-appear. Recommend workspace-wide with an explicit
   allow-list for files that genuinely need sync I/O at module-load
   time (currently: `recovery.ts` lockfile primitives — already flagged
   in G06's remediation as the only legitimate sync-fs callsite).
2. **`statSync` inside `checkOutputGrowth`** — that callback is invoked
   from a `setInterval` and cannot be made `async` without changing the
   contract (the interval will overlap with itself if the awaited stat
   is slower than the interval). Two real options: (a) replace the
   polling with a `fs.watch` on the log paths, or (b) `void`-fire an
   async `stat` and let the next tick consume the latest value via a
   shared `lastStatBytes` slot. Option (b) is the minimal-change path;
   (a) is the "one level up" path and pairs cleanly with G06's stash
   cleanup migration. Recommend (b) for the focused fix and call out
   (a) explicitly in the design.
3. **`existsSync` dead import** — line 22 imports `existsSync` but the
   file does not use it (checked: zero call sites outside the import
   itself). Removing it is a free win in this batch.
4. **Lint vs. unit-test guard** — F22 added neither; G06/G30/G36/G37
   all ask for one. We pick a unit test under `src/mcp/no-sync-fs.test.ts`
   (and a matching workspace-wide one) for portability — no extra lint
   plugin to maintain.

