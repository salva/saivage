# G30 — Functional Analysis (r2)

**Finding**: [G30-builtins-filesystem-sync-fs.md](../G30-builtins-filesystem-sync-fs.md)
**Subsystem**: `src/mcp/` (builtin tool handlers)
**Class**: regression of round-1 [F22](../../review-2026-05/F22/APPROVED.md) (sync-fs migration).
**Changes from r1**: section 3 ("Constraints") gains the `runShellCommand`
close-handler race constraint surfaced by r1 review finding 1; section 4
("Open questions") replaces the underscoped CI-guard discussion with the
full workspace audit table demanded by r1 review finding 3.

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
- **`runShellCommand` close-handler race (r2 — new)**: once
  `safeFileSize` / `readFileTail` / `checkOutputGrowth` become async,
  the `setInterval` tick at
  [src/mcp/builtins.ts#L483-L496](../../../../src/mcp/builtins.ts#L483-L496)
  can have a `stat` in flight at the moment `child.on("close")` fires at
  [src/mcp/builtins.ts#L523-L541](../../../../src/mcp/builtins.ts#L523-L541).
  The in-flight tick must not mutate `timeoutKind`, `lastOutputBytes`,
  or `lastGrowthAt` after close, and must not schedule a post-close kill
  timer. The design must carry a `settled` (a.k.a. `closed`) flag set in
  `clearTimers()` / at the top of the close handler and re-checked after
  every awaited stat before either branch of the inactivity check fires.
  This is the constraint that justifies routing the polling tick through
  a single guarded helper rather than letting `checkOutputGrowth` close
  over the loop locals directly.
- **No async `Promise` executor in `runShellCommand` (r2 — new)**: the
  function currently returns `new Promise(...)` immediately at
  [src/mcp/builtins.ts#L433-L440](../../../../src/mcp/builtins.ts#L433-L440).
  The two `mkdir` calls at
  [src/mcp/builtins.ts#L443-L444](../../../../src/mcp/builtins.ts#L443-L444)
  must move *before* the `new Promise` constructor (so the function body
  is `async function ... { await mkdir(...); await mkdir(...); return new Promise((resolve, reject) => { ... }); }`).
  Using an async Promise executor would make `mkdir` rejections
  unhandled and leave the returned promise potentially unsettled — both
  forbidden under the project's error-handling posture.
- **Cross-finding overlap**: G06 migrates `runtime/stash.ts`, G36
  migrates `auth/store.ts`, G37 migrates `config.ts`. The same lint /
  CI guard (`no sync fs under src/mcp/*` and ideally `src/`-wide) is
  proposed by all four. We design the guard once and stage it after
  the last sync-fs site is gone. The guard must be authored as a small
  reusable helper accepting `(roots, allowList)` so each finding can
  drop it in with no copy-paste.
- **Test ergonomics**: existing test files
  ([src/mcp/builtins.test.ts](../../../../src/mcp/builtins.test.ts#L2),
  [src/mcp/fsGuard.test.ts](../../../../src/mcp/fsGuard.test.ts#L5))
  legitimately use `node:fs` sync helpers for setup/teardown. The CI
  guard must scope to non-`*.test.ts` files only.

## 4. Open questions

### 4.1 Workspace `node:fs` audit (replaces r1 §4.1)

The r1 plan claimed a workspace-wide guard could land "after G06 / G36 /
G37". That claim was wrong — there are more non-test `node:fs` importers
than r1 enumerated. The audit below is the source of truth for which
files have an owning finding, which are deliberately sync (F22
carve-out), and which are still unowned and therefore must not be
covered by a workspace-wide ban yet.

| File | Status | Owning finding / rationale |
|---|---|---|
| [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L15-L26) | covered (this finding) | G30 |
| [src/runtime/stash.ts](../../../../src/runtime/stash.ts#L6-L67) | covered (sibling finding) | [G06](../G06-stash-uses-sync-fs.md) |
| [src/auth/store.ts](../../../../src/auth/store.ts#L8-L66) | covered (sibling finding) | [G36](../G36-auth-store-sync-fs.md) |
| [src/config.ts](../../../../src/config.ts#L2-L280) | covered (sibling finding) | [G37](../G37-config-sync-fs-and-stale-cache.md) |
| `src/runtime/recovery.ts` lockfile primitives | deliberately sync (F22 carve-out) | round-1 [F22](../../review-2026-05/F22/APPROVED.md): lockfile must be atomic at module-load, no event-loop alternative; flagged in G06 remediation as the only legitimate sync site. |
| [src/agents/prompts.ts](../../../../src/agents/prompts.ts#L9-L51) | still unowned | needs new finding; currently reads prompt bundles at module load. Out of scope for G30; must remain on the workspace-wide guard's allow-list until a finding decides to make it lazy/async. |
| [src/agents/base.ts](../../../../src/agents/base.ts#L7) | still unowned | needs new finding; imports `node:fs` for a non-hot-path read. Out of scope for G30. |
| [src/server/cli.ts](../../../../src/server/cli.ts#L493-L538) | still unowned | needs new finding; CLI startup uses sync reads. Acceptable at process boot, but should be confirmed by a focused review before being added to the allow-list permanently. |
| [src/server/bootstrap.ts](../../../../src/server/bootstrap.ts#L15-L720) | still unowned | needs new finding; bootstrap uses sync reads for config discovery. Same comment as `cli.ts`. |
| [src/knowledge/store.ts](../../../../src/knowledge/store.ts#L14-L286) | still unowned | needs new finding; on the agent hot path (knowledge skill resolution), so likely *not* a legitimate sync site — high priority for the next review batch. |
| [src/repo-layout/contract.ts](../../../../src/repo-layout/contract.ts#L29-L154) | still unowned | needs new finding; module-load contract loader. Likely allow-listable. |
| [src/knowledge/builtinWalker.ts](../../../../src/knowledge/builtinWalker.ts#L13-L139) | still unowned | needs new finding; walks the builtin knowledge tree at startup. Likely allow-listable. |

Consequence for sequencing: a workspace-wide `src/no-sync-fs.test.ts`
**cannot** ship after G37 the way r1 implied. The metaplan must
either (a) land per-module guards only and defer the workspace-wide one
until every still-unowned row above has either an owning finding or a
reviewed allow-list entry, or (b) ship a workspace-wide guard with an
explicit allow-list naming every still-unowned file plus
`recovery.ts`. We pick (a): per-module guards now, workspace-wide
guard later, with this audit table as the gating checklist.

### 4.2 `statSync` inside `checkOutputGrowth`

That callback is invoked from a `setInterval` and cannot be made
`async` without changing the contract (the interval will overlap with
itself if the awaited stat is slower than the interval). Two real
options: (a) replace the polling with a `fs.watch` on the log paths,
or (b) `void`-fire an async `stat`, guard against overlap with an
`inFlight` flag, and short-circuit on a `settled`/`closed` flag set by
the close handler so a late tick cannot mutate timeout state after the
child exits. Option (b) is the minimal-change path; (a) is the "one
level up" path and pairs cleanly with G06's stash cleanup migration.
Recommend (b) for the focused fix and call out (a) explicitly in the
design.

### 4.3 `existsSync` dead import

Line 22 imports `existsSync` but the file does not use it (checked:
zero call sites outside the import itself). Removing it is a free win
in this batch.

### 4.4 Lint vs. unit-test guard

F22 added neither; G06/G30/G36/G37 all ask for one. We pick a unit
test under `src/mcp/no-sync-fs.test.ts` (and a sibling instance in
each owning finding) for portability — no extra lint plugin to
maintain. The guard's scanning logic is factored as a small local
helper that accepts `(roots, allowList)` so G06/G36/G37 can reuse it
verbatim and the eventual workspace-wide guard can compose the same
helper with the audit table above.
