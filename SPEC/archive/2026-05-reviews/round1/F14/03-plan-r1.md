# F14 — Implementation plan (R1)

For the recommended proposal: **Proposal B — Absorb F14 into F09's `WorkerAgent` extraction**.

Under Proposal B the reviewer half of F14 is fixed inside F09's commit (see [F09/03-plan-r2.md](../F09/03-plan-r2.md) Step 6, which explicitly deletes the stray `this.messages.push({ role: "assistant", content: text });` at [src/agents/reviewer.ts](../../../../src/agents/reviewer.ts#L121)). This plan therefore covers only:

1. The single-line planner deletion at [src/agents/planner.ts](../../../../src/agents/planner.ts#L232).
2. A regression test that pins the post-condition for both reviewer and planner so the bug cannot silently come back.

The plan is intentionally tiny because the design is small. Where F09 already specifies the reviewer change in detail, this file cross-references it instead of duplicating steps.

## 1. Ordered edit steps

All paths absolute under `/home/salva/g/ml/saivage/`.

1. **Edit [src/agents/planner.ts](../../../../src/agents/planner.ts)** — nudge branch of `run()`.
   - At [planner.ts L232](../../../../src/agents/planner.ts#L232), delete the single line:

     ```ts
     this.messages.push({ role: "assistant", content: text });
     ```

   - Leave the surrounding comment `// Add the planner's response so context is preserved, then nudge` intact only if it still describes what remains; otherwise delete the comment with the line (the assistant response is already preserved by `BaseAgent.runLoop()` pushing it at [src/agents/base.ts](../../../../src/agents/base.ts#L268-L269), so the comment is now misleading and should be removed together with the deleted line).
   - The immediately-following `this.injectMessage("SYSTEM: You ended your turn with text only ...")` call stays exactly as it is; the nudge user message must still be appended after the assistant turn.
   - Do not change `nudgeCount`, `MAX_NUDGES`, return shapes, or the outer `try/catch`.

2. **(Reviewer half — owned by F09.)** Do not touch [src/agents/reviewer.ts](../../../../src/agents/reviewer.ts) in this F14 commit. F09's commit deletes the [reviewer.ts L121](../../../../src/agents/reviewer.ts#L121) duplicate as part of rewriting `review()`. If F09 is for any reason rolled back, fall back to **Proposal A** (see [02-design-r1.md](02-design-r1.md)) and re-plan as two single-line deletions in the same commit.

3. **Add a regression test** to [src/agents/agents.test.ts](../../../../src/agents/agents.test.ts) (the file already exists and already constructs `ReviewerAgent` and uses a stubbed provider, so it is the right host). Two tests, both using the existing stub-provider helpers in that file:

   - `reviewer.review() does not double-push the final assistant message`
     - Set up a `ReviewerAgent` with a provider stub that returns one no-tool text response, e.g. `"REVIEW DONE"`.
     - Call `await reviewer.review(input)`.
     - Assert `reviewer.messages.filter(m => m.role === "assistant" && extractText(m) === "REVIEW DONE").length === 1`.
     - Assert the trailing entry of `reviewer.messages` is that assistant message (no follow-up was appended after the loop returned).
     - Repeat the call (second review on the same instance) with a different stubbed response, e.g. `"REVIEW DONE 2"`; assert exactly one copy of each response is present, in order.
     - This regression is the one F09 fixes via the `review()` rewrite. The test belongs in this F14 commit (paired with the planner fix) so the post-condition is pinned by an F14-owned test even after F09 lands.

   - `planner nudge path does not double-push the assistant turn`
     - Set up a `PlannerAgent` whose provider stub returns a no-tool text response on the first call (triggering the nudge branch), then `plan_complete()` on the second call. Use the same test scaffolding as the existing planner-nudge tests in [src/agents/agents.test.ts](../../../../src/agents/agents.test.ts) if one exists; otherwise lift the stub-provider pattern from the reviewer tests.
     - After `run()` returns, count the assistant messages in `planner.messages` whose text matches the first stub response. Assert the count is exactly `1`.
     - Assert that the message immediately after that single assistant entry is the SYSTEM nudge `user` message (so the nudge ordering described in the analysis §Constraints #3 is preserved).
     - If no convenient nudge-path scaffolding exists in `agents.test.ts`, place this test in a new sibling file `src/agents/planner.nudge.test.ts`; do NOT shoehorn it into `base.compaction.test.ts`.

   Test-only helper if needed: a small `extractText(message)` that returns `message.content` when it's a string or the concatenated `type: "text"` blocks when it's an array. Put it inline in the test file; do not export a new module utility for a single use site (project guideline #2 — no abstractions used only once).

4. **Verify the absence of any other duplicate push site** with one grep, so this issue does not silently regrow elsewhere:

   ```bash
   cd /home/salva/g/ml/saivage
   grep -rn 'this\.messages\.push(\s*{\s*role:\s*"assistant"' src/
   ```

   After Steps 1 and F09 Step 6, the expected output is empty. If any hit remains, file a follow-up — do NOT silently delete additional pushes here without an analysis pass. (The only legitimate `pushMessage({ role: "assistant", ... })` site is inside `BaseAgent` itself at [src/agents/base.ts](../../../../src/agents/base.ts#L267); the grep above intentionally targets `this.messages.push(...)` with an assistant role so it does not match the base-class `pushMessage` helper.)

## 2. Test strategy

### Existing tests that cover the behaviour

- [src/agents/agents.test.ts](../../../../src/agents/agents.test.ts) — exercises `ReviewerAgent` and `PlannerAgent` end-to-end with stubbed providers. Public APIs (`run()`, `review()`) are unchanged; existing assertions remain valid.
- [src/agents/conversation-snapshot.test.ts](../../../../src/agents/conversation-snapshot.test.ts) — if any snapshot test currently asserts on the number of trailing assistant messages after a reviewer call, that assertion was asserting the bug; update it to expect a single assistant message (one push by `BaseAgent.runLoop()`). Confirm by running the test before editing; if it passes today it likely doesn't assert that count and no change is needed.
- [src/agents/base.compaction.test.ts](../../../../src/agents/base.compaction.test.ts) — covers `runLoop` / compaction interaction. Should be unaffected; verify it still passes.

### New tests to add

The two tests described in Step 3 above:

- Reviewer single-assistant-trail assertion across one and two `review()` calls.
- Planner nudge-path single-assistant-then-user-nudge ordering.

### Commands to run

After Step 1 and Step 3, and once F09 is in (or, if proceeding under Proposal A, after Step 1's two-line variant):

```bash
cd /home/salva/g/ml/saivage
npm run typecheck
npx vitest run src/agents/agents.test.ts
npx vitest run src/agents/
```

Final whole-package run before considering F14 done:

```bash
cd /home/salva/g/ml/saivage
npm run typecheck
npm run lint
npx vitest run
npm run build
```

The web bundle is unaffected (no `web/src/` changes); `npm run build` runs `npm run build:web && tsup` per [package.json L13](../../../../package.json#L13) but is cheap and worth running once.

## 3. Validation

This change is TypeScript-only inside `src/agents/`; no web UI, no docs, no LXC deployment, no runtime/dashboard semantics.

The workspace skill at [/home/salva/g/ml/.github/skills/saivage-development-validation/SKILL.md](../../../../../.github/skills/saivage-development-validation/SKILL.md) is **not applicable**: its commands target `/home/salva/g/ml/saivage-v3` and Jest, while F14 modifies `/home/salva/g/ml/saivage` (this repo), which uses Vitest (`"test": "vitest run"`, [package.json L17](../../../../package.json#L17)) and `tsc --noEmit` for typecheck ([package.json L20](../../../../package.json#L20)).

Repo-local validation:

1. `npm run typecheck` — must pass cleanly ([package.json L20](../../../../package.json#L20)).
2. `npm run lint` — must pass cleanly ([package.json L19](../../../../package.json#L19)).
3. `npx vitest run src/agents/` — focused agent suite must pass.
4. `npx vitest run` — full suite must pass.
5. `npm run build` — build smoke check.

No LXC redeploy. The change does not affect on-disk formats, planner contracts, dashboard API schemas, or runtime state.

## 4. Rollback strategy

Single commit containing only:

- The one-line deletion in [src/agents/planner.ts](../../../../src/agents/planner.ts#L232) (Step 1).
- The two new regression tests (Step 3).

Commit message body must call out the behavioural change explicitly: "PlannerAgent no longer manually pushes the final assistant message after `runLoop()` in the nudge branch — `BaseAgent.runLoop()` already pushes it at `base.ts` L269. Restores invariant: exactly one assistant message per LLM turn in `this.messages`."

Rollback: `git revert <sha>`. The deleted line returns, the new tests vanish. No data migration, no schema change, no on-disk format change.

If F09 is later reverted (independent decision), the reviewer half regresses. The F14-owned regression test for the reviewer (Step 3, first test) will then fail and surface the regression immediately — this is the explicit reason F14 keeps the reviewer test even though the reviewer deletion is owned by F09's commit.

## 5. Cross-issue ordering

- **F09 (worker duplication / `WorkerAgent`)** — F09's [03-plan-r2.md](../F09/03-plan-r2.md) Step 6 owns the reviewer L121 deletion as part of the `review()` rewrite. F14 (Proposal B) **must land after** F09. If F09 slips, fall back to **Proposal A** (see [02-design-r1.md](02-design-r1.md)): same plan structure, but Step 1 also deletes the single line at [src/agents/reviewer.ts L121](../../../../src/agents/reviewer.ts#L121) (and only that line — the rest of `review()` remains untouched until F09 lands).
- **F03 (naive JSON parsing)** — orthogonal. Can ship before or after F14.
- **F18 (prompt bloat)** — orthogonal.

There are no other downstream dependencies. F14 closes the issue tracked in [F14-reviewer-double-push.md](../F14-reviewer-double-push.md) and the related observation in [00-SUBSYSTEM-MAP.md](../00-SUBSYSTEM-MAP.md) §2 boundary #3.
