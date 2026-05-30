# F19 Plan — delete the provider barrel (Proposal B)

## Pre-flight: confirm the dead-code claim

Before deleting, re-run the verification from `01-analysis-r1.md` to guard against any new importer added between writing and merging.

```bash
cd /home/salva/g/ml/saivage
grep -rn "from ['\"]\\.\\./providers['\"]" src/ web/ tests/ 2>/dev/null
grep -rn "from ['\"]\\./providers['\"]" src/ web/ tests/ 2>/dev/null
grep -rn "from ['\"].*providers/index" src/ web/ tests/ 2>/dev/null
```

All three must return zero matches. If any hits exist, **stop** and revisit the design — a real consumer changes the calculus toward Proposal A.

Also re-confirm packaging does not advertise the barrel as an entry point:

```bash
grep -n "providers" package.json tsup.config.ts
```

Today: `tsup.config.ts` declares a single CLI entry `src/server/cli.ts` (see [tsup.config.ts](tsup.config.ts#L5)); `package.json` has no `exports` map pointing at the barrel.

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

**Validation commands** (Vitest, per `vitest.config.ts`):

```bash
cd /home/salva/g/ml/saivage
npm run typecheck
npm run build
npx vitest run src/providers
npx vitest run src/agents
```

Pass criteria: typecheck succeeds; tsup emits `dist/` without errors; both `vitest run` invocations report all tests passing. If any of these regress, the deletion has uncovered a hidden importer that the pre-flight grep missed (extremely unlikely with TypeScript's module resolution, but possible if a `// @ts-ignore`'d dynamic import exists somewhere). Investigate and re-import the needed symbol by deep path.

## Rollback strategy

Single commit, single deletion. Revert is `git revert <sha>` or `git checkout HEAD~1 -- src/providers/index.ts`. No data migration, no on-disk format change, no schema change, no runtime state change.

## Cross-issue ordering note

- **Before F13**: Land F19 before F13's typed-error refactor. When F13 introduces `ProviderErrorKind` in [src/providers/types.ts](src/providers/types.ts), there is no barrel to keep in sync — F13's diff stays small and limited to `types.ts` and the per-provider adapters.
- **Independent of F02**: F02 ([F02-agent-roster-drift.md](../F02-agent-roster-drift.md)) addresses the analogous drift in `src/agents/`, but the agents case has live consumers (dispatcher role map, role enums). F19 and F02 share a category label only; F19's outcome (delete the barrel) is not a template for F02 because F02's "barrel-equivalents" are real consumers.
- Independent of all other Fxx in the inventory; can land in any round.
