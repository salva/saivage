# G32 — Analysis r5

**Finding**: [../G32-builtins-search-files-find-subprocess.md](../G32-builtins-search-files-find-subprocess.md)

**Round 1 baseline**: [01-analysis-r1.md](01-analysis-r1.md#L1)

**Round 2 baseline**: [01-analysis-r2.md](01-analysis-r2.md#L1)

**Round 3 baseline**: [01-analysis-r3.md](01-analysis-r3.md#L1)

**Round 4 baseline**: [01-analysis-r4.md](01-analysis-r4.md#L1)

**Round 4 review**: [04-review-r4.md](04-review-r4.md#L1)

**Writer**: Claude Opus 4.7 (round 5)

Round 5 carries [01-analysis-r4.md](01-analysis-r4.md#L1) forward
verbatim at the contract/root-cause layer. The reviewer recorded no
required change against analysis r4 and no new finding on the
handler contract; see [04-review-r4.md](04-review-r4.md#L1-L9).

The two round-4 blockers at
[04-review-r4.md](04-review-r4.md#L13-L41) are both
verification-gate scope defects in
[03-plan-r4.md](03-plan-r4.md#L95-L106): the presence gate is not
handler-scoped, and the helper-body gate's `-nA 25` window does not
span the full r3 `globToRegExp` helper. Both are operationalised in
[03-plan-r5.md](03-plan-r5.md#L1); the design contract in
[02-design-r3.md](02-design-r3.md#L1) and the design-layer literals
recorded in [02-design-r4.md](02-design-r4.md#L73-L120) are
unchanged.

## 1. Reviewer concern at the analysis layer

[04-review-r4.md](04-review-r4.md#L43-L51) confirms the round-4
literal corrections (removal gate now expects zero hits of
`pattern must be non-empty`, presence gate now anchors on
`INVALID_ARGUMENT: pattern must be a non-empty string`). The
remaining blockers are scope, not wording:

- The round-4 presence gate at
  [03-plan-r4.md](03-plan-r4.md#L95-L99) counts the new literal
  across the whole module. A stray comment, a doc string, an
  unreachable helper-local `throw`, or a duplicated arm in a
  different `case` could satisfy the count of exactly one without
  the literal sitting inside the `case "search_files":` body. The
  design at [02-design-r4.md](02-design-r4.md#L99-L107) records the
  required location, but the gate does not enforce it.
- The round-4 helper-body gate at
  [03-plan-r4.md](03-plan-r4.md#L101-L106) uses a fixed
  `grep -nA 25` window. The r3 helper as shown at
  [02-design-r3.md](02-design-r3.md#L78-L120) is roughly 40 lines
  long; a 25-line window leaves the back half of the body
  unobserved. A defence-in-depth `pattern.length === 0` branch
  reintroduced after line 25 of the helper satisfies the round-4
  gate as written.

Both are pure verification-layer defects, identical in kind to the
round-3 wording defect that round 4 fixed. The handler-boundary
contract at [02-design-r3.md](02-design-r3.md#L177-L185) and the
helper contract at [02-design-r3.md](02-design-r3.md#L62-L78)
remain correct.

## 2. Analysis-level consequences of the round-5 fix

### 2.1 The gate must prove the location it claims to prove

Round 4 grounded each gate in a literal the r3 design writes into
the source file. Round 5 adds the symmetric requirement: each gate
must run inside the lexical region the design pins the literal to.

- The presence gate's design claim at
  [02-design-r4.md](02-design-r4.md#L99-L107) is that the new
  literal "sits inside the `case "search_files":` handler body,
  not inside `globToRegExp`, not inside any helper". A
  whole-module count cannot discriminate those locations. Round 5
  extracts the `case "search_files":` body with an awk range bounded
  by the next `case "…":` or `default:` line, and counts inside
  that body.
- The helper-body gate's design claim at
  [02-design-r4.md](02-design-r4.md#L116-L120) is that
  `globToRegExp` no longer contains a `pattern.length === 0`
  branch under any wording. The "body" of the helper is the lexical
  region from the function declaration through the closing brace
  of that function. Round 5 extracts that region with an awk range
  bounded by the next top-level `function`/`const`/`class`/
  `export` declaration, and counts inside that region.

Both gates collapse to a one-line `awk … | grep -c …` pipeline. The
literal anchors are unchanged from r4; only the substrate over
which `grep -c` runs is narrowed.

### 2.2 Joint satisfiability is unchanged

The three gates jointly accept exactly the r3 design and reject
each round-2 regression at
[03-plan-r4.md](03-plan-r4.md#L110-L127). Round 5 preserves that
self-consistency check and extends it with the two new failure
modes the round-5 gates also reject:

- "New literal lives in a helper, not the handler" — fails the
  round-5 presence gate because the literal is absent from the
  awk-extracted `case "search_files":` body.
- "Defence-in-depth `pattern.length === 0` reintroduced past line
  25 of `globToRegExp`" — fails the round-5 helper-body gate
  because the awk-extracted helper body covers every line through
  the helper's closing brace.

### 2.3 No contract surface changes in round 5

Round 5 makes no contract change. The error-code boundary, the
envelope shape, the truncation matrix, the per-entry policy, the
root-error table, and the test catalogue are all the round-3
contract at [02-design-r3.md](02-design-r3.md#L161-L370). Round 5
is plan-layer only.

### 2.4 Symmetry with G31 r3 — unchanged

The round-3 symmetry argument at
[01-analysis-r3.md](01-analysis-r3.md#L130-L150) carries verbatim.
No new caller of `search_files` exists; no live caller branches on
the codes G32 introduces.

## 3. No new findings

Round 5 re-read [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L1).
The pre-G30 handler at
[src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L262-L327)
still shells out to `find(1)`; this remains the prerequisite-
sequencing state observed since round 3, not a new regression.
