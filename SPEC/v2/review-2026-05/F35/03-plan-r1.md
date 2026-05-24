# F35 — Plan r1 (Proposal B)

Recommended proposal: **B — collapse the unused channels barrel**.

## Ordered edit steps

1. **Pre-flight verification (no edit).** Re-run the orphan greps from a fresh shell at repo root `/home/salva/g/ml/saivage`; if any new caller has appeared, abort and revise the design:

   ```bash
   grep -rn "CLIChannel\|OneShotChannel" src/ web/src/
   grep -rn "from [\"']\.\{1,2\}/channels[\"']" src/ web/src/
   grep -rn "from [\"']\.\{1,2\}/channels/index" src/ web/src/
   ```

   Expected: only the definitions in `src/channels/cli.ts`, `src/channels/oneshot.ts`, and the re-exports in `src/channels/index.ts`. No barrel importer.

2. **Delete `src/channels/cli.ts`.**

3. **Delete `src/channels/oneshot.ts`.**

4. **Delete `src/channels/index.ts`.** No remaining caller imports the barrel; verified in step 1.

5. **Confirm `src/channels/` contents** are exactly `types.ts`, `websocket.ts`, `telegram.ts`, `telegram.test.ts`:

   ```bash
   ls src/channels/
   ```

6. **No other source edits required.** `tsup.config.ts`, `package.json`, `vitest.config.ts`, and `tsconfig.json` do not mention the deleted files (verified: tsup entry is `src/server/cli.ts` — [tsup.config.ts](tsup.config.ts#L5) — and `package.json` has no `exports` field).

## Test strategy

### Existing tests that cover this area

- [src/channels/telegram.test.ts](src/channels/telegram.test.ts) — unaffected; the file it tests (`telegram.ts`) is untouched.
- [src/agents/agents.test.ts](src/agents/agents.test.ts#L17) — imports `ChatChannel` *type* from `../channels/types.js`, not from the barrel; unaffected.

### New tests needed

None. The change removes only dead code that has no tests. Adding tests for deleted modules is forbidden by the project guidelines (no abstractions used only once, no defensive code).

### Validation commands (from `/home/salva/g/ml/saivage`)

```bash
npm run typecheck
npm run build
npx vitest run src/channels/telegram.test.ts
npx vitest run src/agents/agents.test.ts
npx vitest run
```

Pass criteria:

- `npm run typecheck` exits 0. Removing files cannot create new type errors at consumer sites because no consumer references the deleted symbols.
- `npm run build` exits 0; the `dist/` bundle still emits from `src/server/cli.ts` (the Commander entry, unrelated to `src/channels/cli.ts`).
- The two focused Vitest commands pass; the full `npx vitest run` passes with the same test count as before minus zero (no test files were removed).

### Negative check

After the build, confirm the produced bundle does not reference the deleted modules:

```bash
grep -c "CLIChannel\|OneShotChannel" dist/cli.js
```

Expected: `0`.

## Rollback strategy

Single commit. `git revert <sha>` restores all three files verbatim. No data migration, no schema change, no runtime state involved.

## Cross-issue ordering

- **No upstream dependency.** F35 can land at any time.
- **Downstream beneficiaries.** If F02 (agent roster drift) or any future "intent-only features" cleanup lands after F35-B, those reviewers see a tidier `src/channels/` and can cite this commit as precedent for the same pattern.
- **No interaction with the out-of-scope `src/skills/` and `SPEC/v2/skills*/` zones.**

## Fallback to Proposal A

If the orchestrator prefers minimal scope, drop steps 3 and 4 and replace step 4 with an edit to `src/channels/index.ts` removing only the `export { CLIChannel } from "./cli.js";` line. Validation commands and rollback strategy are identical.
