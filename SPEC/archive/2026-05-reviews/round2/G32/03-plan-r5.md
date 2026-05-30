# G32 — Plan r5

**Finding**: [../G32-builtins-search-files-find-subprocess.md](../G32-builtins-search-files-find-subprocess.md)

**Analysis**: [01-analysis-r5.md](01-analysis-r5.md#L1)

**Design**: [02-design-r5.md](02-design-r5.md#L1)

**Round 1 baseline**: [03-plan-r1.md](03-plan-r1.md#L1)

**Round 2 baseline**: [03-plan-r2.md](03-plan-r2.md#L1)

**Round 3 baseline**: [03-plan-r3.md](03-plan-r3.md#L1)

**Round 4 baseline**: [03-plan-r4.md](03-plan-r4.md#L1)

**Round 4 review**: [04-review-r4.md](04-review-r4.md#L1)

**Writer**: Claude Opus 4.7 (round 5)

Round 5 supersedes [03-plan-r4.md](03-plan-r4.md#L1) only in the
**scope** of the presence gate and the helper-body gate inside the
empty-pattern verification cluster. Every other section of
[03-plan-r4.md](03-plan-r4.md#L1) — and therefore every section of
[03-plan-r3.md](03-plan-r3.md#L1) and
[03-plan-r2.md](03-plan-r2.md#L1) carried through it — is preserved
verbatim and is not restated. In particular: the contract, the
handler snippet, the test catalogue, the daemon redeploy procedure,
the rollback, and the literal anchors are all unchanged.

The two round-5 deltas are:

- §3 Step 4 — the **presence gate** is rewritten as an
  awk-extracted `case "search_files":` body count plus a
  complement-region count; the **helper-body gate** is rewritten
  as an awk-extracted `globToRegExp` body count bounded by the next
  top-level declaration.
- §9 exit criteria — items 4b and 4c are replaced with the same
  scoped checks.

## 1. Pre-flight — unchanged

See [03-plan-r2.md](03-plan-r2.md#L17-L48) (carried via
[03-plan-r3.md](03-plan-r3.md#L26-L29) and
[03-plan-r4.md §1](03-plan-r4.md#L34-L37)).

## 2. Sequencing — unchanged

See [03-plan-r2.md](03-plan-r2.md#L50-L80) (carried via
[03-plan-r3.md](03-plan-r3.md#L31-L33) and
[03-plan-r4.md §2](03-plan-r4.md#L39-L42)).

## 3. Implementation steps

### Step 1 — Config schema — unchanged

See [03-plan-r2.md](03-plan-r2.md#L84-L102).

### Step 2 — Module-level caps — unchanged

See [03-plan-r2.md](03-plan-r2.md#L104-L116).

### Step 3 — Imports — unchanged

See [03-plan-r2.md](03-plan-r2.md#L118-L129).

### Step 4 — Local helpers (round-5 delta)

File: [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L1).

Edit content unchanged from
[03-plan-r3.md §3 Step 4](03-plan-r3.md#L43-L74) (carried through
[03-plan-r4.md §3 Step 4](03-plan-r4.md#L56-L74)): insert
`globToRegExp` and `translateSegment` per
[02-design-r3.md §3.2](02-design-r3.md#L62-L78) and
[02-design-r3.md §3.2](02-design-r3.md#L141-L155), without the
round-2 `pattern.length === 0` guard. `parseNonNegativeInt` and
`classifyFsError` continue to be reused from G31, not re-declared.

Verify (terminal `grep`/`awk` only, never `read_file`). The first
five identifier-presence checks are unchanged from
[03-plan-r4.md §3 Step 4](03-plan-r4.md#L65-L74):

- `grep -nc 'function globToRegExp' src/mcp/builtins.ts` → 1.
- `grep -nc 'function translateSegment' src/mcp/builtins.ts` → 1.
- `grep -nc 'function parseNonNegativeInt' src/mcp/builtins.ts` → 1
  (declared by G31, not re-declared here).
- `grep -nc 'function classifyFsError' src/mcp/builtins.ts` → 1
  (declared by G31, not re-declared here).
- `grep -n 'G32: dedup\|G32 dedup' src/mcp/builtins.ts` → 0 hits.

**Empty-pattern guard gates (round-5 delta).** Replaces the three
gates at [03-plan-r4.md §3 Step 4](03-plan-r4.md#L87-L106). The
removal gate is unchanged; the presence gate and the helper-body
gate are rescoped to the lexical regions pinned by
[02-design-r5.md §3](02-design-r5.md#L1).

- **Removal gate (unchanged from r4).**

  ```sh
  grep -c 'pattern must be non-empty' src/mcp/builtins.ts
  ```

  Expected: `0`. Asserts the round-2 `globToRegExp` helper guard at
  [02-design-r3.md](02-design-r3.md#L65-L67) is gone from the whole
  module. A non-zero result means the obsolete `throw new Error(
  "pattern must be non-empty")` was retained as defence-in-depth —
  forbidden by the workspace no-shim rule and reintroduces the
  dual-source contract the round-3 fix removes.

- **Presence gate (round-5 delta — handler-scoped).** Two scoped
  counts, both required:

  ```sh
  awk '
    /case "search_files":/ { f=1; next }
    f && /^[[:space:]]*(case "|default:)/ { exit }
    f
  ' src/mcp/builtins.ts \
    | grep -c 'INVALID_ARGUMENT: pattern must be a non-empty string'
  ```

  Expected: `1`. Extracts the body of `case "search_files":` —
  every line after the `case "search_files":` line and before the
  next `case "…":` or `default:` line — and asserts the new
  handler literal occurs exactly once inside that body. The awk
  range bounds are the `case`/`default` arm headers of the
  surrounding `switch` in the request-boundary handler at
  [02-design-r3.md](02-design-r3.md#L167-L370); the case header
  itself and the next arm's header are both excluded from the
  extracted body.

  ```sh
  awk '
    /case "search_files":/ { in_case=1; next }
    in_case && /^[[:space:]]*(case "|default:)/ { in_case=0 }
    !in_case { print }
  ' src/mcp/builtins.ts \
    | grep -c 'INVALID_ARGUMENT: pattern must be a non-empty string'
  ```

  Expected: `0`. Extracts the **complement** of the case body
  (everything in the module that is not part of
  `case "search_files":`) and asserts the new handler literal does
  not appear in any other case arm, helper, comment, or doc string.

  A `0` from the first gate means the handler was not updated; a
  value `> 1` from the first gate means a duplicate arm exists. A
  non-zero result from the second gate means the literal lives
  outside the handler boundary, e.g. inside `globToRegExp` or a
  doc comment, which violates
  [02-design-r4.md §3.2](02-design-r4.md#L99-L107).

- **Helper-body gate (round-5 delta — full helper span).**

  ```sh
  awk '
    /^function globToRegExp/ { f=1; print; next }
    f && /^(function|const|let|class|export|interface) / { exit }
    f
  ' src/mcp/builtins.ts \
    | grep -c 'pattern.length === 0'
  ```

  Expected: `0`. Extracts the body of `globToRegExp` from its
  signature line through (but excluding) the next top-level
  declaration line. The range terminates at the next
  `^function `, `^const `, `^let `, `^class `, `^export `, or
  `^interface ` declaration, which guarantees the entire helper
  body is observed regardless of how many lines it spans. The r3
  helper at [02-design-r3.md](02-design-r3.md#L78-L120) is about
  40 lines long and the next top-level declaration is
  `function translateSegment` at
  [02-design-r3.md](02-design-r3.md#L123-L124); the round-5 range
  therefore covers every line of the helper, replacing the round-4
  fixed `-nA 25` window which only reached the helper's midpoint.

  A non-zero result means a defence-in-depth empty-string
  pre-check was reintroduced anywhere inside `globToRegExp`,
  including past the line that the round-4 gate's window
  truncated at.

**Round-5 joint-satisfiability check.** The four scoped counts
(removal, presence-in-case, absence-in-complement, absence-in-
helper) are jointly satisfiable only by the r3 design exactly as
written:

- Round-2 implementation (helper guard present, no handler check):
  removal `1` (fail), presence-in-case `0` (fail),
  absence-in-complement `0` (pass), absence-in-helper `1` (fail).
  Rejected.
- Round-2-plus-handler regression (helper guard kept, handler
  added): removal `1` (fail), presence-in-case `1` (pass),
  absence-in-complement `0` (pass), absence-in-helper `1` (fail).
  Rejected — the round-3 single-literal gate would have accepted
  this.
- Round-3-as-designed: removal `0` (pass), presence-in-case `1`
  (pass), absence-in-complement `0` (pass), absence-in-helper `0`
  (pass). Accepted.
- Helper-mislocated handler string (literal copied into
  `globToRegExp` instead of the case body): removal `0` (pass),
  presence-in-case `0` (fail), absence-in-complement `1` (fail),
  absence-in-helper `0` (pass — the literal does not contain
  `pattern.length === 0`). Rejected — the round-4 whole-module
  presence gate would have accepted this.
- Late-helper-line defence-in-depth (e.g.
  `if (pattern.length === 0) throw …` inserted past line 25 of
  `globToRegExp`): removal depends on wording; presence-in-case
  `1` (pass); absence-in-complement `0` (pass); absence-in-helper
  `1` (fail). Rejected — the round-4 `-nA 25` window would have
  accepted this.
- Handler-wording typo (handler literal drifted): removal `0`
  (pass), presence-in-case `0` (fail), absence-in-complement `0`
  (pass), absence-in-helper `0` (pass). Rejected — wording must
  match.

### Step 5 — Schema and handler — unchanged

File: [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L1).

Edit content unchanged from
[03-plan-r3.md §3 Step 5](03-plan-r3.md#L76-L114) (carried via
[03-plan-r4.md §3 Step 5](03-plan-r4.md#L129-L154)): replace the
`search_files` schema entry with the block at
[02-design-r1.md](02-design-r1.md#L132-L165); replace the
`case "search_files":` body with the round-3 handler at
[02-design-r3.md](02-design-r3.md#L167-L370). The handler-boundary
empty-pattern rejection lives here; its source-literal gates are
verified in Step 4 (presence-in-case and absence-in-complement)
and Step 4 (helper-body gate asserts the same string does not also
live inside `globToRegExp`).

Verify (terminal `grep` only), unchanged from
[03-plan-r4.md §3 Step 5](03-plan-r4.md#L145-L154):

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

## 5. Tests — unchanged

See [03-plan-r4.md §5](03-plan-r4.md#L156-L196) (carried via
[03-plan-r3.md §5](03-plan-r3.md#L117-L233)).

## 6. Build and lint gates — unchanged

See [03-plan-r2.md](03-plan-r2.md#L360-L371).

## 7. Daemon redeploy — unchanged

See [03-plan-r2.md](03-plan-r2.md#L373-L391).

## 8. Rollback — unchanged

See [03-plan-r2.md](03-plan-r2.md#L393-L400).

## 9. Exit criteria (round-5 delta)

Supersedes [03-plan-r4.md §9](03-plan-r4.md#L207-L242). Every
round-4 item is preserved except items 4b and 4c, which are
rescoped to match [02-design-r5.md §3](02-design-r5.md#L1) and the
gate shapes in §3 Step 4 above.

1. `grep -n 'execFile.*"find"' src/mcp/builtins.ts` → zero hits.
2. `grep -nc 'function classifyFsError\|function parseNonNegativeInt'
   src/mcp/builtins.ts` → exactly 2 (declared by G31, not by G32).
3. `grep -n 'G32: dedup\|G32 dedup' src/mcp/builtins.ts` → zero
   hits.
4a. **(removal gate — unchanged from r4)**
   `grep -c 'pattern must be non-empty' src/mcp/builtins.ts` → 0.
   The round-2 `globToRegExp` helper guard at
   [02-design-r3.md](02-design-r3.md#L65-L67) is removed.
4b. **(round-5 delta — presence gate, handler-scoped)** Both
   scoped counts must hold:

   ```sh
   awk '
     /case "search_files":/ { f=1; next }
     f && /^[[:space:]]*(case "|default:)/ { exit }
     f
   ' src/mcp/builtins.ts \
     | grep -c 'INVALID_ARGUMENT: pattern must be a non-empty string'
   ```

   → `1` (literal occurs exactly once inside the
   `case "search_files":` body).

   ```sh
   awk '
     /case "search_files":/ { in_case=1; next }
     in_case && /^[[:space:]]*(case "|default:)/ { in_case=0 }
     !in_case { print }
   ' src/mcp/builtins.ts \
     | grep -c 'INVALID_ARGUMENT: pattern must be a non-empty string'
   ```

   → `0` (literal does not occur anywhere outside the
   `case "search_files":` body).
4c. **(round-5 delta — helper-body gate, full span)**

   ```sh
   awk '
     /^function globToRegExp/ { f=1; print; next }
     f && /^(function|const|let|class|export|interface) / { exit }
     f
   ' src/mcp/builtins.ts \
     | grep -c 'pattern.length === 0'
   ```

   → `0`. The helper does not pre-check the empty string under any
   wording, anywhere between its signature and the next top-level
   declaration.
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
