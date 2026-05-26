# G48 — Review (Round 1)

- Reviewed: [SPEC/v2/review-2026-05-round2/G48/01-analysis-r1.md](SPEC/v2/review-2026-05-round2/G48/01-analysis-r1.md), [SPEC/v2/review-2026-05-round2/G48/02-design-r1.md](SPEC/v2/review-2026-05-round2/G48/02-design-r1.md), [SPEC/v2/review-2026-05-round2/G48/03-plan-r1.md](SPEC/v2/review-2026-05-round2/G48/03-plan-r1.md)
- Issue: [SPEC/v2/review-2026-05-round2/G48-cli-inspect-runtime-leak-on-throw.md](SPEC/v2/review-2026-05-round2/G48-cli-inspect-runtime-leak-on-throw.md)
- Live anchors: [src/server/cli.ts](src/server/cli.ts), [src/server/bootstrap.ts](src/server/bootstrap.ts), [src/agents/inspector.ts](src/agents/inspector.ts)

## Summary

Round 1 correctly identifies the primary bug: `inspect` calls `bootstrap()` and only reaches `runtime.shutdown()` on the success path, so failures after a runtime is returned can skip teardown. Proposal B is the better architecture-first direction: a shared short-lived CLI lifecycle helper for `start` and `inspect` removes the copy-paste lifecycle contract, while excluding `serve` is correct because it owns a long-lived server and signal-driven shutdown path.

Changes are still required before this should be approved. The biggest gaps are in the proposed test architecture: importing the CLI module for `__withRuntime` will execute `program.parse()` at module load, and T7's `process.getActiveResourcesInfo()` comparison can miss exactly the kind of leaked resources it is meant to catch.

## Required Changes

1. The proposed `__withRuntime` test seam is not viable while [src/server/cli.ts](src/server/cli.ts#L583) calls `program.parse()` at top level.

   [SPEC/v2/review-2026-05-round2/G48/03-plan-r1.md](SPEC/v2/review-2026-05-round2/G48/03-plan-r1.md#L19) and [SPEC/v2/review-2026-05-round2/G48/03-plan-r1.md](SPEC/v2/review-2026-05-round2/G48/03-plan-r1.md#L57) plan to import `__withRuntime` from the CLI entry module. That import will also register commands and parse Vitest's argv, which can exit or fail before the helper tests run. The clean fix is to put the helper in a side-effect-free module next to the CLI, import it from [src/server/cli.ts](src/server/cli.ts), and test that module directly. A guarded parse entrypoint is also possible, but splitting the lifecycle helper is cleaner and avoids exporting a test-only symbol from the executable CLI module.

2. T7 does not use `process.getActiveResourcesInfo()` strongly enough to prove the leak is fixed.

   [SPEC/v2/review-2026-05-round2/G48/03-plan-r1.md](SPEC/v2/review-2026-05-round2/G48/03-plan-r1.md#L154-L168) stores `new Set(process.getActiveResourcesInfo())` before bootstrap and filters by resource kind afterward. `process.getActiveResourcesInfo()` returns resource type names, not individual handles, so a baseline `Timeout`, `PipeWrap`, or similar kind can hide additional leaked resources of the same kind. The test should compare per-kind counts, assert no positive delta for leak-sensitive kinds after teardown, and avoid broad allow-listing that masks MCP child pipes, process handles, or supervisor timers. If this remains an e2e-style test, keep it in a separate spec or reset modules carefully; the unit-test file's top-level bootstrap mock plan conflicts with using the actual `bootstrap()` for T7.

3. The bootstrap-failure claim and the proposed fix are out of sync.

   [SPEC/v2/review-2026-05-round2/G48/01-analysis-r1.md](SPEC/v2/review-2026-05-round2/G48/01-analysis-r1.md#L9) says a throw inside `bootstrap(...)` after lock acquisition leaks runtime resources. The recommended helper cannot call `runtime.shutdown()` when `bootstrap()` rejects before returning a runtime, and T3 in [SPEC/v2/review-2026-05-round2/G48/03-plan-r1.md](SPEC/v2/review-2026-05-round2/G48/03-plan-r1.md#L80-L84) explicitly expects no shutdown in that case. Either narrow the analysis to failures after `bootstrap()` resolves, which is enough for the `inspect` bug, or broaden the design to make [src/server/bootstrap.ts](src/server/bootstrap.ts#L169-L174) transactional so partial bootstrap failures release acquired resources.

4. The helper test matrix is close but should include the missing shutdown-only failure policy.

   T1-T6 cover happy path, callback throw, bootstrap throw, `process.exitCode`, shutdown failure during an existing failure, and exactly-once shutdown. Add a case where the callback succeeds and `runtime.shutdown()` rejects, because that is the only test that pins whether a teardown-only failure exits 0 or 1. The design currently says shutdown rejections are logged and do not change `process.exitCode`; the tests should make that explicit.

5. The grep invariant is useful, but it is not yet codified as a regression guard.

   [SPEC/v2/review-2026-05-round2/G48/03-plan-r1.md](SPEC/v2/review-2026-05-round2/G48/03-plan-r1.md#L35-L38) lists manual grep commands for `await bootstrap(` and `await runtime.shutdown()`. If this is intended to enforce the invariant, make it an automated test or a checked script with exact expected counts and the documented `serve` exception. Also avoid a pattern that only catches the variable name `runtime`; a future `const rt = await bootstrap(...)` would bypass the grep without bypassing the bug.

6. Align the stated operator-facing behavior with the live `start` command.

   [SPEC/v2/review-2026-05-round2/G48/02-design-r1.md](SPEC/v2/review-2026-05-round2/G48/02-design-r1.md#L226-L227) says the `Error:` prefix is preserved from current `inspect` and `start` paths, but [src/server/cli.ts](src/server/cli.ts#L84-L89) currently logs `Fatal:` in `start`. Architecture-first does not require preserving that exact string, but the document should either preserve it deliberately or state that Proposal B intentionally normalizes short-lived runtime command errors.

## Checks Against Review Axes

- Bug localization: correct for the post-bootstrap `inspect` teardown bug at [src/server/cli.ts](src/server/cli.ts#L217-L270), but the bootstrap-partial-failure wording needs narrowing or a larger fix.
- Proposal choice: Proposal B is cleaner than Proposal A. Sharing a lifecycle helper between `start` and `inspect` is the right level-up move, and excluding `serve` is documented for the right reason.
- Tests: T1-T6 are the right categories, modulo the import side effect and the missing shutdown-only failure case. T7 needs per-kind count accounting and isolation from the mocked-bootstrap unit tests.
- Grep invariants: the intended invariant is right, but it should be automated and less variable-name fragile.
- New principles: no user-intent regex and no agent-tool-call heuristics are introduced. No new operator-tuned hardcoded values are needed. The active-resource allow-list in T7 is a fragile test heuristic and should be tightened.
- Architecture-first compliance: the selected design is architecture-first, but exporting a double-underscore helper from the side-effectful CLI entrypoint is not. A side-effect-free helper module would match the stated principle better.

VERDICT: CHANGES_REQUESTED