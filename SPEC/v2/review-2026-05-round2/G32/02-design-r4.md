# G32 — Design r4

**Finding**: [../G32-builtins-search-files-find-subprocess.md](../G32-builtins-search-files-find-subprocess.md)

**Analysis**: [01-analysis-r4.md](01-analysis-r4.md#L1) (delta over
[01-analysis-r3.md](01-analysis-r3.md#L1))

**Round 1 baseline**: [02-design-r1.md](02-design-r1.md#L1)

**Round 2 baseline**: [02-design-r2.md](02-design-r2.md#L1)

**Round 3 baseline**: [02-design-r3.md](02-design-r3.md#L1)

**Round 3 review**: [04-review-r3.md](04-review-r3.md#L1)

**Writer**: Claude Opus 4.7 (round 4)

Round 4 makes no contract change. Every section of
[02-design-r3.md](02-design-r3.md#L1) is preserved verbatim and not
restated. The reviewer recorded no required change against the r3
design at the contract layer; the single round-3 blocker at
[04-review-r3.md](04-review-r3.md#L19-L30) is a plan-layer
verification-gate inconsistency and is fixed in
[03-plan-r4.md](03-plan-r4.md#L1).

This document exists to record the design-layer test-gate summary
in r3 wording precisely enough that the r4 plan can ground its
grep gates in the exact literals the design writes into the source
file.

## 1. Recommendation — unchanged

Proposal A from
[02-design-r1.md](02-design-r1.md#L13-L52). Proposal B remains
rejected at
[02-design-r1.md](02-design-r1.md#L54-L84).

## 2. Anchors carried forward unchanged

All of
[02-design-r3.md](02-design-r3.md#L1-L379) is preserved verbatim:

- §3.1 truncation semantics at
  [02-design-r3.md](02-design-r3.md#L55-L60).
- §3.2 glob translator (empty-pattern guard removed) at
  [02-design-r3.md](02-design-r3.md#L62-L78) and
  [02-design-r3.md](02-design-r3.md#L141-L155).
- §3.3 schema at
  [02-design-r3.md](02-design-r3.md#L161-L165).
- §3.4 handler (root-opendir classification) at
  [02-design-r3.md](02-design-r3.md#L167-L370).
- §3.5 helper reuse at
  [02-design-r3.md](02-design-r3.md#L383-L386).
- §3.6 error-code table at
  [02-design-r3.md](02-design-r3.md#L388-L420).
- §3.7 per-entry policy at
  [02-design-r3.md](02-design-r3.md#L422-L450).
- §3.8 no-sync-fs guard at
  [02-design-r3.md](02-design-r3.md#L452-L455).
- §4 sequencing at
  [02-design-r3.md](02-design-r3.md#L457-L460).
- §6 risks at
  [02-design-r3.md](02-design-r3.md#L520-L525).

## 3. Source literals the plan grep gates must match

This section pins the exact literals the r3 design writes into
[src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L1). The r4
plan grounds its grep gates here so that "the gate passes" and "the
r3 design is implemented correctly" are the same condition.

### 3.1 Obsolete literals — must not appear after r3

The round-2 `globToRegExp` guard at
[02-design-r3.md](02-design-r3.md#L65-L67) was:

```ts
if (pattern.length === 0) {
  throw new Error("pattern must be non-empty");
}
```

Round 3 deletes it. After r3 the module contains:

- Zero occurrences of the literal `pattern must be non-empty`.
- Zero `pattern.length === 0` branches inside `globToRegExp`.

These are the only obsolete strings the r3 contract removes. The
"no migration shim" rule forbids retaining the guard even as
defence-in-depth.

### 3.2 New handler literal — must appear exactly once

The round-3 handler at
[02-design-r3.md](02-design-r3.md#L181-L185) writes:

```ts
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
```

After r3 the module contains:

- Exactly one occurrence of the literal
  `INVALID_ARGUMENT: pattern must be a non-empty string`.
- The single occurrence sits inside the `case "search_files":`
  handler body, not inside `globToRegExp`, not inside any helper.

`INVALID_ARGUMENT` itself appears in additional places (the
`max_results` rejection envelope, the test catalogue); the gate
distinguishes the empty-pattern message by anchoring on the full
sentence, not on `INVALID_ARGUMENT` alone.

### 3.3 Self-consistency check

The r4 plan asserts both directions:

- Removal: `grep -c 'pattern must be non-empty' src/mcp/builtins.ts`
  must return 0. A non-zero result means the obsolete guard was
  retained.
- Presence: `grep -c
  'INVALID_ARGUMENT: pattern must be a non-empty string'
  src/mcp/builtins.ts` must return 1. A 0 means the handler was not
  copied from §3.4; a >1 means a duplicate handler arm exists.
- Helper body: a scoped `grep -A` window around `function
  globToRegExp` must show no `pattern.length === 0` line. A hit
  inside that window means the helper still pre-checks the empty
  string.

These three together are jointly satisfiable only by the r3 design
exactly as written. Any retained obsolete guard, any missing
handler copy, and any duplicate of either trips at least one gate.

## 4. Test gates — r3 summary preserved

The design-layer test-gate summary at
[02-design-r3.md](02-design-r3.md#L462-L515) is preserved verbatim.
The behavioural assertions
(`INVALID_ARGUMENT` for empty pattern; `INVALID_PATTERN` for
malformed-non-empty glob; root-opendir rows in the root-error
table) do not change. Round 4 only adds the source-literal gates
in §3 above, which the r4 plan operationalises as `grep` commands.

## 5. Risks — unchanged

See
[02-design-r3.md](02-design-r3.md#L520-L525). Round 4 adds no new
risks; it removes a verification-layer false-positive/false-negative
pair without altering any behavioural code.
