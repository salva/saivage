# F24 — Design r2

## Changes from r1

- **Locked the filename contract to `${original-path}.consumed`** everywhere (i.e. `shutdown-summary.json.consumed`, `shutdown-request.json.consumed`). The r1 design text used `*.consumed.json` while the r1 plan used `*.json.consumed`. Reviewer r1 (item 2) flagged this mismatch. Choosing `${path}.consumed` because (a) it matches the existing plan implementation, (b) it is a one-liner — `renameDoc(path, \`${path}.consumed\`)` — with no string-split required, and (c) it cannot accidentally match a future `*.json` glob.
- **Removed the "no stale replay" overclaim** from the recommendation. Reviewer r1 (item 1) correctly noted that Proposal A does not prevent a stale un-suffixed handoff from a previous process generation being consumed as fresh if the previous run never reached the consume step. The recommendation now claims only what Proposal A actually delivers: forensic preservation + post-consume re-read prevention. Cross-generation staleness is explicitly out of scope (see analysis r2).
- **Restated Proposal A risk and "what it forbids"** to reflect the narrowed scope: a file written by a *previous* process generation that was never consumed is still consumed as fresh on the next bootstrap. The operator-side memory note about clearing stale files when repurposing the harness is preserved as the correct mitigation; it is **not** rendered obsolete.
- Proposal B is unchanged in shape; its "Recommendation note" is unchanged (still not recommended this round). Only the recommendation section comparison wording is updated to reflect the narrower claim for A.

---

Two proposals. Both replace the current "delete on read" pattern in [src/runtime/shutdown-handoff.ts](src/runtime/shutdown-handoff.ts#L79-L95) and the request-deletion at [src/runtime/shutdown-handoff.ts](src/runtime/shutdown-handoff.ts#L74) with a non-destructive disposition. Per the project's no-backward-compat guideline, the chosen approach replaces the old behaviour outright; there is no flag or grace period.

## Proposal A — Rename consumed files to `${path}.consumed` (focused fix)

### Scope

Files touched:

- [src/runtime/shutdown-handoff.ts](src/runtime/shutdown-handoff.ts) — replace `deleteDoc` calls at [L74](src/runtime/shutdown-handoff.ts#L74), [L82](src/runtime/shutdown-handoff.ts#L82), [L88](src/runtime/shutdown-handoff.ts#L88) with a `markConsumed(path)` helper that calls `renameDoc(path, \`${path}.consumed\`)`. Also reorder `consumeShutdownHandoff` so the rename happens **before** building the directive string (claim-then-format), closing the post-consume re-read failure window: if the caller crashes after rename but before queueing, the directive is lost but the consumed file is preserved on disk for operator recovery.
- [src/store/documents.ts](src/store/documents.ts) — add a `renameDoc(src, dst)` primitive next to `deleteDoc`. `renameSync` is already imported there (see [src/store/documents.ts](src/store/documents.ts#L6-L17)). Sync rename matches the existing sync style; the only callers are at shutdown and bootstrap, never on a hot path.
- [src/runtime/shutdown-handoff.test.ts](src/runtime/shutdown-handoff.test.ts) — flip the assertion at [L141](src/runtime/shutdown-handoff.test.ts#L141) to expect the `${path}.consumed` file to exist and the original `.json` to be gone; same for the request-only fallback test ([L155-L160](src/runtime/shutdown-handoff.test.ts#L155-L160)); same for the request side of the happy-path test at [L131](src/runtime/shutdown-handoff.test.ts#L131). Add one new test (see plan) covering rename-overwrite on a second consume.

Behavioural change:

- `writeShutdownSummary`: when a `shutdown-request.json` is present, rename it to `shutdown-request.json.consumed` (today: delete). The request is preserved alongside the summary it contributed to.
- `consumeShutdownHandoff`: when a `shutdown-summary.json` is read, rename it to `shutdown-summary.json.consumed`. Same for the fallback `shutdown-request.json` branch. The rename is performed **before** returning the formatted directive (claim-then-format), so the failure window between consume returning and the caller queueing the directive can no longer cause the source to disappear.
- Consume only ever looks for the un-suffixed `.json`. A `${path}.consumed` is forensic-only and is never re-read.
- Each new write of `shutdown-summary.json` or `shutdown-request.json` overwrites the prior `${path}.consumed` of the same name (single most-recent-shutdown slot). This is a conscious choice — see "What it forbids".

### What it adds

- One new helper (`renameDoc` in the document store).
- Two distinct on-disk states per file: "pending consume" (`*.json`) vs "already consumed" (`*.json.consumed`).

### What it removes

- All three `deleteDoc(project.paths.shutdownRequest | shutdownSummary)` calls inside [src/runtime/shutdown-handoff.ts](src/runtime/shutdown-handoff.ts).
- The `deleteDoc` import in [src/runtime/shutdown-handoff.ts](src/runtime/shutdown-handoff.ts#L16) (replaced by `renameDoc`).
- The test assertion that codifies the broken "delete on read" behaviour.

### Risk

- `renameSync` is atomic on the same filesystem; in the new ordering it happens **before** the directive is built, so a crash after rename but before `queuePlannerDirective` leaves the source preserved as `${path}.consumed` and only the in-memory directive is lost. Operators can re-trigger by manually copying `${path}.consumed` back to `${path}` if they want to replay. This is strictly an improvement over today, where the same crash deletes the only copy.
- A future second shutdown in the same project overwrites the previous `${path}.consumed` (rename target already exists → `renameSync` replaces it on POSIX). This is the intended one-slot semantic. Operators wanting multi-shutdown history use Proposal B.
- **Limitation: cross-generation stale replay is not addressed.** If a previous process generation wrote `shutdown-summary.json` and the next bootstrap never reached `consumeShutdownHandoff` (e.g. it crashed during early init), the un-suffixed file survives and the *following* bootstrap consumes it as if fresh. This is the operator scenario captured in the user-memory note about clearing stale handoffs when repurposing the harness. Closing it requires a `run_id` / project-identity stamp on the handoffs — schema work that belongs in a separate issue, not in F24.

### What it enables / forbids

- Enables: trivial operator inspection (`cat .saivage/tmp/state/shutdown-summary.json.consumed`) without code changes; recovery from the post-consume crash window by manual rename-back.
- Forbids: keeping a multi-shutdown audit trail (one slot only). Forbids consuming the same file twice via the runtime (the rename is read-once by construction). Does **not** forbid cross-generation stale replay — see Risk above.

### Cross-links

- F08: the legacy runtime-state mirror has the opposite flavour (written, never read). Both issues stem from the same gap — `.saivage/tmp/state/` has no documented ownership/lifecycle rules. Fixing F24 with A leaves the F08 fix independent.
- F22: this proposal adds at most one extra sync `fs` call (rename) at shutdown and at startup. Not on any HTTP / agent-tick hot path; F22's concern is unaffected.
- Future "shutdown lineage / run_id" issue (not yet filed): would build on this by adding an identity stamp to the schema and a check at consume time. Independent of F24's rename mechanic.

### Recommendation note

Recommended. Smallest change that addresses the two in-scope halves of the bug (forensics loss; post-consume re-read window) with one rename helper and minimal test churn.

---

## Proposal B — Append-only shutdown history under `.saivage/tmp/state/shutdown-history/`

### Scope

Files touched:

- [src/store/project.ts](src/store/project.ts) — add `paths.shutdownHistory: join(saivageDir, "tmp", "state", "shutdown-history")` near [L83-L84](src/store/project.ts#L83-L84).
- [src/runtime/shutdown-handoff.ts](src/runtime/shutdown-handoff.ts) — `writeShutdownSummary` writes the summary as `${ISO_timestamp}-summary.json` inside `paths.shutdownHistory` (no separate "current" file). `consumeShutdownHandoff` scans the directory for unconsumed entries (entries lacking a sibling `${stem}.consumed` marker), picks the most recent unconsumed one, formats it, then writes the marker. Same scheme for `shutdown-request.json`: drop the persistent "request" slot and treat requests as ephemeral inputs to the summary, since the summary already records `requested_by` / `requested_at` / `reason`.
- [src/types.ts](src/types.ts) — no schema change to `ShutdownSummarySchema` ([L286-L306](src/types.ts#L286-L306)); the timestamp is encoded in the filename. Optionally eliminate the request fallback path.
- [src/runtime/shutdown-handoff.test.ts](src/runtime/shutdown-handoff.test.ts) — rewrite all three tests against the directory layout. Add a new test for "two shutdowns in a row leave two history entries; consume picks the most recent".
- [src/server/cli.ts](src/server/cli.ts#L207-L230) — `request-shutdown` still writes a transient `shutdown-request.json` (so SIGTERM has a hand-off), but its lifecycle is now "consumed by `writeShutdownSummary`, then archived as part of the summary entry". `consumeShutdownHandoff`'s fallback request-only branch ([src/runtime/shutdown-handoff.ts](src/runtime/shutdown-handoff.ts#L84-L94)) collapses into "write a degenerate summary entry to history immediately on startup if we found a stranded request", then format from history.

### What it adds

- A directory of immutable shutdown records, naturally ordered by ISO timestamp.
- A scan/select step in `consumeShutdownHandoff`.
- A small `markConsumed(historyEntryPath)` primitive (sibling `.consumed` marker file).
- A natural target for a future operator UI "shutdown history" tab without further schema work.

### What it removes

- The persistent `paths.shutdownSummary` single-slot file at [src/store/project.ts](src/store/project.ts#L84). Path constant is deleted; `ProjectContext.paths` shrinks by one field.
- The fallback "request-only directive" branch in its current shape — it becomes a synthesised history entry instead of a separate code path.
- The "delete on read" code at [src/runtime/shutdown-handoff.ts](src/runtime/shutdown-handoff.ts#L74), [L82](src/runtime/shutdown-handoff.ts#L82), [L88](src/runtime/shutdown-handoff.ts#L88).

### Risk

- Larger change. Tests and bootstrap touch more code.
- The directory grows unbounded unless we also add a sweep. Defer the sweep — leave size policy to the operator until there is a real complaint, since each entry is small.
- Consume now performs a `readdirSync` of the history directory. Currently negligible (one entry per process lifetime) but worth noting against F22.
- Same cross-generation stale-replay limitation as Proposal A (the un-suffixed pending file would now be a directory entry; no `run_id` stamp on it either).

### What it enables / forbids

- Enables: a real audit trail; the basis for an operator "why did Saivage last crash/stop?" view; cleanly separates the production of shutdown records from their consumption.
- Forbids: pretending there is only ever one shutdown to think about (intentional — that pretence is what created F24).

### Cross-links

- F08: the natural follow-up is "move runtime-state mirror responsibilities into the same shutdown-history concept (snapshot a runtime tick into history at shutdown time)". Not in scope for this proposal but unlocked by it.
- F22: introduces `readdirSync` at startup. Acceptable in cold-start; do not extend to per-request handlers. Plan must call this out.

### Recommendation note

Not recommended for this round. The in-scope bug is small and well-bounded; B's larger surface area is only justified once a second consumer of shutdown history exists (operator UI, telemetry export). Re-evaluate when F08 lands.

---

## Recommendation

**Proposal A.** It addresses the two in-scope halves of F24 (forensic preservation; post-consume re-read prevention via claim-then-format reordering) with one rename helper, three assertion flips in tests, and one new test. Proposal B is the right shape *eventually*, but only after a second consumer for shutdown history exists; introducing the directory machinery now would be over-engineering and would multiply the surface area touched by F22's eventual async-fs migration. Cross-generation stale replay (Reviewer r1 item 1) is explicitly out of scope for both proposals; the operator memory note remains the correct mitigation for that scenario and a separate `run_id`-stamped lineage issue should be filed if runtime auto-detection is wanted.
