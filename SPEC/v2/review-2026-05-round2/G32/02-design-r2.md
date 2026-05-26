# G32 — Design r2

**Finding**: [../G32-builtins-search-files-find-subprocess.md](../G32-builtins-search-files-find-subprocess.md)

**Analysis**: [01-analysis-r2.md](01-analysis-r2.md) (delta over
[01-analysis-r1.md](01-analysis-r1.md))

**Round 1 baseline**: [02-design-r1.md](02-design-r1.md)

**Round 1 review**: [04-review-r1.md](04-review-r1.md)

**Writer**: Claude Opus 4.7 (round 2)

Round 2 keeps Proposal A as recommended and Proposal B rejected for
the same reasons recorded in [02-design-r1.md §1](02-design-r1.md).
Every section of round 1 not listed below is unchanged and is not
re-stated. Round-2 changes are confined to: §3.4 (handler/walker),
§3.5 (glob translator), §3.6 (structured errors and `skipped`
envelope field), §3.7 (per-entry failure policy), §4 (sequencing).

## 1. Recommendation (unchanged)

**Proposal A** from [02-design-r1.md §1](02-design-r1.md#L13-L52).
Proposal B remains rejected at [02-design-r1.md §1](02-design-r1.md#L54-L84).

## 2. Anchors carried forward unchanged

The following sections of [02-design-r1.md](02-design-r1.md) are
preserved verbatim and are not restated in round 2:

- §3.1 (config-schema additions: `maxSearchResults`,
  `maxSearchDepth`, `maxSearchMs`). See
  [02-design-r1.md §3.1](02-design-r1.md#L105-L114).
- §3.2 (module-level caps + register-time wiring). See
  [02-design-r1.md §3.2](02-design-r1.md#L116-L130).
- §3.8 (default skip set: `.git`, `node_modules`). See
  [02-design-r1.md §3.8](02-design-r1.md#L444-L455).
- §3.9 (symlinks contribute nothing). See
  [02-design-r1.md §3.9](02-design-r1.md#L457-L468).
- §3.10 (deletion list). See
  [02-design-r1.md §3.10](02-design-r1.md#L470-L484).
- §3.11 (public-API impact: schema gains `max_results`; envelope
  shape change). See
  [02-design-r1.md §3.11](02-design-r1.md#L486-L497).

## 3. Round-2 design deltas

### 3.1 Truncation semantics — boundary-exact

The walker's "stop when we have enough" condition is rewritten so
the boundary is exact:

- A candidate match is appended **only if** `files.length <
  maxResults`. The push therefore never crosses the cap.
- `truncated_reason = "results"` is set **only when an
  additional match is discovered after the cap is reached** — i.e.
  the walker encounters a candidate it cannot push because
  `files.length >= maxResults`. At that point the walker stops.

Behavioural matrix (for a tree with `M` matches and request
`max_results: N`):

| `N` vs `M` | `files.length` | `truncated_reason` |
|---|---|---|
| `M === 0` | 0 | `null` |
| `N === 0`, `M > 0` | 0 | `"results"` |
| `N === 0`, `M === 0` | 0 | `null` |
| `N > 0`, `M < N` | `M` | `null` |
| `N > 0`, `M === N` | `N` | `null` |
| `N > 0`, `M > N` | `N` | `"results"` |

The exact-boundary row (`M === N`) is the case round-1 review concern
1 flagged at [04-review-r1.md](04-review-r1.md#L21-L29). The walker
never sees an `(N + 1)`th candidate, so the truncation flag stays
`null` and the envelope is honest.

The `max_results: 0` row uses the new "matches-exist" semantics
recorded in
[01-analysis-r2.md §2.1](01-analysis-r2.md). Tests in
[03-plan-r2.md §5.4](03-plan-r2.md) cover every row.

### 3.2 Glob translator — segment-aware `**`

The round-1 translator at
[02-design-r1.md §3.4](02-design-r1.md#L337-L344) treated any
adjacent `**` as the recursive marker. Round 2 makes `**` a
path-segment operator: the pattern is split on `/`, each segment is
either the literal `**` (the recursive marker) or a sequence of
single-segment glob tokens; any segment that contains `**` mixed
with other characters is rejected.

Replacement helper:

```ts
function globToRegExp(pattern: string): RegExp {
  if (pattern.length === 0) {
    throw new Error("pattern must be non-empty");
  }
  const segments = pattern.split("/");
  const out: string[] = ["^"];
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const isLast = i === segments.length - 1;
    const isFirst = i === 0;

    if (seg === "**") {
      if (isFirst && isLast) {
        // bare "**" — match every relative path, files included.
        out.push(".*");
        continue;
      }
      if (isFirst) {
        // "**/x" — zero or more leading directories.
        out.push("(?:[^/]+/)*");
        continue;
      }
      if (isLast) {
        // "x/**" — match anything beneath x, files included.
        // The trailing slash from the previous join is already in out.
        // We want "x/.*" (matches "x/a", "x/a/b"), and we must NOT also
        // emit a "/" because the previous iteration did.
        out.push(".*");
        continue;
      }
      // "x/**/y" — zero or more intermediate segments. The previous
      // iteration emitted "x/"; we emit "(?:[^/]+/)*" and the next
      // iteration emits "y".
      out.push("(?:[^/]+/)*");
      // Skip the "/" we would otherwise emit after this segment.
      continue;
    }

    if (seg.includes("**")) {
      throw new Error(
        `'**' must occupy an entire path segment (got '${seg}')`,
      );
    }

    out.push(translateSegment(seg));
    if (!isLast) {
      // Join the next segment with "/", unless the next segment is
      // "**" mid-path, which absorbs its leading "/" into the
      // (?:[^/]+/)* group above.
      const next = segments[i + 1];
      if (!(next === "**" && i + 1 < segments.length - 1)) {
        out.push("/");
      } else {
        // mid-path "**" — emit nothing here; the "**" iteration
        // emits "(?:[^/]+/)*", which already covers the slash.
        out.push("/");
      }
    }
  }
  out.push("$");
  return new RegExp(out.join(""));
}

function translateSegment(seg: string): string {
  let out = "";
  let i = 0;
  while (i < seg.length) {
    const c = seg[i];
    if (c === "*") { out += "[^/]*"; i += 1; continue; }
    if (c === "?") { out += "[^/]"; i += 1; continue; }
    if (c === "[") {
      const close = seg.indexOf("]", i + 1);
      if (close === -1) throw new Error("Unterminated character class");
      out += seg.slice(i, close + 1);
      i = close + 1;
      continue;
    }
    if (/[.+^$()|{}\\]/.test(c)) { out += "\\" + c; i += 1; continue; }
    out += c;
    i += 1;
  }
  return out;
}
```

Translator behaviour matrix (regex match target is
`relative(dir, file)` with forward slashes):

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
| `` (empty) | — | `INVALID_PATTERN`: `pattern must be non-empty` |

This replaces the round-1 table at
[02-design-r1.md §3.7](02-design-r1.md#L411-L432). The bare `**`
edge case now matches every file (the round-1 "matches nothing"
behaviour is removed). All other rows in the round-1 matrix retain
their semantics; only `src/**` and bare `**` change, and both
changes are corrections.

### 3.3 Schema — unchanged from round 1

The schema body at
[02-design-r1.md §3.3](02-design-r1.md#L132-L165) is preserved
verbatim. The description text already documents the segment
contract for `**`; no edit is required.

### 3.4 Handler — round-2 version

Replaces the round-1 handler at
[02-design-r1.md §3.4](02-design-r1.md#L167-L312). The new version
uses G31 r3's `classifyFsError` helper for the root-level
filesystem call and applies the per-entry failure policy from §3.7.

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

  let dirStat: Awaited<ReturnType<typeof stat>>;
  try {
    dirStat = await stat(dir);
  } catch (err) {
    const classified = classifyFsError(err, args.directory as string, "stat");
    // ENOTDIR / ENOENT here mean "not a directory" from the user's
    // point of view. The classifier's NOT_FOUND is correct for ENOENT;
    // for ENOTDIR (parent component is a file) we map to NOT_A_DIRECTORY
    // for symmetry with the !isDirectory() branch below.
    if (classified.errno === "ENOTDIR") {
      return {
        content: {
          error: `NOT_A_DIRECTORY: ${args.directory} is not a directory`,
          code: "NOT_A_DIRECTORY",
          directory: args.directory,
          errno: "ENOTDIR",
        },
        isError: true,
      };
    }
    return {
      content: { ...classified, directory: args.directory },
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
  const skipped: Array<{ path: string; code: "PERMISSION_DENIED" | "NOT_FOUND" }> = [];
  let truncatedReason: "results" | "depth" | "time" | null = null;
  let fatalWalkError: { error: string; code: "READ_DIRECTORY_FAILED"; errno?: string; path: string } | null = null;

  const visit = async (current: string, depth: number): Promise<void> => {
    if (truncatedReason !== null || fatalWalkError !== null) return;
    if (Date.now() > deadline) { truncatedReason = "time"; return; }
    if (depth > MAX_SEARCH_DEPTH) { truncatedReason = "depth"; return; }

    let handle: Awaited<ReturnType<typeof opendir>>;
    try {
      handle = await opendir(current);
    } catch (err) {
      const classified = classifyFsError(err, current, "open");
      // Mid-walk root: the user-supplied directory was already validated
      // above. A failure here is on a child subtree and is classified
      // per §3.7.
      if (classified.code === "PERMISSION_DENIED") {
        skipped.push({ path: current, code: "PERMISSION_DENIED" });
        return;
      }
      if (classified.code === "NOT_FOUND") {
        // ENOENT / ENOTDIR mid-walk: deletion/rename race. Skip.
        skipped.push({ path: current, code: "NOT_FOUND" });
        return;
      }
      // IO_ERROR or NOT_A_FILE (EISDIR-inversion is impossible on opendir):
      // unrecoverable. Abort the walk.
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
        if (truncatedReason !== null || fatalWalkError !== null) return;
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

        // Truncation gate: enforce the cap BEFORE pushing so the
        // boundary is exact. See §3.1.
        if (files.length >= maxResults) {
          truncatedReason = "results";
          return;
        }
        files.push(full);
      }
    } catch (err) {
      // Async-iterator throw after opendir succeeded — classify the same
      // way as opendir itself; PERMISSION_DENIED / NOT_FOUND become
      // skipped entries on the current subtree, IO_ERROR escalates.
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
    // opendir's async iterator auto-closes on completion or break.
  };

  await visit(dir, 0);

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

Three correctness notes for the snippet:

- The truncation gate at `if (files.length >= maxResults)` runs
  before every `files.push`. For `maxResults: 0` the first matching
  entry triggers the gate immediately; the envelope reports zero
  results and `truncated_reason: "results"`. For exact boundary
  (`M === N`) the gate never triggers because the walk runs out of
  candidates after the `N`th push.
- `fatalWalkError` is sticky: once set, every active `visit` frame
  short-circuits on its first re-entry check and the walk unwinds
  without further filesystem calls.
- `skipped` is emitted only when non-empty so the success envelope
  stays unchanged for the common case. This is a non-breaking
  superset of the round-1 envelope (round 1 already retired the
  plain `{ files }` shape under the no-back-compat rule).

### 3.5 Helper reuse — no temporary duplication

Both `parseNonNegativeInt` and `classifyFsError` are imported by
reference from G31's edits:

- `parseNonNegativeInt` is the helper introduced by G31 r2 at
  [../G31/02-design-r2.md](../G31/02-design-r2.md#L317-L329).
- `classifyFsError` is the helper introduced by G31 r3 at
  [../G31/02-design-r3.md](../G31/02-design-r3.md#L48-L99).

Round 2 promotes G31 from "soft prerequisite" to **hard
prerequisite** (see §4). G32 does not declare a local copy of
either helper; it does not annotate any helper with a "dedup once
G31 lands" comment. The migration-shim policy is satisfied by
sequencing, not by code-level shims.

### 3.6 Structured-error and success envelope — full contract

Error codes emitted by `search_files`:

| Code | Trigger | Envelope fields | Source |
|---|---|---|---|
| `INVALID_ARGUMENT` | `pattern` missing/empty/non-string; `max_results` is not a non-negative integer | `error`, `code`, `directory` | round-1 |
| `INVALID_PATTERN` | `globToRegExp` throws — unterminated `[...]`, `**` mixed inside a segment, empty pattern (defence-in-depth; schema rejects first) | `error`, `code`, `directory`, `pattern` | round-1 + §3.2 |
| `NOT_A_DIRECTORY` | `stat(dir)` returns `ENOTDIR`, or succeeds but `!isDirectory()` | `error`, `code`, `directory`, `errno?` | round-1 + r2 ENOTDIR fold-in |
| `NOT_FOUND` | `stat(dir)` returns `ENOENT` | `error`, `code`, `directory`, `errno` | r2 (via G31 classifier) |
| `PERMISSION_DENIED` | `stat(dir)` returns `EACCES`/`EPERM` | `error`, `code`, `directory`, `errno` | r2 (via G31 classifier) |
| `IO_ERROR` | `stat(dir)` returns any other errno | `error`, `code`, `directory`, `errno?` | r2 (via G31 classifier) |
| `READ_DIRECTORY_FAILED` | Mid-walk `opendir(child)` or async-iterator throw with an unrecoverable errno (anything that the classifier maps to `IO_ERROR` or to `NOT_A_FILE`) | `error`, `code`, `directory`, `path`, `errno?` | r2 |

`code` is always a stable machine-readable string. `errno` is
operator-facing diagnostic context; agents branch on `code`. The
envelope shape `{ content: { error, code, ...context }, isError:
true }` matches G31 r3's exhaustive contract at
[../G31/02-design-r3.md](../G31/02-design-r3.md#L19-L46).

Success envelope:

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

`skipped` is operator-facing: an agent that pushed through a
permission-denied subtree may still want to know which paths were
silently passed over. `truncated` and `truncated_reason` continue
to be the primary "is this answer complete" affordance.

### 3.7 Per-entry failure policy

Three classes of mid-walk failure, each with a deterministic outcome:

| Failure class | Errnos | Policy | Envelope effect |
|---|---|---|---|
| Recoverable subtree | `EACCES`, `EPERM` | Skip subtree, continue | `skipped[i] = { path, code: "PERMISSION_DENIED" }` |
| Recoverable subtree (race) | `ENOENT`, `ENOTDIR` | Skip subtree, continue | `skipped[i] = { path, code: "NOT_FOUND" }` |
| Unrecoverable | Everything else (`EMFILE`, `ENFILE`, `EIO`, `ELOOP`, …) | Abort walk; discard partial result | `isError: true`, `code: "READ_DIRECTORY_FAILED"`, `path` names the offending subtree |

This is a deliberate divergence from G31 r3's single-path policy.
G31 classifies all errors symmetrically because a single-file read
either succeeds or fails as a unit. G32 walks a tree, so the
recoverable subset is wider: a permission-denied subtree under a
50-file project is a routine outcome and must not erase the other
49 matches. The unrecoverable class is narrower than G31's `IO_ERROR`
because we *do* want truly bad filesystem state (file-handle
exhaustion, device errors, symlink loops) to surface a failure
envelope rather than be quietly skipped. The split is justified by
the difference in tool shape, not by relaxing G31's policy.

The reviewer concern at
[04-review-r1.md](04-review-r1.md#L45-L57) is addressed by:

- Naming the `READ_DIRECTORY_FAILED` code explicitly (§3.6 table).
- Defining the recoverable/unrecoverable split (this section).
- Testing every failure-policy branch (see
  [03-plan-r2.md §5.6](03-plan-r2.md)), not only the
  permission-denied happy path.

### 3.8 No-sync-fs guard — anchor to G30's actual deliverable

The post-G30 tree has two G30-shipped files relevant to the no-sync
guard:

- [src/testing/noSyncFsScanner.ts](../../../../src/testing/noSyncFsScanner.ts)
  — dependency-free scanner exported as `scanForSyncFs`. See
  [../G30/APPROVED.md](../G30/APPROVED.md#L7).
- [src/mcp/no-sync-fs.test.ts](../../../../src/mcp/no-sync-fs.test.ts)
  — the consumer test G30's plan creates at
  [../G30/03-plan-r2.md](../G30/03-plan-r2.md#L212-L244).

Round 1's plan referenced the test consumer; the reviewer is correct
that the file is absent from the pre-G30 live checkout
([04-review-r1.md](04-review-r1.md#L75-L82)). Because G32 hard-depends
on G30 (§4), the file exists at G32's merge time. The round-2 plan
records that dependency explicitly and treats the guard as a
post-merge check, not a pre-flight check on the pre-G30 tree.

The G32-specific "no `find(1)` subprocess" assertion remains a
separate test ([03-plan-r2.md §5.7](03-plan-r2.md)) because the
no-sync scanner only detects `node:fs` sync identifiers — it does
not prove the absence of an `execFile` invocation pointed at the
host `find` binary.

## 4. Sequencing (round-2 revision)

### 4.1 Hard prerequisites

1. **G30** — async fs baseline. The post-G30 handler is already
   async and imports `node:fs/promises`; round 2 reuses both. G30
   also ships the no-sync scanner and its consumer test referenced
   in §3.8.
2. **G31** — promoted from soft to hard. G32 reuses two G31 helpers
   (`parseNonNegativeInt` from G31 r2, `classifyFsError` from
   G31 r3); declaring local duplicates would be a migration shim.
   Per [01-analysis-r2.md §2.4](01-analysis-r2.md), the
   architecture-first option is to hard-sequence G31 ahead of G32.

### 4.2 Disjoint co-edits in the same file

| Finding | Edit range in builtins.ts | Conflict surface with G32 |
|---|---|---|
| G33 web_search regex | ~L743-L770 | None |
| G34 fetch_url cap | ~L820-L860 | None substantive; possible rebase touch on the `node:fs/promises` import line if G34 adds streaming I/O |
| G35 `SECRET_ENV_PATTERNS` | L416-L432 | None |

G32 may merge in any order with respect to G33/G34/G35.

### 4.3 No daemon impact

Unchanged from [02-design-r1.md §4 item 4](02-design-r1.md#L529-L532).
Pure in-process change; no systemd or LXC edits.

## 5. Test gates (round-2 summary)

The full test plan is in [03-plan-r2.md §5](03-plan-r2.md). Round-2
must-pass gates at the design layer:

- `search_files` happy path: top-level `*.ts`, recursive `**/*.ts`,
  directory-anchored `src/*.ts`, prefix `src/**`, bare `**`,
  character class `[ab].ts`, `?` metachar, `a/**/b.ts` pattern.
- Glob rejection: `foo**bar`, `**foo`, `foo**`, empty pattern — all
  return `INVALID_PATTERN`.
- Truncation: every row of the §3.1 matrix (zero, under-boundary,
  exact-boundary, over-boundary) covered. Exact-boundary asserts
  `truncated: false` — the round-1 regression the reviewer flagged.
- Per-entry failure policy: permission-denied subtree mid-walk
  appears in `skipped`; deletion-race ENOENT mid-walk appears in
  `skipped`; an injected non-recoverable errno surfaces
  `READ_DIRECTORY_FAILED` and aborts the walk.
- No-subprocess regression: G32-specific assertion (no
  `execFile("find", …)`) plus the post-G30 no-sync-fs scanner test
  remains green.

## 6. Risks (delta from round 1)

The risks in [02-design-r1.md §5](02-design-r1.md) carry forward.
New risks introduced by round 2:

1. **Hard-prereq chain G30 → G31 → G32 stretches merge cadence.**
   Accepted trade-off (see [01-analysis-r2.md §2.4](01-analysis-r2.md)).
   The alternative — a shared helper module landed in either G31 or
   G32's PR — was rejected because no third consumer is in flight.
2. **`READ_DIRECTORY_FAILED` test requires an `opendir` stub.**
   Mirrors G31 r3's `IO_ERROR` stub at
   [../G31/02-design-r3.md](../G31/02-design-r3.md#L211-L216).
   Scoped to one `it()` block via Vitest's `vi.spyOn`. Accepted.
3. **`skipped` envelope field is operator-facing only.** Agents are
   not contracted to read it. If a future agent workflow needs to
   distinguish "no matches" from "no matches in the searchable
   subtree", the field is already there. No commitment to the agent
   contract is made.
