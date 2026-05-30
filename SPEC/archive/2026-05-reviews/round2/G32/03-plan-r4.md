# G32 — Plan r4

**Finding**: [../G32-builtins-search-files-find-subprocess.md](../G32-builtins-search-files-find-subprocess.md)

**Analysis**: [01-analysis-r4.md](01-analysis-r4.md#L1)

**Design**: [02-design-r4.md](02-design-r4.md#L1)

**Round 1 baseline**: [03-plan-r1.md](03-plan-r1.md#L1)

**Round 2 baseline**: [03-plan-r2.md](03-plan-r2.md#L1)

**Round 3 baseline**: [03-plan-r3.md](03-plan-r3.md#L1)

**Round 3 review**: [04-review-r3.md](04-review-r3.md#L1)

**Writer**: Claude Opus 4.7 (round 4)

Round 4 supersedes [03-plan-r3.md](03-plan-r3.md#L1) only in the two
verification clusters tied to the empty-pattern grep gate:

- §3 Step 4 — replace the single `pattern must be non-empty` gate
  with the three source-aware gates from
  [02-design-r4.md](02-design-r4.md#L73-L120).
- §9 exit criteria — replace exit criterion 4 with the same
  three-gate split.

Every other section of
[03-plan-r3.md](03-plan-r3.md#L1) is preserved verbatim and is not
restated. In particular: the contract, the handler snippet, the
test catalogue, the daemon redeploy procedure, and the rollback are
all unchanged.

## 1. Pre-flight — unchanged

See [03-plan-r2.md](03-plan-r2.md#L17-L48) (carried via
[03-plan-r3.md](03-plan-r3.md#L26-L29)).

## 2. Sequencing — unchanged

See [03-plan-r2.md](03-plan-r2.md#L50-L80) (carried via
[03-plan-r3.md](03-plan-r3.md#L31-L33)).

## 3. Implementation steps

### Step 1 — Config schema — unchanged

See [03-plan-r2.md](03-plan-r2.md#L84-L102).

### Step 2 — Module-level caps — unchanged

See [03-plan-r2.md](03-plan-r2.md#L104-L116).

### Step 3 — Imports — unchanged

See [03-plan-r2.md](03-plan-r2.md#L118-L129).

### Step 4 — Local helpers (round-4 delta)

File: [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L1).

Edit content unchanged from
[03-plan-r3.md §3 Step 4](03-plan-r3.md#L43-L74): insert
`globToRegExp` and `translateSegment` per
[02-design-r3.md §3.2](02-design-r3.md#L62-L78) and
[02-design-r3.md §3.2](02-design-r3.md#L141-L155), without the
round-2 `pattern.length === 0` guard. `parseNonNegativeInt` and
`classifyFsError` continue to be reused from G31, not re-declared.

Verify (terminal `grep` only, never `read_file`):

- `grep -nc 'function globToRegExp' src/mcp/builtins.ts` → 1.
- `grep -nc 'function translateSegment' src/mcp/builtins.ts` → 1.
- `grep -nc 'function parseNonNegativeInt' src/mcp/builtins.ts` → 1
  (declared by G31, not re-declared here).
- `grep -nc 'function classifyFsError' src/mcp/builtins.ts` → 1
  (declared by G31, not re-declared here).
- `grep -n 'G32: dedup\|G32 dedup' src/mcp/builtins.ts` → 0 hits.

**Empty-pattern guard gates (round-4 delta).** Replaces the single
`grep -n 'pattern must be non-empty' … → 1` line at
[03-plan-r3.md §3 Step 4](03-plan-r3.md#L68-L71). Each of the three
gates below is grounded in a literal the r3 design writes into the
source file, per
[02-design-r4.md §3](02-design-r4.md#L73-L120):

- Removal gate.
  `grep -c 'pattern must be non-empty' src/mcp/builtins.ts` → 0.
  Asserts the round-2 `globToRegExp` helper guard at
  [02-design-r3.md](02-design-r3.md#L65-L67) is gone. A non-zero
  result means the obsolete `throw new Error("pattern must be
  non-empty")` was retained as a "defence in depth" — forbidden by
  the workspace no-shim rule and reintroduces the dual-source
  contract the round-3 fix exists to remove.
- Presence gate.
  `grep -c 'INVALID_ARGUMENT: pattern must be a non-empty string'
  src/mcp/builtins.ts` → 1. Asserts the round-3 handler at
  [02-design-r3.md](02-design-r3.md#L181-L185) was copied verbatim
  and lives in the request-boundary handler. A 0 means the handler
  was not updated; a value > 1 means a duplicate handler arm exists.
- Helper-body gate.
  `grep -nA 25 'function globToRegExp' src/mcp/builtins.ts |
  grep -c 'pattern.length === 0'` → 0. Asserts the helper body has
  no length-zero pre-check even under a renamed error message. The
  25-line window covers the helper body shown at
  [02-design-r3.md](02-design-r3.md#L70-L100); the helper does not
  span more lines. A non-zero result means a defence-in-depth
  re-introduction smuggled in under different wording.

The three gates are jointly satisfiable only by the r3 design
exactly as written. Self-consistency check, with all three:

- Round-2 implementation (helper guard present, no handler check):
  removal gate fails (`1`), presence gate fails (`0`),
  helper-body gate fails (`1`). All three reject.
- Round-2-plus-handler regression (helper guard kept, handler
  string added): removal gate fails (`1`), presence gate passes
  (`1`), helper-body gate fails (`1`). The round-3 gate would have
  reported one hit and called this pass; the round-4 gates correctly
  reject.
- Round-3-as-designed (helper guard removed, handler string added):
  removal gate passes (`0`), presence gate passes (`1`),
  helper-body gate passes (`0`). All three accept.
- Round-3-handler-typo (helper removed, handler wording drifted):
  removal gate passes (`0`), presence gate fails (`0`),
  helper-body gate passes (`0`). Correctly rejected — wording must
  match the design.

### Step 5 — Schema and handler — unchanged

File: [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L1).

Edit content unchanged from
[03-plan-r3.md §3 Step 5](03-plan-r3.md#L76-L114): replace the
`search_files` schema entry with the block at
[02-design-r1.md](02-design-r1.md#L132-L165); replace the
`case "search_files":` body with the round-3 handler at
[02-design-r3.md](02-design-r3.md#L167-L370). The handler-boundary
empty-pattern rejection lives here; its source-literal gates are
verified in Step 4 (presence gate) and Step 4 (helper-body gate
asserts the same string does not also live inside `globToRegExp`).

Verify (terminal `grep` only):

- `grep -n 'execFile.*"find"' src/mcp/builtins.ts` → 0 hits.
- `grep -n 'truncated_reason' src/mcp/builtins.ts` → at least 1 hit.
- `grep -n '"READ_DIRECTORY_FAILED"' src/mcp/builtins.ts` → at
  least 1 hit.
- `grep -nc '"search_files"' src/mcp/builtins.ts` → 1 (schema
  entry).
- `grep -n 'rootErrorEnvelope' src/mcp/builtins.ts` → at least 4
  hits.
- `grep -n 'depth === 0' src/mcp/builtins.ts` → at least 2 hits.
- `grep -n 'classifyFsError(err' src/mcp/builtins.ts` → at least 3
  hits.

### Step 6 — Wire config — unchanged

See [03-plan-r2.md](03-plan-r2.md#L188-L201).

## 4. Sibling-parity audit — unchanged

See [03-plan-r2.md](03-plan-r2.md#L203-L211).

## 5. Tests

File: [src/mcp/builtins.test.ts](../../../../src/mcp/builtins.test.ts#L1).

### 5.1 Schema and catalogue — unchanged

See [03-plan-r2.md](03-plan-r2.md#L223-L227).

### 5.2 Happy path — unchanged

See [03-plan-r2.md](03-plan-r2.md#L229-L250).

### 5.3 Glob rejection — unchanged from r3

See [03-plan-r3.md §5.3](03-plan-r3.md#L137-L150). Empty pattern is
not in this list; it is in §5.5 as `INVALID_ARGUMENT`.

### 5.4 Truncation envelope — unchanged

See [03-plan-r2.md](03-plan-r2.md#L266-L290).

### 5.5 Error envelope — unchanged from r3

See [03-plan-r3.md §5.5](03-plan-r3.md#L154-L171). The empty-pattern
test asserts `INVALID_ARGUMENT` and the literal substring
`INVALID_ARGUMENT: pattern must be a non-empty string`, matching
the source literal in §3 Step 5 above and
[02-design-r3.md](02-design-r3.md#L181-L185).

### 5.6 Per-entry failure policy + root-opendir — unchanged from r3

See [03-plan-r3.md §5.6](03-plan-r3.md#L173-L230).

### 5.7 No-subprocess regression — unchanged

See [03-plan-r2.md](03-plan-r2.md#L337-L350).

### 5.8 No-sync-fs invariant — unchanged

See [03-plan-r2.md](03-plan-r2.md#L352-L358).

## 6. Build and lint gates — unchanged

See [03-plan-r2.md](03-plan-r2.md#L360-L371).

## 7. Daemon redeploy — unchanged

See [03-plan-r2.md](03-plan-r2.md#L373-L391).

## 8. Rollback — unchanged

See [03-plan-r2.md](03-plan-r2.md#L393-L400).

## 9. Exit criteria (round-4 delta)

Supersedes
[03-plan-r3.md §9](03-plan-r3.md#L264-L308). Every round-3 item is
preserved except item 4, which is split into three source-aware
checks (4a–4c) per
[02-design-r4.md §3](02-design-r4.md#L73-L120).

1. `grep -n 'execFile.*"find"' src/mcp/builtins.ts` → zero hits.
2. `grep -nc 'function classifyFsError\|function parseNonNegativeInt'
   src/mcp/builtins.ts` → exactly 2 (declared by G31, not by G32).
3. `grep -n 'G32: dedup\|G32 dedup' src/mcp/builtins.ts` → zero
   hits.
4a. **(round-4 delta — removal gate)**
   `grep -c 'pattern must be non-empty' src/mcp/builtins.ts` → 0.
   The round-2 `globToRegExp` helper guard at
   [02-design-r3.md](02-design-r3.md#L65-L67) is removed.
4b. **(round-4 delta — presence gate)**
   `grep -c 'INVALID_ARGUMENT: pattern must be a non-empty string'
   src/mcp/builtins.ts` → 1. The round-3 handler at
   [02-design-r3.md](02-design-r3.md#L181-L185) is in place,
   exactly once, in the `case "search_files":` body.
4c. **(round-4 delta — helper-body gate)**
   `grep -nA 25 'function globToRegExp' src/mcp/builtins.ts |
   grep -c 'pattern.length === 0'` → 0. The helper does not
   pre-check the empty string under any wording.
5. `grep -n 'rootErrorEnvelope' src/mcp/builtins.ts` → at least 4
   hits (declaration + root `stat` catch + root `opendir` catch +
   root iterator-throw catch).
6. `grep -n 'depth === 0' src/mcp/builtins.ts` → at least 2 hits
   inside the `visit` walker.
7. New `search_files` tests in §5 all pass:
   - Every row of the §3.1 truncation matrix
     ([02-design-r2.md](02-design-r2.md#L55-L77)).
   - Every row of the §3.2 glob matrix
     ([02-design-r3.md](02-design-r3.md#L141-L155)).
   - Every leg of the §3.7 child per-entry failure policy
     ([02-design-r3.md](02-design-r3.md#L422-L450)).
   - Every row of the §3.6 root-error table
     ([02-design-r3.md](02-design-r3.md#L388-L420)), including the
     three root-`opendir` rows.
   - The empty-pattern test in §5.5 asserts both the code
     `INVALID_ARGUMENT` and the message
     `INVALID_ARGUMENT: pattern must be a non-empty string`, the
     same literal asserted by gate 4b.
8. [src/mcp/no-sync-fs.test.ts](../../../../src/mcp/no-sync-fs.test.ts#L1)
   continues to pass (G30 invariant preserved).
9. The seven `mcpConfig.max*` parameters are wired in a single
   contiguous block inside `registerBuiltinServices` (§4).
10. Three harness health endpoints return 200 after restart.
11. Reviewer sign-off recorded as `APPROVED.md` per the workflow.
