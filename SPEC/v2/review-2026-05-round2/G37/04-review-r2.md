# G37 - Review (r2)

Reviewer: GPT-5.5

Verdict: Changes requested.

## Axis Check

- The round-1 barrel blocker is resolved. Round 2 explicitly stops touching [src/index.ts](../../../src/index.ts#L28-L36), and the live barrel still re-exports the async helper from [src/store/documents.ts](../../../src/store/documents.ts#L149-L151), not the sync config helper.
- The live [src/auth/store.ts](../../../src/auth/store.ts#L10) dependency is acknowledged. Round 2 correctly promotes G36 to a hard prerequisite before deleting the config-level `ensureDir` export, with matching gates in [03-plan-r2.md](03-plan-r2.md#L7-L13) and [03-plan-r2.md](03-plan-r2.md#L312-L316).
- G36 as a hard prerequisite is the right sequencing call. The current checkout still imports and calls config `ensureDir` in [src/auth/store.ts](../../../src/auth/store.ts#L10) and [src/auth/store.ts](../../../src/auth/store.ts#L59-L60), while G36's approved design removes that dependency before G37 lands.
- The test fixture mechanics are fixed. Live [src/config.test.ts](../../../src/config.test.ts#L1-L4) already uses sync test helpers, and the r2 plan reuses `mkdirSync` plus `writeFileSync` with a parent-directory create before each new write in [03-plan-r2.md](03-plan-r2.md#L168-L206).
- The malformed-JSON prose is fixed. Round 2 now preserves the live crash-fast `JSON.parse` behavior in [src/config.ts](../../../src/config.ts#L267-L270) and adds a rejection test for it.
- The new project-wide principles do not add extra objections here. This change does not parse analyst user intent, does not introduce a tool-call heuristic, and keeps operational constants in the same documented validation surface as the sibling Saivage findings.

## Findings

1. High - The proposed no-sync-fs guard fails against the G30 scanner contract.

   Round 2 says the new guard scans `roots: ["src"]` with the default G30 allow-list, post-filters to [src/config.ts](../../../src/config.ts), and expects exactly one violation: `{ kind: "sync-call", detail: "existsSync" }` in [02-design-r2.md](02-design-r2.md#L30-L38) and [03-plan-r2.md](03-plan-r2.md#L210-L235). But the scanner defined by G30 reports two classes of data for this case: it flags named imports not in the allow-list as `disallowed-named-import` and then separately records sync calls via `collectSyncCalls` in [../G30/02-design-r2.md](../G30/02-design-r2.md#L167-L215). Because G37 intentionally keeps `import { existsSync } from "node:fs"` in [03-plan-r2.md](03-plan-r2.md#L73-L74), the post-filtered violations for [src/config.ts](../../../src/config.ts#L2) will contain at least both `disallowed-named-import existsSync` and `sync-call existsSync`. The Step 6 `expect(configViolations.length).toBe(1)` assertion will fail on the first validation run.

   Required r3 change: keep the config-only post-filter, but make the expected set match the scanner output. The simplest tight form is to assert exactly the expected config import violation plus exactly one expected `existsSync` call. If the writer instead wants `existsSync` treated as allowed, add a scanner capability that scopes that allowance to [src/config.ts](../../../src/config.ts); do not claim the test uses the default allow-list while expecting the import violation to disappear, and do not globally allow `existsSync` across `src` as a workaround.

## Resolved Round-1 Blockers

- Barrel re-identification: resolved. [02-design-r2.md](02-design-r2.md#L14-L18) and [03-plan-r2.md](03-plan-r2.md#L27-L30) now correctly identify the barrel export as the store/documents helper and leave it alone.
- Auth store dependency: resolved. [01-analysis-r2.md](01-analysis-r2.md#L179-L193) correctly records the live config `ensureDir` consumer and how G36 removes it.
- G36 prerequisite: resolved. [03-plan-r2.md](03-plan-r2.md#L7-L13) and [03-plan-r2.md](03-plan-r2.md#L312-L316) make G36 a hard prerequisite.
- Fixture mechanics: resolved. The new test snippets in [03-plan-r2.md](03-plan-r2.md#L173-L206) create the parent directory before writing and reuse the live test helpers.
- Malformed JSON semantics: resolved. [02-design-r2.md](02-design-r2.md#L122-L128) now says malformed JSON throws.

## Summary

The architecture direction remains sound: make `loadConfig` async, delete the stale module cache, keep `resolveProjectRoot` sync as a narrow path-discovery carve-out, and delete config `ensureDir` only after G36. The remaining blocker is purely in the regression guard mechanics: the planned assertion does not match the scanner output it depends on, so the implementation plan would fail validation.

VERDICT: CHANGES_REQUESTED