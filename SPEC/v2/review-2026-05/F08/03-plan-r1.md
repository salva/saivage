# F08 — Plan (r1)

Plan for **Proposal A** — focused delete of the legacy runtime-state mirror, the helper that derives its path, the test case that asserts it, and the planner-prompt paragraph that documents it.

## Ordered edit steps

1. **Edit [src/runtime/recovery.ts](src/runtime/recovery.ts#L297-L315).**
   - Replace the body of `writeRuntimeState` with a single call:
     ```ts
     export function writeRuntimeState(
       path: string,
       state: RuntimeState,
     ): void {
       writeDoc(path, state, RuntimeStateSchema);
     }
     ```
   - Delete the entire `legacyRuntimeStatePath` helper function (the next 7 lines).
   - Verify the `join` import on line 14 still has other consumers (`recoverFromCrash` uses it for `stageDir`, `summaryPath`, `tasksPath`, `reportsDir`); it does — keep it.
   - Verify the `dirname` import is still used by `ensureDir` / parent-dir computation in `recoverFromCrash` ([src/runtime/recovery.ts](src/runtime/recovery.ts#L172)); it is — keep it.

2. **Edit [src/runtime/runtime.test.ts](src/runtime/runtime.test.ts#L1026-L1043).**
   - Delete the entire `it("writeRuntimeState mirrors the compatibility runtime-state path", () => { … })` test block (lines 1026 through the closing `});` on 1043 inclusive).
   - Do NOT replace it with a "mirror is NOT written" negative test — that would defend the deletion forever (Constraint 4 in the analysis).
   - Verify the surrounding `describe` block still has at least one test and brackets balance: run `npx vitest run src/runtime/runtime.test.ts --reporter=verbose` after the edit.

3. **Edit [src/agents/planner.ts](src/agents/planner.ts#L47).**
   - Replace the existing bullet:
     ```
     - `.saivage/tmp/state/runtime.json` — authoritative live agent status visible on the dashboard. Older artifacts may mention `.saivage/runtime/runtime-state.json`; treat that as a compatibility mirror, not the primary state path.
     ```
     with:
     ```
     - `.saivage/tmp/state/runtime.json` — authoritative live agent status visible on the dashboard.
     ```
   - Do not touch other bullets in the same list; they are F18's territory.

4. **Grep verification (sanity).**
   - From repo root: `rg -n "runtime-state\\.json|legacyRuntimeStatePath" -t ts -g '!dist/**'`. Expected output: zero matches. Any hit means the deletion is incomplete (or someone added a new caller in parallel — investigate before proceeding).
   - From repo root: `rg -n "compatibility mirror|legacy runtime|legacy.*runtime-state" -t ts -t md -g '!dist/**' -g '!node_modules/**' -g '!SPEC/v2/review-2026-05/**'`. Expected: zero matches outside this review directory.

## Test strategy

**Existing tests that cover the modified code:**

- [src/runtime/runtime.test.ts](src/runtime/runtime.test.ts) — `RuntimeTracker` lifecycle tests (lines around 1045, 1064 …) exercise `writeRuntimeState` indirectly via `tracker.flush()`. They write to a temp path that does NOT match the `tmp/state/runtime.json` suffix, so they already touch only the primary write — they continue to pass byte-for-byte.
- The three direct `writeRuntimeState` callers in the test file at lines 1114, 1203, 1246 also use the SPEC-shaped path under `tmpDir/.saivage/tmp/state/runtime.json`. With the mirror gone, only the primary file is written; the assertions on those tests read back through `paths.runtimeState`, which is unchanged.
- [src/runtime/shutdown-handoff.test.ts](src/runtime/shutdown-handoff.test.ts#L55-L67) writes to `paths.runtimeState` via `writeDoc` directly (not `writeRuntimeState`); unaffected.

**New tests:** none. The deletion removes a test; per Constraint 4 we do not add a negative test in its place. The remaining `RuntimeTracker` tests already cover the live behaviour of `writeRuntimeState`.

**Validation commands** (run in order; project root is `/home/salva/g/ml/saivage`):

```
npm run typecheck
npm run build
npx vitest run src/runtime/runtime.test.ts
npx vitest run src/runtime/
npx vitest run
```

Expected: `typecheck` and `build` pass; the targeted vitest run shows one fewer test than before; the full vitest run is green.

**Manual smoke (optional, only if reviewing the runtime in a live container):**

- On the `saivage-v3` LXC harness (per workspace handoff), confirm `/work/saivage-v3/.saivage/tmp/state/runtime.json` continues to update on the dashboard, and that `/work/saivage-v3/.saivage/runtime/runtime-state.json` stops updating (mtime stops advancing after the deploy). The orphan file itself is left in place per Constraint 3.

## Rollback strategy

Single commit; revert with `git revert <sha>`. The reverted state restores the dual-write, the helper, the test case, and the planner-prompt paragraph identically. No data migration is needed in either direction (the primary path's data is never touched, only the redundant mirror).

If the change is in production and operators complain about the orphan file accumulating in `.saivage/runtime/`, the response is `rm -rf .saivage/runtime/` per project — not a code change.

## Cross-issue ordering note

- **Independent of F06, F22, F24.** F08 can land before or after any of them; there is no merge ordering requirement.
- **Eases F22.** F22's "documents store sync fs" patch becomes simpler in the runtime-state hot path because there is one fewer await to add inside `writeRuntimeState`. If F22 lands first, F08's edit becomes mechanically identical (just delete one `await writeDoc(legacyPath, …)` instead of one synchronous call).
- **Disjoint from F18.** F18 (system-prompt bloat) will rewrite the planner prompt more broadly; the one-line trim in step 3 is small enough that the merge with F18's eventual rewrite is trivial.
- **Disjoint from the in-flight skills/memory work.** F08 touches no file under `src/skills/` or `SPEC/v2/skills*`.
