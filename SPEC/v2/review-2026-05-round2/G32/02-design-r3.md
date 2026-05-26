# G32 — Design r3

**Finding**: [../G32-builtins-search-files-find-subprocess.md](../G32-builtins-search-files-find-subprocess.md)

**Analysis**: [01-analysis-r3.md](01-analysis-r3.md) (delta over
[01-analysis-r2.md](01-analysis-r2.md))

**Round 1 baseline**: [02-design-r1.md](02-design-r1.md)

**Round 2 baseline**: [02-design-r2.md](02-design-r2.md)

**Round 2 review**: [04-review-r2.md](04-review-r2.md)

**Writer**: Claude Opus 4.7 (round 3)

Round 3 keeps Proposal A as recommended and Proposal B rejected for
the same reasons recorded in
[02-design-r1.md §1](02-design-r1.md#L13-L84). Every section of
round 1 and round 2 not listed below is unchanged and is not
restated. Round-3 changes are confined to: §3.2 (glob translator —
empty-pattern dead-code removal), §3.4 (handler — root-opendir
classification), §3.6 (error-code table — empty-pattern row,
root-opendir trigger), §3.7 (per-entry policy — scope clamp to
depth ≥ 1), §5 (design-layer test-gate summary).

## 1. Recommendation (unchanged)

**Proposal A** from
[02-design-r1.md §1](02-design-r1.md#L13-L52). Proposal B remains
rejected at
[02-design-r1.md §1](02-design-r1.md#L54-L84).

## 2. Anchors carried forward unchanged

All sections of
[02-design-r2.md](02-design-r2.md) other than §3.2, §3.4, §3.6, §3.7
and §5 are preserved verbatim and are not restated:

- §3.1 (truncation semantics, boundary-exact matrix) at
  [02-design-r2.md §3.1](02-design-r2.md#L55-L77).
- §3.3 (schema, unchanged) at
  [02-design-r2.md §3.3](02-design-r2.md#L202-L207).
- §3.5 (helper reuse — G31 hard prereq) at
  [02-design-r2.md §3.5](02-design-r2.md#L426-L439).
- §3.8 (no-sync-fs guard anchored to G30 deliverables) at
  [02-design-r2.md §3.8](02-design-r2.md#L520-L545).
- §4 (sequencing, hard prereqs, disjoint co-edits, no daemon impact)
  at
  [02-design-r2.md §4](02-design-r2.md#L547-L562).
- §6 (round-2 risk delta) at
  [02-design-r2.md §6](02-design-r2.md#L580-L600).

## 3. Round-3 design deltas

### 3.1 Truncation semantics — unchanged

See [02-design-r2.md §3.1](02-design-r2.md#L55-L77). Carried
forward verbatim.

### 3.2 Glob translator — empty-pattern guard removed

The round-2 translator at
[02-design-r2.md §3.2](02-design-r2.md#L108-L110) opened with:

```ts
if (pattern.length === 0) {
  throw new Error("pattern must be non-empty");
}
```

Under the round-3 contract (blocker 2 fix) the handler pre-rejects
non-string and empty patterns at the request boundary and never
calls `globToRegExp` on an empty string. The defence-in-depth guard
is unreachable dead code and is removed. The replacement helper
opens directly with the segment split:

```ts
function globToRegExp(pattern: string): RegExp {
  const segments = pattern.split("/");
  const out: string[] = ["^"];
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const isLast = i === segments.length - 1;
    const isFirst = i === 0;

    if (seg === "**") {
      if (isFirst && isLast) {
        out.push(".*");
        continue;
      }
      if (isFirst) {
        out.push("(?:[^/]+/)*");
        continue;
      }
      if (isLast) {
        out.push(".*");
        continue;
      }
      out.push("(?:[^/]+/)*");
      continue;
    }

    if (seg.includes("**")) {
      throw new Error(
        `'**' must occupy an entire path segment (got '${seg}')`,
      );
    }

    out.push(translateSegment(seg));
    if (!isLast) {
      const next = segments[i + 1];
      if (!(next === "**" && i + 1 < segments.length - 1)) {
        out.push("/");
      } else {
        out.push("/");
      }
    }
  }
  out.push("$");
  return new RegExp(out.join(""));
}
```

`translateSegment` is identical to the round-2 helper at
[02-design-r2.md §3.2](02-design-r2.md#L156-L177) and is not
restated.

The translator's caller contract is now: **the input string is
guaranteed non-empty**. The two failure modes the helper still
raises are syntactic (`'**' must occupy an entire path segment`,
`Unterminated character class`); both surface as `INVALID_PATTERN`
per §3.6.

Translator behaviour matrix (regex match target is
`relative(dir, file)` with forward slashes). Replaces the round-2
matrix at
[02-design-r2.md §3.2](02-design-r2.md#L182-L201). The empty-pattern
row is **removed**; empty pattern is rejected at the handler
boundary with `INVALID_ARGUMENT` per §3.4.

| Pattern | Regex | Matches |
|---|---|---|
| `*.ts` | `^[^/]*\.ts$` | `foo.ts` ✓, `src/foo.ts` ✗ |
| `**/*.ts` | `^(?:[^/]+/)*[^/]*\.ts$` | `foo.ts` ✓, `src/foo.ts` ✓, `a/b/c.ts` ✓ |
| `src/*.ts` | `^src/[^/]*\.ts$` | `src/foo.ts` ✓, `src/a/b.ts` ✗ |
| `src/**/*.ts` | `^src/(?:[^/]+/)*[^/]*\.ts$` | `src/foo.ts` ✓, `src/a/b.ts` ✓ |
| `src/**` | `^src/.*$` | `src/a` ✓, `src/a/b` ✓; `src` alone ✗ |
| `a/**/b.ts` | `^a/(?:[^/]+/)*b\.ts$` | `a/b.ts` ✓, `a/x/b.ts` ✓, `a/x/y/b.ts` ✓ |
| `**` | `^.*$` | every file in the tree |
| `?.ts` | `^[^/]\.ts$` | `a.ts` ✓, `ab.ts` ✗ |
| `[ab].ts` | `^[ab]\.ts$` | `a.ts` ✓, `c.ts` ✗ |
| `foo**bar` | — | `INVALID_PATTERN`: `'**' must occupy an entire path segment` |
| `**foo` | — | `INVALID_PATTERN`: same |
| `foo**` | — | `INVALID_PATTERN`: same |
| `[abc` | — | `INVALID_PATTERN`: `Unterminated character class` |

### 3.3 Schema — unchanged

See
[02-design-r1.md §3.3](02-design-r1.md#L132-L165).

### 3.4 Handler — round-3 version

Replaces the round-2 handler at
[02-design-r2.md §3.4](02-design-r2.md#L211-L411). Two contract
changes from round 2:

1. The root opendir (depth 0) is classified as a **root-level**
   error and never routed to `skipped[]`. ENOENT/ENOTDIR/EACCES/
   EPERM/other-errno on the root all return a structured failure
   envelope.
2. The empty-pattern check at the request boundary is the **only**
   source of empty-pattern rejection; `globToRegExp` no longer
   guards it.

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

  // Helper: map a classifier result on the user-supplied root to a
  // structured failure envelope. ENOTDIR is folded into
  // NOT_A_DIRECTORY for symmetry with the !isDirectory() branch.
  const rootErrorEnvelope = (err: unknown, op: "stat" | "open") => {
    const classified = classifyFsError(err, dir, op);
    if (classified.errno === "ENOTDIR") {
      return {
        error: `NOT_A_DIRECTORY: ${args.directory} is not a directory`,
        code: "NOT_A_DIRECTORY" as const,
        directory: args.directory,
        errno: "ENOTDIR" as const,
      };
    }
    return { ...classified, directory: args.directory };
  };

  let dirStat: Awaited<ReturnType<typeof stat>>;
  try {
    dirStat = await stat(dir);
  } catch (err) {
    return { content: rootErrorEnvelope(err, "stat"), isError: true };
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
  const skipped: Array<{ path: string; code: "PERMISSION_DENIED" | "NOT_FOUND" }> = [];
  let truncatedReason: "results" | "depth" | "time" | null = null;

  // Two distinct terminal-failure shapes, mutually exclusive:
  //  - rootError: structured root-level envelope (classifier-shaped).
  //  - fatalWalkError: READ_DIRECTORY_FAILED on a child subtree.
  // Only one can ever be set; the walk short-circuits on either.
  let rootError: ReturnType<typeof rootErrorEnvelope> | null = null;
  let fatalWalkError:
    | { error: string; code: "READ_DIRECTORY_FAILED"; errno?: string; path: string }
    | null = null;

  const visit = async (current: string, depth: number): Promise<void> => {
    if (truncatedReason !== null || rootError !== null || fatalWalkError !== null) return;
    if (Date.now() > deadline) { truncatedReason = "time"; return; }
    if (depth > MAX_SEARCH_DEPTH) { truncatedReason = "depth"; return; }

    let handle: Awaited<ReturnType<typeof opendir>>;
    try {
      handle = await opendir(current);
    } catch (err) {
      if (depth === 0) {
        // Root opendir failure: the user-supplied directory is not
        // readable. Always escalates to a structured root error;
        // never populates skipped[]. Continuation of the root-stat
        // error table.
        rootError = rootErrorEnvelope(err, "open");
        return;
      }
      // Child subtree: §3.7 policy.
      const classified = classifyFsError(err, current, "open");
      if (classified.code === "PERMISSION_DENIED") {
        skipped.push({ path: current, code: "PERMISSION_DENIED" });
        return;
      }
      if (classified.code === "NOT_FOUND") {
        skipped.push({ path: current, code: "NOT_FOUND" });
        return;
      }
      fatalWalkError = {
        error: `READ_DIRECTORY_FAILED: ${classified.error}`,
        code: "READ_DIRECTORY_FAILED",
        ...(classified.errno ? { errno: classified.errno } : {}),
        path: current,
      };
      return;
    }

    try {
      for await (const entry of handle) {
        if (truncatedReason !== null || rootError !== null || fatalWalkError !== null) return;
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
        if (files.length >= maxResults) {
          truncatedReason = "results";
          return;
        }
        files.push(full);
      }
    } catch (err) {
      // Async-iterator throw after opendir succeeded. At depth 0 the
      // root directory failed mid-iteration; treat as a root-level
      // error (same policy as root opendir). At depth ≥ 1 apply the
      // §3.7 recoverable/unrecoverable split.
      if (depth === 0) {
        rootError = rootErrorEnvelope(err, "open");
        return;
      }
      const classified = classifyFsError(err, current, "read");
      if (classified.code === "PERMISSION_DENIED" || classified.code === "NOT_FOUND") {
        skipped.push({ path: current, code: classified.code });
        return;
      }
      fatalWalkError = {
        error: `READ_DIRECTORY_FAILED: ${classified.error}`,
        code: "READ_DIRECTORY_FAILED",
        ...(classified.errno ? { errno: classified.errno } : {}),
        path: current,
      };
    }
  };

  await visit(dir, 0);

  if (rootError !== null) {
    return { content: rootError, isError: true };
  }
  if (fatalWalkError !== null) {
    return {
      content: { ...fatalWalkError, directory: args.directory },
      isError: true,
    };
  }

  return {
    content: {
      files,
      truncated: truncatedReason !== null,
      truncated_reason: truncatedReason,
      max_results: maxResults,
      max_depth: MAX_SEARCH_DEPTH,
      max_ms: MAX_SEARCH_MS,
      ...(skipped.length > 0 ? { skipped } : {}),
    },
    isError: false,
  };
}
```

Four correctness notes:

- `rootError` and `fatalWalkError` are disjoint by construction:
  `rootError` is only assigned at `depth === 0`, and the very next
  re-entry check in `visit` short-circuits on either set, so a
  later child cannot also set `fatalWalkError`. The handler asserts
  this implicitly by checking `rootError` first.
- The `rootErrorEnvelope` closure captures `dir` (the
  `resolvePath`-normalised path) for `classifyFsError`'s `path`
  argument and `args.directory` (the user's original input) for the
  envelope's `directory` field. This matches the round-2 envelope
  shape exactly.
- A root opendir failure produces a `PERMISSION_DENIED` /
  `NOT_FOUND` / `NOT_A_DIRECTORY` / `IO_ERROR` envelope identical in
  shape to the same code arising from root `stat`. Agents that
  branch on `code` see one consistent table; they need not know
  whether the failure was observed by `stat` or by `opendir`.
- The async-iterator throw at depth 0 is also escalated to a root
  error (not a `skipped` root entry). The reviewer's required fix
  explicitly names `opendir`; round 3 extends the same principle to
  the iterator throw because both observations have the same
  meaning ("the user-supplied root is not traversable") and the
  alternative (root-iterator throw → skipped[root]) would
  reintroduce the dishonest-success shape the reviewer rejected.

### 3.5 Helper reuse — unchanged

See
[02-design-r2.md §3.5](02-design-r2.md#L426-L439).

### 3.6 Structured-error and success envelope — round-3 table

Replaces the round-2 table at
[02-design-r2.md §3.6](02-design-r2.md#L468-L478). Two rows change:

- `INVALID_PATTERN` trigger description no longer mentions empty
  pattern.
- `PERMISSION_DENIED`, `NOT_FOUND`, `NOT_A_DIRECTORY`, and
  `IO_ERROR` triggers now name both root `stat` and root `opendir`
  (and the root iterator throw, which is policy-equivalent).

| Code | Trigger | Envelope fields | Source |
|---|---|---|---|
| `INVALID_ARGUMENT` | `pattern` missing/empty/non-string; `max_results` is not a non-negative integer | `error`, `code`, `directory` | round-1 |
| `INVALID_PATTERN` | `globToRegExp` throws on a non-empty pattern — unterminated `[...]`, `**` mixed inside a segment | `error`, `code`, `directory`, `pattern` | round-1 + §3.2 |
| `NOT_A_DIRECTORY` | Root `stat` or root `opendir` returns `ENOTDIR`, or root `stat` succeeds but `!isDirectory()` | `error`, `code`, `directory`, `errno?` | round-1 + r3 root-`opendir` fold-in |
| `NOT_FOUND` | Root `stat` or root `opendir` returns `ENOENT` | `error`, `code`, `directory`, `errno` | r2 + r3 root-`opendir` fold-in |
| `PERMISSION_DENIED` | Root `stat` or root `opendir` returns `EACCES`/`EPERM`; or the root async iterator throws with the same | `error`, `code`, `directory`, `errno` | r2 + r3 root-`opendir` fold-in |
| `IO_ERROR` | Root `stat` or root `opendir` returns any other errno; or the root async iterator throws with the same | `error`, `code`, `directory`, `errno?` | r2 + r3 root-`opendir` fold-in |
| `READ_DIRECTORY_FAILED` | **Child** `opendir` (depth ≥ 1) or **child** async-iterator throw with an unrecoverable errno (classifier maps to `IO_ERROR` or `NOT_A_FILE`) | `error`, `code`, `directory`, `path`, `errno?` | r2 + r3 depth-clamp |

`code` is the stable machine-readable string agents branch on.
`errno` is operator-facing diagnostic context. The envelope shape
`{ content: { error, code, ...context }, isError: true }` continues
to match G31 r3's contract at
[../G31/02-design-r3.md](../G31/02-design-r3.md#L19-L46).

Success envelope — unchanged from r2:

```ts
{
  files: string[],
  truncated: boolean,
  truncated_reason: "results" | "depth" | "time" | null,
  max_results: number,
  max_depth: number,
  max_ms: number,
  skipped?: Array<{ path: string; code: "PERMISSION_DENIED" | "NOT_FOUND" }>,
}
```

### 3.7 Per-entry failure policy — scope clamped to depth ≥ 1

Replaces the round-2 table at
[02-design-r2.md §3.7](02-design-r2.md#L498-L518). The behavioural
matrix is unchanged; round 3 only clarifies that the policy applies
to **child** traversal (depth ≥ 1). Root traversal (depth 0) is
governed by the §3.6 root-error table.

| Failure class (depth ≥ 1 only) | Errnos | Policy | Envelope effect |
|---|---|---|---|
| Recoverable subtree | `EACCES`, `EPERM` | Skip subtree, continue | `skipped[i] = { path, code: "PERMISSION_DENIED" }` |
| Recoverable subtree (race) | `ENOENT`, `ENOTDIR` | Skip subtree, continue | `skipped[i] = { path, code: "NOT_FOUND" }` |
| Unrecoverable | Everything else (`EMFILE`, `ENFILE`, `EIO`, `ELOOP`, …) | Abort walk; discard partial result | `isError: true`, `code: "READ_DIRECTORY_FAILED"`, `path` names the offending subtree |

At depth 0 every one of these errnos instead maps via §3.6:
`EACCES`/`EPERM` → `PERMISSION_DENIED`; `ENOENT` → `NOT_FOUND`;
`ENOTDIR` → `NOT_A_DIRECTORY`; anything else → `IO_ERROR`. The root
never appears in `skipped[]` and never produces
`READ_DIRECTORY_FAILED`.

Rationale (delta over r2): the recoverable/unrecoverable split is a
**traversal-policy** decision designed to keep a partial-success
search honest when a deep subtree fails. The root is not a subtree
under traversal — it is the search request itself. Folding root
failure into the policy table conflated two different boundaries.

### 3.8 No-sync-fs guard — unchanged

See
[02-design-r2.md §3.8](02-design-r2.md#L520-L545).

## 4. Sequencing — unchanged

See
[02-design-r2.md §4](02-design-r2.md#L547-L562).

## 5. Test gates (round-3 summary)

Replaces the round-2 summary at
[02-design-r2.md §5](02-design-r2.md#L565-L578). Two list items
change: the glob-rejection list no longer mentions empty pattern,
and a new root-opendir item is added. The full test plan is in
[03-plan-r3.md §5](03-plan-r3.md).

Round-3 must-pass gates at the design layer:

- `search_files` happy path: top-level `*.ts`, recursive `**/*.ts`,
  directory-anchored `src/*.ts`, prefix `src/**`, bare `**`,
  character class `[ab].ts`, `?` metachar, `a/**/b.ts` pattern.
- Argument rejection (`INVALID_ARGUMENT`): empty pattern,
  non-string pattern, `max_results: -1`, `max_results: 1.5`.
- Glob rejection (`INVALID_PATTERN`): `foo**bar`, `**foo`, `foo**`,
  `[abc` (unterminated class). Empty pattern is **not** listed here;
  it is rejected upstream with `INVALID_ARGUMENT`.
- Root error: root `stat` `ENOENT` → `NOT_FOUND`; root `stat`
  `EACCES` → `PERMISSION_DENIED`; root `stat` returns a file →
  `NOT_A_DIRECTORY`; **root `opendir` `EACCES`** (after a successful
  `stat`) → `PERMISSION_DENIED`; **root `opendir` `ENOENT`**
  (deletion race) → `NOT_FOUND`; **root `opendir` `EMFILE`** →
  `IO_ERROR`. The three root-`opendir` rows are the regression guard
  for [04-review-r2.md](04-review-r2.md#L19-L31). None of these may
  return `isError: false` or populate `skipped[]`.
- Truncation: every row of the §3.1 matrix (zero, under-boundary,
  exact-boundary, over-boundary) covered. Exact-boundary asserts
  `truncated: false` — the round-1 regression the reviewer flagged.
- Per-entry failure policy (depth ≥ 1): permission-denied subtree
  mid-walk appears in `skipped`; deletion-race `ENOENT` mid-walk
  appears in `skipped`; an injected non-recoverable errno surfaces
  `READ_DIRECTORY_FAILED` and aborts the walk.
- No-subprocess regression: G32-specific assertion (no
  `execFile("find", …)`) plus the post-G30 no-sync-fs scanner test
  remains green.

## 6. Risks — unchanged

See
[02-design-r2.md §6](02-design-r2.md#L580-L600). Round 3 adds no new
risks; both fixes are local contract clarifications that delete code
rather than add it (empty-pattern guard removed; root-`opendir`
branch replaces a routed-through-policy branch of the same length).
