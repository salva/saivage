# F14 — Implementation plan (R3)

## Changes from r2

- Corrected the `package.json` validation line references in §3. `lint` is at [package.json](../../../../package.json#L20), `typecheck` is at [package.json](../../../../package.json#L21) (line 19 is `test:bundle`). Updated all three sites in r2 that cited these (the "skill not applicable" sentence, validation step 1, validation step 2). Verified against `/home/salva/g/ml/saivage/package.json` lines 12-26.
- No other changes; the substantive plan from r2 stands.

---

For the recommended proposal: **Proposal B — Absorb F14 into F09's `WorkerAgent` extraction**.

Under Proposal B the reviewer half of F14 is fixed inside F09's commit (see [F09/03-plan-r2.md](../F09/03-plan-r2.md) Step 6, which explicitly deletes the stray `this.messages.push({ role: "assistant", content: text });` at [src/agents/reviewer.ts](../../../../src/agents/reviewer.ts#L121)). This plan therefore covers only:

1. The single-line planner deletion at [src/agents/planner.ts](../../../../src/agents/planner.ts#L232).
2. Two regression tests that pin the post-condition for both reviewer and planner so the bug cannot silently come back.

The plan is intentionally tiny because the design is small. Where F09 already specifies the reviewer change in detail, this file cross-references it instead of duplicating steps.

## 1. Ordered edit steps

All paths absolute under `/home/salva/g/ml/saivage/`.

1. **Edit [src/agents/planner.ts](../../../../src/agents/planner.ts)** — nudge branch of `run()`.
   - At [src/agents/planner.ts](../../../../src/agents/planner.ts#L232), delete the single line:

     ```ts
     this.messages.push({ role: "assistant", content: text });
     ```

   - The immediately-preceding comment at [src/agents/planner.ts](../../../../src/agents/planner.ts#L231) reads `// Add the planner's response so context is preserved, then nudge`. Delete the comment together with the line — the assistant response is already preserved by `BaseAgent.runLoop()` pushing it at [src/agents/base.ts](../../../../src/agents/base.ts#L266), so the comment would be misleading on its own.
   - The immediately-following `this.injectMessage("SYSTEM: You ended your turn with text only ...")` call at [src/agents/planner.ts](../../../../src/agents/planner.ts#L233-L241) stays exactly as it is; the nudge user message must still be appended after the assistant turn.
   - Do not change `nudgeCount`, `MAX_NUDGES`, return shapes, or the outer `try/catch`.

2. **(Reviewer half — owned by F09.)** Do not touch [src/agents/reviewer.ts](../../../../src/agents/reviewer.ts) in this F14 commit. F09's commit deletes the [src/agents/reviewer.ts](../../../../src/agents/reviewer.ts#L121) duplicate as part of rewriting `review()`. If F09 is rolled back, fall back to **Proposal A** (see [02-design-r2.md](02-design-r2.md)) and re-plan as two single-line deletions in the same commit.

3. **Add reviewer regression test** in [src/agents/agents.test.ts](../../../../src/agents/agents.test.ts), at the end of the existing `describe("ReviewerAgent", ...)` block at [src/agents/agents.test.ts](../../../../src/agents/agents.test.ts#L91). It reuses the existing `makeReviewerContext` / `makeReviewInput` / stub-router scaffolding already in the file.

   - Test name: `does not duplicate the final assistant message in this.messages after review()`.
   - Stub-router behaviour, in order:
     - **Call 1** (review 1, first turn): return a tool-use response — `content: "Inspecting evidence."`, `toolCalls: [{ id: "tool-1", name: "test_tool", input: {} }]`, `finishReason: "tool_use"`. This satisfies `ReviewerAgent.validateFinalResponse()` at [src/agents/reviewer.ts](../../../../src/agents/reviewer.ts#L137-L140) on the next no-tool turn.
     - **Call 2** (review 1, final): return `content: "REVIEW DONE"`, `toolCalls: []`, `finishReason: "end_turn"`. `runLoop()` pushes this assistant message at [src/agents/base.ts](../../../../src/agents/base.ts#L266), then returns. Currently the reviewer also pushes it at [src/agents/reviewer.ts](../../../../src/agents/reviewer.ts#L121) (the bug); after F09 it does not.
     - **Call 3** (review 2, first turn): return any valid tool-use response (e.g. `content: "Re-inspecting."`, `toolCalls: [{ id: "tool-2", name: "test_tool", input: {} }]`). The captured `messages` on this call is the post-review-1 snapshot that the test asserts on.
     - **Call 4** (review 2, final): return a no-tool `"REVIEW DONE 2"` to let the second review return cleanly.
   - Driver:
     - `await agent.review(firstInput)`
     - `await agent.review(makeReviewInput("review-2", "Recheck"))`
   - Assertions on the captured `calls[2].messages` (the messages sent on call 3):
     - Exactly one entry has `role === "assistant"` and renders the text `"REVIEW DONE"`. Define a local helper inside the test file (project guideline #2 — no abstractions used only once; inline it):

       ```ts
       const assistantTextEquals = (m: { role: string; content: unknown }, target: string): boolean => {
         if (m.role !== "assistant") return false;
         if (typeof m.content === "string") return m.content === target;
         if (Array.isArray(m.content)) {
           const textBlocks = m.content.filter((b: any) => b?.type === "text").map((b: any) => b.text ?? "");
           return textBlocks.join("") === target;
         }
         return false;
       };
       const count = (calls[2].messages as any[]).filter((m) => assistantTextEquals(m, "REVIEW DONE")).length;
       expect(count).toBe(1);
       ```

     - The single `"REVIEW DONE"` assistant entry is followed (after the follow-up reviewer user message injected by `injectMessage` in [src/agents/reviewer.ts](../../../../src/agents/reviewer.ts#L110)) by review 2's content, not by another `"REVIEW DONE"`.
   - This regression is the one F09 fixes via the `review()` rewrite. The test belongs in this F14 commit (paired with the planner fix) so the post-condition is pinned by an F14-owned test even after F09 lands.

4. **Add planner regression test** in a new sibling file `src/agents/planner.nudge.test.ts`. [src/agents/agents.test.ts](../../../../src/agents/agents.test.ts) does NOT currently import or construct `PlannerAgent`; rather than add planner scaffolding there for a single test, place this test in its own file co-located with the reviewer tests' style.

   - Imports: `PlannerAgent` from `./planner.js`, `makeReviewerContext` and supporting helpers — since those helpers live as private functions in `agents.test.ts`, copy the minimal subset needed (`ensureDir`, the `AgentContext`-building factory adapted to `role: "planner"`, `agentId: "planner-1"`, `stageId: undefined`) into the new test file. Do NOT export the helpers from `agents.test.ts` to share them; the duplication is one test file's worth and is preferred over creating a new test-helper module for a single use (project guideline #2).
   - Test name: `does not duplicate the nudged assistant message in this.messages`.
   - Stub-router behaviour, in order:
     - **Call 1**: no-tool text response — `content: "I have nothing else to do."`, `toolCalls: []`, `finishReason: "end_turn"`. `PlannerAgent` does not override `validateFinalResponse()`, so the default at [src/agents/base.ts](../../../../src/agents/base.ts#L264) returns `null` and `runLoop()` returns this text. The planner success branch at [src/agents/planner.ts](../../../../src/agents/planner.ts#L216-L217) sees no `PLAN_COMPLETE` match and falls into the nudge branch at [src/agents/planner.ts](../../../../src/agents/planner.ts#L220-L241).
     - **Call 2**: text response matching the planner success regex — `content: "PLAN_COMPLETE"`, `toolCalls: []`, `finishReason: "end_turn"`. `runLoop()` pushes and returns; the planner regex `/^\s*PLAN_COMPLETE\s*$/m` at [src/agents/planner.ts](../../../../src/agents/planner.ts#L216) matches and `run()` returns `{ kind: "success", data: { summary: "PLAN_COMPLETE" } }`.
   - Driver: `await planner.run()`.
   - Assertions on the captured `calls[1].messages` (the messages sent on call 2):
     - Use the same local `assistantTextEquals` helper as in Step 3 (inline it in this file as well — different test files, single use within each).
     - Exactly one assistant entry has text `"I have nothing else to do."`.
     - The entry immediately following that single assistant entry is a `role: "user"` message whose content (string-typed) starts with `"SYSTEM: You ended your turn with text only"` — confirming the nudge ordering described in analysis r2 §Constraints #3 is preserved (one assistant turn, then the nudge user message, in that order).

5. **Verify no other duplicate-push site silently exists** with a single ripgrep pass:

   ```bash
   cd /home/salva/g/ml/saivage
   rg -n 'this\.messages\.push\(\s*\{\s*role:\s*"assistant"' src/
   ```

   After Step 1 and F09 Step 6, the expected output is empty. If any hit remains, file a follow-up — do NOT silently delete additional pushes here without an analysis pass. (The only legitimate `pushMessage({ role: "assistant", ... })` site is inside `BaseAgent` itself at [src/agents/base.ts](../../../../src/agents/base.ts#L266); the regex above intentionally targets the literal `this.messages.push(...)` form so it does not match the base-class `pushMessage` helper.)

## 2. Test strategy

### Existing tests that cover the behaviour

- [src/agents/agents.test.ts](../../../../src/agents/agents.test.ts#L91-L145) — exercises `ReviewerAgent` end-to-end with stubbed providers. Public APIs (`run()`, `review()`) are unchanged; existing assertions remain valid. In particular, the existing "keeps prior review reports visible for follow-up reviews" test continues to pass: it asserts that `"first review found blocker"` appears in the second review's request messages, which it still does — just once instead of twice.
- [src/agents/base.compaction.test.ts](../../../../src/agents/base.compaction.test.ts) — covers `runLoop` / compaction interaction. Unaffected; verify it still passes.
- The `PlannerAgent` is NOT exercised by `agents.test.ts` today (confirmed by inspecting imports at [src/agents/agents.test.ts](../../../../src/agents/agents.test.ts#L11-L20)); the new file `src/agents/planner.nudge.test.ts` is the first planner test in the agents test surface and is the only test that hits the nudge branch.

### New tests to add

- Reviewer single-assistant-trail assertion across two `review()` calls (Step 3, added to existing `describe("ReviewerAgent", ...)` block).
- Planner nudge-path single-assistant-then-user-nudge ordering (Step 4, new file).

### Commands to run

After Step 1 and Steps 3-4, and once F09 is in (or, under Proposal A, after a Step 1 variant that also deletes the reviewer line):

```bash
cd /home/salva/g/ml/saivage
npm run typecheck
npx vitest run src/agents/agents.test.ts
npx vitest run src/agents/planner.nudge.test.ts
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

The web bundle is unaffected (no `web/src/` changes); `npm run build` runs `npm run build:web && tsup` per [package.json](../../../../package.json#L13) but is cheap and worth running once.

## 3. Validation

This change is TypeScript-only inside `src/agents/`; no web UI, no docs, no LXC deployment, no runtime/dashboard semantics.

The workspace skill at [.github/skills/saivage-development-validation/SKILL.md](../../../../../.github/skills/saivage-development-validation/SKILL.md) is **not applicable**: its commands target `/home/salva/g/ml/saivage-v3` and Jest, while F14 modifies `/home/salva/g/ml/saivage` (this repo), which uses Vitest (`"test": "vitest run"`, [package.json](../../../../package.json#L17)) and `tsc --noEmit` for typecheck ([package.json](../../../../package.json#L21)).

Repo-local validation:

1. `npm run typecheck` — must pass cleanly ([package.json](../../../../package.json#L21)).
2. `npm run lint` — must pass cleanly ([package.json](../../../../package.json#L20)).
3. `npx vitest run src/agents/` — focused agent suite must pass.
4. `npx vitest run` — full suite must pass.
5. `npm run build` — build smoke check.

No LXC redeploy. The change does not affect on-disk formats, planner contracts, dashboard API schemas, or runtime state.

## 4. Rollback strategy

Single commit containing only:

- The one-line deletion (plus its now-stale comment) in [src/agents/planner.ts](../../../../src/agents/planner.ts#L231-L232) (Step 1).
- The new reviewer regression test added to [src/agents/agents.test.ts](../../../../src/agents/agents.test.ts) (Step 3).
- The new file `src/agents/planner.nudge.test.ts` (Step 4).

Commit message body must call out the behavioural change explicitly: `PlannerAgent no longer manually pushes the final assistant message after runLoop() in the nudge branch — BaseAgent.runLoop() already pushes it at base.ts:266. Restores invariant: exactly one assistant message per LLM turn in this.messages.`

Rollback: `git revert <sha>`. The deleted line and comment return; the new tests vanish. No data migration, no schema change, no on-disk format change.

If F09 is later reverted (independent decision), the reviewer half regresses. The F14-owned reviewer regression test (Step 3) will then fail and surface the regression immediately — this is the explicit reason F14 keeps the reviewer test even though the reviewer deletion is owned by F09's commit.

## 5. Cross-issue ordering

- **F09 (worker duplication / `WorkerAgent`)** — F09's [F09/03-plan-r2.md](../F09/03-plan-r2.md) Step 6 owns the reviewer L121 deletion as part of the `review()` rewrite. F14 (Proposal B) **must land after** F09. If F09 slips, fall back to **Proposal A** (see [02-design-r2.md](02-design-r2.md)): same plan structure, but Step 1 also deletes the single line at [src/agents/reviewer.ts](../../../../src/agents/reviewer.ts#L121) (and only that line — the rest of `review()` remains untouched until F09 lands).
- **F03 (naive JSON parsing)** — orthogonal. Can ship before or after F14.
- **F18 (prompt bloat)** — orthogonal.

There are no other downstream dependencies. F14 closes the issue tracked in [F14-reviewer-double-push.md](../F14-reviewer-double-push.md) and the related observation in [00-SUBSYSTEM-MAP.md](../00-SUBSYSTEM-MAP.md) §2 boundary #3.
