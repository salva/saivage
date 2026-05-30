# F31 — Plan r1 (recommended Proposal A: subsume into F18)

## Ordered edit steps

There are no F31-owned source edits. F31's deliverable is administrative: confirm closure-by-reference once F18 lands.

1. **Wait for F18 to land.** F18 is approved per [SPEC/v2/review-2026-05/F18/APPROVED.md](SPEC/v2/review-2026-05/F18/APPROVED.md); its Plan r2 ([SPEC/v2/review-2026-05/F18/03-plan-r2.md](SPEC/v2/review-2026-05/F18/03-plan-r2.md)) creates `prompts/<role>.md`, adds `src/agents/prompts.ts`, extends `tsup.config.ts`, and rewrites the JSDoc at [src/agents/base.ts](src/agents/base.ts#L104-L105).
2. **Verify F18 actually rewrote the JSDoc.** After the F18 commit, run from the repo root `/home/salva/g/ml/saivage/`:
   ```bash
   grep -n "from prompts/<role>.md" src/agents/base.ts || echo "F31 resolved"
   grep -n "Rendered role prompt" src/agents/base.ts
   test -d prompts && ls prompts/shared
   ```
   Expected: the first grep prints "F31 resolved", the second finds the new JSDoc, the third lists the `shared/` directory (`roster.md`, `communication-protocol.md`, `persistence.md`, `corrective-action.md`, `execution-style.md`, `worker-contract.md`).
3. **Close F31.** When the reviewer approves this r1 document, create `SPEC/v2/review-2026-05/F31/APPROVED.md` per loop conventions, pointing at this r1 set and citing F18 as the implementing change.

## Fallback (only if F18 is descoped or blocked)

If F18 is paused for longer than the F31 reviewer is willing to wait, switch to Proposal B and ship a one-line edit:

- File: [src/agents/base.ts](src/agents/base.ts#L104-L105)
- Replace `/** System prompt (from prompts/<role>.md). */` with `/** Rendered system prompt string. */`.
- Commit message: `F31: drop stale prompts/<role>.md JSDoc on BaseAgentConfig.systemPrompt`.
- This must be re-coordinated with F18 if F18 later resumes.

## Test strategy

No production tests change under Proposal A.

- Existing coverage for `BaseAgent` continues to exercise `systemPrompt` end-to-end through every agent constructor; nothing under F31's recommended path alters runtime behaviour.
- F18 owns adding the loader-level integration test (one call per role) per [SPEC/v2/review-2026-05/F18/03-plan-r2.md](SPEC/v2/review-2026-05/F18/03-plan-r2.md). F31 does not duplicate it.

For the fallback (Proposal B), a comment-only change still warrants the standard pre-merge gate:

```bash
cd /home/salva/g/ml/saivage
npm run typecheck
npm run build
```

No vitest run is required for a JSDoc-only change; the comment is not consumed at runtime or by the type-checker.

## Validation commands

Under Proposal A, F31 itself runs nothing; F18's validation block ([SPEC/v2/review-2026-05/F18/03-plan-r2.md](SPEC/v2/review-2026-05/F18/03-plan-r2.md)) is the operative one. To confirm F31's specific concern is closed after F18 lands:

```bash
cd /home/salva/g/ml/saivage
grep -n "from prompts/<role>.md" src/agents/base.ts && echo "STILL BROKEN" || echo "F31 OK"
test -d prompts && echo "prompts/ exists"
```

Both lines should print the success branch.

## Rollback strategy

Proposal A: nothing to roll back — F31 ships no code. If F18 itself is rolled back, F31's closure note becomes stale; reopen and switch to Proposal B.

Proposal B (fallback): single-commit JSDoc edit, `git revert <sha>` is sufficient.

## Cross-issue ordering

- **Must NOT precede F18.** Any independent F31 patch on [src/agents/base.ts](src/agents/base.ts#L104-L105) collides with F18's same-line rewrite.
- **Must be evaluated AFTER F18 lands** to confirm closure.
- F02 (roster), F09 (worker contract), F33 (prompt-defaults) are all resolved by the same F18 change; their closure can be checked together with the grep above.
