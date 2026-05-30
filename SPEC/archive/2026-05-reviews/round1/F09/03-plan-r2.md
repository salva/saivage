# F09 — Implementation plan (R2)

## Changes from r1

Reviewer feedback in [04-review-r1.md](04-review-r1.md):

- **Reviewer item 1 (stale refs)**: accepted. Step 6 now points to the correct `reviewer.ts` lines (L102-L104 for the `run()` delegate, L106 for `review()`, L121 for the double-push to remove, L143 for `normalizeWorkerInput`) and to [base.ts L269](../../../../src/agents/base.ts#L269) for the existing terminal assistant push. Step 8's grep is unchanged.
- **Reviewer item 2 (Step 6 reviewer-run semantics)**: accepted. Step 6 now explicitly preserves the `ReviewerAgent.run()` → `review(this.input)` delegate, mandates that `review()` remains the only carrier of `reviewCount` / `injectMessage` semantics, and routes the post-loop mapping through the shared `WorkerAgent.executeTask()` helper rather than the inherited `WorkerAgent.run()`.
- **Reviewer item 3 (validation skill misattribution)**: accepted. The workspace skill at `/home/salva/g/ml/.github/skills/saivage-development-validation/SKILL.md` is scoped to `/home/salva/g/ml/saivage-v3` and uses Jest, not to this repo (`/home/salva/g/ml/saivage`) which uses Vitest and is what F09 actually touches. Section 3 is rewritten to list the repo-local Saivage v2 commands directly without invoking that skill.

Recommended proposal: **C — `WorkerAgent` base class**, with `src/agents/task-report.ts` extracted as a prerequisite and `src/agents/designer.ts` deleted in the same commit. Fallback (Proposal A) is mechanically the first half of these steps and can be split off if Step 4 hits unforeseen friction.

## 1. Ordered edit steps

All paths absolute under `/home/salva/g/ml/saivage/`.

1. **Create [src/agents/task-report.ts](../../../../src/agents/task-report.ts)**.
   - Export `WorkerRole = "coder" | "researcher" | "data_agent" | "reviewer"`.
   - Export `normalizeTask(raw: any, role: WorkerRole): Task` — body lifted verbatim from coder's copy at [coder.ts L212](../../../../src/agents/coder.ts#L212), with `type` and `assigned_to` defaults driven by a `ROLE_TO_TASK_TYPE` lookup. The shape is otherwise identical to today's per-worker copy.
   - Export `parseTaskReport(text, input, role, startedAt, startMs): TaskReport` — body lifted from coder's copy at [coder.ts L263](../../../../src/agents/coder.ts#L263) with `agent: role`. Do NOT fix F03 here; keep the existing regex/silent-fall-through behaviour so F09 stays a pure refactor. F03 will edit this single function later.
   - Export `buildFailureReport(input, role, startedAt, startMs, reason): TaskReport` — unifies on the "with single error issue" variant (data-agent/reviewer/designer shape, per analysis §2.3). This is one of two behavioural changes in F09 and must be called out in the commit message.

2. **Create [src/agents/worker.ts](../../../../src/agents/worker.ts)**.
   - Export `WorkerAgentConfig` and abstract `WorkerAgent extends BaseAgent implements Agent`.
   - Implement `run()` as a one-line `return this.executeTask(this.input)`.
   - Implement `executeTask(input: WorkerInput): Promise<AgentResult>` as a protected method holding the shared try/catch + finishReason switch + `parseTaskReport` / `buildFailureReport` mapping (see [02-design-r2.md](02-design-r2.md) §"Proposal C → Shape").
   - Implement `validateFinalResponse()` returning `null` if `hasUsedAnyTool()`, else the configured `invalidFinalResponseMessage`.
   - Stores `input: WorkerInput` (protected), `workerRole: WorkerRole` (protected, used by `ReviewerAgent`), `invalidFinalResponseMessage: string` (private).
   - No other public methods.

3. **Edit [src/agents/coder.ts](../../../../src/agents/coder.ts)**.
   - Remove unused imports `readFileSync`, `join` (currently at top of file but never used).
   - Replace `extends BaseAgent implements Agent` with `extends WorkerAgent`.
   - Remove the module-private `normalizeTask` ([L212](../../../../src/agents/coder.ts#L212)), `parseTaskReport` ([L263](../../../../src/agents/coder.ts#L263)), `buildFailureReport` ([L319](../../../../src/agents/coder.ts#L319)) functions (~140 lines total).
   - Remove the overridden `run()` and `validateFinalResponse()` on `CoderAgent`.
   - Replace the constructor body with a single `super(ctx, input, { role: "coder", systemPrompt: CODER_PROMPT, buildInitialMessage: (i) => buildCoderMessage(ctx, i), invalidFinalResponseMessage: "...", ...config })`.
   - Keep `CODER_PROMPT` and `buildCoderMessage` as-is.

4. **Edit [src/agents/researcher.ts](../../../../src/agents/researcher.ts)** — same transformation, `role: "researcher"`. Helpers to delete are at [L208](../../../../src/agents/researcher.ts#L208), [L260](../../../../src/agents/researcher.ts#L260), [L313](../../../../src/agents/researcher.ts#L313). Keep `RESEARCHER_PROMPT` and `buildResearcherMessage`.

5. **Edit [src/agents/data-agent.ts](../../../../src/agents/data-agent.ts)** — same transformation, `role: "data_agent"`. Helpers to delete are at [L125](../../../../src/agents/data-agent.ts#L125), [L176](../../../../src/agents/data-agent.ts#L176), [L229](../../../../src/agents/data-agent.ts#L229). Keep `DATA_AGENT_PROMPT` and `buildDataAgentMessage`.

6. **Edit [src/agents/reviewer.ts](../../../../src/agents/reviewer.ts)** — **special case, preserves the existing public contract**.
   - Change the class declaration to `class ReviewerAgent extends WorkerAgent`.
   - Delete the module-private helpers at [L143 `normalizeWorkerInput`](../../../../src/agents/reviewer.ts#L143), [L148 `normalizeTask`](../../../../src/agents/reviewer.ts#L148), [L206 `parseTaskReport`](../../../../src/agents/reviewer.ts#L206), [L259 `buildFailureReport`](../../../../src/agents/reviewer.ts#L259). Delete the overridden `validateFinalResponse()` on `ReviewerAgent`.
   - **Keep the `run()` override**. The existing implementation at [reviewer.ts L102-L104](../../../../src/agents/reviewer.ts#L102-L104) is `async run() { return this.review(this.input); }`. Re-write it as exactly that one-line delegate using the override keyword: `override async run(): Promise<AgentResult> { return this.review(this.input); }`. **Do not let `ReviewerAgent` inherit `WorkerAgent.run()`.** The inherited version would call `executeTask(this.input)` directly and bypass `reviewCount` / `injectMessage`. This is the explicit answer to reviewer item 2.
   - **Rewrite `review()`** (currently [reviewer.ts L106-L138](../../../../src/agents/reviewer.ts#L106-L138)) to:

     ```ts
     async review(input: WorkerInput): Promise<AgentResult> {
       this.input = { ...input, task: normalizeTask(input.task, "reviewer") };
       if (this.reviewCount > 0) {
         this.injectMessage(buildReviewerMessage(this.ctx, this.input, this.reviewCount + 1));
       }
       this.reviewCount++;
       return this.executeTask(this.input);
     }
     ```

     - `normalizeTask` is the imported one from `task-report.ts`.
     - `injectMessage(buildReviewerMessage(...))` for follow-up reviews is preserved verbatim from the current implementation.
     - `reviewCount` is preserved as a member of `ReviewerAgent` (it was already declared on the class; do not move it to `WorkerAgent`).
     - The post-loop mapping is delegated to `this.executeTask(this.input)`, which is the `WorkerAgent` helper Step 2 introduces. `executeTask` is responsible for `runLoop()` + finishReason switch + `parseTaskReport` / `buildFailureReport`.
   - **Remove the stray `this.messages.push({ role: "assistant", content: text });` at [reviewer.ts L121](../../../../src/agents/reviewer.ts#L121).** `BaseAgent.runLoop()` already pushes the terminal assistant message at [base.ts L269](../../../../src/agents/base.ts#L269) via `pushMessage({ role: "assistant", content: assistantContent }, ...)`. The manual push was a double-write bug (F14 / subsystem-map note). Removing it is the second of the two behavioural changes F09 introduces and must be called out in the commit message. The removal happens by way of the `review()` rewrite above — the new body does not contain the stray push.

7. **Delete [src/agents/designer.ts](../../../../src/agents/designer.ts)** (per F01).
   - Verified: `grep -rnE "designer|DesignerAgent" src/ --include="*.ts" | grep -v "src/agents/designer.ts"` returns no matches. Bootstrap does not construct it; the dispatcher role map has no `designer` entry; `index.ts` does not export it.
   - If any stray reference appears at edit time (e.g. in tests, in a barrel export), remove it.

8. **Verify no other duplicate copies linger** — run `grep -rn "function normalizeTask\|function parseTaskReport\|function buildFailureReport" src/agents/` after edits. Only the definitions inside `src/agents/task-report.ts` should remain. Inspector's `normalizeInspectionRequest` and `parseInspectionReport` are different functions over different types and stay.

## 2. Test strategy

### Existing tests that cover this change

- [src/agents/agents.test.ts](../../../../src/agents/agents.test.ts) — constructs `CoderAgent` and `ReviewerAgent` and exercises `run()` and `review()`. The public API is unchanged, so these tests should pass without modification. If they fail, the failure is the bug — investigate before patching the tests.
- [src/agents/conversation-snapshot.test.ts](../../../../src/agents/conversation-snapshot.test.ts) — tests snapshot serialisation. Should be untouched by F09 (the changed code is outside the snapshot serialiser). Removing reviewer's stray `messages.push` may change the count of trailing assistant messages observed in any test that constructs a reviewer and inspects `getConversationSnapshot()` after `review()` — if so, those expectations were asserting the bug; update them to assert the correct behaviour (one assistant message per `runLoop()`, not two).

### New tests to add

In `src/agents/agents.test.ts` (or a new `src/agents/task-report.test.ts` if the file is already crowded — check before deciding):

- `normalizeTask`: feed a raw object with `objective` instead of `description`, `acceptance_criteria` instead of `checklist`, no `id`, no `assigned_to`. Assert the returned `Task` has the role's `type` and `assigned_to` defaults, description includes the objective, and checklist items are coerced to `{description, required: true}`.
- `parseTaskReport`: feed a text string with a valid JSON object → assert the parsed report uses the role as `agent` and overlays missing fields with defaults. Feed text without a JSON object → assert the fallback report (`status: "completed"`, truncated summary).
- `buildFailureReport`: assert `issues_found = [{ severity: "error", description: reason }]` for all four roles (this is the unification — without a test it could silently regress).
- `ReviewerAgent.run()`: assert that calling `run()` followed by `review(input)` with the same input increments `reviewCount` twice (covers the `run()` → `review()` delegate explicitly).

### Commands to run

After each numbered step that touches a file, and at the end:

```bash
cd /home/salva/g/ml/saivage
npm run typecheck
npx vitest run src/agents/
```

Final whole-package run before considering F09 done:

```bash
cd /home/salva/g/ml/saivage
npm run typecheck
npm run lint
npx vitest run
npm run build
```

## 3. Validation

This change is TypeScript-only inside `src/agents/`; no web UI, no docs, no LXC deployment.

The workspace skill at [/home/salva/g/ml/.github/skills/saivage-development-validation/SKILL.md](../../../../../.github/skills/saivage-development-validation/SKILL.md) is **not applicable** here: its local-validation commands are scoped to `/home/salva/g/ml/saivage-v3` and Jest (`NODE_OPTIONS=--experimental-vm-modules npx jest ... --runInBand --forceExit`), while F09 modifies `/home/salva/g/ml/saivage` (this repo) which uses Vitest (`"test": "vitest run"` at [package.json L17](../../../../package.json#L17)) and `tsc --noEmit` for typecheck ([package.json L20](../../../../package.json#L20)). Do not run the skill's commands against this repo.

Repo-local validation for this F09 change:

1. `npm run typecheck` — must pass cleanly. Backed by `tsc --noEmit` ([package.json L20](../../../../package.json#L20)).
2. `npm run lint` — must pass cleanly. Backed by `eslint src/` ([package.json L19](../../../../package.json#L19)).
3. `npx vitest run src/agents/` — agent unit tests must pass (focused run).
4. `npx vitest run` (or `npm test`) — full suite must pass (no peripheral regressions). Backed by `"test": "vitest run"` ([package.json L17](../../../../package.json#L17)).
5. `npm run build` — runs `npm run build:web && tsup` ([package.json L13](../../../../package.json#L13)). For this F09 change, the web bundle is unaffected; `npm run build:server` (just `tsup`) is sufficient as a smoke check, but running the full `npm run build` is cheap and worth doing once before declaring done.

No need to rebuild `web/` (no UI changes). No need to redeploy to any LXC container — F09 does not change runtime/dashboard semantics, only worker construction internals.

If a downstream consumer (such as the `saivage-v3` harness that imports the built `saivage` package via `dist/`) is later rebuilt against the new code, do a smoke check by triggering a one-task stage and confirming a `TaskReport` is written under `.saivage/stages/<id>/reports/` — but this is optional verification, not a blocker for F09 itself.

## 4. Rollback strategy

Single commit. The commit body must list the two behavioural changes plus the deletion (so a future reader auditing a regression knows where to look):

1. `buildFailureReport.issues_found` now contains a single error issue uniformly across all workers (was empty for coder/researcher).
2. `ReviewerAgent.review()` no longer manually pushes a trailing assistant message after `runLoop()` (was a double-push; `BaseAgent.runLoop()` already pushes at `base.ts` L269). `ReviewerAgent.run()` still delegates to `review(this.input)` so `reviewCount` / `injectMessage` semantics are unchanged.
3. `src/agents/designer.ts` deleted (per F01).

Rollback: `git revert <sha>`. The new `task-report.ts` and `worker.ts` files vanish; the four workers and `designer.ts` are restored verbatim. No data migration, no schema change, no on-disk format change.

## 5. Cross-issue ordering

- **F01 (designer orphan)**: Step 7 enacts F01's verdict for this subtree. F09 cannot be cleanly executed without taking a position on `designer.ts` (porting it perpetuates dead code; deleting it requires F01 to be agreed). Treat F01 as a co-decision and execute it inside the F09 commit. If F01 is independently resolved beforehand with a different verdict (e.g. "wire designer up properly"), F09 should land first and a fresh F01 commit can wire the now-`WorkerAgent`-based designer with ~20 lines of subclass code.
- **F03 (naive JSON parsing)**: Sequence F03 **after** F09. Once F09 lands, F03's fix is a single edit to `parseTaskReport` in `src/agents/task-report.ts` instead of five.
- **F14 (reviewer double-push side-effect)**: F09 fixes the double-push as a side-effect of the `review()` rewrite, while preserving the `run()` → `review()` delegate that F14 was concerned about losing. F14 can be closed when F09 lands.
- **F18 (prompt bloat)**: Orthogonal. Can be done before or after.

## 6. Alternative (Proposal A) — brief note

If during Step 2 the `WorkerAgent` extraction reveals unanticipated coupling (e.g. one worker needing a divergent `run()` body), fall back to **Proposal A**: keep `task-report.ts` (Step 1), skip `worker.ts` (Step 2), keep the per-worker `run()` skeletons but rewrite them to call the imported helpers. The rest of the steps (designer deletion, tests, validation, rollback) are unchanged. The reviewer double-push fix is then out of F09's scope and should be raised as a follow-up issue (F14 stays open).
