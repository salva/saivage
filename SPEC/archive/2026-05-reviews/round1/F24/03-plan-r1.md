# F24 — Plan r1 (Proposal A: rename consumed handoff files)

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

2. **Replace the three `deleteDoc` calls in `shutdown-handoff.ts` with rename-to-`.consumed.json`.**
   - File: [src/runtime/shutdown-handoff.ts](src/runtime/shutdown-handoff.ts).
   - Add an internal helper near the bottom of the file:
     ```ts
     function markConsumed(path: string): void {
       renameDoc(path, `${path}.consumed`);
     }
     ```
     Use the `.consumed` suffix on the full path (so `shutdown-summary.json` becomes `shutdown-summary.json.consumed`). This keeps the `.json` extension contiguous with the original name and avoids accidentally matching the same file via any future `*.json` glob.
   - Replace the import `import { deleteDoc, readDocOrNull, writeDoc } from "../store/documents.js";` with `import { readDocOrNull, renameDoc, writeDoc } from "../store/documents.js";` (drop `deleteDoc`; add `renameDoc`).
   - At [src/runtime/shutdown-handoff.ts](src/runtime/shutdown-handoff.ts#L74), change `if (request) deleteDoc(project.paths.shutdownRequest);` to `if (request) markConsumed(project.paths.shutdownRequest);`.
   - At [src/runtime/shutdown-handoff.ts](src/runtime/shutdown-handoff.ts#L82), change `deleteDoc(project.paths.shutdownSummary);` to `markConsumed(project.paths.shutdownSummary);`.
   - At [src/runtime/shutdown-handoff.ts](src/runtime/shutdown-handoff.ts#L88), change `deleteDoc(project.paths.shutdownRequest);` to `markConsumed(project.paths.shutdownRequest);`.
   - No changes to function signatures, exports, or `ShutdownSummarySchema`.

3. **Idempotency for re-shutdowns.**
   - `renameSync` on POSIX atomically replaces an existing destination. A second shutdown in the same project simply overwrites the previous `*.consumed` file — the intended single-slot semantic. No code is required for this, but the test in step 4 must cover it.

4. **Update existing tests and add one new test.**
   - File: [src/runtime/shutdown-handoff.test.ts](src/runtime/shutdown-handoff.test.ts).
   - In "writes a shutdown summary and consumes it as Planner restart context", replace the final assertion at [L141](src/runtime/shutdown-handoff.test.ts#L141) `expect(existsSync(project.paths.shutdownSummary)).toBe(false);` with both:
     ```ts
     expect(existsSync(project.paths.shutdownSummary)).toBe(false);
     expect(existsSync(`${project.paths.shutdownSummary}.consumed`)).toBe(true);
     ```
     Also update the earlier assertion at [L131](src/runtime/shutdown-handoff.test.ts#L131) — `existsSync(project.paths.shutdownRequest)).toBe(false)` — by adding `expect(existsSync(\`${project.paths.shutdownRequest}.consumed\`)).toBe(true);`.
   - In "falls back to a request-only Planner handoff if no summary was saved" ([L154-L161](src/runtime/shutdown-handoff.test.ts#L154-L161)), same pattern: keep the negative existence check on the original path; add the positive existence check on `${path}.consumed`.
   - In "does not throw when a stale summary file is malformed" ([L162-L173](src/runtime/shutdown-handoff.test.ts#L162-L173)), no behavioural change needed (the malformed file falls through to the request branch, which we already cover). Optionally add `expect(existsSync(\`${project.paths.shutdownRequest}.consumed\`)).toBe(true);`.
   - New test: "second consume on the same project replaces the prior .consumed file".
     - Seed once, write request + summary, consume. Then seed again (new active stage), write request + summary, consume.
     - Assert: only one `${shutdownSummary}.consumed` file exists; its contents reflect the *second* shutdown's reason; `shutdownSummary` (un-suffixed) does not exist.

5. **Operator memory note — do not change the docs in this commit.**
   - The user memory note about manually clearing stale `shutdown-summary.json` after stopping the v2 harness becomes obsolete once consume rename-stamps the file. The note lives in the user's memory store, not in the repo; do not touch repo docs in this change. The reviewer of F24 should not block on this.

## Test strategy

Existing coverage to rely on:

- The three tests in [src/runtime/shutdown-handoff.test.ts](src/runtime/shutdown-handoff.test.ts) already cover (a) full happy path, (b) fallback when only a request exists, (c) malformed summary fallthrough. All three need the assertion updates from step 4.

New coverage:

- "Second consume replaces prior `.consumed`" test in step 4 covers the rename-overwrite semantic and the bug's "stale replay" half.

Commands to run from `/home/salva/g/ml/saivage`:

```
npm run typecheck
npx vitest run src/runtime/shutdown-handoff.test.ts
npm run build
```

`npm run typecheck` catches the import-list change in step 2. The vitest run is fast (no I/O beyond `tmpdir`). The build verifies `tsup` still produces `dist/`.

A broader sanity run is optional but cheap:

```
npx vitest run
```

## Rollback strategy

Single commit. Revert with `git revert <sha>`. No data migration: any `*.json.consumed` files left on disk are inert and either ignored by the reverted code (it only ever looks at the un-suffixed paths) or removed manually.

## Cross-issue ordering

- **Independent of F08.** F08 deletes the legacy runtime-state mirror; F24 only touches `shutdown-handoff.ts` plus a new `renameDoc` helper in `documents.ts`. The two changes do not overlap and can land in either order.
- **Must land before any F22 follow-up that rewrites `documents.ts` against `fs/promises`.** Adding `renameDoc` in the current sync style first means F22's eventual conversion picks it up uniformly; doing it in the opposite order forces F24 to either pre-empt F22's async surface or churn twice.
- **No dependency on operator UI / dashboard work.** The `.consumed` file is forensic-only for now; any future UI surfacing of it is a separate change.
