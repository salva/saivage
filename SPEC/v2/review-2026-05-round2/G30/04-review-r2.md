# G30 - Review r2

## Reviewer

GitHub Copilot

## Documents reviewed

- [SPEC/v2/review-2026-05-round2/G30-builtins-filesystem-sync-fs.md](SPEC/v2/review-2026-05-round2/G30-builtins-filesystem-sync-fs.md#L1-L46)
- [SPEC/v2/review-2026-05-round2/G30/01-analysis-r2.md](SPEC/v2/review-2026-05-round2/G30/01-analysis-r2.md#L1-L208)
- [SPEC/v2/review-2026-05-round2/G30/02-design-r2.md](SPEC/v2/review-2026-05-round2/G30/02-design-r2.md#L1-L456)
- [SPEC/v2/review-2026-05-round2/G30/03-plan-r2.md](SPEC/v2/review-2026-05-round2/G30/03-plan-r2.md#L1-L408)
- Previous review: [SPEC/v2/review-2026-05-round2/G30/04-review-r1.md](SPEC/v2/review-2026-05-round2/G30/04-review-r1.md#L1-L52)

## Findings

None. The three required r1 changes are addressed in the r2 documents.

## Required-change verification

| # | Required r1 change | r2 status |
|---|---|---|
| 1 | Fix the `runShellCommand` async race plan, spell out pre-`Promise` `mkdir`, and add focused shell coverage. | Addressed. The analysis adds the close-handler race and no-async-executor constraints in [SPEC/v2/review-2026-05-round2/G30/01-analysis-r2.md](SPEC/v2/review-2026-05-round2/G30/01-analysis-r2.md#L108-L130). The design gives the exact pre-`Promise` `await mkdir(...)` shape, `settled`/`inFlightTick` guards, post-`await` checks, and close-handler invariant in [SPEC/v2/review-2026-05-round2/G30/02-design-r2.md](SPEC/v2/review-2026-05-round2/G30/02-design-r2.md#L34-L110). The plan repeats the hoist, guarded async tick, first-line `settled = true` close handling, and adds the fast-exit inactivity regression test in [SPEC/v2/review-2026-05-round2/G30/03-plan-r2.md](SPEC/v2/review-2026-05-round2/G30/03-plan-r2.md#L62-L93), [SPEC/v2/review-2026-05-round2/G30/03-plan-r2.md](SPEC/v2/review-2026-05-round2/G30/03-plan-r2.md#L107-L198), and [SPEC/v2/review-2026-05-round2/G30/03-plan-r2.md](SPEC/v2/review-2026-05-round2/G30/03-plan-r2.md#L247-L272). |
| 2 | Make the no-sync-fs guard dependency-clean and reusable. | Addressed. The design introduces `src/testing/noSyncFsScanner.ts` as a dependency-free helper using `fs/promises.readdir`, generalized `node:fs` import detection, `*Sync` call detection, and reusable `(roots, allowList)` options in [SPEC/v2/review-2026-05-round2/G30/02-design-r2.md](SPEC/v2/review-2026-05-round2/G30/02-design-r2.md#L118-L263). The plan adds the helper and a thin `src/mcp/no-sync-fs.test.ts` consumer with no `tinyglobby` and no hard-coded scanner assumptions in [SPEC/v2/review-2026-05-round2/G30/03-plan-r2.md](SPEC/v2/review-2026-05-round2/G30/03-plan-r2.md#L212-L244). |
| 3 | Replace the incomplete workspace-wide guard coordination with an explicit audit table and gating rule. | Addressed. The analysis replaces the old claim with a workspace `node:fs` audit that distinguishes G30/G06/G36/G37 coverage, the F22 `recovery.ts` carve-out, and still-unowned sync-fs sites in [SPEC/v2/review-2026-05-round2/G30/01-analysis-r2.md](SPEC/v2/review-2026-05-round2/G30/01-analysis-r2.md#L147-L177). The design recommendation now delays the workspace-wide guard until that audit is resolved in [SPEC/v2/review-2026-05-round2/G30/02-design-r2.md](SPEC/v2/review-2026-05-round2/G30/02-design-r2.md#L435-L441). The plan carries the full audit and an explicit gating rule for `roots: ["src"]` in [SPEC/v2/review-2026-05-round2/G30/03-plan-r2.md](SPEC/v2/review-2026-05-round2/G30/03-plan-r2.md#L377-L401). |

## Non-blocking note

The proposed fast-exit shell test remains timing-sensitive rather than using a fakeable delayed-stat helper. That is acceptable for this review because r1 made deterministic injection the ideal form, not a hard requirement, and the r2 docs now require the actual `settled` state guard that prevents the bad interleaving.

## Required change count

3 addressed / 3 required.

VERDICT: APPROVED