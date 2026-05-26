# G32 — Plan r3

**Finding**: [../G32-builtins-search-files-find-subprocess.md](../G32-builtins-search-files-find-subprocess.md)

**Analysis**: [01-analysis-r3.md](01-analysis-r3.md)

**Design**: [02-design-r3.md](02-design-r3.md)

**Round 1 baseline**: [03-plan-r1.md](03-plan-r1.md)

**Round 2 baseline**: [03-plan-r2.md](03-plan-r2.md)

**Round 2 review**: [04-review-r2.md](04-review-r2.md)

**Writer**: Claude Opus 4.7 (round 3)

Round 3 supersedes [03-plan-r2.md](03-plan-r2.md). All sections of
round 2 not listed below carry over verbatim. Round-3 changes are
confined to: §3 Step 4 (translator dead-code removal), §3 Step 5
(handler replacement points at the round-3 snippet and a new
verification line), §5.3 (glob-rejection test list), §5.5 (error
envelope test list), §5.6 (per-entry failure-policy clamp + new
root-opendir tests), and §9 exit criteria.

## 1. Pre-flight — unchanged

See [03-plan-r2.md §1](03-plan-r2.md#L17-L48). Same four steps
(confirm G30 merged, confirm G31 merged, re-anchor against the
post-G30+G31 file, capture the green baseline).

## 2. Sequencing — unchanged

See [03-plan-r2.md §2](03-plan-r2.md#L50-L80).

## 3. Implementation steps

Each step remains an atomic edit verifiable by `grep` from the
terminal (not by `read_file`), per the recorded VS Code
stale-buffer guidance in the workspace memory.

### Step 1 — Config schema — unchanged

See [03-plan-r2.md §3 Step 1](03-plan-r2.md#L84-L102).

### Step 2 — Module-level caps — unchanged

See [03-plan-r2.md §3 Step 2](03-plan-r2.md#L104-L116).

### Step 3 — Imports — unchanged

See [03-plan-r2.md §3 Step 3](03-plan-r2.md#L118-L129).

### Step 4 — Local helpers (round-3 delta)

File: [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts).

Insert `globToRegExp` (and its `translateSegment` companion) after
`parseHttpUrl` per
[02-design-r3.md §3.2](02-design-r3.md). The round-3 `globToRegExp`
**omits** the leading `if (pattern.length === 0) throw …` guard that
appeared in [02-design-r2.md §3.2](02-design-r2.md#L108-L110); the
handler rejects empty patterns at the request boundary so the guard
is unreachable.

G32 does **not** declare `parseNonNegativeInt` or `classifyFsError`
— both are reused from G31 (pre-flight step 2).

Verify (terminal `grep` only, never `read_file`):

- `grep -nc 'function globToRegExp' src/mcp/builtins.ts` → 1.
- `grep -nc 'function translateSegment' src/mcp/builtins.ts` → 1.
- `grep -n 'pattern must be non-empty' src/mcp/builtins.ts` → 1
  (the handler-level rejection in Step 5), not 2. A second hit
  indicates the dead guard from round 2 was retained.
- `grep -nc 'function parseNonNegativeInt' src/mcp/builtins.ts` → 1
  (declared by G31, not re-declared here).
- `grep -nc 'function classifyFsError' src/mcp/builtins.ts` → 1
  (declared by G31, not re-declared here).
- `grep -n 'G32: dedup\|G32 dedup' src/mcp/builtins.ts` → 0 hits.

### Step 5 — Schema and handler (round-3 delta)

File: [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts).

Replace the `search_files` schema entry (post-G30+G31 anchor; round 1
pre-G30 anchor was L262-L271) with the block from
[02-design-r1.md §3.3](02-design-r1.md#L132-L165) (unchanged across
rounds).

Replace the `case "search_files":` body (post-G30+G31 anchor;
round 1 pre-G30 anchor was L310-L327) with the **round-3** handler
at [02-design-r3.md §3.4](02-design-r3.md). The round-3 snippet
differs from the round-2 snippet at
[02-design-r2.md §3.4](02-design-r2.md#L211-L411) in three places:

1. A new `rootErrorEnvelope(err, op)` closure that funnels both root
   `stat` and root `opendir` failures through a single classifier
   call.
2. Inside `visit`, the `opendir` catch branches on `depth === 0`
   and assigns to a new `rootError` slot rather than to `skipped[]`
   or `fatalWalkError`.
3. Inside `visit`, the async-iterator catch likewise branches on
   `depth === 0` and assigns to `rootError`. At depth ≥ 1 the
   round-2 recoverable-vs-unrecoverable policy is preserved.

Verify (terminal `grep` only):

- `grep -n 'execFile.*"find"' src/mcp/builtins.ts` → 0 hits.
- `grep -n 'truncated_reason' src/mcp/builtins.ts` → at least 1
  hit.
- `grep -n '"READ_DIRECTORY_FAILED"' src/mcp/builtins.ts` → at
  least 1 hit.
- `grep -nc '"search_files"' src/mcp/builtins.ts` → 1 (schema
  entry).
- `grep -n 'rootErrorEnvelope' src/mcp/builtins.ts` → at least 4
  hits (declaration + root `stat` catch + root `opendir` branch +
  root iterator-throw branch).
- `grep -n 'depth === 0' src/mcp/builtins.ts` → at least 2 hits
  (opendir catch + iterator catch).
- `grep -n 'classifyFsError(err' src/mcp/builtins.ts` → at least 3
  hits (root-stat path via `rootErrorEnvelope`, child opendir,
  child iterator).

### Step 6 — Wire config — unchanged

See [03-plan-r2.md §3 Step 6](03-plan-r2.md#L188-L201).

## 4. Sibling-parity audit — unchanged

See [03-plan-r2.md §4](03-plan-r2.md#L203-L211).

## 5. Tests

File: [src/mcp/builtins.test.ts](../../../../src/mcp/builtins.test.ts).

Add a new `describe("search_files", () => { … })` block after the
filesystem block at
[src/mcp/builtins.test.ts](../../../../src/mcp/builtins.test.ts#L68-L77).

### 5.1 Schema and catalogue — unchanged

See [03-plan-r2.md §5.1](03-plan-r2.md#L223-L227).

### 5.2 Happy path — unchanged

See [03-plan-r2.md §5.2](03-plan-r2.md#L229-L250).

### 5.3 Glob rejection (round-3 delta — empty-pattern row moved out)

Replaces [03-plan-r2.md §5.3](03-plan-r2.md#L252-L264). For each
pattern below, expect the runtime to throw with an
`INVALID_PATTERN` substring:

- `foo**bar` — `**` not its own segment.
- `**foo` — same.
- `foo**` — same.
- `[abc` — unterminated character class.

The empty-pattern case is **not** in this list. It is exercised in
§5.5 as an `INVALID_ARGUMENT` rejection, matching the
single-sourced contract in
[02-design-r3.md §3.6](02-design-r3.md). A regression test that
asserts `expect(error).toMatch(/INVALID_PATTERN/)` for the empty
pattern would now fail by design.

### 5.4 Truncation envelope — unchanged

See [03-plan-r2.md §5.4](03-plan-r2.md#L266-L290).

### 5.5 Error envelope (G31-parity, round-3 delta)

Replaces [03-plan-r2.md §5.5](03-plan-r2.md#L292-L305). Each row
expects the runtime to throw with the listed substring:

- Empty pattern → `INVALID_ARGUMENT` (regression guard for blocker
  2).
- `pattern` missing → `INVALID_ARGUMENT`.
- `pattern` is a number → `INVALID_ARGUMENT`.
- `max_results: -1` → `INVALID_ARGUMENT`.
- `max_results: 1.5` → `INVALID_ARGUMENT`.
- Pattern `[abc` → `INVALID_PATTERN`.
- `directory` is a file path → `NOT_A_DIRECTORY`.
- `directory` does not exist → `NOT_FOUND`.
- `directory` outside project root → `Path must stay inside` (the
  existing `resolvePath` error; unchanged behaviour).
- Stub `stat` to throw `{ code: "EACCES" }` for one call →
  `PERMISSION_DENIED`.

### 5.6 Per-entry failure policy + root-opendir regression (round-3 delta)

Replaces [03-plan-r2.md §5.6](03-plan-r2.md#L307-L335) and adds
three new sub-cases for blocker 1.

**Child-subtree cases (depth ≥ 1)** — carried from round 2:

- **Permission-denied subtree (real fs).** `chmod(0o000)` a
  **child** directory mid-tree (skip on Windows and when running
  as root — detect via `process.getuid?.() === 0` and `it.skip`).
  Assert sibling matches return, `truncated === false`, and
  `skipped` contains exactly one `{ path, code:
  "PERMISSION_DENIED" }` entry. Restore mode in `afterEach` so
  `rmSync` cleanup works.
- **Deletion race (ENOENT) mid-walk.** Stub `opendir` so the
  **second** call rejects with `{ code: "ENOENT" }` (the first call
  is the root, which must succeed). Assert the walk completes,
  `truncated === false`, and `skipped` contains exactly one
  `{ path, code: "NOT_FOUND" }` entry.
- **Unrecoverable EMFILE.** Stub `opendir` so a **mid-walk** (≥ 2nd)
  call rejects with `{ code: "EMFILE" }`. Assert the runtime throws
  with `READ_DIRECTORY_FAILED` in the message. Assert `files`,
  `skipped`, and `truncated` are **not** present in the failure
  envelope (the partial result is discarded).
- **Async-iterator throw at depth ≥ 1.** Stub the iterator of a
  child `opendir` to reject with `{ code: "EACCES" }` mid-iteration.
  Assert `skipped` contains exactly one `{ path, code:
  "PERMISSION_DENIED" }` entry and `files` contains any matches
  found before the throw.

**Root-opendir cases (depth 0)** — new in round 3, the regression
guard for [04-review-r2.md](04-review-r2.md#L19-L31):

- **Root opendir EACCES after successful stat.** Stub `opendir` so
  the **first** call (on the user-supplied root) rejects with
  `{ code: "EACCES" }`; let `stat` succeed normally. Assert the
  runtime throws with `PERMISSION_DENIED` in the message and
  `code === "PERMISSION_DENIED"`. Assert the envelope does **not**
  carry `files`, `truncated`, or `skipped` — i.e. the call is a
  hard failure, not a partial success with the root in
  `skipped[]`. This is the precise shape the round-2 design
  produced and the reviewer rejected.
- **Root opendir ENOENT after successful stat.** Same fixture,
  reject the first `opendir` with `{ code: "ENOENT" }` (deletion
  race between `stat` and `opendir`). Assert `code ===
  "NOT_FOUND"`, no success-envelope fields, no `skipped[]` entry
  for the root.
- **Root opendir EMFILE after successful stat.** Reject the first
  `opendir` with `{ code: "EMFILE" }`. Assert `code === "IO_ERROR"`,
  no success-envelope fields, no `skipped[]` entry for the root.
  This is the case the reviewer flagged explicitly at
  [04-review-r2.md](04-review-r2.md#L25-L31) as "unexpected root
  opendir errors should fail rather than populate skipped".

The combined seven cases (four child + three root) exercise every
leg of the policy split in
[02-design-r3.md §3.6](02-design-r3.md) and
[02-design-r3.md §3.7](02-design-r3.md).

### 5.7 No-subprocess regression (G32-specific) — unchanged

See [03-plan-r2.md §5.7](03-plan-r2.md#L337-L350).

### 5.8 No-sync-fs invariant (post-G30 cross-check) — unchanged

See [03-plan-r2.md §5.8](03-plan-r2.md#L352-L358).

## 6. Build and lint gates — unchanged

See [03-plan-r2.md §6](03-plan-r2.md#L360-L371).

## 7. Daemon redeploy — unchanged

See [03-plan-r2.md §7](03-plan-r2.md#L373-L391).

## 8. Rollback — unchanged

See [03-plan-r2.md §8](03-plan-r2.md#L393-L400).

## 9. Exit criteria (round-3 delta)

Supersedes [03-plan-r2.md §9](03-plan-r2.md#L402-L424). Adds three
items for the round-3 blockers; keeps every round-2 item.

1. `grep -n 'execFile.*"find"' src/mcp/builtins.ts` → zero hits.
2. `grep -nc 'function classifyFsError\|function parseNonNegativeInt'
   src/mcp/builtins.ts` → exactly 2 (declared by G31, not by G32).
3. `grep -n 'G32: dedup\|G32 dedup' src/mcp/builtins.ts` → zero
   hits.
4. **(round-3)** `grep -n 'pattern must be non-empty'
   src/mcp/builtins.ts` → exactly 1 hit (the handler-level
   `INVALID_ARGUMENT` rejection); the round-2 `globToRegExp` guard
   is gone.
5. **(round-3)** `grep -n 'rootErrorEnvelope' src/mcp/builtins.ts` →
   at least 4 hits (declaration + three call sites: root `stat`
   catch, root `opendir` catch, root iterator-throw catch).
6. **(round-3)** `grep -n 'depth === 0' src/mcp/builtins.ts` → at
   least 2 hits inside the `visit` walker.
7. New `search_files` tests in §5 all pass, including:
   - Every row of the §3.1 truncation matrix
     ([02-design-r2.md §3.1](02-design-r2.md#L55-L77)).
   - Every row of the §3.2 glob matrix
     ([02-design-r3.md §3.2](02-design-r3.md)).
   - Every leg of the §3.7 child per-entry failure policy
     ([02-design-r3.md §3.7](02-design-r3.md)).
   - Every row of the §3.6 root-error table
     ([02-design-r3.md §3.6](02-design-r3.md)), including the
     three root-`opendir` rows added in §5.6.
   - The empty-pattern test in §5.5 asserts `INVALID_ARGUMENT` (not
     `INVALID_PATTERN`).
8. [src/mcp/no-sync-fs.test.ts](../../../../src/mcp/no-sync-fs.test.ts)
   continues to pass (G30 invariant preserved).
9. The seven `mcpConfig.max*` parameters are wired in a single
   contiguous block inside `registerBuiltinServices` (§4).
10. Three harness health endpoints return 200 after restart.
11. Reviewer sign-off recorded as `APPROVED.md` per the workflow.
