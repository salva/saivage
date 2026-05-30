# G06 - Review (r2)

Required change count: 0

Proposal A is approved. The r2 analysis, design, and implementation plan address both r1 blockers: the base-agent import is now explicitly trimmed to `stashResult` only, and the stash test fixture now follows the actual [src/config.ts](../../../../src/config.ts#L199-L221) environment contract with `PROJECT_ROOT`, `SAIVAGE_ROOT`, real Vitest hooks, explicit temp `.saivage` creation, and path-containment assertions.

## Review Notes

- The async cascade is complete and appropriately scoped: [src/runtime/stash.ts](../../../../src/runtime/stash.ts) moves to `node:fs/promises`; [src/agents/base.ts](../../../../src/agents/base.ts#L334-L342) awaits `maybeStash` through `Promise.all`; [src/runtime/dispatcher.ts](../../../../src/runtime/dispatcher.ts#L139-L153) awaits `readStash`; and [src/server/bootstrap.ts](../../../../src/server/bootstrap.ts#L204) awaits `cleanStash` during bootstrap.
- The r2 base-agent import trim is required and now correctly planned. Current [src/agents/base.ts](../../../../src/agents/base.ts#L36) imports `readStash` and `cleanStash` even though the file only calls `stashResult`; the plan now removes those dead names before the lint gate in [eslint.config.js](../../../../eslint.config.js#L8-L15).
- The r2 test fixture correction matches the repo pattern in [src/mcp/builtins.test.ts](../../../../src/mcp/builtins.test.ts#L37-L67). It restores both environment variables, creates the temporary `.saivage` root, and asserts that `stashResult` writes under the temporary stash directory instead of silently touching the real project state.
- The dependency on G30's shared `src/testing/noSyncFsScanner.ts` is acceptable as written. The implementation plan's pre-flight step requires confirming that scanner exists and rebasing on G30 if it has not landed; it also correctly forbids re-implementing or vendoring the scanner in G06.
- Proposal B remains correctly rejected for this finding. Stash writes are UUID-unique files, not shared JSON read-modify-write operations, so pulling `LockedJsonFile<T>` forward would add review and security-sensitive blast radius without solving a stash-specific problem.

No further document changes are required before implementation planning can be marked approved.

VERDICT: APPROVED