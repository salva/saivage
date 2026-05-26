# G49 - Review (Round 3)

- **Analysis**: [01-analysis-r3.md](01-analysis-r3.md)
- **Design**: [02-design-r3.md](02-design-r3.md)
- **Plan**: [03-plan-r3.md](03-plan-r3.md)
- **Round 2 review**: [04-review-r2.md](04-review-r2.md)
- **Issue**: [../G49-usewebsocket-send-leaky-envelope.md](../G49-usewebsocket-send-leaky-envelope.md)

## Findings

1. **The alias realpath acceptance command uses plain `node` to import a TypeScript config.**
   Round 3 fixes the substantive resolver design, but the new acceptance checklist in [03-plan-r3.md](03-plan-r3.md#acceptance-checklist-delta-from-r2) verifies the root Vitest alias with `node -e 'import("./vitest.config.ts")...'`. In this repo that command fails before it can inspect the alias: plain Node reports `TypeError: Unknown file extension ".ts" for /home/salva/g/ml/saivage/vitest.config.ts`. That makes the checklist report failure even after a correct implementation. Use the existing TS runner path, for example `node --import tsx -e 'import("./vitest.config.ts").then(...)'`, or replace the dynamic import with a static source/realpath check that does not require Node to load a `.ts` config directly.

## Verified Corrections

- Round 3 adds the missing root [vitest.config.ts](../../../../vitest.config.ts) `resolve.alias` requirement for `@channels/ws-schema`, alongside the already-required `web/src/**/*.test.ts` include.
- [web/vite.config.ts](../../../../web/vite.config.ts) and [web/tsconfig.json](../../../../web/tsconfig.json) now specify matching `@channels/ws-schema` targets relative to their own config files, both resolving to [src/channels/ws-schema.ts](../../../../src/channels/ws-schema.ts).
- The server-side design keeps [src/channels/websocket.ts](../../../../src/channels/websocket.ts) on the relative `./ws-schema.js` import and explicitly says not to switch server imports to the web alias.
- The manual smoke commands now use `/home/salva/g/ml/tmp/saivage-g49-smoke-project`; the remaining `/tmp` mentions are historical/prose references, not live smoke command targets.

## Summary

The two round-2 blockers are materially addressed: test discovery now has a matching resolver plan, and the smoke path is workspace-local. The only remaining issue is a bad acceptance command that would produce a false negative during validation.

VERDICT: CHANGES_REQUESTED