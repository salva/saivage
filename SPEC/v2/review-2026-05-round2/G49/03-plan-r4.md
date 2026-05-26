# G49 — Plan (Round 4)

- **Round 1**: [03-plan-r1.md](03-plan-r1.md)
- **Round 2**: [03-plan-r2.md](03-plan-r2.md)
- **Round 3**: [03-plan-r3.md](03-plan-r3.md)
- **Round 4**: [01-analysis-r4.md](01-analysis-r4.md), [02-design-r4.md](02-design-r4.md)
- **Review**: [04-review-r3.md](04-review-r3.md)

This r4 plan supersedes [03-plan-r3.md](03-plan-r3.md) only on the single blocker in [04-review-r3.md](04-review-r3.md): the acceptance command that uses plain `node` to import a TypeScript config fails with `Unknown file extension ".ts"` and would produce a false negative. All other r3 step bodies — including Steps 2, 4a, 4b, 12, and the file-edit order — stand verbatim.

## Replaced acceptance line — Vitest alias realpath check

In [03-plan-r3.md "Acceptance checklist (delta from r2)"](03-plan-r3.md#acceptance-checklist-delta-from-r2), the bullet that begins "All three aliases above point at the same on-disk file. Verify with `realpath`" is replaced with the version below. Every other checkbox in that section is carried forward unchanged.

- [ ] All three aliases above point at the same on-disk file. Verify with `realpath` plus the `tsx` Node import hook (already in `devDependencies` as `tsx@^4.21.0`, so plain `node` need not natively understand `.ts`):
  ```bash
  cd /home/salva/g/ml/saivage
  test "$(realpath src/channels/ws-schema.ts)" = \
       "$(node --import tsx -e 'import("./vitest.config.ts").then(c => console.log(c.default.resolve.alias["@channels/ws-schema"]))')"
  ```
  Exit code 0 means the [vitest.config.ts](../../../../vitest.config.ts) alias resolves to the same absolute path as the on-disk schema file. Non-zero means the alias is missing, points at a different file, or the `fileURLToPath(new URL(...))` form produced an unexpected absolute path — all of which are implementation bugs the check is meant to catch. (The Vite/tsc resolutions are verified implicitly by `cd web && npm run build` and `npm run typecheck` in the web package, as before.)

## Everything else is unchanged

- Step 2 (browser-side alias entries): unchanged from [r3](03-plan-r3.md#replaced-step-2--browser-side-alias-entries-restates-r1-b1--r2-4).
- Step 4 / 4a / 4b (Vitest discovery + resolver alias): unchanged from [r3](03-plan-r3.md#replaced-step-4--vitest-discovery--resolver-alias).
- Step 12 (manual smoke, workspace-local path): unchanged from [r3](03-plan-r3.md#replaced-step-12--manual-smoke-workspace-local-project-path).
- File-edit order: unchanged from [r3](03-plan-r3.md#updated-order-of-file-edits-delta-from-r2).
- All other acceptance bullets (vitest alias entry, web vite alias entry, web tsconfig paths entry, `npm test` outcome `Test Files 3 passed (3)` / `Tests 20 passed (20)`, smoke-path policy, smoke cleanup): unchanged from [r3](03-plan-r3.md#acceptance-checklist-delta-from-r2).
- Out of scope: unchanged from [r3](03-plan-r3.md#out-of-scope-unchanged-from-r1r2).
