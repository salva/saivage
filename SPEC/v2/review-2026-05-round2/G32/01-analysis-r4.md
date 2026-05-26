# G32 — Analysis r4

**Finding**: [../G32-builtins-search-files-find-subprocess.md](../G32-builtins-search-files-find-subprocess.md)

**Round 1 baseline**: [01-analysis-r1.md](01-analysis-r1.md#L1)

**Round 2 baseline**: [01-analysis-r2.md](01-analysis-r2.md#L1)

**Round 3 baseline**: [01-analysis-r3.md](01-analysis-r3.md#L1)

**Round 3 review**: [04-review-r3.md](04-review-r3.md#L1)

**Writer**: Claude Opus 4.7 (round 4)

Round 4 carries [01-analysis-r3.md](01-analysis-r3.md#L1) forward
verbatim at the contract/root-cause layer. The reviewer recorded no
required change against analysis r3 and no new finding on the
handler contract; see
[04-review-r3.md](04-review-r3.md#L1-L13). The only round-3
blocker is a verification-gate inconsistency in
[03-plan-r3.md](03-plan-r3.md#L1), which is rewritten in
[03-plan-r4.md](03-plan-r4.md#L1). This document records the
analysis-level consequences of that single fix.

## 1. Reviewer concern at the analysis layer

[04-review-r3.md](04-review-r3.md#L11-L13) confirms both contract
fixes from round 3 (root traversal failure is a hard error;
empty-pattern is `INVALID_ARGUMENT`) and approves them. The remaining
blocker at
[04-review-r3.md](04-review-r3.md#L19-L30) is verification-only: the
plan-layer grep gate keyed to the literal string
`pattern must be non-empty` is inconsistent with the round-3 handler
copy at
[02-design-r3.md](02-design-r3.md#L181-L185), which emits
`INVALID_ARGUMENT: pattern must be a non-empty string`.

The two failure modes the reviewer documents are:

- False pass: the obsolete `globToRegExp` guard
  `throw new Error("pattern must be non-empty")` is retained, the
  new handler-level error is also added with a different wording,
  the round-3 gate finds exactly one `pattern must be non-empty`
  hit (at the obsolete guard), and the gate concludes the obsolete
  guard was removed. The regression the gate is supposed to catch
  is accepted as a pass.
- False fail: the obsolete guard is removed exactly as
  [02-design-r3.md](02-design-r3.md#L62-L78) requires; the handler
  emits its actual wording; the round-3 gate finds zero
  `pattern must be non-empty` hits and rejects a correct
  implementation.

Both are pure verification-layer defects. The design contract at
[02-design-r3.md](02-design-r3.md#L181-L185) (handler boundary owns
empty-pattern rejection; `globToRegExp` does not guard it) is
unchanged in round 4.

## 2. Analysis-level consequences of the round-4 fix

### 2.1 Verification gates must be source-aware

The round-3 gate at
[03-plan-r3.md](03-plan-r3.md#L68-L74) and
[03-plan-r3.md](03-plan-r3.md#L278-L281) treated
`pattern must be non-empty` as a stable signature for the
empty-pattern rejection. Round 3 itself changed the wording (the
helper guard string disappears entirely; the new handler string is
`pattern must be a non-empty string` prefixed by
`INVALID_ARGUMENT: `). A single literal cannot stand in for both
"the obsolete code is gone" and "the new code is present" when the
two literals differ.

Round 4 splits the assertion into two source-aware gates that match
exactly what
[02-design-r3.md](02-design-r3.md#L62-L78) and
[02-design-r3.md](02-design-r3.md#L181-L185) write into the source
file:

- Removal gate — asserts the obsolete guard string is gone from the
  whole module. The exact obsolete literal is
  `pattern must be non-empty` (the round-2 helper throw at
  [02-design-r3.md](02-design-r3.md#L65-L67), which round 3
  deletes).
- Presence gate — asserts the new handler-level error string is
  present in the handler. The exact new literal is
  `INVALID_ARGUMENT: pattern must be a non-empty string`
  ([02-design-r3.md](02-design-r3.md#L181-L185)).
- Helper-body gate — asserts `globToRegExp` no longer carries a
  `pattern.length === 0` branch. This catches a defence-in-depth
  reintroduction even if the implementer chose a new error wording.

These three together are self-consistent with the r3 handler and r3
helper; no single gate can pass while the regression is present and
no single gate can fail when r3 is implemented correctly.

### 2.2 No contract surface changes in round 4

Round 4 does not move the error-code boundary, the envelope shape,
the truncation matrix, the per-entry policy, or the root-error
table. The G32 contract after round 4 is exactly the round-3
contract at
[02-design-r3.md](02-design-r3.md#L161-L370). Round 4 is a
plan-only delta that aligns the verification step with that
unchanged contract.

### 2.3 Symmetry with G31 r3 — unchanged

The round-3 symmetry argument at
[01-analysis-r3.md](01-analysis-r3.md#L130-L150) carries
verbatim. The empty-pattern error remains an argument-shape
`INVALID_ARGUMENT`; root traversal failure remains an
operation-failed-on-a-valid-argument code from the G31 classifier
table at
[../G31/02-design-r3.md](../G31/02-design-r3.md#L19-L46).

## 3. No new findings

Round 4 re-read
[src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L1) and the
prerequisite G30/G31 contracts referenced from
[02-design-r3.md](02-design-r3.md#L1). No new caller of
`search_files` exists. No live caller branches on the codes G32
introduces. The pre-G30 handler at
[src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L262-L327)
still shells out to `find(1)`; this is the prerequisite-sequencing
state the round-3 reviewer also observed at
[04-review-r3.md](04-review-r3.md#L40-L43), not a new regression.
