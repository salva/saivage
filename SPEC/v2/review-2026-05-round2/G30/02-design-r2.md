# G30 — Design (r2)

**Changes from r1**: Proposal A's `runShellCommand` description now
spells out the pre-`Promise` `mkdir` placement and the
`settled` close-handler race guard required by review finding 1; the
shared regression-guard description is rewritten as a dependency-free,
reusable helper (review finding 2); the cross-finding section is replaced
with the audit table from
[01-analysis-r2.md §4.1](./01-analysis-r2.md#L116-L144) (review finding 3).

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
this module. The guard is authored as a small dependency-free helper
that sibling findings can drop into their own module with a different
`(roots, allowList)` argument.

### `runShellCommand` — exact async shape (r2)

The body of `runShellCommand` becomes:

```ts
async function runShellCommand(
  command, cwd, timeoutMs, inactivityTimeoutMs, outputPaths,
): Promise<CommandResult> {
  // Pre-Promise mkdir: both awaits land BEFORE the `new Promise` so the
  // streams created inside the executor are guaranteed to have their
  // parent directories. Using an async Promise executor would orphan
  // mkdir rejections, so we keep the executor synchronous.
  await mkdir(dirname(outputPaths.stdoutAbs), { recursive: true });
  await mkdir(dirname(outputPaths.stderrAbs), { recursive: true });

  return new Promise((resolve, reject) => {
    // ... existing setup ...
    let settled = false;        // (r2) flips true at top of close handler;
                                // every awaited stat in checkOutputGrowth
                                // re-checks this before mutating state.
    let inFlightTick = false;   // (r2) prevents overlapping async ticks.

    const clearTimers = () => { /* unchanged */ };

    const terminate = (kind) => {
      if (settled || timeoutKind) return;            // (r2) settled-guarded
      timeoutKind = kind;
      terminateChild(child);
      killTimer = setTimeout(() => terminateChild(child, "SIGKILL"), PROCESS_KILL_GRACE_MS);
    };

    const checkOutputGrowth = () => {
      if (!inactivityTimeoutMs || inFlightTick || settled) return;
      inFlightTick = true;
      void (async () => {
        try {
          const [s1, s2] = await Promise.all([
            safeFileSize(outputPaths.stdoutAbs),
            safeFileSize(outputPaths.stderrAbs),
          ]);
          if (settled) return;                       // (r2) race guard
          const outputBytes = Math.max(lastOutputBytes, s1 + s2);
          if (outputBytes > lastOutputBytes) {
            lastOutputBytes = outputBytes;
            lastGrowthAt = Date.now();
            return;
          }
          if (settled) return;                       // (r2) re-check
          if (Date.now() - lastGrowthAt >= inactivityTimeoutMs) terminate("inactivity");
        } finally {
          inFlightTick = false;
        }
      })();
    };

    child.on("close", async (code) => {
      settled = true;            // (r2) set FIRST so any in-flight tick
                                 // that resolves between here and the
                                 // tail read becomes a no-op.
      clearTimers();
      // ... existing finishStream + await readFileTail + safeFileSize ...
    });
  });
}
```

Key invariants (enforced by the new `settled` flag):

1. After `child.on("close")` runs, no tick may write to
   `timeoutKind`, `lastOutputBytes`, `lastGrowthAt`, or schedule a
   `killTimer`. The flag is checked after the awaited
   `Promise.all([stat, stat])` *and* immediately before `terminate()`,
   covering both the "stat returned, then close fired" and "stat
   already in flight when close fired" interleavings.
2. The two `mkdir` calls are awaited before the executor runs, so the
   returned promise is settled exactly once (by `resolve` in the close
   handler, or by `reject` in an `error`/`stream-error` handler). No
   async Promise executor.
3. The close handler itself can `await readFileTail` safely because
   the new tail reader is async-correct (single `open`/`read`/`close`
   via `FileHandle`); no fd leak even on read error (try/finally).

### Files touched

- [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts) — only file
  with behavioural changes.
- [src/mcp/no-sync-fs.test.ts](../../../../src/mcp/no-sync-fs.test.ts) — new
  file. Scans `src/mcp/` (excluding `*.test.ts`) and asserts no
  `node:fs` import other than the allow-listed `createWriteStream`
  identifier, and no `*Sync(` call. Implemented via the reusable
  helper described below.
- [src/testing/noSyncFsScanner.ts](../../../../src/testing/noSyncFsScanner.ts) — new
  file. The reusable helper. Dependency-free; uses `fs/promises.readdir`
  recursion. Consumed by `src/mcp/no-sync-fs.test.ts` here and by the
  matching tests under G06 / G36 / G37.

### Reusable guard helper (r2)

```ts
// src/testing/noSyncFsScanner.ts
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

const SYNC_FS_IDENTIFIERS = [
  "readFileSync", "writeFileSync", "mkdirSync", "readdirSync",
  "statSync", "openSync", "readSync", "closeSync",
  "unlinkSync", "existsSync", "chmodSync", "rmSync", "rmdirSync",
  "appendFileSync", "copyFileSync", "renameSync", "symlinkSync",
  "linkSync", "realpathSync", "accessSync", "lstatSync",
] as const;

const NODE_FS_SPECIFIERS = ['"node:fs"', "'node:fs'"];

export interface SyncFsScanOptions {
  /** Repo-relative roots to walk (e.g. `["src/mcp"]`). */
  roots: string[];
  /**
   * Identifiers permitted in named imports from `node:fs`.
   * Empty array means no named import from `node:fs` is allowed.
   * Default: `["createWriteStream"]`.
   */
  allowedNamedImports?: readonly string[];
  /** File extensions to scan. Default: `[".ts"]`. */
  extensions?: readonly string[];
  /** Substrings; any file whose path contains one is skipped. */
  skipPathContains?: readonly string[];
}

export interface SyncFsViolation {
  file: string;
  kind: "namespace-import" | "default-import" | "disallowed-named-import" | "sync-call";
  detail: string;
}

export async function scanForSyncFs(opts: SyncFsScanOptions): Promise<SyncFsViolation[]> {
  const allowed = new Set(opts.allowedNamedImports ?? ["createWriteStream"]);
  const exts = opts.extensions ?? [".ts"];
  const skip = opts.skipPathContains ?? [".test.ts", ".d.ts"];
  const files: string[] = [];
  for (const root of opts.roots) await walk(root, files, exts, skip);
  const violations: SyncFsViolation[] = [];
  for (const file of files) {
    const src = await readFile(file, "utf-8");
    if (!NODE_FS_SPECIFIERS.some((s) => src.includes(s))) {
      // No node:fs import at all; still scan for *Sync calls in case
      // a future regression imports via require().
      collectSyncCalls(file, src, violations);
      continue;
    }
    // Generalized regex: handles default, namespace, named, and mixed
    // forms. We tokenize each import statement that ends at node:fs.
    const importRe = /import\s+([^"';]+?)\s+from\s+["']node:fs["']/g;
    let m: RegExpExecArray | null;
    while ((m = importRe.exec(src)) !== null) {
      const clause = m[1].trim();
      // Default import: `import fs from "node:fs"`.
      const defaultMatch = clause.match(/^([A-Za-z_$][\w$]*)\s*(,|$)/);
      const namespaceMatch = clause.match(/\*\s+as\s+([A-Za-z_$][\w$]*)/);
      const namedMatch = clause.match(/\{([^}]*)\}/);
      if (namespaceMatch) {
        violations.push({ file, kind: "namespace-import", detail: clause });
      }
      if (defaultMatch && !clause.startsWith("{")) {
        // A bare default import (or `default, { named }`) gives
        // unrestricted access to the sync surface.
        violations.push({ file, kind: "default-import", detail: clause });
      }
      if (namedMatch) {
        const names = namedMatch[1]
          .split(",")
          .map((s) => s.trim().split(/\s+as\s+/)[0].trim())
          .filter(Boolean);
        for (const name of names) {
          if (!allowed.has(name)) {
            violations.push({
              file,
              kind: "disallowed-named-import",
              detail: name,
            });
          }
        }
      }
    }
    collectSyncCalls(file, src, violations);
  }
  return violations;
}

function collectSyncCalls(file: string, src: string, out: SyncFsViolation[]): void {
  const callRe = new RegExp(`\\b(${SYNC_FS_IDENTIFIERS.join("|")})\\s*\\(`, "g");
  let m: RegExpExecArray | null;
  while ((m = callRe.exec(src)) !== null) {
    out.push({ file, kind: "sync-call", detail: m[1] });
  }
}

async function walk(
  dir: string,
  out: string[],
  exts: readonly string[],
  skip: readonly string[],
): Promise<void> {
  let entries: Awaited<ReturnType<typeof readdir>>;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      await walk(full, out, exts, skip);
      continue;
    }
    if (!exts.some((ext) => full.endsWith(ext))) continue;
    if (skip.some((s) => full.includes(s))) continue;
    out.push(full);
  }
}
```

Why this shape:

- **Dependency-free** — only `node:fs/promises` and `node:path`. No
  `tinyglobby`, no `fast-glob`. The `package.json` dep tree is
  unchanged.
- **Generalized regex** — flags any default import (`import fs from "node:fs"`),
  any namespace import (`import * as fs from "node:fs"`), and any
  named import whose identifier is not on the allow-list. The previous
  r1 regex only handled one named-import block and would silently miss
  namespace forms; this version cannot.
- **Reusable** — every sibling finding instantiates it the same way,
  passing its own root and (typically) the default allow-list:

  ```ts
  // G30 — src/mcp/no-sync-fs.test.ts
  expect(await scanForSyncFs({ roots: ["src/mcp"] })).toEqual([]);

  // G06 — src/runtime/no-sync-fs.test.ts
  expect(await scanForSyncFs({ roots: ["src/runtime"],
    skipPathContains: [".test.ts", "recovery.ts"] })).toEqual([]);
  ```

  The eventual workspace-wide guard composes the same helper with
  `roots: ["src"]` and an explicit allow-list derived from
  [01-analysis-r2.md §4.1](./01-analysis-r2.md#L116-L144).

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
- The synchronous `checkOutputGrowth` body — replaced by the
  `settled`/`inFlightTick`-guarded async tick shown above.

### Test impact

- [src/mcp/builtins.test.ts](../../../../src/mcp/builtins.test.ts)
  needs one new focused test: a fast normal exit with inactivity
  polling enabled, asserting `exitCode === 0` and no
  `timed out`/`inactivity` substring in `stderr`. The test runs a
  command that exits in &lt; 10 ms with `inactivity_timeout_ms = 25` so
  every poll tick has an in-flight stat at close time; without the
  `settled` guard the run would frequently be reported as an inactivity
  timeout. The other setup helpers continue to use sync fs (allowed:
  test files are excluded from the guard).
- [src/mcp/fsGuard.test.ts](../../../../src/mcp/fsGuard.test.ts) keeps
  asserting `BLOCKED_PATH` for `.saivage/skills/` and `.saivage/memory/`
  via the public `runtime.callTool("filesystem", "write_file", …)`
  surface; nothing to update.
- New `src/mcp/no-sync-fs.test.ts` calls `scanForSyncFs({ roots: ["src/mcp"] })`
  and asserts the violation array is empty.
- New `src/testing/noSyncFsScanner.ts` — no companion unit test ships
  with G30 (it is exercised end-to-end by the per-module guards). G06
  is the natural place to add a small self-test for the scanner
  helper once it has its second consumer.

### Cost

Smallest blast radius. One source file, one new scanner helper, one
new test. No callers change. Matches F22 exactly: F22 migrated
`documents.ts` in place, async-cascaded callers, and added no new
abstraction.

### Risks

- The shared scanner is consumed cross-finding. We accept the
  coupling: every sibling finding wants the exact same behaviour, and
  the alternative (copy-paste per finding) is precisely what review
  finding 2 ruled out.
- Does not address G06 / G36 / G37, which are the *same* regression
  class in three other modules. The audit table in
  [01-analysis-r2.md §4.1](./01-analysis-r2.md#L116-L144) is the
  gating checklist for when a workspace-wide guard is safe to ship.

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
(open question 4.2 in the analysis) lives on the facade as
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
  (~120 lines).
- [src/mcp/fsGuard.test.ts](../../../../src/mcp/fsGuard.test.ts) —
  expand to unit-test the facade directly.
- New [src/mcp/no-sync-fs.test.ts](../../../../src/mcp/no-sync-fs.test.ts) — same
  guard as in Proposal A.
- New `src/testing/noSyncFsScanner.ts` — same helper as in Proposal A
  (the guard is independent of the facade decision).

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

### Cost

Medium. Restores a deleted module, refactors three handlers to take a
constructor-injected facade, expands one test file. Roughly 200 net
lines moved, 50 deleted, 30 added.

### Risks

- Restoring `fsGuard.ts` reverses a round-1 architectural decision.
- `fs.watch` semantics differ between Linux (inotify) and macOS
  (FSEvents). Dev/CI/production are all Linux LXC.

---

## Recommendation

**Proposal A** (focused fix), with the `settled` close-handler guard
and dependency-free reusable scanner from the r2 design. We ship the
`src/mcp/`-scoped instance now; G06/G36/G37 reuse
`scanForSyncFs` with their own roots; the workspace-wide guard waits
until the audit table in
[01-analysis-r2.md §4.1](./01-analysis-r2.md#L116-L144) is fully
resolved.

Justification:

- F22 — the round-1 reference — is exactly Proposal A's shape: in-place
  async migration, no new abstraction, no callers above the handler
  needed updating. The `settled` race guard is the load-bearing piece
  the r1 design was missing; adding it does not justify Proposal B's
  facade.
- Proposal B's headline benefit — collapsing the `setInterval` +
  `statSync` polling into `fs.watch` — is a *behavioural* change in
  the shell handler that deserves its own review and would silently
  bundle that change with the async migration.
- Reviving `fsGuard.ts` so soon after round-1 deleted it (and re-using
  the same filename for a different responsibility) is the kind of
  flip-flop the project guideline warns against.
