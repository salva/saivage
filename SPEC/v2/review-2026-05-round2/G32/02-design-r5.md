# G32 — Design r5

**Finding**: [../G32-builtins-search-files-find-subprocess.md](../G32-builtins-search-files-find-subprocess.md)

**Analysis**: [01-analysis-r5.md](01-analysis-r5.md#L1) (delta over
[01-analysis-r4.md](01-analysis-r4.md#L1))

**Round 1 baseline**: [02-design-r1.md](02-design-r1.md#L1)

**Round 2 baseline**: [02-design-r2.md](02-design-r2.md#L1)

**Round 3 baseline**: [02-design-r3.md](02-design-r3.md#L1)

**Round 4 baseline**: [02-design-r4.md](02-design-r4.md#L1)

**Round 4 review**: [04-review-r4.md](04-review-r4.md#L1)

**Writer**: Claude Opus 4.7 (round 5)

Round 5 makes no contract change. Every section of
[02-design-r3.md](02-design-r3.md#L1) is preserved verbatim and not
restated. Round 4's design-layer summary at
[02-design-r4.md](02-design-r4.md#L1) is also preserved; the
literal anchors recorded at
[02-design-r4.md §3](02-design-r4.md#L73-L120) are unchanged.

This document refines the **scope** of two of the three grep gates
defined at [02-design-r4.md §3](02-design-r4.md#L73-L120) so that
each gate proves the lexical region the design pins its literal to.
The fix is operationalised as `awk` ranges in
[03-plan-r5.md](03-plan-r5.md#L1).

## 1. Recommendation — unchanged

Proposal A from
[02-design-r1.md](02-design-r1.md#L13-L52). Proposal B remains
rejected at [02-design-r1.md](02-design-r1.md#L54-L84).

## 2. Anchors carried forward unchanged

All of [02-design-r3.md](02-design-r3.md#L1-L379) is preserved
verbatim, as carried by [02-design-r4.md §2](02-design-r4.md#L37-L72).

## 3. Source literals and lexical regions the plan grep gates must match

The three literal anchors from
[02-design-r4.md §3](02-design-r4.md#L73-L120) are preserved
verbatim. Round 5 attaches a **lexical region** to two of them so
the plan gate proves where the literal lives, not only that it
exists.

### 3.1 Obsolete literal — region: whole module (unchanged)

Removal of the round-2 helper guard
([02-design-r3.md](02-design-r3.md#L65-L67)) is a global property.
The literal `pattern must be non-empty` must be absent from
[src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L1) in its
entirety, so the gate runs over the whole module. Unchanged from
[02-design-r4.md §3.1](02-design-r4.md#L83-L97).

### 3.2 New handler literal — region: the `case "search_files":` body

The literal
`INVALID_ARGUMENT: pattern must be a non-empty string` must occur
exactly once inside the body of `case "search_files":` and zero
times outside it. The location requirement is recorded at
[02-design-r4.md §3.2](02-design-r4.md#L99-L107). Round 5 pins the
lexical region for the gate:

- **Region start**: the line matching `case "search_files":` in
  [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L1).
- **Region end**: the first subsequent line matching `case "` (the
  next `switch` arm) or `default:` (the `switch`'s catch-all). The
  region is open at both ends — the boundary lines themselves are
  not part of the case body and are excluded from the count.
- **Complement region**: everything in
  [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L1) that is
  not part of the region above.

Required gate output: the literal occurs exactly once in the region
and zero times in the complement. The "exactly once in module"
property is implied by the conjunction of those two and need not be
asserted separately; the round-5 plan asserts the two scoped counts
directly.

### 3.3 Helper-body literal — region: the `globToRegExp` function body

The branch `pattern.length === 0` must be absent from the body of
`globToRegExp` under any wording. The location requirement is
recorded at [02-design-r4.md §3.3](02-design-r4.md#L116-L120).
Round 5 pins the lexical region for the gate to the full helper
body, not a fixed `-nA 25` window:

- **Region start**: the line matching `^function globToRegExp` in
  [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L1).
- **Region end**: the first subsequent line starting a new
  top-level declaration — `^function `, `^const `, `^let `,
  `^class `, `^export `, or `^interface `. The boundary line
  itself is excluded.

The region therefore extends from the helper's signature through
its closing brace, regardless of the helper's exact line count. The
r3 helper at [02-design-r3.md](02-design-r3.md#L78-L120) is about
40 lines long; the round-5 region covers all of them and would
continue to cover the helper if a future writer added segments.

Required gate output: zero occurrences of `pattern.length === 0`
in the region.

### 3.4 Self-consistency check

The round-4 self-consistency table at
[03-plan-r4.md](03-plan-r4.md#L110-L127) is preserved. The
round-5 region narrowing adds two further regressions the gates
now reject:

- **Helper-mislocated handler string.** If a writer copies the
  handler error literal into `globToRegExp` (or any helper) and
  fails to add it to `case "search_files":`, the round-4 presence
  gate sees one whole-module hit and accepts. The round-5 presence
  gate counts zero hits in the awk-extracted case body and rejects.
- **Late-helper-line defence-in-depth.** If a writer reintroduces
  `if (pattern.length === 0) throw …` past the 25th line of
  `globToRegExp` (for example, inside the new segment loop), the
  round-4 helper-body gate's `-nA 25` window does not cover that
  branch and accepts. The round-5 helper-body gate's range extends
  to the next top-level declaration and rejects.

The three round-5 gates are jointly satisfiable only by the r3
design exactly as written, in the lexical regions r3 writes the
literals into.

## 4. Test gates — r3 summary preserved

Unchanged from [02-design-r4.md §4](02-design-r4.md#L130-L139). The
behavioural assertions (`INVALID_ARGUMENT` for empty pattern;
`INVALID_PATTERN` for malformed-non-empty glob; root-opendir rows
in the root-error table) are unchanged. Round 5 only refines the
source-literal gate substrate.

## 5. Risks — unchanged

See [02-design-r3.md](02-design-r3.md#L520-L525). Round 5 adds no
new risks; it narrows the substrate two grep gates run on without
altering any behavioural code.
