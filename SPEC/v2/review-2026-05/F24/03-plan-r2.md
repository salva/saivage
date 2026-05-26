# F24 — Plan r2 (Proposal A: rename consumed handoff files)

## Changes from r1

- **Locked the consumed-file suffix contract to `${path}.consumed`** everywhere (resulting on-disk names: `shutdown-summary.json.consumed` and `shutdown-request.json.consumed`). r1 plan already used this spelling but r1 design used `*.consumed.json`; r2 design now matches. Reviewer r1 (item 2).
- **Reordered `consumeShutdownHandoff` to claim-then-format** (rename first, then build directive string). This closes the post-consume re-read failure window: a crash between rename and return leaves the data preserved as `${path}.consumed` instead of deleting the only copy. Step 2 now spells out the new ordering.
- **Added a stale-replay test** that documents (and asserts) the in-scope behaviour: a `${path}.consumed` left from a previous consume is **not** picked up by the next `consumeShutdownHandoff` (because the consumer only ever reads the un-suffixed `.json`). The test also documents the deliberate out-of-scope limitation: an un-suffixed file that survived because a *prior* bootstrap never reached the consume step would still be consumed as fresh — the operator memory note remains the mitigation for that case. Reviewer r1 (item 3).
- **Dropped the "operator memory note becomes obsolete" claim** from r1. The note remains correct for the cross-generation case (out of scope for F24). Reviewer r1 (item 1).

## Edit steps (ordered)

1. **Add a `renameDoc` primitive in the document store.**
   - File: [src/store/documents.ts](src/store/documents.ts).
   - Add a sibling of `deleteDoc`:
     ```ts
     export function renameDoc(src: string, dst: string): void {
       renameSync(src, dst);
     }
     ```
     `renameSync` is already imported (see the import block at [src/store/documents.ts](src/store/documents.ts#L6-L17)); no new import needed.
   - No other store changes. Do not refactor the file beyond this; F22 covers the broader sync-fs concern.

2. **Replace the three `deleteDoc` calls in `shutdown-handoff.ts` with `markConsumed`, and reorder consume to claim-then-format.**
   - File: [src/runtime/shutdown-handoff.ts](src/runtime/shutdown-handoff.ts).
   - Replace the import `import { deleteDoc, readDocOrNull, writeDoc } from "../store/documents.js";` ([src/runtime/shutdown-handoff.ts](src/runtime/shutdown-handoff.ts#L16)) with `import { readDocOrNull, renameDoc, writeDoc } from "../store/documents.js";` (drop `deleteDoc`; add `renameDoc`).
   - Add an internal helper near the bottom of the file:
     ```ts
     function markConsumed(path: string): void {
       renameDoc(path, `${path}.consumed`);
     }
     ```
     The `.consumed` suffix is applied to the full path so `shutdown-summary.json` becomes `shutdown-summary.json.consumed`. Contract is contiguous with the design.
   - At [src/runtime/shutdown-handoff.ts](src/runtime/shutdown-handoff.ts#L74), change `if (request) deleteDoc(project.paths.shutdownRequest);` to `if (request) markConsumed(project.paths.shutdownRequest);`.
   - In `consumeShutdownHandoff` (currently [src/runtime/shutdown-handoff.ts](src/runtime/shutdown-handoff.ts#L79-L95)), reorder the summary branch so the rename happens **before** building the directive:
     ```ts
     if (summary) {
       markConsumed(project.paths.shutdownSummary);
       return formatShutdownSummaryForPlanner(summary);
     }
     ```
     Same pattern for the request-only fallback branch: call `markConsumed(project.paths.shutdownRequest)` before constructing the `SYSTEM RESTART HANDOFF: …` template string.
   - No changes to function signatures, exports, or `ShutdownSummarySchema`.

3. **Idempotency for re-shutdowns.**
   - `renameSync` on POSIX atomically replaces an existing destination. A second shutdown in the same project simply overwrites the previous `${path}.consumed` file — the intended single-slot semantic. No code is required for this; step 4 adds the test.

4. **Update existing tests; add two new tests.**
   - File: [src/runtime/shutdown-handoff.test.ts](src/runtime/shutdown-handoff.test.ts).
   - In "writes a shutdown summary and consumes it as Planner restart context", replace the assertion at [L141](src/runtime/shutdown-handoff.test.ts#L141) `expect(existsSync(project.paths.shutdownSummary)).toBe(false);` with both:
     ```ts
     expect(existsSync(project.paths.shutdownSummary)).toBe(false);
     expect(existsSync(`${project.paths.shutdownSummary}.consumed`)).toBe(true);
     ```
     Also update the earlier assertion at [L131](src/runtime/shutdown-handoff.test.ts#L131) — `existsSync(project.paths.shutdownRequest)).toBe(false)` — by adding `expect(existsSync(\`${project.paths.shutdownRequest}.consumed\`)).toBe(true);`.
   - In "falls back to a request-only Planner handoff if no summary was saved" ([L154-L161](src/runtime/shutdown-handoff.test.ts#L154-L161)), same pattern: keep the negative existence check on the original path; add the positive existence check on `${path}.consumed`.
   - In "does not throw when a stale summary file is malformed" ([L162-L173](src/runtime/shutdown-handoff.test.ts#L162-L173)), no behavioural change needed — the malformed file falls through to the request branch. Add `expect(existsSync(\`${project.paths.shutdownRequest}.consumed\`)).toBe(true);` to assert the request was claim-renamed.
   - **New test #1: "second consume on the same project replaces the prior .consumed file".**
     - Seed once, write request + summary, consume.
     - Then write request + summary again (no separate seed needed; the project paths are stable), consume.
     - Assert: `${project.paths.shutdownSummary}.consumed` exists exactly once (use `readFileSync` to check contents); its parsed `reason` matches the *second* shutdown's reason; un-suffixed `shutdownSummary` does not exist. Same for `shutdownRequest`.
   - **New test #2: "consume does not re-read a previously consumed file".**
     - Seed, write request + summary, consume → returns directive A; assert `${path}.consumed` exists.
     - Without writing any new request or summary, call `consumeShutdownHandoff` again.
     - Assert: returns `null`. The un-suffixed `.json` does not exist; `${path}.consumed` is untouched. This documents the in-scope guarantee that the consumer only reads un-suffixed paths and that `.consumed` files are forensic-only.
     - **Out-of-scope note (in a code comment in the test only):** an un-suffixed file produced by a prior process generation that bypassed consume would still be picked up on the next bootstrap; preventing that requires a `run_id` stamp and is not covered by F24. This matches the operator-side memory note about clearing stale handoffs when repurposing the harness.

5. **No repo doc changes.**
   - The user memory note about clearing stale `.saivage/tmp/state/*.json` files when repurposing the v2 harness remains correct (it covers the out-of-scope cross-generation case) and lives in the user's memory store, not in the repo. Do not touch repo docs in this change.

## Test strategy

Existing coverage to rely on:

- The three tests in [src/runtime/shutdown-handoff.test.ts](src/runtime/shutdown-handoff.test.ts) already cover (a) full happy path, (b) fallback when only a request exists, (c) malformed summary fallthrough. All three need the assertion updates from step 4.

New coverage:

- **New test #1** (rename-overwrite on re-shutdown) covers the one-slot semantic and proves the rename target is atomically replaced.
- **New test #2** (no re-read of `.consumed`) covers the in-scope correctness claim — the consumer only ever reads un-suffixed paths — and inline-documents the out-of-scope cross-generation limitation.

Commands to run from `/home/salva/g/ml/saivage`:

```
npm run typecheck
npx vitest run src/runtime/shutdown-handoff.test.ts
npm run build
```

`npm run typecheck` catches the import-list change in step 2. The vitest run is fast (only `tmpdir`-backed I/O). The build verifies `tsup` still produces `dist/`.

A broader sanity run is optional but cheap:

```
npx vitest run
```

## Rollback strategy

Single commit. Revert with `git revert <sha>`. No data migration: any `${path}.consumed` files left on disk are inert — the reverted code only ever looks at the un-suffixed paths. Operators may delete them manually if desired.

## Cross-issue ordering

- **Independent of F08.** F08 deletes the legacy runtime-state mirror; F24 only touches `shutdown-handoff.ts` plus a new `renameDoc` helper in `documents.ts`. The two changes do not overlap and can land in either order.
- **Must land before any F22 follow-up that rewrites `documents.ts` against `fs/promises`.** Adding `renameDoc` in the current sync style first means F22's eventual conversion picks it up uniformly; doing it in the opposite order forces F24 to either pre-empt F22's async surface or churn twice.
- **No dependency on operator UI / dashboard work.** The `${path}.consumed` file is forensic-only; any future UI surfacing of it is a separate change.
- **A future "shutdown lineage / run_id" issue** (not yet filed) would build on F24 by adding an identity stamp to handoff files and rejecting cross-generation reads at consume time. Independent of F24's rename mechanic.
