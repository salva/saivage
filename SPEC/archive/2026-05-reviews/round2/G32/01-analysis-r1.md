# G32 — Analysis r1

**Finding**: [../G32-builtins-search-files-find-subprocess.md](../G32-builtins-search-files-find-subprocess.md)

**Writer**: Claude Opus 4.7 (round 1)

**Pre-G30 anchors below cite the live tree. After G30 lands the line
numbers in [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts)
shift; the plan in [03-plan-r1.md](03-plan-r1.md) re-anchors against
the post-G30 file before edits.**

## 1. What the code does today

`search_files` is one of four tools registered by the `filesystem`
service in [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L256-L272).
Its handler at
[src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L310-L327):

1. Resolves the user-supplied `directory` via `resolvePath` so it
   stays under `projectRoot()`.
2. Branches on whether the `pattern` argument contains a `/`:
   - With `/`: passes `[dir, "-path", "*/" + pattern, "-type", "f"]`.
   - Without `/`: passes `[dir, "-name", pattern, "-type", "f"]`.
3. Spawns the host `find(1)` binary via `execFileAsync` with
   `maxBuffer: MAX_OUTPUT` (currently shared with shell output cap at
   [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L39)).
4. Splits stdout on `\n`, filters empty strings, and returns
   `{ content: { files }, isError: false }`.
5. On **any** thrown error (binary missing, exit ≠ 0, `maxBuffer`
   overflow, invalid pattern, EPERM mid-walk, anything) it swallows
   the exception and returns the empty success envelope
   `{ content: { files: [] }, isError: false }`.

There is no test in
[src/mcp/builtins.test.ts](../../../../src/mcp/builtins.test.ts) that
exercises `search_files` — `grep -n search_files
src/mcp/builtins.test.ts` returns no hits. The tool's behaviour is
therefore entirely defined by the host `find` binary's behaviour, with
no regression coverage.

## 2. Why this is wrong

### 2.1 Hidden hard dependency on POSIX `find`

The module banner at
[src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L1-L9) claims
"Core services (filesystem, shell, git, skills) run in-process — no
subprocess spawning, no external dependencies." `search_files`
contradicts that contract: it requires a `find` binary on `PATH`, and
specifically one that accepts GNU-style ordering (directory first,
then predicates). BusyBox `find` accepts this, but minimal containers
without `findutils` (or future Windows hosts) fail. The closing
comment at
[src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L1069) doubles
down on the false claim ("No subprocess spawning — all operations run
directly in the Node.js process").

### 2.2 Failure mode is invisible to the agent

The bare `catch` at
[src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L324-L326) maps
*every* failure to the empty-success envelope. An agent that asks
"find all `*.test.ts` under `src/`" on a host without `find` gets back
`{ files: [] }`, concludes there are no test files, and proceeds with
a faulty world model. The same opacity hides:

- `maxBuffer` exceeded (truncation collapsed to "no results").
- `find` exit code 1 (a permission-denied subtree midway through a
  walk) when some matches did print.
- A typo in the pattern that GNU `find` rejects.

This violates the structured-error envelope discipline G31 r2 codified
at
[../G31/02-design-r2.md §3.5](../G31/02-design-r2.md): every error
path must carry a stable machine-readable `code`.

### 2.3 Glob semantics are POSIX `find`, not `glob(7)`

The branch at
[src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L314-L316)
interprets a `/` in the pattern as "this is a path expression" and
prepends `*/` to make the partial path match anywhere in the tree.
But:

- `-name` and `-path` do not support `**` (recursive directory
  match). The tool description ("Search for files matching a glob
  pattern" at
  [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L263)) is
  silent about which glob dialect.
- `-name '*.ts'` does *not* match across directories with a single
  glob, so the agent must use `-path '*/...'` form — which the
  current branch produces only when the pattern already has a slash.
  An agent passing `*.ts` gets every `.ts` filename in the tree (via
  `-name`), but an agent passing `src/*.ts` gets `-path '*/src/*.ts'`
  which matches inside *any* `src/` directory at *any* depth, not
  the project-root `src/` only. The contract is undocumented and
  inconsistent.
- `find -name` is shell-glob-style with no character-class escaping;
  patterns with brackets behave unpredictably across `find`
  implementations.

### 2.4 No caps beyond `maxBuffer`

`maxBuffer` (currently 100 KiB, shared with shell output via
[src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L39)) is the
only ceiling. A search that prints 1 000 paths averaging 110 bytes
hits the limit silently (see §2.2). There is no:

- Result-count cap (`maxResults`).
- Walk-depth cap (`maxDepth`).
- Wall-clock cap (`maxMs`).
- Per-call override of any of the above.

`find` itself has `-maxdepth`, but the handler does not pass it. The
neighbour caps at
[src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L39-L43)
(`MAX_OUTPUT`, `MAX_FETCH_CHARS`, `MAX_DOWNLOAD_BYTES`) all flow from
`SaivageConfig.mcp` via `registerBuiltinServices` at
[src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L1077-L1080);
this tool has no equivalent.

### 2.5 Process-fork overhead per call

For a typical Saivage project tree (a few thousand files), an
in-process `opendir` walk completes in low single-digit milliseconds.
`execFile("find", ...)` costs at minimum a `fork`+`execve` plus the
child's own walk; benchmarked at ~5–15 ms on Linux per invocation
before any work. Agents that probe the file tree iteratively
(planner exploration loop, designer scan-for-tests, reviewer
"locate-tests-for-changed-files") amortise this cost dozens of times
per stage.

### 2.6 Argument-vector hygiene is fine, but the framing is bad

`execFile` (not `exec`/`spawn-shell`) means the `pattern` value is
not shell-interpreted, so there is no command-injection. The risk
the finding's brief calls "attack surface … any user-controlled glob
is now a shell arg" is therefore overstated for the current code —
the value goes straight into `argv`. However, two pattern-injection
shapes are still real:

1. A pattern starting with `-` (e.g. `-delete`, `-exec rm {} \;`)
   would be parsed by `find` as a predicate rather than a name
   pattern. `find` POSIX semantics treat the first non-option arg as
   the path, so `[dir, "-name", "-delete", "-type", "f"]` is safe
   because `-name` consumes the next token — but `[dir, "-path",
   "*/-delete", "-type", "f"]` is *also* safe for the same reason.
   The actual risk is small; we should not pretend it is the
   driving concern. The driving concern is portability and clarity.
2. An empty pattern (`""`) or a pattern containing a literal NUL is
   passed through unsanitised; `find` rejects with exit ≠ 0, the
   handler swallows it, agent sees "no results".

### 2.7 Project guideline violations

- Workspace rule "architecture-first, no backward compatibility":
  the subprocess path is legacy stylistic baggage. The handler
  contract is already async; the right primitive is `node:fs`.
- The bare-catch empty-success is a "migration shim" for missing
  `find` — it makes the failure mode look like the absence of
  matches. This is the kind of behavior the project rules say to
  remove rather than preserve.
- G30 r2 just removed every other sync-fs call from this module and
  produced a `node:fs/promises`-shaped baseline. `search_files` is
  now the only filesystem operation in
  [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts) that still
  reaches outside the process.

## 3. Public-API consequences

`search_files` ships these tool semantics today:

```
input:  { directory: string, pattern: string }
output: { files: string[] }   // always isError=false
```

After this finding the input gains optional cap-override fields and
the output gains a `truncated` flag, mirroring the post-G31
`read_file` envelope. Per workspace no-back-compat rule, the plain
`{ files }` envelope is retired — every consumer reading the result
must accept the augmented shape. The `errno`-style structured error
envelope is introduced for the failure paths that today silently
return `[]`.

## 4. Consumers

Searched for callers of the tool by name:

- `grep -rn '"search_files"' src/` → only
  [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L262-L271).
- `grep -rn '"search_files"' web/src/` → no hits.
- `grep -rn 'search_files' prompts/` → mentioned only in the tool
  catalogue presented to agents.

All consumers reach the tool through `McpRuntime.callTool`. The
prompt-level documentation is the only place that promises the
`{ files }` shape, and that documentation is regenerated from the
schema.

## 5. Related findings and shared infrastructure

- **G30** (filesystem sync fs → async): APPROVED, in flight. Its
  shared output is [src/testing/noSyncFsScanner.ts](../../../../src/testing/noSyncFsScanner.ts)
  — a test-only scanner; not a runtime walker. G30 does not produce
  a reusable runtime traversal helper. G32 must land *after* G30 so
  the surrounding handler is already async and `node:fs/promises`
  is the import baseline.
- **G31** (read_file size cap): APPROVED design pattern at
  [../G31/02-design-r2.md](../G31/02-design-r2.md). Establishes the
  structured-error envelope `{ content: { error, code, ...context },
  isError: true }` and the success-side `truncated: boolean`
  pattern. G32 adopts both.
- **G33** (web_search regex): also in
  [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts) but at
  ~L743-L770 — disjoint range from G32 (L262-L271 schema,
  L310-L327 handler).
- **G34** (fetch_url streaming cap): ~L820-L860 — disjoint range
  from G32.
- **G35** (`SECRET_ENV_PATTERNS`): L416-L432 — disjoint range from
  G32.
- **G06 / G36 / G37**: other sync-fs regressions in different
  modules. Not a traversal concern.

## 6. Root cause statement

`search_files` shells out to POSIX `find` because that was the
shortest path to "make it work" when the tool was first added.
Every subsequent G3x finding on this file has assumed the
"in-process, no subprocess" framing in the module banner; this tool
silently violated that framing and the framing's promise to agents
(uniform structured errors, configurable caps, no host-binary
dependency). The fix is an in-process bounded async walker that
returns the same structured envelopes the rest of the file already
returns.

## 7. Open questions for the reviewer

1. Default `mcp.maxSearchResults`: 1 000 (matches the rough working
   size of "all results an agent can usefully consume in one tool
   reply"; smaller than the implicit ~900-line cap that 100 KiB of
   path strings allowed) — does the reviewer want a different
   default?
2. Glob dialect: minimal POSIX-ish — `*`, `?`, `[...]`, plus `**`
   meaning "zero-or-more path segments". Implementation is an
   in-handler `globToRegExp` (see design §3.3). Reviewer to confirm
   we do not want a third-party matcher (no new dependency).
3. Default skip set: hard-code `.git`, `node_modules`. The current
   `find` invocation does *not* skip these, but agents never want
   them and the cost of *not* skipping `node_modules` is the entire
   walker budget. Confirm this is the right behaviour change to ship
   under the no-back-compat rule.
4. Sequencing: G32 must land after G30 (helper-baseline reuse) but
   may land in either order relative to G31, G33, G34, G35 because
   the edit ranges are disjoint. Confirm we do not want to gate G32
   on G31 explicitly.
