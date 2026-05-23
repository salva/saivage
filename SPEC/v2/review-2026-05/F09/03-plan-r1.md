# F09 — Implementation plan (R1)

Recommended proposal: **C — `WorkerAgent` base class**, with `src/agents/task-report.ts` extracted as a prerequisite and `src/agents/designer.ts` deleted in the same commit. Fallback (Proposal A) is mechanically the first half of these steps and can be split off if Step 4 hits unforeseen friction.

## 1. Ordered edit steps

All paths absolute under [saivage/](saivage/).

1. **Create [src/agents/task-report.ts](src/agents/task-report.ts)**.
   - Export `WorkerRole = "coder" | "researcher" | "data_agent" | "reviewer"`.
   - Export `normalizeTask(raw: any, role: WorkerRole): Task` — body lifted verbatim from coder's copy, with `type` and `assigned_to` defaults driven by a `ROLE_TO_TASK_TYPE` lookup. The shape is otherwise identical to today's per-worker copy.
   - Export `parseTaskReport(text, input, role, startedAt, startMs): TaskReport` — body lifted from coder's copy with `agent: role`. Do NOT fix F03 here; keep the existing regex/silent-fall-through behaviour so F09 stays a pure refactor. F03 will edit this single function later.
   - Export `buildFailureReport(input, role, startedAt, startMs, reason): TaskReport` — unifies on the "with single error issue" variant (data-agent/reviewer/designer shape, per analysis §2.3). This is the only behavioural change in F09 and must be called out in the commit message.

2. **Create [src/agents/worker.ts](src/agents/worker.ts)**.
   - Export `WorkerAgentConfig` and abstract `WorkerAgent extends BaseAgent implements Agent`.
   - Implements `run()` and `validateFinalResponse()` as in design §C.
   - Stores `input: WorkerInput`, `workerRole: WorkerRole`, `invalidFinalResponseMessage: string` as protected/private.
   - No other public methods.

3. **Edit [src/agents/coder.ts](src/agents/coder.ts)**.
   - Remove unused imports `readFileSync`, `join` (currently at top of file but never used).
   - Replace `extends BaseAgent implements Agent` with `extends WorkerAgent`.
   - Remove the module-private `normalizeTask`, `parseTaskReport`, `buildFailureReport` functions (~140 lines).
   - Remove the overridden `run()` and `validateFinalResponse()`.
   - Replace the constructor body with a single `super(ctx, input, { role: "coder", systemPrompt: CODER_PROMPT, buildInitialMessage: (i) => buildCoderMessage(ctx, i), invalidFinalResponseMessage: "...", ...config })`.
   - Keep `CODER_PROMPT` and `buildCoderMessage` as-is.

4. **Edit [src/agents/researcher.ts](src/agents/researcher.ts)** — same transformation, `role: "researcher"`, keep `RESEARCHER_PROMPT` and `buildResearcherMessage`.

5. **Edit [src/agents/data-agent.ts](src/agents/data-agent.ts)** — same transformation, `role: "data_agent"`, keep `DATA_AGENT_PROMPT` and `buildDataAgentMessage`.

6. **Edit [src/agents/reviewer.ts](src/agents/reviewer.ts)**.
   - Same transformation as the other workers for `run()` / `normalizeTask` / `parseTaskReport` / `buildFailureReport` / `validateFinalResponse`.
   - Keep `REVIEWER_PROMPT`, `buildReviewerMessage`, and the public `review(input: WorkerInput)` method.
   - Inside `review()`: replace `normalizeWorkerInput(input)` with `{ ...input, task: normalizeTask(input.task, "reviewer") }` and inline-delete the now-unused `normalizeWorkerInput` helper.
   - Replace the per-method `parseTaskReport` / `buildFailureReport` call sites with the imported ones (passing `"reviewer"`).
   - **Remove** the stray `this.messages.push({ role: "assistant", content: text });` at [reviewer.ts L122](src/agents/reviewer.ts#L122). `BaseAgent.runLoop()` already pushes the assistant message at its terminal text branch. Note this in the commit body.

7. **Delete [src/agents/designer.ts](src/agents/designer.ts)** (per F01).
   - Verify with `grep -r "designer" src/ --include="*.ts"` that no live import path references it. Based on §4 of the analysis, only the file itself uses `DesignerAgent`; bootstrap does not construct it, and the dispatcher role map has no `designer` entry.
   - If any stray reference exists (e.g. in tests, in a barrel export), remove it.

8. **Verify no other duplicate copies linger** — run `grep -rn "function normalizeTask\|function parseTaskReport\|function buildFailureReport" src/agents/` after edits. Only the definitions inside `src/agents/task-report.ts` should remain.

## 2. Test strategy

### Existing tests that cover this change

- [src/agents/agents.test.ts](src/agents/agents.test.ts) — constructs `CoderAgent` (L439) and `ReviewerAgent` (L281), exercises `run()` and `review()`. The public API is unchanged, so these tests should pass without modification. If they fail, the failure is the bug — investigate before patching the tests.
- [src/agents/conversation-snapshot.test.ts](src/agents/conversation-snapshot.test.ts) — tests snapshot serialisation. Should be untouched by F09 (the changed code is outside the snapshot serialiser). Removing reviewer's stray `messages.push` may change the count of trailing assistant messages observed in any test that constructs a reviewer and inspects `getConversationSnapshot()` after `review()` — if so, those expectations were asserting the bug; update them to assert the correct behaviour.

### New tests to add

In `src/agents/agents.test.ts` (or a new `src/agents/task-report.test.ts` if the file is already crowded — check before deciding):

- `normalizeTask`: feed a raw object with `objective` instead of `description`, `acceptance_criteria` instead of `checklist`, no `id`, no `assigned_to`. Assert the returned `Task` has the role's `type` and `assigned_to` defaults, description includes the objective, and checklist items are coerced to `{description, required: true}`.
- `parseTaskReport`: feed a text string with a valid JSON object → assert the parsed report uses the role as `agent` and overlays missing fields with defaults. Feed text without a JSON object → assert the fallback report (`status: "completed"`, truncated summary).
- `buildFailureReport`: assert `issues_found = [{ severity: "error", description: reason }]` for all four roles (this is the unification — without a test it could silently regress).

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
```

## 3. Validation per `saivage-development-validation` skill

This change is TypeScript-only inside `src/agents/`; no web UI, no docs, no LXC deployment.

Per [/home/salva/g/ml/.github/skills/saivage-development-validation/SKILL.md](.github/skills/saivage-development-validation/SKILL.md):

1. `npm run typecheck` — must pass cleanly.
2. `npx vitest run src/agents/` — agent unit tests must pass.
3. `npx vitest run` — full suite must pass (no peripheral regressions).
4. `npm run build` — optional but cheap and worth running once before declaring done.
5. No need to rebuild `web/` (no UI changes). No need to redeploy to any LXC container — F09 does not change runtime/dashboard semantics, only worker construction internals.

If the harness `saivage-v3` is later restarted against modified `saivage/dist`, do a smoke check by triggering a one-task stage and confirming a `TaskReport` is written under `.saivage/stages/<id>/reports/` — but this is optional verification, not a blocker.

## 4. Rollback strategy

Single commit. The commit body must list the three behavioural changes (so a future reader auditing a regression knows where to look):

1. `buildFailureReport.issues_found` now contains a single error issue uniformly across all workers (was empty for coder/researcher).
2. `ReviewerAgent.review()` no longer manually pushes a trailing assistant message after `runLoop()` (was a double-push; `BaseAgent` already pushes).
3. `src/agents/designer.ts` deleted (per F01).

Rollback: `git revert <sha>`. The new `task-report.ts` and `worker.ts` files vanish; the four workers and `designer.ts` are restored verbatim. No data migration, no schema change, no on-disk format change.

## 5. Cross-issue ordering

- **F01 (designer orphan)**: Step 7 enacts F01's verdict for this subtree. F09 cannot be cleanly executed without taking a position on designer.ts (porting it perpetuates dead code; deleting it requires F01 to be agreed). Treat F01 as a co-decision and execute it inside the F09 commit. If F01 is independently resolved beforehand with a different verdict (e.g. "wire designer up properly"), F09 should land first and a fresh F01 commit can wire the now-`WorkerAgent`-based designer with ~20 lines of subclass code.
- **F03 (naive JSON parsing)**: Sequence F03 **after** F09. Once F09 lands, F03's fix is a single edit to `parseTaskReport` in `src/agents/task-report.ts` instead of five.
- **F18 (prompt bloat)**: Orthogonal. Can be done before or after.

## 6. Alternative (Proposal A) — brief note

If during Step 2 the `WorkerAgent` extraction reveals unanticipated coupling (e.g. one worker needing a divergent `run()` body), fall back to **Proposal A**: keep `task-report.ts` (Step 1), skip `worker.ts` (Step 2), keep the per-worker `run()` skeletons but rewrite them to call the imported helpers. The rest of the steps (designer deletion, tests, validation, rollback) are unchanged. The reviewer double-push fix is then out of F09's scope and should be raised as a follow-up issue.
