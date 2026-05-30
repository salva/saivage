# G32 — Review r2

**Reviewer**: GPT-5.5 (Copilot)

**Inputs reviewed**: [SPEC/v2/review-2026-05-round2/G32/01-analysis-r2.md](01-analysis-r2.md#L1), [SPEC/v2/review-2026-05-round2/G32/02-design-r2.md](02-design-r2.md#L1), [SPEC/v2/review-2026-05-round2/G32/03-plan-r2.md](03-plan-r2.md#L1), [SPEC/v2/review-2026-05-round2/G32/04-review-r1.md](04-review-r1.md#L1), [SPEC/v2/review-2026-05-round2/G30/APPROVED.md](../G30/APPROVED.md#L1), [SPEC/v2/review-2026-05-round2/G31/02-design-r3.md](../G31/02-design-r3.md#L1), [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L1), [src/mcp/builtins.test.ts](../../../../src/mcp/builtins.test.ts#L1), [src/mcp/fsGuard.test.ts](../../../../src/mcp/fsGuard.test.ts#L1), [src/config.ts](../../../../src/config.ts#L137)

## Summary

Round 2 addresses most of the round-1 numbered feedback. The `max_results` boundary matrix is now exact at [SPEC/v2/review-2026-05-round2/G32/02-design-r2.md](02-design-r2.md#L55-L77) and the test plan covers zero, exact-boundary, and over-boundary cases at [SPEC/v2/review-2026-05-round2/G32/03-plan-r2.md](03-plan-r2.md#L271-L290). The glob translator is now segment-aware, rejects `foo**bar` / `**foo` / `foo**`, and covers `src/**`, bare `**`, and `a/**/b.ts` at [SPEC/v2/review-2026-05-round2/G32/02-design-r2.md](02-design-r2.md#L95-L200). G31 is correctly promoted to a hard prerequisite, reusing `parseNonNegativeInt` and `classifyFsError` rather than adding local duplicates at [SPEC/v2/review-2026-05-round2/G32/02-design-r2.md](02-design-r2.md#L426-L439).

I cannot approve r2 yet. The traversal-error policy still has one root-vs-child classification hole, and the empty-pattern error code is contradictory across the design and plan.

## Required Changes

### 1. Do not report a root `opendir` failure as a recoverable skipped subtree

The handler validates the supplied directory with `stat(dir)` at [SPEC/v2/review-2026-05-round2/G32/02-design-r2.md](02-design-r2.md#L270), then calls `visit(dir, 0)` at [SPEC/v2/review-2026-05-round2/G32/02-design-r2.md](02-design-r2.md#L384). Inside `visit`, any `opendir(current)` failure is treated as a mid-walk subtree failure at [SPEC/v2/review-2026-05-round2/G32/02-design-r2.md](02-design-r2.md#L317-L329): `PERMISSION_DENIED` and `NOT_FOUND` are pushed into `skipped` and the tool returns a successful envelope.

That is wrong for the first `visit(dir, 0)` call. A directory can `stat` successfully and still fail `opendir` with `EACCES` / `EPERM`; it can also disappear between `stat` and `opendir`. In those root cases, the user-supplied search root was not readable, so returning `isError: false` with an empty `files` array and a root-level `skipped` entry would make a failed search look like a partial success. The structured root error table only covers root `stat` failures at [SPEC/v2/review-2026-05-round2/G32/02-design-r2.md](02-design-r2.md#L448-L451), and the plan tests root `stat` permission failure plus child traversal failures, but not root `opendir` failure, at [SPEC/v2/review-2026-05-round2/G32/03-plan-r2.md](03-plan-r2.md#L302-L331).

Required fix: distinguish the root `opendir(dir)` call from child-subtree `opendir` calls. Root `EACCES` / `EPERM` should return a structured `PERMISSION_DENIED` error, root `ENOENT` / `ENOTDIR` should return the same root-level `NOT_FOUND` / `NOT_A_DIRECTORY` policy chosen for `stat`, and unexpected root `opendir` errors should fail rather than populate `skipped`. Keep `skipped` only for child subtrees. Add a test that stubs or constructs a root `opendir` denial after a successful `stat` and asserts the call rejects with the root error code and no success envelope.

### 2. Make the empty-pattern error code single-sourced

Round 2 still gives empty patterns two different contracts. The replacement glob matrix says the empty pattern is `INVALID_PATTERN` at [SPEC/v2/review-2026-05-round2/G32/02-design-r2.md](02-design-r2.md#L197), and the design-layer test-gate summary says `foo**bar`, `**foo`, `foo**`, and empty pattern all return `INVALID_PATTERN` at [SPEC/v2/review-2026-05-round2/G32/02-design-r2.md](02-design-r2.md#L571-L572). But the actual handler rejects empty strings before calling `globToRegExp`, returning `INVALID_ARGUMENT` at [SPEC/v2/review-2026-05-round2/G32/02-design-r2.md](02-design-r2.md#L223-L230), and the plan expects `INVALID_ARGUMENT` for empty pattern at [SPEC/v2/review-2026-05-round2/G32/03-plan-r2.md](03-plan-r2.md#L255-L264) and [SPEC/v2/review-2026-05-round2/G32/03-plan-r2.md](03-plan-r2.md#L302-L305).

Required fix: choose one code and make every table, summary, handler snippet, and test row agree. The cleaner contract is the handler's current one: missing, non-string, or empty `pattern` is `INVALID_ARGUMENT`; syntactically malformed non-empty glob input is `INVALID_PATTERN`. If that is retained, remove the empty-pattern row from the `INVALID_PATTERN` glob matrix and remove “empty pattern” from the design-layer glob rejection summary.

## Verified Fixes From Round 1

- R1 change 1 is addressed: the walker now sets `truncated_reason: "results"` only after discovering an additional suppressed match, and `max_results: 0` is explicitly defined as a match-existence probe at [SPEC/v2/review-2026-05-round2/G32/02-design-r2.md](02-design-r2.md#L55-L77).
- R1 change 2 is addressed: `**` is now a segment operator, and mixed forms such as `foo**bar` are rejected at [SPEC/v2/review-2026-05-round2/G32/02-design-r2.md](02-design-r2.md#L95-L200).
- R1 change 4 is addressed: G31 is now a hard prerequisite, with no temporary helper duplication, at [SPEC/v2/review-2026-05-round2/G32/03-plan-r2.md](03-plan-r2.md#L24-L43) and [SPEC/v2/review-2026-05-round2/G32/03-plan-r2.md](03-plan-r2.md#L154-L166).
- R1 change 5 is mostly addressed: G32 keeps a dedicated no-`find(1)` source assertion at [SPEC/v2/review-2026-05-round2/G32/03-plan-r2.md](03-plan-r2.md#L341-L350) and treats the no-sync guard as a post-G30 artifact at [SPEC/v2/review-2026-05-round2/G32/03-plan-r2.md](03-plan-r2.md#L24-L32). The current checkout is still pre-G30: [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L15-L25) still imports sync fs helpers and [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L310-L320) still shells out to `find`; implementation must not run G32 gates until the G30 deliverables exist.

## Notes

- The current-code anchors in the plan are reasonable for a pre-G30/G31 checkout: the schema and handler anchors still line up with [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L262-L320), the git `execFileAsync` preservation anchor still lines up with [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L918), and the register-time cap block still starts at [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L1071-L1079).
- The no-sync guard inclusion is directionally right. [SPEC/v2/review-2026-05-round2/G30/APPROVED.md](../G30/APPROVED.md#L7) records the shared scanner, while G32's plan separately keeps the no-subprocess assertion because the scanner would not catch `execFileAsync("find", ...)`.

VERDICT: CHANGES_REQUESTED