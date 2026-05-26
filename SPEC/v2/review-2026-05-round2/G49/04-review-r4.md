# G49 - Review (Round 4)

- **Analysis**: [01-analysis-r4.md](01-analysis-r4.md)
- **Design**: [02-design-r4.md](02-design-r4.md)
- **Plan**: [03-plan-r4.md](03-plan-r4.md)
- **Round 3 review**: [04-review-r3.md](04-review-r3.md)
- **Issue**: [../G49-usewebsocket-send-leaky-envelope.md](../G49-usewebsocket-send-leaky-envelope.md)

## Findings

None.

## Verified Corrections

- The live acceptance command in [03-plan-r4.md](03-plan-r4.md) replaces the plain `node -e 'import("./vitest.config.ts")...'` form with `node --import tsx -e 'import("./vitest.config.ts").then(...)'`, so the TypeScript Vitest config is loaded through the repository's existing TS runner path.
- [package.json](../../../../package.json) has `tsx` in `devDependencies` at `^4.21.0`, which supports the `node --import tsx` hook form used by the revised command.
- Round 4 does not reopen or weaken the r3-approved alias topology: the Vitest, Vite, and web tsconfig requirements still target [src/channels/ws-schema.ts](../../../../src/channels/ws-schema.ts), and the server-side import remains the intentional relative `./ws-schema.js` path.
- The workspace-local smoke path remains under `/home/salva/g/ml/tmp/saivage-g49-smoke-project`; no live smoke command target under `/tmp` was reintroduced.
- The accepted test surface from r3 is preserved: [03-plan-r4.md](03-plan-r4.md) still carries forward the `npm test` expectation of `Test Files 3 passed (3)` and `Tests 20 passed (20)`.

## Validation Note

The current source tree has not applied G49 Step 4b yet, so running the r4 alias-realpath command against today's [vitest.config.ts](../../../../vitest.config.ts) fails because `resolve.alias` is absent. That is not a round-4 docs regression; it is the pre-implementation failure condition the acceptance check is meant to catch until the planned alias is added.

## Summary

Round 4 addresses the only r3 blocker while preserving the r3 corrections for resolver wiring, server import boundaries, workspace-local smoke behavior, and acceptance coverage. I found no r3 regression.

VERDICT: APPROVED