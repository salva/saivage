# G36 - Review r2

## Findings

### 1. The deterministic child-process test target is not emitted by the current build

Round 1 required deterministic tests for the real lost-update invariant: two actors against the same temp `.saivage`, with one mutating profile `b` and the other refreshing or mutating profile `a`, plus failure-injection tests for `writeFile` or `rename` errors ([SPEC/v2/review-2026-05-round2/G36/04-review-r1.md](SPEC/v2/review-2026-05-round2/G36/04-review-r1.md#L29)). R2 now specifies child-process concurrency tests and a fixture, which is the right direction ([SPEC/v2/review-2026-05-round2/G36/03-plan-r2.md](SPEC/v2/review-2026-05-round2/G36/03-plan-r2.md#L127-L149), [SPEC/v2/review-2026-05-round2/G36/03-plan-r2.md](SPEC/v2/review-2026-05-round2/G36/03-plan-r2.md#L171-L180)).

The plan then says the fork target should use `dist/auth/__fixtures__/concurrent-writer.js`, requires that file to be emitted, and validates it with `require.resolve` ([SPEC/v2/review-2026-05-round2/G36/03-plan-r2.md](SPEC/v2/review-2026-05-round2/G36/03-plan-r2.md#L234-L239)). That does not match the repo's current build shape: `npm run build` runs `build:web && tsup` ([package.json](package.json#L12-L14)), and `tsup` has a single entry, `src/server/cli.ts`, producing a bundled CLI artifact rather than a `dist/auth/` module tree ([tsup.config.ts](tsup.config.ts#L4-L9)). The manual scratch-container check has the same mismatch because it imports `/opt/saivage/dist/auth/index.js` ([SPEC/v2/review-2026-05-round2/G36/03-plan-r2.md](SPEC/v2/review-2026-05-round2/G36/03-plan-r2.md#L267-L270)).

This leaves required change 3 only partially addressed: the proposed tests prove the right invariant in concept, but the concrete test runner path is not executable unless the implementation also changes the build/test strategy. Fix by either forking the TypeScript fixture through the existing test-time `tsx` path, adding an explicit `tsc`/fixture emit step for tests, or adding dedicated tsup entries for the auth module and fixture and updating the validation text accordingly. Also update the scratch-container command so it imports an artifact that the actual deployment produces.

## Addressed Round-1 Items

- The stale-cache/lost-update design issue is addressed by dropping Proposal B and choosing the in-place Proposal A shape with no cache, no class, and a locked read-modify-write helper ([SPEC/v2/review-2026-05-round2/G36/02-design-r2.md](SPEC/v2/review-2026-05-round2/G36/02-design-r2.md#L19-L23), [SPEC/v2/review-2026-05-round2/G36/02-design-r2.md](SPEC/v2/review-2026-05-round2/G36/02-design-r2.md#L35-L45)). Mutations now route through `mutateProfiles`, reload inside the critical section, and merge refreshed token fields into the latest store ([SPEC/v2/review-2026-05-round2/G36/02-design-r2.md](SPEC/v2/review-2026-05-round2/G36/02-design-r2.md#L66-L69), [SPEC/v2/review-2026-05-round2/G36/02-design-r2.md](SPEC/v2/review-2026-05-round2/G36/02-design-r2.md#L89-L107)).
- The lock terminology and stale-lock policy are tightened: R2 explicitly chooses a lockfile, not `flock(LOCK_EX)`, and defines PID/hostname stale recovery plus timeout behavior ([SPEC/v2/review-2026-05-round2/G36/01-analysis-r2.md](SPEC/v2/review-2026-05-round2/G36/01-analysis-r2.md#L212-L228), [SPEC/v2/review-2026-05-round2/G36/02-design-r2.md](SPEC/v2/review-2026-05-round2/G36/02-design-r2.md#L196-L199)).
- The facade concern is addressed. R2 removes the `SecretStore` framework framing, does not add `SecretStoreLike`, and does not ship `InMemorySecretStore` from the production auth barrel ([SPEC/v2/review-2026-05-round2/G36/02-design-r2.md](SPEC/v2/review-2026-05-round2/G36/02-design-r2.md#L321-L329), [SPEC/v2/review-2026-05-round2/G36/03-plan-r2.md](SPEC/v2/review-2026-05-round2/G36/03-plan-r2.md#L62-L63)).
- The cross-finding lint overclaim is addressed. R2 scopes the restriction to `src/auth/**`, consumes the G30 scanner only for that scope, and explicitly avoids a repo-wide allow-list promise ([SPEC/v2/review-2026-05-round2/G36/02-design-r2.md](SPEC/v2/review-2026-05-round2/G36/02-design-r2.md#L329-L349), [SPEC/v2/review-2026-05-round2/G36/03-plan-r2.md](SPEC/v2/review-2026-05-round2/G36/03-plan-r2.md#L217-L220), [SPEC/v2/review-2026-05-round2/G36/03-plan-r2.md](SPEC/v2/review-2026-05-round2/G36/03-plan-r2.md#L330-L342)).

## Notes

No auth-profile secret values are quoted in this review.

## Required change count

1

VERDICT: CHANGES_REQUESTED