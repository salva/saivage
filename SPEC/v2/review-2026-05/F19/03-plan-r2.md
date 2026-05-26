# F19 Plan r2 — delete the provider barrel (Proposal B)

## Changes from r1

- **Broadened the pre-flight grep.** r1 used three narrow `grep` patterns that only caught `from "../providers"` / `from "./providers"` and `from ".*providers/index"`. They missed arbitrary relative depth (e.g. `from "../../providers"`), re-exports (`export ... from "...providers"`), side-effect imports (`import "...providers"`), and dynamic imports (`import("...providers")`). The recipe below replaces them with a single `rg` invocation that covers all of these across `src/` and `web/`, plus a separate check for `providers/index` references. The "no top-level `tests/` directory" fact is now reflected — tests are colocated as `*.test.ts` under `src/` and are already in the same scan.
- **Corrected the packaging line.** r1 referenced `tsup.config.ts` having a single `entry: ["src/index.ts"]`-style configuration; that was wrong. The plan now references the actual entry `src/server/cli.ts` at [tsup.config.ts](tsup.config.ts#L5) and the absence of any `main`/`exports`/`types` in [package.json](package.json#L1-L40).

## Pre-flight: confirm the dead-code claim

Before deleting, re-run the verification from [01-analysis-r2.md](01-analysis-r2.md) to guard against any new importer added between writing and merging.

Tests in `saivage` are colocated as `*.test.ts` under `src/`; there is no top-level `tests/` directory. Scanning `src/` and `web/` covers all TypeScript and Vue source.

```bash
cd /home/salva/g/ml/saivage
# 1. Any reference to a providers barrel: static import, re-export, side-effect import, dynamic import.
#    Covers arbitrary relative depth (`..`, `../..`, etc.) and bare `providers` / `providers/index`.
rg -n --type-add 'vue:*.vue' -t ts -t js -t vue \
  "(from|import)\s*\(?\s*['\"]([^'\"]*/)?providers(/index(\.js)?)?['\"]" \
  src web 2>/dev/null

# 2. Defensive secondary pass: any literal substring `providers/index` anywhere in TS/JS/Vue source.
rg -n --type-add 'vue:*.vue' -t ts -t js -t vue \
  "providers/index" \
  src web 2>/dev/null
```

Both invocations must return zero matches. If any hit exists, **stop** and revisit the design — a real consumer changes the calculus toward Proposal A.

Also re-confirm packaging does not advertise the barrel as an entry point:

```bash
grep -n "providers" package.json tsup.config.ts
```

Today: [tsup.config.ts](tsup.config.ts#L5) declares a single CLI entry `src/server/cli.ts`; [package.json](package.json#L1-L40) has no `main`, `module`, `exports`, or `types` field — the only published entry is the CLI bin at [package.json](package.json#L9-L11). The `grep` should yield no entry-point reference to `src/providers/index.ts`.

## Edit steps

1. Delete the file [src/providers/index.ts](src/providers/index.ts).

   ```bash
   git rm src/providers/index.ts
   ```

   That is the only change. No new file, no edit to any other file, no `package.json` change, no `tsup.config.ts` change.

## Test strategy

**Existing coverage that exercises the providers area** (kept as-is, used to confirm no regression):

- [src/providers/router.test.ts](src/providers/router.test.ts) — `ModelRouter` registration, failover, sticky-primary recovery.
- [src/providers/types.test.ts](src/providers/types.test.ts) — `parseModelId`.
- [src/providers/copilot.test.ts](src/providers/copilot.test.ts) — Copilot provider HTTP shape.
- [src/providers/openai-codex.test.ts](src/providers/openai-codex.test.ts) — Codex provider auth/transport.
- [src/providers/responses-ids.test.ts](src/providers/responses-ids.test.ts) — Responses-API id helpers.
- Agent tests that import provider types: [src/agents/agents.test.ts](src/agents/agents.test.ts), [src/agents/conversation-snapshot.test.ts](src/agents/conversation-snapshot.test.ts), [src/agents/base.compaction.test.ts](src/agents/base.compaction.test.ts).

**New tests**: none. There is nothing to test — we are removing a file with no importers. Adding a test that asserts "the barrel does not exist" would itself be an abstraction used once.

**Validation commands** (Vitest, per [vitest.config.ts](vitest.config.ts)):

```bash
cd /home/salva/g/ml/saivage
npm run typecheck
npm run build
npx vitest run src/providers
npx vitest run src/agents
```

Pass criteria: typecheck succeeds; `tsup` emits `dist/` without errors (the only bundled entry is `src/server/cli.ts` per [tsup.config.ts](tsup.config.ts#L5), unchanged); both `vitest run` invocations report all tests passing. If any of these regress, the deletion has uncovered a hidden importer that the pre-flight grep missed. Investigate and re-import the needed symbol by deep path.

## Rollback strategy

Single commit, single deletion. Revert is `git revert <sha>` or `git checkout HEAD~1 -- src/providers/index.ts`. No data migration, no on-disk format change, no schema change, no runtime state change.

## Cross-issue ordering note

- **Before F13**: Land F19 before F13's typed-error refactor. When F13 introduces `ProviderErrorKind` in [src/providers/types.ts](src/providers/types.ts), there is no barrel to keep in sync — F13's diff stays small and limited to `types.ts` and the per-provider adapters.
- **Independent of F02**: F02 ([F02-agent-roster-drift.md](../F02-agent-roster-drift.md)) addresses the analogous drift in `src/agents/`, but the agents case has live consumers (dispatcher role map, role enums). F19 and F02 share a category label only; F19's outcome (delete the barrel) is not a template for F02 because F02's "barrel-equivalents" are real consumers.
- Independent of all other Fxx in the inventory; can land in any round.
