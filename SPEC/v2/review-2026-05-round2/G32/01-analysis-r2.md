# G32 — Analysis r2

**Finding**: [../G32-builtins-search-files-find-subprocess.md](../G32-builtins-search-files-find-subprocess.md)

**Round 1 baseline**: [01-analysis-r1.md](01-analysis-r1.md)

**Round 1 review**: [04-review-r1.md](04-review-r1.md)

**Writer**: Claude Opus 4.7 (round 2)

Round 2 keeps the round-1 root-cause analysis verbatim. Every section
of [01-analysis-r1.md](01-analysis-r1.md) stands, and the analysis is
not re-stated here. The reviewer raised no analysis-level required
changes — the four blockers all live in
[02-design-r1.md](02-design-r1.md) and [03-plan-r1.md](03-plan-r1.md),
which round 2 rewrites. This document only records the analysis-level
clarifications round 1 left implicit.

## 1. Reviewer concerns at the analysis layer

[04-review-r1.md](04-review-r1.md) records no required change against
[01-analysis-r1.md](01-analysis-r1.md). The reviewer's only
analysis-touching note —
[04-review-r1.md](04-review-r1.md#L93-L96) — endorses the round-1
re-framing of the subprocess risk as portability/clarity rather than
shell injection, citing
[01-analysis-r1.md](01-analysis-r1.md#L103-L126). No change is
required at this layer; the citation is preserved.

## 2. Clarifications surfaced while addressing design blockers

### 2.1 `max_results: 0` is a valid request shape

Round 1 was silent on whether `max_results: 0` should be accepted at
all. Round-1 review concern 1 ([04-review-r1.md](04-review-r1.md#L21-L29))
forced a decision. The semantic the round-2 design adopts is: zero
is a valid, non-negative integer; it asks "tell me whether at least
one file matches without returning paths". This matches the existing
G31 `length: 0` policy at
[../G31/02-design-r2.md](../G31/02-design-r2.md#L317-L329), preserves
schema symmetry across MCP builtins, and is cheaper to reason about
than carving an exceptional zero case at the schema boundary. The
analysis-level consequence: the tool now surfaces a boolean
"matches-exist" probe shape for free, which agents may use as a
discovery primitive (no consumer relies on this today; it is a
side benefit, not a contract).

### 2.2 `**` is a path-segment operator, not a character operator

Round-1 review concern 2 ([04-review-r1.md](04-review-r1.md#L31-L43))
correctly notes that the round-1 prose at
[02-design-r1.md](02-design-r1.md#L327-L344) said "segment-aware"
while the implementation matched any pair of adjacent asterisks.
Analytically the gap was a contract-vs-implementation mismatch, not
a missing requirement: the round-1 analysis already promised "zero
or more path segments" semantics at
[01-analysis-r1.md](01-analysis-r1.md#L268-L271). Round 2 makes the
implementation honour that contract and rejects malformed inputs
(`foo**bar`, `**foo`, `foo**`) as `INVALID_PATTERN`. No new
analysis-level requirement is introduced; the analysis-level
contract is unchanged.

### 2.3 Per-entry traversal errors split into two failure modes

Round-1 review concern 3
([04-review-r1.md](04-review-r1.md#L45-L57)) is an analysis-level
gap: the round-1 prose did not name a policy for mid-walk
directory-read failures other than the root-level `stat`. The
round-2 analysis-level decision is to split mid-walk errors into:

- **Recoverable subtree errors** — `ENOENT` (deletion race),
  `ENOTDIR` (parallel mutation), `EACCES`/`EPERM` (permission-denied
  subtree). These are reported in a new operator-facing `skipped`
  array in the success envelope. The walk continues; results from
  sibling subtrees are returned.
- **Unrecoverable traversal errors** — every other errno from
  `opendir(child)` or the async iterator. These surface as
  `READ_DIRECTORY_FAILED` on `isError: true`; the partial result is
  discarded.

This is consistent with G31 r3's exhaustive structured-error contract
at [../G31/02-design-r3.md](../G31/02-design-r3.md#L19-L46), but
adds two G32-specific codes (`READ_DIRECTORY_FAILED`,
`NOT_A_DIRECTORY`) and one new envelope field (`skipped`). The
divergence is justified in [02-design-r2.md §3.7](02-design-r2.md).

### 2.4 G31/G32 helper duplication is a sequencing decision

Round-1 review concern 4
([04-review-r1.md](04-review-r1.md#L59-L73)) flags the
"temporary duplicate `parseNonNegativeInt`" branch in round 1 as a
migration shim. Architecturally the choice is binary: either G31 is
a hard prerequisite (G32 reuses its helper) or both findings ship a
single shared helper file at first merge. The round-2 analysis-level
decision is to make G31 a hard prerequisite. G32 reuses both
`parseNonNegativeInt` and the G31 r3 `classifyFsError` helper at
[../G31/02-design-r3.md](../G31/02-design-r3.md#L48-L99) — the
latter is needed for the root-level `stat`/`opendir` error
classification regardless of how `parseNonNegativeInt` is sequenced.
Hard-sequencing G31 first removes both shims in one step. The
trade-off (a longer merge chain G30 → G31 → G32) is acceptable
under the workspace "no migration shims" rule.

### 2.5 No-sync-fs guard file is a G30 deliverable

Round-1 review concern 5
([04-review-r1.md](04-review-r1.md#L75-L82)) notes that the round-1
plan referenced a guard file
([src/mcp/no-sync-fs.test.ts](../../../../src/mcp/no-sync-fs.test.ts))
not present in the live tree. That file is created by G30's
approved plan at
[../G30/03-plan-r2.md](../G30/03-plan-r2.md#L212-L244): it consumes
the dependency-free scanner
[src/testing/noSyncFsScanner.ts](../../../../src/testing/noSyncFsScanner.ts)
that G30 also ships. The file appears on disk post-G30 merge.
Because G32 already hard-requires G30 (round-1 analysis
[01-analysis-r1.md](01-analysis-r1.md#L237-L242)), the reference is
correct at G32's merge time. Round 2 re-states this dependency
explicitly in [03-plan-r2.md §1](03-plan-r2.md) and points at the
correct G30 anchor.

## 3. No new findings

No round-2 investigation surfaced a new failure mode or a new caller
of `search_files`. The four blockers are all
implementation/sequencing fixes; the analysis stands.
