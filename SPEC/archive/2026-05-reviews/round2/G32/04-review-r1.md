# G32 — Review r1

**Reviewer**: GPT-5.5 (Copilot)

**Inputs reviewed**: [SPEC/v2/review-2026-05-round2/G32-builtins-search-files-find-subprocess.md](../G32-builtins-search-files-find-subprocess.md#L1), [SPEC/v2/review-2026-05-round2/G32/01-analysis-r1.md](01-analysis-r1.md#L1), [SPEC/v2/review-2026-05-round2/G32/02-design-r1.md](02-design-r1.md#L1), [SPEC/v2/review-2026-05-round2/G32/03-plan-r1.md](03-plan-r1.md#L1), [SPEC/v2/review-2026-05-round2/G30/APPROVED.md](../G30/APPROVED.md#L1), [SPEC/v2/review-2026-05-round2/G31/02-design-r2.md](../G31/02-design-r2.md#L1), [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L1), [src/mcp/builtins.test.ts](../../../../src/mcp/builtins.test.ts#L1), [src/mcp/fsGuard.test.ts](../../../../src/mcp/fsGuard.test.ts#L1), [src/config.ts](../../../../src/config.ts#L137)

## Summary

Removing the host `find(1)` subprocess is the right architectural direction. The live handler still contradicts the in-process banner by invoking `execFileAsync("find", ...)` and swallowing all failures as empty success at [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L314-L326), while the module still advertises “no subprocess spawning” at [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L4-L5) and [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L1069-L1070). The proposed config keys `maxSearchResults`, `maxSearchDepth`, and `maxSearchMs` are well named and fit the existing cap block in [src/config.ts](../../../../src/config.ts#L137-L144).

I cannot approve r1 yet. The direction is good, but the concrete algorithm and merge plan have correctness holes that would ship misleading results and brittle sequencing.

## Required Changes

### 1. Fix `max_results` and truncation semantics before implementation

The design allows a non-negative `max_results` at [SPEC/v2/review-2026-05-round2/G32/02-design-r1.md](02-design-r1.md#L156-L160) and parses it with `parseNonNegativeInt` at [SPEC/v2/review-2026-05-round2/G32/02-design-r1.md](02-design-r1.md#L197), but the proposed walker pushes a match before checking the cap at [SPEC/v2/review-2026-05-round2/G32/02-design-r1.md](02-design-r1.md#L288-L290). That means `max_results: 0` returns one file if any file matches, violating the cap. It also means `max_results: N` sets `truncated_reason: "results"` as soon as the Nth match is added, even when there is no N+1th match. The success envelope promised at [SPEC/v2/review-2026-05-round2/G32/02-design-r1.md](02-design-r1.md#L400-L403) would therefore report false truncation at exact boundaries.

Required fix: decide whether `max_results: 0` is valid. If valid, return zero files and `truncated_reason: "results"` only if at least one match exists. If invalid, make both schema and helper positive-only for this argument. For the normal case, detect truncation by finding one extra match or by checking before appending and only setting `truncated_reason` when an additional match is actually suppressed. Add tests for zero, exact-boundary, and over-boundary result counts; the current plan only tests the over-boundary case at [SPEC/v2/review-2026-05-round2/G32/03-plan-r1.md](03-plan-r1.md#L223-L225).

### 2. Correct the `**` glob translator contract

The design says `**` means zero or more path segments and must be an entire segment at [SPEC/v2/review-2026-05-round2/G32/02-design-r1.md](02-design-r1.md#L327-L330), but the implementation treats any adjacent pair of asterisks as special at [SPEC/v2/review-2026-05-round2/G32/02-design-r1.md](02-design-r1.md#L337-L344). This accepts non-segment forms such as `foo**bar` as recursive path syntax instead of rejecting them or treating them as two ordinary `*` tokens.

The replacement `(?:.*/)?` also does not implement all common segment positions. It handles `**/*.ts` and `src/**/*.ts` as documented at [SPEC/v2/review-2026-05-round2/G32/02-design-r1.md](02-design-r1.md#L421-L423), but `src/**` compiles to a pattern that matches `src/`-like directory suffixes rather than files beneath `src`. The bare `**` edge case is documented as returning no files at [SPEC/v2/review-2026-05-round2/G32/02-design-r1.md](02-design-r1.md#L426), but that is a sign the translator is not honoring the stated “zero or more path segments” contract.

Required fix: make `**` segment-aware. Cover at least `**/*`, `**/*.ts`, `src/**`, `src/**/*`, `a/**/b.ts`, bare `**`, and invalid/non-segment `**` placement in the test matrix. Keep the existing coverage for `*`, `?`, `[ab]`, and regex metacharacter escaping. If the intended dialect intentionally excludes `src/**` or bare `**`, say that in the schema and tests instead of claiming generic zero-or-more segment support.

### 3. Tighten structured-error and partial-result coverage

The proposed error table covers `INVALID_ARGUMENT`, `INVALID_PATTERN`, and `NOT_A_DIRECTORY` at [SPEC/v2/review-2026-05-round2/G32/02-design-r1.md](02-design-r1.md#L391-L399), and that is the right G31-style envelope shape; G31 r2 defines the same `{ content: { error, code, ...context }, isError: true }` policy at [SPEC/v2/review-2026-05-round2/G31/02-design-r2.md](../G31/02-design-r2.md#L350-L360). However, the walker outline only catches `opendir(current)` failures and silently skips those subtrees at [SPEC/v2/review-2026-05-round2/G32/02-design-r1.md](02-design-r1.md#L264-L272). It does not define what happens if async directory iteration itself throws after a handle opens, nor does the test plan exercise unexpected traversal errors.

Required fix: either translate unexpected walker failures into a structured `SEARCH_FAILED` or `READ_DIRECTORY_FAILED` code, or explicitly document and test that all recoverable subtree failures are skipped while unrecoverable failures surface with a stable code. Keep the permission-denied subtree test, but add coverage for the failure policy rather than relying on an unstructured rejection path.

### 4. Make G31 sequencing architecture-first instead of temporary duplication

G30 is correctly treated as a hard prerequisite: it is the approved async-fs baseline in [SPEC/v2/review-2026-05-round2/G30/APPROVED.md](../G30/APPROVED.md#L1-L7), and the live file is still pre-G30 with sync imports/usages at [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L15-L26), [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L276-L304), and [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L609). The G31 story is weaker. The plan says to declare a local duplicate `parseNonNegativeInt` if G31 has not landed and mark it with a later dedup comment at [SPEC/v2/review-2026-05-round2/G32/03-plan-r1.md](03-plan-r1.md#L27-L33), while G31 r2 already owns that helper at [SPEC/v2/review-2026-05-round2/G31/02-design-r2.md](../G31/02-design-r2.md#L323-L333).

That is a migration shim in a same-file edit zone, not architecture-first sequencing. G32 also touches the same config block, module cap block, import area, helper area, test file, and register-time wiring that G31 touches, even if the switch branches are disjoint.

Required fix: make G31 a hard prerequisite, or move `parseNonNegativeInt` into a deliberately shared local helper in the first PR that lands and have the other PR reuse it without temporary comments. The sequencing table should say G31 is not fully disjoint; only the `read_file` and `search_files` handler bodies are disjoint.

### 5. Fix the regression-guard file assumptions

The plan asks pre-flight and merge gates to run a no-sync guard path at [SPEC/v2/review-2026-05-round2/G32/03-plan-r1.md](03-plan-r1.md#L35-L36), [SPEC/v2/review-2026-05-round2/G32/03-plan-r1.md](03-plan-r1.md#L276-L278), and [SPEC/v2/review-2026-05-round2/G32/03-plan-r1.md](03-plan-r1.md#L321). That path is not present in this checkout; the existing nearby guard file is [src/mcp/fsGuard.test.ts](../../../../src/mcp/fsGuard.test.ts#L1-L4), and G30’s approved shared infrastructure is [SPEC/v2/review-2026-05-round2/G30/APPROVED.md](../G30/APPROVED.md#L7), which names a scanner module rather than the plan’s test path.

Required fix: re-anchor the test gate after G30 lands and name the actual guard file(s) that exist in the post-G30 tree. Do not leave a plan that depends on a missing file. Also keep the dedicated no-`find(1)` source assertion proposed at [SPEC/v2/review-2026-05-round2/G32/03-plan-r1.md](03-plan-r1.md#L255-L269), because the no-sync scanner alone does not prove that `search_files` stopped using a subprocess.

## Notes

- The analysis correctly de-emphasizes command injection: `execFile` avoids shell interpolation, so the root issue is portability, process dependency, and opaque failure behavior rather than shell injection. That correction is well framed in [SPEC/v2/review-2026-05-round2/G32/01-analysis-r1.md](01-analysis-r1.md#L103-L126).
- The config names and defaults are acceptable: `maxSearchResults: 1_000`, `maxSearchDepth: 20`, and `maxSearchMs: 10_000` at [SPEC/v2/review-2026-05-round2/G32/02-design-r1.md](02-design-r1.md#L106-L108) are clear and consistent with the existing `mcp` cap style at [src/config.ts](../../../../src/config.ts#L137-L144).
- The plan anchor for the current `search_files` schema and handler matches the live pre-G30 file at [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L262-L327). The plan is right to require re-anchoring after G30, but the same re-anchor pass must cover G31’s helper/config/cap edits.
- Returning absolute paths preserves the current `find` behavior because `find` is invoked with an absolute resolved directory at [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L312-L320). If the desired future contract is repo-relative paths, that should be an explicit breaking change and tested as such; r1 implicitly keeps absolutes.

VERDICT: CHANGES_REQUESTED