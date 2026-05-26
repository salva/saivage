# G32 — Analysis r3

**Finding**: [../G32-builtins-search-files-find-subprocess.md](../G32-builtins-search-files-find-subprocess.md)

**Round 1 baseline**: [01-analysis-r1.md](01-analysis-r1.md)

**Round 2 baseline**: [01-analysis-r2.md](01-analysis-r2.md)

**Round 2 review**: [04-review-r2.md](04-review-r2.md)

**Writer**: Claude Opus 4.7 (round 3)

Round 3 keeps the round-1 root-cause analysis and the round-2
clarifications verbatim. The two blockers the reviewer raised in
[04-review-r2.md](04-review-r2.md) live entirely in
[02-design-r2.md](02-design-r2.md) and
[03-plan-r2.md](03-plan-r2.md); round 3 rewrites those documents.
This document only records the analysis-level consequences of the
two round-3 fixes.

## 1. Reviewer concerns at the analysis layer

[04-review-r2.md](04-review-r2.md) records no required change against
[01-analysis-r2.md](01-analysis-r2.md). Both blockers are
design/plan-layer contract holes:

- Blocker 1 — "Do not report a root opendir failure as a recoverable
  skipped subtree" at
  [04-review-r2.md](04-review-r2.md#L19-L31) — affects the handler
  snippet in
  [02-design-r2.md §3.4](02-design-r2.md#L317-L329) and the
  per-entry policy table in
  [02-design-r2.md §3.7](02-design-r2.md#L498-L518).
- Blocker 2 — "Make the empty-pattern error code single-sourced" at
  [04-review-r2.md](04-review-r2.md#L33-L44) — affects the glob
  matrix in
  [02-design-r2.md §3.2](02-design-r2.md#L188-L201), the error-code
  table in
  [02-design-r2.md §3.6](02-design-r2.md#L468-L478), the design-layer
  test-gate summary in
  [02-design-r2.md §5](02-design-r2.md#L571-L572), and the
  plan-layer rejection list in
  [03-plan-r2.md §5.3](03-plan-r2.md#L255-L264).

## 2. Analysis-level consequences of the round-3 fixes

### 2.1 Root traversal failure is a hard error, not a partial success

The round-2 per-entry policy at
[01-analysis-r2.md §2.3](01-analysis-r2.md#L62-L78) split mid-walk
failures into recoverable subtree errors (`skipped[]`) and
unrecoverable traversal errors (`READ_DIRECTORY_FAILED`). That split
was correct for **child** directories: a deep subtree losing read
permission while a 50-file project is being searched is a routine
outcome that must not erase the other 49 matches.

The split is wrong when applied to the **root**. The user supplied
a single directory; if it cannot be opened, the search did not
succeed on a smaller scope — it did not run. Returning
`isError: false` with `files: []` and `skipped: [{ path: root, code:
"PERMISSION_DENIED" }]` is dishonest in the same way that the
round-1 truncation bug was dishonest: the envelope's primary fields
report success on a request that failed.

The round-3 analysis-level rule:

- The root opendir is part of the **request-validation** boundary,
  not the **traversal-policy** boundary. It is the natural
  continuation of `stat(dir)`: `stat` proves the path resolves to a
  directory; `opendir` proves the directory is readable. Both
  belong to the same root-level error table that already produces
  `NOT_FOUND`, `NOT_A_DIRECTORY`, `PERMISSION_DENIED`, and
  `IO_ERROR` per the G31 r3 classifier at
  [../G31/02-design-r3.md](../G31/02-design-r3.md#L48-L99).
- The mid-walk recoverable/unrecoverable split applies at depths
  `>= 1`, exactly where the round-2 design intended it but the
  snippet did not enforce it.

This is not a new failure mode; it is a fence-line move between two
existing failure modes. Total error-code surface is unchanged
(`PERMISSION_DENIED` already exists from the root-`stat` path; the
round-3 fix routes root-`opendir` failures to the same code).

### 2.2 Empty pattern is an argument-validation failure, not a syntax failure

`INVALID_ARGUMENT` and `INVALID_PATTERN` answer two different
questions:

- `INVALID_ARGUMENT` — "this request is not a well-formed call into
  search_files". The pattern field is missing, non-string, or empty.
  The runtime never attempted glob compilation.
- `INVALID_PATTERN` — "this is a well-formed call, but the glob
  syntax is malformed". Compilation was attempted and failed
  (unterminated `[...]`, `**` mixed inside a segment).

An empty pattern fails the first test. It cannot even be classified
as "well-formed but malformed glob syntax" — there is no glob to
parse. Treating it as `INVALID_PATTERN` would conflate the two
contracts and make `INVALID_PATTERN` mean "any complaint about the
pattern field", which dilutes its agent-facing meaning.

Round 3 fixes the contradiction by deleting the empty-pattern row
from the `INVALID_PATTERN` matrix and from the design-layer test-gate
summary, leaving only the handler-level `INVALID_ARGUMENT` rejection.
The internal `globToRegExp` empty-string guard in
[02-design-r2.md §3.2](02-design-r2.md#L108-L110) becomes
unreachable dead code under the new contract and is deleted —
keeping it would be a defence-in-depth fig leaf that the workspace
"no migration shims, no obsolete code" rule rejects.

### 2.3 Symmetry with G31 r3

The G31 r3 contract at
[../G31/02-design-r3.md](../G31/02-design-r3.md#L19-L46) keeps
"argument shape" errors (`INVALID_ARGUMENT`) separate from "operation
failed on a valid argument" errors (`NOT_FOUND`, `PERMISSION_DENIED`,
`IO_ERROR`). Both round-3 fixes pull G32 toward that same shape:

- Root traversal failure is an operation-failed-on-a-valid-argument
  error (the argument resolved to a directory; the directory then
  refused to open). It joins the same code surface as root-`stat`
  failure.
- Empty pattern is an argument-shape error. It joins the same code
  surface as `max_results: -1` and non-string `pattern`.

After round 3 the G32 error contract is one consistent table; there
is no longer a single failure whose code depends on which internal
code path observes it first.

## 3. No new findings

Round 3 reviewed
[src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L1) again for
new callers of `search_files` and for any caller branching on the
specific error codes the round-2 design emits. None found. The
pre-G30 handler at
[src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L262) still
shells out to `find(1)` and returns a plain `{ files }` shape; no
in-process consumer reads any of the codes G32 introduces. The two
fixes are pure contract clarifications; no implementation surface
outside the new handler is affected.
