# G37 - Review (r3)

Reviewer: GPT-5.5

Verdict: Approved.

## Axis Check

- The round-2 blocker is resolved. The r3 regression guard in [02-design-r3.md](02-design-r3.md#L268-L349) and [03-plan-r3.md](03-plan-r3.md#L227-L294) now asserts exactly the two G30 scanner violations produced by the remaining [src/config.ts](../../../src/config.ts#L208) existsSync carve-out: disallowed-named-import existsSync from the named import and sync-call existsSync from the call site.
- This matches the G30 scanner contract. [../G30/02-design-r2.md](../G30/02-design-r2.md#L167-L215) builds a default allowedNamedImports set containing only createWriteStream, reports each non-allowed node:fs named import as disallowed-named-import, and then independently records matching Sync calls through collectSyncCalls.
- The r3 test does not broaden the G30 allow-list, does not switch to a default or namespace node:fs import, and does not add a per-file scanner exception. The carve-out stays local to [src/config.no-sync-fs.test.ts](../../../src/config.no-sync-fs.test.ts) through the post-filter described in [02-design-r3.md](02-design-r3.md#L289-L324).
- The earlier r2-resolved items remain intact: [src/index.ts](../../../src/index.ts#L28-L36) is still explicitly out of scope, G36 remains a hard prerequisite before deleting config ensureDir, the new config tests still reuse existing sync test fixtures, and malformed JSON remains a propagated SyntaxError.
- Current live checkout caveat: [src/config.ts](../../../src/config.ts#L2-L280) is still pre-G37 and pre-G36, and the requested live [src/mcp/no-sync-fs.test.ts](../../../src/mcp/no-sync-fs.test.ts) plus [src/testing/noSyncFsScanner.ts](../../../src/testing/noSyncFsScanner.ts) are not present in this checkout. That does not create a G37 design blocker because [03-plan-r3.md](03-plan-r3.md#L61-L72) correctly gates implementation on G30 and G36 being merged first.

## Findings

No blocking findings.

## Verification Notes

- R2 required the config-only regression test to expect both G30 violation kinds. R3 does that with a stable sort and an exact array assertion in [02-design-r3.md](02-design-r3.md#L314-L328) and [03-plan-r3.md](03-plan-r3.md#L254-L268).
- The exact assertion is appropriately tight: a second existsSync call, a reintroduced readFileSync or mkdirSync, another disallowed named import, or a default/namespace node:fs import in [src/config.ts](../../../src/config.ts) would add another filtered violation and fail the test.
- The G36 sequencing guard remains necessary against the current live tree, where [src/auth/store.ts](../../../src/auth/store.ts#L8-L60) still imports config ensureDir and calls it from saveProfiles.

## Summary

Round 3 fixes the only r2 blocker without reopening the prior issues. The design remains the same: make loadConfig async, remove the stale module cache, delete config ensureDir only after G36, and pin the remaining resolveProjectRoot existsSync as a narrow, test-visible carve-out.

VERDICT: APPROVED