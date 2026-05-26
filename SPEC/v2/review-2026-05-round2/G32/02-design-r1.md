# G32 — Design r1

**Finding**: [../G32-builtins-search-files-find-subprocess.md](../G32-builtins-search-files-find-subprocess.md)

**Analysis**: [01-analysis-r1.md](01-analysis-r1.md)

**Writer**: Claude Opus 4.7 (round 1)

**Anchors below cite the live pre-G30 tree. The plan in
[03-plan-r1.md](03-plan-r1.md) re-anchors each insertion point
against the post-G30 file before edits.**

## 1. Two proposals

### Proposal A — In-process bounded async walker (RECOMMENDED)

Replace the `execFile("find", ...)` body with a small async walker
built on `node:fs/promises.opendir`, plus an inline `globToRegExp`
translator and structured caps/error envelopes that match the rest
of the file. The walker lives as a local helper next to
`filesystemHandler` — no new module — because:

- The traversal logic is short (≈ 30 lines).
- No other current callsite in `src/` walks a tree with a
  user-supplied glob. `list_dir` is single-level; `data` /
  `download_*` do not walk; `knowledgeSkills` / `knowledgeMemory`
  enumerate a fixed directory shape, not arbitrary patterns. G06,
  G36, G37 are sync→async regressions in unrelated modules, not
  globbed walks.
- Workspace rule "avoid over-engineering" says do not introduce a
  shared module before the second consumer materialises.

**Pros**:

- Smallest blast radius. One source file, one switch branch, one
  helper function, no new module, no new dependency.
- Removes the host `find` dependency without changing the tool's
  conceptual purpose.
- Brings `search_files` under the same structured-error envelope
  shape G31 r2 established.
- Adds the result/depth/time caps every sibling builtin already
  has via `SaivageConfig.mcp`.
- The post-G30 handler is already async; the replacement body slots
  in with no `async` plumbing change above the handler.

**Cons**:

- The glob translator is hand-rolled. Mitigated by an explicit
  test matrix in §3.7 covering every supported metacharacter and
  every documented edge case.
- Re-extracting a shared traversal module later (if a second
  caller appears) means moving ~30 lines. The cost is small and
  paid only if/when needed.

### Proposal B — Shared `src/mcp/fsWalker.ts` module reusable across builtins

Introduce a new module `src/mcp/fsWalker.ts` that exports
`walkFiles({ root, pattern, maxResults, maxDepth, deadlineMs,
skipDirs })` returning `{ files, truncated, reason }`. Convert
`search_files` to call it. Migrate `list_dir` (currently a single
`readdir` call) to call the same module with `maxDepth: 1`. Audit
`knowledgeSkills` / `knowledgeMemory` for tree enumeration and route
them through the helper too.

**Pros**:

- A single canonical traversal primitive across MCP builtins.
- Forces a uniform skip-set / cap policy.

**Cons**:

- Premature abstraction. The current second caller is `list_dir`,
  which today is a one-line `readdir({ withFileTypes: true })` and
  needs no walker — using `walkFiles` with `maxDepth: 1` is a
  pessimisation, not a simplification.
- Knowledge stores enumerate fixed-shape directories with their own
  invariants (lock files, archive trees); routing them through a
  generic walker would either need a much wider option surface or
  duplicate the knowledge-specific filters inside `walkFiles`.
- Workspace rule explicitly says do not create helpers/abstractions
  for one-time operations. The honest description today is "one
  caller plus a pretend caller".
- G30 r2's APPROVED shared output was test-only
  ([src/testing/noSyncFsScanner.ts](../../../../src/testing/noSyncFsScanner.ts));
  the next runtime walker should arrive with at least two real
  callers.

## 2. Recommendation

**Proposal A**. It removes the subprocess, fixes the structured-error
gap, adds the caps, and ships in one self-contained edit. If a second
runtime walker materialises (e.g. a future "search file contents" or
"list-recursive" tool), promoting the helper to `src/mcp/fsWalker.ts`
is a mechanical refactor — and at that point the cost is justified by
a real second caller.

## 3. Detailed shape (Proposal A)

### 3.1 New config fields

In [src/config.ts](../../../../src/config.ts#L137-L147), inside the
`mcp` block, alongside `maxOutputBytes` / `maxFetchChars` /
`maxDownloadBytes` (and the `maxFileReadBytes` G31 r2 will add):

```ts
maxSearchResults: z.number().int().positive().default(1_000),
maxSearchDepth: z.number().int().positive().default(20),
maxSearchMs: z.number().int().positive().default(10_000),
```

No new `superRefine` rule — these caps are independent of the
shell-timeout invariants.

### 3.2 Module-level lets + register-time wiring

In [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L39-L43),
adjacent to the existing caps:

```ts
let MAX_SEARCH_RESULTS = 1_000;
let MAX_SEARCH_DEPTH = 20;
let MAX_SEARCH_MS = 10_000;
```

In [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L1077-L1080),
inside `registerBuiltinServices` (post-G30 these lines remain the
canonical wiring site):

```ts
MAX_SEARCH_RESULTS = mcpConfig.maxSearchResults;
MAX_SEARCH_DEPTH = mcpConfig.maxSearchDepth;
MAX_SEARCH_MS = mcpConfig.maxSearchMs;
```

### 3.3 Updated schema

Replace the `search_files` entry at
[src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L262-L271):

```ts
{
  name: "search_files",
  description:
    "Recursively search for files matching a glob under 'directory'. " +
    "Glob dialect: '*' matches one path segment's chars, '?' matches " +
    "one char, '[...]' is a character class, '**' matches zero or more " +
    "path segments. Skips '.git' and 'node_modules' by default. " +
    "Hard ceilings come from mcp.maxSearchResults (default 1000), " +
    "mcp.maxSearchDepth (default 20), mcp.maxSearchMs (default 10000). " +
    "Per-call 'max_results' may only lower the ceiling.",
  inputSchema: {
    type: "object",
    properties: {
      directory: { type: "string" },
      pattern: { type: "string" },
      max_results: {
        type: "number",
        description:
          "Optional non-negative integer cap on returned matches. " +
          "Must be ≤ mcp.maxSearchResults.",
      },
    },
    required: ["directory", "pattern"],
  },
},
```

`max_depth` and `max_ms` are intentionally **not** caller-overridable
in r1 — the analysis identified zero current callsites that need to
tune them, and exposing every dial as a tool input is precisely the
over-engineering the workspace rule forbids. They remain config-only.

### 3.4 Handler

Replace the `case "search_files":` body at
[src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L310-L327)
with:

```ts
case "search_files": {
  const dir = resolvePath(args.directory as string);
  const pattern = args.pattern;

  if (typeof pattern !== "string" || pattern.length === 0) {
    return {
      content: {
        error: "INVALID_ARGUMENT: pattern must be a non-empty string",
        code: "INVALID_ARGUMENT",
        directory: args.directory,
      },
      isError: true,
    };
  }

  let maxResults: number;
  try {
    const override = parseNonNegativeInt(args.max_results, "max_results");
    maxResults = override === undefined
      ? MAX_SEARCH_RESULTS
      : Math.min(override, MAX_SEARCH_RESULTS);
  } catch (err) {
    return {
      content: {
        error: `INVALID_ARGUMENT: ${(err as Error).message}`,
        code: "INVALID_ARGUMENT",
        directory: args.directory,
      },
      isError: true,
    };
  }

  let regex: RegExp;
  try {
    regex = globToRegExp(pattern);
  } catch (err) {
    return {
      content: {
        error: `INVALID_PATTERN: ${(err as Error).message}`,
        code: "INVALID_PATTERN",
        directory: args.directory,
        pattern,
      },
      isError: true,
    };
  }

  let dirStat;
  try {
    dirStat = await stat(dir);
  } catch (err) {
    return {
      content: {
        error: `NOT_A_DIRECTORY: ${args.directory} (${(err as Error).message})`,
        code: "NOT_A_DIRECTORY",
        directory: args.directory,
      },
      isError: true,
    };
  }
  if (!dirStat.isDirectory()) {
    return {
      content: {
        error: `NOT_A_DIRECTORY: ${args.directory} is not a directory`,
        code: "NOT_A_DIRECTORY",
        directory: args.directory,
      },
      isError: true,
    };
  }

  const deadline = Date.now() + MAX_SEARCH_MS;
  const files: string[] = [];
  let truncatedReason: "results" | "depth" | "time" | null = null;

  const visit = async (current: string, depth: number): Promise<void> => {
    if (truncatedReason !== null) return;
    if (Date.now() > deadline) {
      truncatedReason = "time";
      return;
    }
    if (depth > MAX_SEARCH_DEPTH) {
      truncatedReason = "depth";
      return;
    }
    let handle;
    try {
      handle = await opendir(current);
    } catch {
      // Permission-denied or transient ENOENT mid-walk: skip subtree
      // silently. This is the *intentional* partial-result branch;
      // an outright failure to open the requested root was already
      // caught above as NOT_A_DIRECTORY.
      return;
    }
    try {
      for await (const entry of handle) {
        if (truncatedReason !== null) return;
        if (Date.now() > deadline) { truncatedReason = "time"; return; }
        const full = join(current, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === ".git" || entry.name === "node_modules") continue;
          await visit(full, depth + 1);
          continue;
        }
        if (!entry.isFile()) continue;
        const rel = relative(dir, full);
        if (!regex.test(rel)) continue;
        files.push(full);
        if (files.length >= maxResults) {
          truncatedReason = "results";
          return;
        }
      }
    } finally {
      // for-await-of fully drains the dir; handle.close() is a no-op
      // after exhaustion but is safe to call defensively if we
      // returned early.
      // (opendir's iterator auto-closes on completion; explicit close
      // is a no-op in that case.)
    }
  };

  await visit(dir, 0);

  return {
    content: {
      files,
      truncated: truncatedReason !== null,
      truncated_reason: truncatedReason,
      max_results: maxResults,
      max_depth: MAX_SEARCH_DEPTH,
      max_ms: MAX_SEARCH_MS,
    },
    isError: false,
  };
}
```

Local helper `globToRegExp` (inserted next to the other parsing
helpers, immediately after `parseHttpUrl` at
[src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L74-L80)):

```ts
function globToRegExp(pattern: string): RegExp {
  // Match against project-root-relative paths using forward slashes.
  // Supported tokens:
  //   **   zero or more path segments (must be the entire segment)
  //   *    zero or more chars except '/'
  //   ?    one char except '/'
  //   [..] character class (passed through, only ']' may not be first)
  // All other regex metachars are escaped.
  let i = 0;
  let out = "^";
  while (i < pattern.length) {
    const c = pattern[i];
    if (c === "*") {
      if (pattern[i + 1] === "*") {
        // '**' — collapse adjacent slashes so '**/foo', 'foo/**',
        // and 'a/**/b' all behave intuitively.
        out += "(?:.*/)?";
        i += 2;
        if (pattern[i] === "/") i += 1;
        continue;
      }
      out += "[^/]*";
      i += 1;
      continue;
    }
    if (c === "?") { out += "[^/]"; i += 1; continue; }
    if (c === "[") {
      const close = pattern.indexOf("]", i + 1);
      if (close === -1) throw new Error("Unterminated character class");
      out += pattern.slice(i, close + 1);
      i = close + 1;
      continue;
    }
    if (/[.+^$()|{}\\]/.test(c)) { out += "\\" + c; i += 1; continue; }
    if (c === "/") { out += "/"; i += 1; continue; }
    out += c;
    i += 1;
  }
  out += "$";
  return new RegExp(out);
}
```

`parseNonNegativeInt` is the helper G31 r2 introduces (see
[../G31/02-design-r2.md §3.4](../G31/02-design-r2.md)). If G31 has
not yet landed at G32-merge time, G32 declares it locally in the
same place and G31 removes the duplicate when it merges. The plan
in [03-plan-r1.md](03-plan-r1.md) §2.2 lists this as the only
ordering-sensitive item.

### 3.5 Required imports

In [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L29):

- Add `opendir` and `stat` to the `node:fs/promises` import that G30
  r2 introduces (G30 r2 imports `open` and `stat` already; this
  appends `opendir`).
- Remove `execFile` and `promisify` from the `node:child_process` /
  `node:util` imports **iff** they are no longer used after the
  edit. `git_log`/`git_diff` at
  [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L918) still
  uses `execFileAsync`, so `execFile` and `promisify` and the
  `execFileAsync` binding all stay. The plan re-verifies this with
  `grep -n execFileAsync` after the patch.

### 3.6 Error and success envelope shape

**Errors** match G31 r2's documented shape exactly:
`{ content: { error, code, ...context }, isError: true }`. Codes:

| Code | Trigger |
|---|---|
| `INVALID_ARGUMENT` | `pattern` missing/empty/non-string, `max_results` not a non-negative integer, `max_results` exceeds `MAX_SEARCH_RESULTS` is *not* an error — it is silently clamped down per the schema description. |
| `INVALID_PATTERN` | `globToRegExp` throws (unterminated `[...]`). |
| `NOT_A_DIRECTORY` | `stat(dir)` fails or is not a directory. |

**Success** envelope (no `isError`):
`{ files: string[], truncated: boolean, truncated_reason: "results" |
"depth" | "time" | null, max_results: number, max_depth: number,
max_ms: number }`. `truncated` is the single boolean a polling agent
should check; `truncated_reason` is the human-actionable hint. The
plain `{ files }` shape is retired (no back-compat).

**Runtime surface**: identical to G31's analysis at
[../G31/02-design-r2.md §3.5](../G31/02-design-r2.md) — the runtime
wrapper at
[src/mcp/runtime.ts](../../../../src/mcp/runtime.ts#L188-L193)
throws an `Error("Tool \"search_files\" on \"filesystem\" returned
error: " + JSON.stringify(content))` on `isError: true`, so each
`code` string is a substring of the thrown message and error-path
tests match on that substring.

### 3.7 Glob translator semantics (exhaustive)

| Pattern | Match against `relative(dir, file)` | Example |
|---|---|---|
| `*.ts` | `^[^/]*\.ts$` | `foo.ts` ✓, `src/foo.ts` ✗ |
| `**/*.ts` | `^(?:.*/)?[^/]*\.ts$` | `foo.ts` ✓, `src/foo.ts` ✓, `a/b/c.ts` ✓ |
| `src/*.ts` | `^src/[^/]*\.ts$` | `src/foo.ts` ✓, `src/a/b.ts` ✗ |
| `src/**/*.ts` | `^src/(?:.*/)?[^/]*\.ts$` | `src/foo.ts` ✓, `src/a/b.ts` ✓ |
| `?.ts` | `^[^/]\.ts$` | `a.ts` ✓, `ab.ts` ✗ |
| `[ab].ts` | `^[ab]\.ts$` | `a.ts` ✓, `c.ts` ✗ |
| `**` (alone) | `^(?:.*/)?$` | matches every directory-suffix; matched against files yields the file's own path with trailing slash — never matches. **Documented edge case**: a bare `**` returns no files; agents should use `**/*` instead. The schema description states this. |

Behaviour difference from pre-G32: the old `*.ts` (via `-name '*.ts'`)
matched a file's basename anywhere in the tree (because `find -name`
matches basename). The new `*.ts` matches only the *top-level*
file's relative path; for recursive matching the agent must say
`**/*.ts`. This is the deliberate behaviour change under the
no-back-compat rule. The schema description (§3.3) names this
explicitly.

### 3.8 Skip set

Hard-coded directory-name skip: `.git`, `node_modules`. Not
configurable in r1. Rationale: the analysis identified zero realistic
agent workflow that wants to traverse these, and traversing
`node_modules` is the single fastest way to exhaust the time budget.
If a future use case needs different skips it adds a config field;
adding it speculatively today violates the "avoid over-engineering"
rule.

### 3.9 Symlinks

`opendir` reads entries with `dirent.isDirectory()` / `isFile()` which
operate on the entry's own type, **not** the target of a symlink.
Symlinks to directories therefore do not recurse; symlinks to files
are matched only if the schema's regex matches their relative path
(but the file-type predicate is `entry.isFile()`, which returns false
for symlinks, so symlinked files are skipped too). This is stricter
than the old `find` behaviour, which followed neither (find without
`-L` doesn't dereference). Net effect: symlinks contribute nothing.
Acceptable: the analysis found no consumer that depends on symlinks.

### 3.10 Deletion list

- The `execFile("find", ...)` call body at
  [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L313-L325).
- The two-branch `findArgs` construction at
  [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L314-L316).
- The bare `catch { return { content: { files: [] } } }` swallowing
  block at
  [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L324-L326).

No deletions of imports yet (`execFileAsync` is still used by
`git_log`/`git_diff` at
[src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L918)).

### 3.11 Public-API impact

- Tool schema: gains optional `max_results` field; description
  documents the new glob dialect, the hard ceilings, and the
  default skip set.
- Success envelope: `{ files }` → `{ files, truncated,
  truncated_reason, max_results, max_depth, max_ms }`.
- Error envelope: previously silent → structured
  `{ error, code, ... }` with `isError: true`.

Under the workspace no-back-compat rule, every prompt-side or
test-side consumer reading the result must accept the new shape.
The analysis found zero such consumers outside the test file.

## 4. Sequencing

1. **Hard prereq**: G30 must merge first. G32 reuses G30's
   `node:fs/promises` import baseline and the post-G30 handler is
   already async.
2. **Soft prereq**: G31 r2's `parseNonNegativeInt` helper. If G31
   merges first, G32 reuses the helper; otherwise G32 declares it
   locally and G31's PR removes the duplicate. The plan covers both
   orderings.
3. **Disjoint co-edits in the same file**: G33 (L743-L770), G34
   (L820-L860), G35 (L416-L432) all edit
   [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts) but in
   ranges disjoint from G32's (L262-L271 schema, L310-L327
   handler, L39-L43 module-level lets, L1077-L1080 wiring). Merge
   order between G32/G33/G34/G35 is unconstrained; expect
   rebase-level conflicts only on the import line (G34 may add
   streaming imports) and on the `MAX_*` adjacent-let block.
4. **No daemon coupling**: pure in-process change; no service-file
   or systemd-unit edits.

## 5. Test gates

Detailed in [03-plan-r1.md §5](03-plan-r1.md). Summary of must-pass
gates before merge:

- `search_files` happy path: top-level `*.ts`, recursive `**/*.ts`,
  directory-anchored `src/*.ts`, character class `[ab].ts`, `?`
  metachar.
- Skip set: a file under a synthetic `node_modules/` is **not**
  returned by `**/*.ts`; same for `.git/`.
- Truncation: `truncated_reason: "results"` when match count
  exceeds `max_results`; `"depth"` when nested deeper than
  `MAX_SEARCH_DEPTH`; `"time"` when a slow walker (synthetic
  fixture) exceeds `MAX_SEARCH_MS` (test uses a 50 ms budget).
- Error envelope: `INVALID_ARGUMENT` on empty pattern;
  `INVALID_PATTERN` on `[abc`; `NOT_A_DIRECTORY` on a file path
  passed as `directory`.
- Permission-denied subtree mid-walk: synthetic chmod-0 directory
  is skipped silently; sibling matches are still returned;
  `truncated` stays false.
- No subprocess: assert via the
  [src/mcp/no-sync-fs.test.ts](../../../../src/mcp/no-sync-fs.test.ts)
  scanner (G30's contribution) that
  [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts) imports
  zero new sync-fs identifiers; **plus** a new
  `search_files`-specific test asserts no `execFile("find", …)`
  appears in the post-edit file (regex-grep self-check).
