# G30 — Design (r1)

Two proposals. Both keep the public MCP `filesystem` / `shell` / `data`
tool surface identical and remove every sync-fs primitive from
`src/mcp/builtins.ts`. They differ in how much surrounding structure
moves with the fix.

---

## Proposal A — Focused fix: replace sync-fs with `fs/promises` in place

### Idea

Convert every sync primitive in
[src/mcp/builtins.ts](../../../../src/mcp/builtins.ts) to its
`node:fs/promises` equivalent and propagate `await` through the three
internal helpers that are still sync (`safeFileSize`, `readFileTail`,
and the `setInterval`-driven `checkOutputGrowth`). Add one CI guard
(`src/mcp/no-sync-fs.test.ts`) so the regression class cannot recur in
this module.

### Files touched

- [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts) — only file
  with behavioural changes.
- [src/mcp/no-sync-fs.test.ts](../../../../src/mcp/no-sync-fs.test.ts) — new
  file. Reads `builtins.ts` from disk and asserts the source contains
  no import of `"node:fs"` and no `*Sync(` identifier (excluding the
  permitted `createWriteStream`). Doubles as the regression guard
  cited in the round-2 finding.

### Public API impact

None. `filesystem.read_file` / `write_file` / `list_dir` /
`search_files`, `shell.run_command`, `data.download_file` /
`download_with_fallbacks` keep their tool names, input schemas, and
result shapes. All handlers are already `async`; their `await`
boundary moves from "after the sync call returns" to "after the async
primitive resolves" — no consumer change above
`McpRuntime.callTool`.

### Deletion list

- The eight sync imports at
  [src/mcp/builtins.ts#L15-L26](../../../../src/mcp/builtins.ts#L15-L26)
  (`closeSync`, `readFileSync`, `readSync`, `writeFileSync`,
  `readdirSync`, `mkdirSync`, `openSync`, `statSync`).
- The unused `existsSync` import on the same line (dead code).
- The synchronous `checkOutputGrowth` `setInterval` body — replaced by
  an async tick that fires-and-forgets `fs.promises.stat` and updates
  the shared `lastStatBytes` slot, so successive ticks do not stack.

### Test impact

- [src/mcp/builtins.test.ts](../../../../src/mcp/builtins.test.ts)
  needs no behavioural change. Setup helpers continue to use sync fs
  (allowed: test files are excluded from the guard).
- [src/mcp/fsGuard.test.ts](../../../../src/mcp/fsGuard.test.ts) keeps
  asserting `BLOCKED_PATH` for `.saivage/skills/` and `.saivage/memory/`
  via the public `runtime.callTool("filesystem", "write_file", …)`
  surface; nothing to update.
- New `src/mcp/no-sync-fs.test.ts` is the single addition.

### Cost

Smallest blast radius. One source file, one new test. No callers
change. Matches F22 exactly: F22 migrated `documents.ts` in place,
async-cascaded callers, and added no new abstraction.

### Risks

- Does not address G06 / G36 / G37, which are the *same* regression
  class in three other modules. The CI guard, if scoped only to
  `src/mcp/`, lets the bug re-appear in `runtime/`, `auth/`, `config/`.
  Recommend the same `no-sync-fs.test.ts` shape be reused workspace-wide
  by those findings; G30 ships the `src/mcp/` instance.

---

## Proposal B — One level up: centralise filesystem access through an async fs facade and restore `fsGuard` as a proper async module

### Idea

Round-1 deleted `src/mcp/fsGuard.ts` and folded its WI-15
`BLOCKED_PATH` write-guard inline into the `filesystem.write_file`
handler. That decision is what hid the sync-fs regression in this file
for an entire review cycle: the guard, the path resolution, and the
disk I/O are all interleaved in a single 50-line switch arm, so
"replace `writeFileSync`" reads as a one-line edit and nobody notices
the same pattern hiding in `read_file`, `list_dir`, and three
non-filesystem handlers.

The level-up move is to extract a dedicated async filesystem facade
that *every* `builtins.ts` disk site funnels through:

```ts
// src/mcp/fsGuard.ts (restored, async-only)
export interface ProjectFs {
  readFile(rel: string): Promise<string>;
  writeFile(rel: string, content: string): Promise<void>;          // applies WI-15 guard
  listDir(rel: string): Promise<Array<{ name: string; type: "file" | "dir" }>>;
  ensureDirFor(absPath: string): Promise<void>;
  stat(absPath: string): Promise<{ size: number } | null>;          // returns null on ENOENT
  readTail(absPath: string, maxBytes: number): Promise<string>;
}

export function createProjectFs(opts: { projectRoot: () => string }): ProjectFs;
```

`registerBuiltinServices` constructs one `ProjectFs` and passes it into
the `filesystem`, `shell`, and `data` handler factories. The
`filesystem.write_file` BLOCKED_PATH check moves inside
`ProjectFs.writeFile`, where the path is already resolved. The shell
log helpers (`safeFileSize`, `readFileTail`) become thin wrappers
around `ProjectFs.stat` / `ProjectFs.readTail`. The download writes
share `ProjectFs.ensureDirFor` + `fs/promises.writeFile`.

The `fs.watch`-based polling alternative for `checkOutputGrowth`
(open question 2 in the analysis) lives on the facade as
`ProjectFs.watchGrowth(absPath, signal)` returning an async iterator
of byte deltas; the shell handler subscribes for the duration of the
command. This collapses the `setInterval` + `safeFileSize` polling
loop entirely.

### Files touched

- [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts) — sync-fs
  primitives removed; handlers receive `ProjectFs` from
  `registerBuiltinServices`; the WI-15 guard call moves to a single
  `fs.writeFile(...)` line.
- `src/mcp/fsGuard.ts` — restored as a project-scoped async facade
  (~120 lines). Contains: `resolvePath`, `assertInside`, BLOCKED_PATH
  check for `.saivage/skills/` and `.saivage/memory/`, async stat /
  tail / ensure-dir helpers, optional `watchGrowth`.
- [src/mcp/fsGuard.test.ts](../../../../src/mcp/fsGuard.test.ts) —
  expand to unit-test the facade directly (path traversal, BLOCKED_PATH,
  stat-on-missing-file, tail-bigger-than-file, watchGrowth fires on
  growth and stops on `AbortSignal`) in addition to the existing
  end-to-end assertions through `runtime.callTool`.
- New [src/mcp/no-sync-fs.test.ts](../../../../src/mcp/no-sync-fs.test.ts) — same
  guard as in Proposal A, scanning `src/mcp/**/*.ts` excluding `*.test.ts`.

### Public API impact

- MCP tool surface unchanged.
- `registerBuiltinServices(runtime, cfg.mcp)` signature unchanged
  (the `ProjectFs` is constructed *inside* the function from
  `projectRoot()`).

### Deletion list

- The eight sync-fs primitives in `builtins.ts` imports (same as A).
- The dead `existsSync` import (same as A).
- Inline `resolvePath` and `assertInside` definitions in
  `builtins.ts` (now provided by the facade).
- The inline BLOCKED_PATH switch arm in `filesystem.write_file` —
  collapses to `await fs.writeFile(rel, content)`.
- The polling `setInterval` body of `checkOutputGrowth` (replaced
  by `watchGrowth` consumption).

### Test impact

- New / expanded `fsGuard.test.ts` (above). The original four
  assertions move verbatim into the new file as the end-to-end tier.
- `builtins.test.ts` is unchanged.
- New `no-sync-fs.test.ts`.

### Cost

Medium. Restores a deleted module, refactors three handlers to take a
constructor-injected facade, expands one test file. Roughly 200 net
lines moved, 50 deleted, 30 added.

### Risks

- Restoring `fsGuard.ts` reverses a round-1 architectural decision
  (F28/round-1 audit cited the empty fsGuard module as dead). The
  revival is justified only if the facade carries real new behaviour
  (async, BLOCKED_PATH, `watchGrowth`) — which it does. We name the
  module `fsGuard.ts` to recover the round-1 test path without breaking
  imports of the test file.
- `fs.watch` semantics differ between Linux (inotify, fires on every
  write) and macOS (FSEvents, debounced). The dev/CI environment is
  Linux; production runs on Linux LXC containers. We treat
  `watchGrowth` as the canonical mechanism and keep no macOS fallback.

---

## Recommendation

**Proposal A** (focused fix), with one borrowing from B: the
`no-sync-fs.test.ts` guard must be written in a way that the sibling
findings (G06, G36, G37) can drop into their modules unchanged. We
ship the `src/mcp/`-scoped instance now; G06/G36/G37 will widen the
glob to `src/runtime/`, `src/auth/`, `src/config*.ts` in their own
batches and finally to all of `src/` (excluding tests and the
`recovery.ts` lockfile primitives) once the last sync-fs site is gone.

Justification:

- F22 — the round-1 reference — is exactly Proposal A's shape: in-place
  async migration, no new abstraction, no callers above the handler
  needed updating. There is no evidence that the abstraction in B
  prevents a future regression beyond what the CI guard already
  prevents. The guard is the load-bearing piece; the facade is
  scaffolding around it.
- Proposal B's headline benefit — collapsing the `setInterval` +
  `statSync` polling into `fs.watch` — is a *behavioural* change in
  the shell handler that deserves its own review (timing, inotify
  exhaustion under heavy parallel commands, etc.) and would silently
  bundle that change with the async migration. Keeping it out of G30
  keeps the patch focused on the regression class the finding actually
  flags.
- Reviving `fsGuard.ts` so soon after round-1 deleted it (and re-using
  the same filename for a different responsibility) is the kind of
  flip-flop the project guideline warns against. If a facade is
  needed later, it should be named for what it actually does (e.g.
  `projectFs.ts`) and introduced when a second consumer outside
  `builtins.ts` justifies it.

