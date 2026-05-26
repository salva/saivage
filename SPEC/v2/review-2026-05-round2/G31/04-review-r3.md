# G31 - Review r3

**Reviewer**: GPT-5.5
**Verdict**: CHANGES_REQUESTED

Round 3 fixes the central r2 design gap in the right direction: `stat`, `open`, and `handle.read` failures are now routed through a small `classifyFsError` helper, and the contract now names `NOT_FOUND`, `PERMISSION_DENIED`, `NOT_A_FILE`, and `IO_ERROR` explicitly. The r2 window accounting and file-head NUL-probe semantics are preserved in the complete handler assembly: it still records `probeRead.bytesRead` / `winRead.bytesRead`, slices by actual bytes read, and uses an `isBinary` flag to return `BINARY_CONTENT` after `finally` without doing the window read.

I cannot approve yet because the r3 test plan and the remaining close path still leave the exhaustive structured-error claim too strong.

## Blocking Findings

1. **The planned `IO_ERROR` regression test cannot work as written in this ESM/Vitest repo.** The plan stubs `node:fs/promises.open` with `vi.spyOn(fsPromises, "open")` in [SPEC/v2/review-2026-05-round2/G31/03-plan-r3.md](03-plan-r3.md#L343-L354), but this package is native ESM in [package.json](../../../../package.json#L5), and Vitest cannot spy on the non-configurable `node:fs/promises` module namespace export. I verified the exact pattern from the plan in this workspace and it fails with `Cannot spy on export "open". Module namespace is not configurable in ESM.` As a result, the required dedicated `IO_ERROR` test is not actually implementable from this plan. Required change: use a testable import/mocking strategy, such as a pre-import `vi.mock("node:fs/promises", ...)` with isolated module loading, a tiny module-local filesystem adapter that tests can spy on, or an exported/internal classifier unit test plus runtime coverage for the reachable filesystem paths.

2. **The classifier's `NOT_A_FILE` branch is explicitly left untested.** The r3 contract says `NOT_A_FILE` is emitted both by the existing `!st.isFile()` branch and by `EISDIR` from `open` in [SPEC/v2/review-2026-05-round2/G31/02-design-r3.md](02-design-r3.md#L35-L38), and the helper itself returns `NOT_A_FILE` for `EISDIR` in [SPEC/v2/review-2026-05-round2/G31/02-design-r3.md](02-design-r3.md#L85-L91). But the test plan keeps only the r2 directory case and makes the `EISDIR` fold-in optional, then says not to add it in [SPEC/v2/review-2026-05-round2/G31/03-plan-r3.md](03-plan-r3.md#L363-L369). The r2 directory test in [SPEC/v2/review-2026-05-round2/G31/03-plan-r2.md](03-plan-r2.md#L335-L340) exercises `!st.isFile()`, not `classifyFsError`. Since the r3 prompt requires dedicated coverage for each classifier code, `EISDIR -> NOT_A_FILE` needs a real test once the mocking strategy in finding 1 is fixed.

3. **A `handle.close()` rejection still escapes the structured-error contract.** The design says the code list is the full contract and no error path escapes raw in [SPEC/v2/review-2026-05-round2/G31/02-design-r3.md](02-design-r3.md#L40-L41). However, the complete handler still awaits `handle.close()` unguarded in `finally` in [SPEC/v2/review-2026-05-round2/G31/03-plan-r3.md](03-plan-r3.md#L216-L220). If `close()` rejects, `McpRuntime.callTool` receives a raw handler rejection rather than a returned `isError: true` envelope, bypassing the structured serialization path in [src/mcp/runtime.ts](../../../../src/mcp/runtime.ts#L188-L193). It can also mask a previously classified `readFailure` or a detected binary file because the post-`finally` branches have not run yet. Required change: either include close failures in the structured `IO_ERROR` path, or narrow the exhaustive contract so it no longer claims all filesystem error paths are covered.

## R3 Change Verification

| Requirement | r3 status |
| --- | --- |
| Address the r2 blocker for `stat` / `open` raw failures. | Mostly addressed. `stat` and `open` are wrapped and classified in [SPEC/v2/review-2026-05-round2/G31/03-plan-r3.md](03-plan-r3.md#L117-L125) and [SPEC/v2/review-2026-05-round2/G31/03-plan-r3.md](03-plan-r3.md#L176-L182). The remaining raw `close()` path keeps the exhaustive contract from being fully true. |
| Cover `handle.read` failures with `classifyFsError`. | Addressed for read failures themselves. The plan captures read rejections through `classifyFsError(..., "read")` in [SPEC/v2/review-2026-05-round2/G31/03-plan-r3.md](03-plan-r3.md#L190-L220). |
| Add dedicated tests for `NOT_FOUND`, `PERMISSION_DENIED`, `NOT_A_FILE`, and `IO_ERROR`. | Not yet. `NOT_FOUND` and `PERMISSION_DENIED` have concrete cases in [SPEC/v2/review-2026-05-round2/G31/03-plan-r3.md](03-plan-r3.md#L309-L336). The `PERMISSION_DENIED` chmod-`0o000` case is correctly gated for root via `process.getuid()` in [SPEC/v2/review-2026-05-round2/G31/03-plan-r3.md](03-plan-r3.md#L320-L336). `IO_ERROR` is specified but uses an invalid spy strategy, and `NOT_A_FILE` through the classifier is intentionally not tested. |
| Preserve r2 windowed-read accounting. | Addressed. The r3 handler still uses `probeRead.bytesRead` and `winRead.bytesRead`, reuses the probe buffer only when safe, and computes `truncated` from actual bytes read in [SPEC/v2/review-2026-05-round2/G31/03-plan-r3.md](03-plan-r3.md#L192-L246). |
| Preserve r2 NUL-probe semantics. | Addressed. The probe still reads the file head independent of the requested window, sets `isBinary`, skips the window read, closes the handle, then returns `BINARY_CONTENT` in [SPEC/v2/review-2026-05-round2/G31/03-plan-r3.md](03-plan-r3.md#L192-L234). |
| Keep live-code sequencing honest. | Addressed. The live implementation is still pre-G30, with sync imports and `readFileSync` in [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L18-L25) and [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L274-L277), and r3 keeps the re-anchor/G30 sequencing requirement. |

## Required Round-4 Change

Keep the r3 classifier direction, but fix the testability story before implementation: make the `IO_ERROR` and `EISDIR -> NOT_A_FILE` cases executable in this ESM/Vitest setup, and classify or explicitly scope out `handle.close()` failures. The chmod-`0o000` permission test and the r2 read-accounting/NUL-probe carry-forward are otherwise in good shape.

VERDICT: CHANGES_REQUESTED