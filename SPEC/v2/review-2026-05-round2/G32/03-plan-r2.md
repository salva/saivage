# G32 — Plan r2

**Finding**: [../G32-builtins-search-files-find-subprocess.md](../G32-builtins-search-files-find-subprocess.md)

**Analysis**: [01-analysis-r2.md](01-analysis-r2.md)

**Design**: [02-design-r2.md](02-design-r2.md)

**Round 1 baseline**: [03-plan-r1.md](03-plan-r1.md)

**Round 1 review**: [04-review-r1.md](04-review-r1.md)

**Writer**: Claude Opus 4.7 (round 2)

Round 2 supersedes [03-plan-r1.md](03-plan-r1.md). The structural
shape (config, module caps, imports, helpers, schema, handler,
register-wiring, tests, build/lint, redeploy, rollback, exit
criteria) carries over; round 2 rewrites the sequencing, helper-reuse,
truncation tests, glob tests, and per-entry-error tests to match
[02-design-r2.md](02-design-r2.md).

## 1. Pre-flight

1. **Confirm G30 has merged.**
   - `git log --oneline | grep -i G30` shows the G30 implementation
     commit.
   - [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts) imports
     `opendir`, `open`, `stat` from `node:fs/promises` (G30 baseline)
     and contains zero sync-fs identifiers from
     [src/testing/noSyncFsScanner.ts](../../../../src/testing/noSyncFsScanner.ts)'s
     `*Sync` set.
   - [src/mcp/no-sync-fs.test.ts](../../../../src/mcp/no-sync-fs.test.ts)
     exists (G30's consumer test) and passes against the post-G30
     `builtins.ts`. The reviewer's concern at
     [04-review-r1.md](04-review-r1.md#L75-L82) is satisfied by this
     dependency rather than by a workaround.
2. **Confirm G31 has merged.** Round 2 makes G31 a **hard prerequisite**
   (see [02-design-r2.md §4.1](02-design-r2.md)).
   - `parseNonNegativeInt` is declared once in
     [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts) (G31 r2's
     helper).
   - `classifyFsError` is declared once in
     [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts) (G31 r3's
     helper).
   - No "G32: dedup once G31 lands" comments anywhere in the file.
3. **Re-anchor every line reference in
   [02-design-r2.md](02-design-r2.md) against the post-G30+G31 file.**
   The pre-G30 anchors carried over from round 1 are: L29 (subprocess
   imports), L39-L43 (module-level caps), L74-L80
   (`parseHttpUrl`-adjacent helpers), L262-L271 (`search_files`
   schema), L310-L327 (handler body), L918 (`execFileAsync` for git,
   must remain), L1077-L1080 (register-time wiring). Expect downward
   drift from G30's mkdir-hoist/settled-flag edits and from G31's
   `parseNonNegativeInt` + `classifyFsError` insertions.
4. **Capture the green baseline.**
   ```bash
   pnpm vitest run \
     src/mcp/builtins.test.ts \
     src/mcp/no-sync-fs.test.ts \
     src/mcp/fsGuard.test.ts
   ```

## 2. Sequencing

### 2.1 Hard prerequisites

- **G30** — [../G30/APPROVED.md](../G30/APPROVED.md). Provides the
  `fs/promises` baseline, the
  [src/testing/noSyncFsScanner.ts](../../../../src/testing/noSyncFsScanner.ts)
  helper, and the
  [src/mcp/no-sync-fs.test.ts](../../../../src/mcp/no-sync-fs.test.ts)
  consumer test.
- **G31** — promoted from soft to hard. Provides
  `parseNonNegativeInt` (G31 r2) and `classifyFsError` (G31 r3).
  No local duplicates in G32.

### 2.2 Disjoint co-edits in the same file

| Finding | Edit range in builtins.ts | Conflict surface with G32 |
|---|---|---|
| G33 web_search | ~L743-L770 | None |
| G34 fetch_url cap | ~L820-L860 | None substantive; possible rebase touch on `node:fs/promises` import line |
| G35 SECRET_ENV_PATTERNS | L416-L432 | None |

G32 may merge in any order with respect to G33/G34/G35.

### 2.3 No daemon impact

Unchanged from [03-plan-r1.md §2.4](03-plan-r1.md). Pure in-process
change; service restarts in §7 are the only deploy step.

## 3. Implementation steps

Each step is an atomic edit verifiable by `grep` from the terminal
(not `read_file`), per the recorded VS Code stale-buffer guidance.

### Step 1 — Config schema

File: [src/config.ts](../../../../src/config.ts). Unchanged from
[03-plan-r1.md §3 Step 1](03-plan-r1.md). Inside the `mcp` block at
[src/config.ts](../../../../src/config.ts#L137-L147), append after
`maxDownloadBytes` (and after any G31 r2 `maxFileReadBytes`):

```ts
maxSearchResults: z.number().int().min(0).default(1_000),
maxSearchDepth: z.number().int().positive().default(20),
maxSearchMs: z.number().int().positive().default(10_000),
```

Round-2 deviation: `maxSearchResults` is `.min(0)` rather than
`.positive()` so the config admits zero as a valid value (matches
the per-call `max_results: 0` semantics fixed in
[02-design-r2.md §3.1](02-design-r2.md)). `maxSearchDepth` and
`maxSearchMs` remain `.positive()` — zero values for those would
make the tool trivially useless.

Verify: `grep -n 'maxSearchResults\|maxSearchDepth\|maxSearchMs'
src/config.ts` → three hits.

### Step 2 — Module-level caps

File: [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts).
Unchanged from [03-plan-r1.md §3 Step 2](03-plan-r1.md). After the
`MAX_DOWNLOAD_BYTES` declaration, add:

```ts
let MAX_SEARCH_RESULTS = 1_000;
let MAX_SEARCH_DEPTH = 20;
let MAX_SEARCH_MS = 10_000;
```

Verify: `grep -nc 'MAX_SEARCH_' src/mcp/builtins.ts` → at least six
(three lets plus uses inside the handler).

### Step 3 — Imports

File: [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts).

The post-G30+G31 import line for `node:fs/promises` already exports
`stat`, `open`, and a `readFile`/`writeFile`/`mkdir`/`readdir` set
(per G30's plan). Append `opendir` to that import if it is not
already present. Do **not** remove `execFile`, `promisify`, or
`execFileAsync` — the git handler at
[src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L918) still
needs them.

Verify: `grep -n "from \"node:fs/promises\"" src/mcp/builtins.ts`
returns the post-G31 import line and it contains `opendir`.

### Step 4 — Local helpers

File: [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts).

Insert `globToRegExp` (and its `translateSegment` companion) after
`parseHttpUrl` per [02-design-r2.md §3.2](02-design-r2.md). G32 does
**not** declare `parseNonNegativeInt` or `classifyFsError` — both
are reused from G31 (pre-flight step 2).

Verify:

- `grep -nc 'function globToRegExp' src/mcp/builtins.ts` → 1.
- `grep -nc 'function translateSegment' src/mcp/builtins.ts` → 1.
- `grep -nc 'function parseNonNegativeInt' src/mcp/builtins.ts` → 1
  (declared by G31, not re-declared here).
- `grep -nc 'function classifyFsError' src/mcp/builtins.ts` → 1
  (declared by G31, not re-declared here).
- `grep -n 'G32: dedup\|G32 dedup' src/mcp/builtins.ts` → 0 hits.

### Step 5 — Schema and handler

File: [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts).

Replace the `search_files` schema entry (post-G30+G31 anchor; round 1
pre-G30 anchor was L262-L271) with the block from
[02-design-r1.md §3.3](02-design-r1.md#L132-L165) (unchanged in
round 2).

Replace the `case "search_files":` body (post-G30+G31 anchor; round 1
pre-G30 anchor was L310-L327) with the round-2 handler at
[02-design-r2.md §3.4](02-design-r2.md).

Verify:

- `grep -n 'execFile.*"find"' src/mcp/builtins.ts` → 0 hits.
- `grep -n 'truncated_reason' src/mcp/builtins.ts` → at least 1 hit.
- `grep -n '"READ_DIRECTORY_FAILED"' src/mcp/builtins.ts` → at least
  1 hit.
- `grep -nc '"search_files"' src/mcp/builtins.ts` → 1 (schema entry).
- `grep -n 'classifyFsError(err' src/mcp/builtins.ts` → at least 3
  hits (stat root, opendir child, async-iterator catch).

### Step 6 — Wire config

File: [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts).

Inside `registerBuiltinServices` (post-G30+G31 anchor; round 1
pre-G30 anchor was L1077-L1080), after the last existing
`mcpConfig.*` assignment, add:

```ts
MAX_SEARCH_RESULTS = mcpConfig.maxSearchResults;
MAX_SEARCH_DEPTH = mcpConfig.maxSearchDepth;
MAX_SEARCH_MS = mcpConfig.maxSearchMs;
```

Verify: `grep -nc 'mcpConfig.maxSearch' src/mcp/builtins.ts` → 3.

## 4. Sibling-parity audit (after step 6)

```bash
grep -n 'mcpConfig\.\(maxOutputBytes\|maxFetchChars\|maxDownloadBytes\|maxSearchResults\|maxSearchDepth\|maxSearchMs\|maxFileReadBytes\|shellTimeoutFloorMs\)' src/mcp/builtins.ts
```

Every hit must live inside `registerBuiltinServices` in a single
contiguous block. Drift is rejected at review.

## 5. Tests

File: [src/mcp/builtins.test.ts](../../../../src/mcp/builtins.test.ts).

Add a new `describe("search_files", () => { … })` block after the
filesystem block at
[src/mcp/builtins.test.ts](../../../../src/mcp/builtins.test.ts#L68-L77).

### 5.1 Schema and catalogue

- `search_files` appears in `runtime.getAllTools()` with the new
  schema (`max_results` optional, `directory`/`pattern` required).

### 5.2 Happy path — glob matrix

For each row create the fixture under `projectRoot` and assert the
returned `files` (sorted, after `relative(projectRoot, …)`) matches
the expected set, `truncated === false`, `truncated_reason === null`,
no `skipped` field.

| Pattern | Fixture | Expected matches |
|---|---|---|
| `*.ts` | `a.ts`, `b.txt`, `src/c.ts` | `a.ts` |
| `**/*.ts` | same | `a.ts`, `src/c.ts` |
| `src/*.ts` | `a.ts`, `src/c.ts`, `src/sub/d.ts` | `src/c.ts` |
| `src/**/*.ts` | same | `src/c.ts`, `src/sub/d.ts` |
| `src/**` | `a.ts`, `src/c.ts`, `src/sub/d.ts` | `src/c.ts`, `src/sub/d.ts` |
| `**` | `a.ts`, `src/c.ts` | `a.ts`, `src/c.ts` |
| `a/**/b.ts` | `a/b.ts`, `a/x/b.ts`, `a/x/y/b.ts`, `b.ts` | `a/b.ts`, `a/x/b.ts`, `a/x/y/b.ts` |
| `?.ts` | `a.ts`, `ab.ts` | `a.ts` |
| `[ab].ts` | `a.ts`, `b.ts`, `c.ts` | `a.ts`, `b.ts` |

This expands round 1's six-row matrix at
[03-plan-r1.md §5.2](03-plan-r1.md) to nine rows. The new rows
(`src/**`, bare `**`, `a/**/b.ts`) are the segment-aware contract
the reviewer required at
[04-review-r1.md](04-review-r1.md#L31-L43).

### 5.3 Glob rejection

For each pattern below, expect the runtime to throw with an
`INVALID_PATTERN` substring:

- `foo**bar` — `**` not its own segment.
- `**foo` — same.
- `foo**` — same.
- `[abc` — unterminated character class.
- `""` (empty) — `INVALID_ARGUMENT` (caught by the schema-level
  validation, not by `globToRegExp`).

### 5.4 Truncation envelope — boundary-exact

Covers every row of [02-design-r2.md §3.1](02-design-r2.md) truncation
matrix:

- **Zero matches:** tree has no `*.ts` files; call with default
  caps. Assert `files === []`, `truncated === false`,
  `truncated_reason === null`.
- **`max_results: 0` with at least one match:** tree has 3 matching
  files; call with `max_results: 0`. Assert `files === []`,
  `truncated === true`, `truncated_reason === "results"`.
- **`max_results: 0` with zero matches:** tree has no matching
  files; call with `max_results: 0`. Assert `files === []`,
  `truncated === false`, `truncated_reason === null`.
- **Under-boundary:** tree has 2 matching files, call with
  `max_results: 5`. Assert `files.length === 2`, `truncated ===
  false`.
- **Exact boundary:** tree has 3 matching files, call with
  `max_results: 3`. Assert `files.length === 3`, **`truncated ===
  false`**, `truncated_reason === null`. This is the regression
  guard for [04-review-r1.md](04-review-r1.md#L21-L29).
- **Over-boundary:** tree has 5 matching files, call with
  `max_results: 3`. Assert `files.length === 3`, `truncated ===
  true`, `truncated_reason === "results"`.
- **Depth truncation:** override `mcp.maxSearchDepth` to 2 via
  `loadConfig`; build `a/b/c/leaf.ts` and search `**/*.ts`. Assert
  leaf is **not** returned and `truncated_reason === "depth"`.
- **Time truncation:** override `mcp.maxSearchMs` to 1; create ~200
  `*.ts` files; assert `truncated === false || truncated_reason
  === "time"` (never `"results"` or `"depth"`).

### 5.5 Error envelope (G31-parity)

Each row expects the runtime to throw with the listed substring:

- Empty pattern → `INVALID_ARGUMENT`.
- `max_results: -1` → `INVALID_ARGUMENT`.
- `max_results: 1.5` → `INVALID_ARGUMENT`.
- Pattern `[abc` → `INVALID_PATTERN`.
- `directory` is a file path → `NOT_A_DIRECTORY`.
- `directory` does not exist → `NOT_FOUND`.
- `directory` outside project root → `Path must stay inside` (the
  existing `resolvePath` error; unchanged behaviour).
- Stub `stat` to throw `{ code: "EACCES" }` for one call →
  `PERMISSION_DENIED`.

### 5.6 Per-entry failure policy

- **Permission-denied subtree (real fs).** `chmod(0o000)` a
  directory mid-tree (skip on Windows and when running as root —
  detect via `process.getuid?.() === 0` and `it.skip`). Assert
  sibling matches return, `truncated === false`, and `skipped`
  contains exactly one `{ path, code: "PERMISSION_DENIED" }`
  entry. Restore mode in `afterEach` so `rmSync` cleanup works.
- **Deletion race (ENOENT) mid-walk.** Stub `opendir` so the
  second call rejects with `{ code: "ENOENT" }`. Assert the walk
  completes, `truncated === false`, and `skipped` contains exactly
  one `{ path, code: "NOT_FOUND" }` entry.
- **Unrecoverable EMFILE.** Stub `opendir` so a mid-walk call
  rejects with `{ code: "EMFILE" }`. Assert the runtime throws
  with `READ_DIRECTORY_FAILED` in the message. Assert `files`,
  `skipped`, and `truncated` are **not** present in the failure
  envelope (the partial result is discarded).
- **Async-iterator throw.** Stub the iterator of the second
  `opendir` to reject with `{ code: "EACCES" }` mid-iteration.
  Assert `skipped` contains exactly one
  `{ path, code: "PERMISSION_DENIED" }` entry and `files` contains
  any matches found before the throw.

The four cases together exercise every leg of the §3.7 policy
matrix in [02-design-r2.md](02-design-r2.md).

### 5.7 No-subprocess regression (G32-specific)

Lives in the new `search_files` describe block (not in
[src/mcp/no-sync-fs.test.ts](../../../../src/mcp/no-sync-fs.test.ts),
which is G30's scanner-based test):

```ts
it("no longer shells out to find(1)", async () => {
  const src = await readFile(join(__dirname, "builtins.ts"), "utf-8");
  expect(src).not.toMatch(/execFile.*["']find["']/);
  expect(src).not.toMatch(/execFileAsync.*["']find["']/);
});
```

### 5.8 No-sync-fs invariant (post-G30 cross-check)

Re-run the existing
[src/mcp/no-sync-fs.test.ts](../../../../src/mcp/no-sync-fs.test.ts)
in CI (G30's deliverable). It must remain green: G32 introduces
zero sync-fs identifiers (`opendir` and `stat` come from
`node:fs/promises`, not from `node:fs`).

## 6. Build and lint gates

```bash
pnpm tsc -p tsconfig.json
pnpm vitest run src/mcp/builtins.test.ts \
                src/mcp/no-sync-fs.test.ts \
                src/mcp/fsGuard.test.ts
pnpm vitest run            # full suite, no skips
pnpm build                 # tsup -> dist/
```

All four must be green before merge.

## 7. Daemon redeploy

Pure in-process change. After `pnpm build` produces a new
`dist/cli.js`, the three bind-mounted harnesses pick up the new
bytes via service restart only:

```bash
ssh root@10.0.3.111 systemctl restart saivage.service
ssh root@10.0.3.112 systemctl restart saivage.service
ssh root@10.0.3.113 systemctl restart saivage.service
```

Health probe each:

```bash
for ip in 10.0.3.111 10.0.3.112 10.0.3.113; do
  curl -fsS http://$ip:8080/health || echo "FAIL $ip"
done
```

`saivage-v3-getrich-v2` (10.0.3.170) ships its own v3 binary;
unaffected.

## 8. Rollback

Contained to one source file plus a config schema addition. Rollback
is `git revert <merge-sha>` followed by `pnpm build` and the three
harness restarts in §7. No on-disk state migration; config defaults
backfill missing fields. Because G30 and G31 are hard prerequisites,
they remain in place after a G32 revert without orphaning code paths.

## 9. Exit criteria

1. `grep -n 'execFile.*"find"' src/mcp/builtins.ts` → zero hits.
2. `grep -nc 'function classifyFsError\|function parseNonNegativeInt'
   src/mcp/builtins.ts` → exactly 2 (declared by G31, not by G32).
3. `grep -n 'G32: dedup\|G32 dedup' src/mcp/builtins.ts` → zero hits.
4. New `search_files` tests in §5 all pass, including:
   - Every row of the §3.1 truncation matrix
     ([02-design-r2.md §3.1](02-design-r2.md)).
   - Every row of the §3.2 glob matrix
     ([02-design-r2.md §3.2](02-design-r2.md)).
   - Every leg of the §3.7 per-entry failure policy
     ([02-design-r2.md §3.7](02-design-r2.md)).
5. [src/mcp/no-sync-fs.test.ts](../../../../src/mcp/no-sync-fs.test.ts)
   continues to pass (G30 invariant preserved).
6. The seven `mcpConfig.max*` parameters are wired in a single
   contiguous block inside `registerBuiltinServices` (§4).
7. Three harness health endpoints return 200 after restart.
8. Reviewer sign-off recorded as `APPROVED.md` per the workflow.
