# G06 - Review (r1)

Required change count: 2

Proposal A is the right design direction. The stash module has UUID-unique files, no shared JSON read-modify-write surface, and no need for the locked-file abstraction considered in Proposal B. The in-place `node:fs/promises` migration also matches the F22/G30/G36 precedent, and the plan correctly depends on G30's scanner rather than reimplementing it.

## Required Changes

1. Fix the stash test fixture setup. [SPEC/v2/review-2026-05-round2/G06/02-design-r1.md](SPEC/v2/review-2026-05-round2/G06/02-design-r1.md#L135) and [SPEC/v2/review-2026-05-round2/G06/03-plan-r1.md](SPEC/v2/review-2026-05-round2/G06/03-plan-r1.md#L77) tell the implementer to isolate tests with `SAIVAGE_PROJECT_ROOT`, and the plan also says to use `vi.beforeEach` / `vi.afterEach`. Current path resolution does not read `SAIVAGE_PROJECT_ROOT`: [src/config.ts](src/config.ts#L199-L219) uses `PROJECT_ROOT` and `SAIVAGE_ROOT`, and existing tests preserve and restore those two variables as the local pattern in [src/mcp/builtins.test.ts](src/mcp/builtins.test.ts#L37-L64). As written, the new stash tests would either fail to typecheck because `vi.beforeEach` / `vi.afterEach` are not Vitest hooks, or they would write under the repo/project `.saivage` instead of the temp fixture despite the plan saying not to. Update the design and plan to import/use `beforeEach` and `afterEach`, preserve and restore `PROJECT_ROOT` and `SAIVAGE_ROOT`, create the temp `.saivage` root explicitly, and assert the returned stash paths live under that temp root.

2. Remove the stale names from the touched base-agent import. The analysis records [src/agents/base.ts](src/agents/base.ts#L36) as a named import of all three stash exports in [SPEC/v2/review-2026-05-round2/G06/01-analysis-r1.md](SPEC/v2/review-2026-05-round2/G06/01-analysis-r1.md#L45), and the design says the import is unchanged in [SPEC/v2/review-2026-05-round2/G06/02-design-r1.md](SPEC/v2/review-2026-05-round2/G06/02-design-r1.md#L105). But [src/agents/base.ts](src/agents/base.ts#L36) imports `readStash` and `cleanStash` even though [src/agents/base.ts](src/agents/base.ts#L704) is the only stash use in the file. The repo lint config treats unused variables as errors in [eslint.config.js](eslint.config.js#L8-L12), so leaving that line unchanged conflicts with the plan's lint gate. Update the implementation plan to replace the import with just `stashResult`, and adjust the caller-verification expectations accordingly.

## Accepted Points

- Proposal B should stay rejected for G06. `LockedJsonFile<T>` would solve a different class of shared JSON mutation, while stash writes are independent files.
- Reusing G30's scanner is the correct cross-finding coordination point. The plan's preflight instruction to rebase on G30 rather than vendoring a scanner copy is sufficient.
- The async cascade through `maybeStash`, the dispatcher `read_stash` path, and bootstrap `cleanStash` is otherwise complete.

VERDICT: CHANGES_REQUESTED