# F24 — Design r1

Two proposals. Both replace the current "delete on read" pattern in [src/runtime/shutdown-handoff.ts](src/runtime/shutdown-handoff.ts#L79-L95) and the request-deletion at [src/runtime/shutdown-handoff.ts](src/runtime/shutdown-handoff.ts#L74) with a non-destructive disposition. Per the project's no-backward-compat guideline, the chosen approach replaces the old behaviour outright; there is no flag or grace period.

## Proposal A — Rename consumed files to `.consumed.json` (focused fix)

### Scope

Files touched:

- [src/runtime/shutdown-handoff.ts](src/runtime/shutdown-handoff.ts) — replace `deleteDoc` calls at [L74](src/runtime/shutdown-handoff.ts#L74), [L82](src/runtime/shutdown-handoff.ts#L82), [L88](src/runtime/shutdown-handoff.ts#L88) with a `markConsumed` helper that `renameSync`s the file from `*.json` to `*.consumed.json` in the same directory.
- [src/store/documents.ts](src/store/documents.ts) — add a small `renameDoc(src, dst)` primitive next to `deleteDoc`, or expose `renameSync` directly. Sync rename matches the existing sync style; the only callers are at shutdown and bootstrap, never on a hot path.
- [src/runtime/shutdown-handoff.test.ts](src/runtime/shutdown-handoff.test.ts) — flip the assertion at [L141](src/runtime/shutdown-handoff.test.ts#L141) to expect the `*.consumed.json` file to exist and the original `*.json` to be gone; same for the request-only fallback test ([L155-L160](src/runtime/shutdown-handoff.test.ts#L155-L160)).

Behavioural change:

- `writeShutdownSummary`: when a `shutdown-request.json` is present, rename it to `shutdown-request.consumed.json` (today: delete). Captures the request even after a successful summary.
- `consumeShutdownHandoff`: when a `shutdown-summary.json` is read, rename it to `shutdown-summary.consumed.json`. Same for the fallback `shutdown-request.json` branch.
- Consume only ever looks for the un-suffixed `.json`. A `.consumed.json` is forensic-only and is never re-read.
- Each new write of `shutdown-summary.json` or `shutdown-request.json` overwrites the prior `.consumed.json` of the same name (single most-recent-shutdown slot). This is a conscious choice — see "What it forbids".

### What it adds

- One new helper (`renameDoc` or inline `renameSync`).
- Two distinct on-disk states per file: "pending consume" (`*.json`) vs "already consumed" (`*.consumed.json`).

### What it removes

- All three `deleteDoc(project.paths.shutdownRequest | shutdownSummary)` calls inside [src/runtime/shutdown-handoff.ts](src/runtime/shutdown-handoff.ts).
- The test assertion that codifies the broken "delete on read" behaviour.

### Risk

- `renameSync` is atomic on the same filesystem; the rename happens after the new directive text is built but before the function returns. If the caller crashes between `consume` returning and `queuePlannerDirective` writing, the directive is lost — but this is strictly an improvement over today, where the file is also already deleted. After this change, the renamed forensic file at least documents the loss.
- A future second shutdown in the same project overwrites the previous `*.consumed.json` (rename target already exists → `renameSync` replaces it on POSIX). This is the intended one-slot semantic. Operators wanting multi-shutdown history use Proposal B.

### What it enables / forbids

- Enables: trivial operator inspection (`cat .saivage/tmp/state/shutdown-summary.consumed.json`) without code changes.
- Forbids: keeping a multi-shutdown audit trail (one slot only). Forbids consuming the same file twice (rename-then-look is idempotent).

### Cross-links

- F08: the legacy runtime-state mirror has the opposite flavour (written, never read). Both issues stem from the same gap — `.saivage/tmp/state/` has no documented ownership/lifecycle rules. Fixing F24 with A leaves the F08 fix independent.
- F22: this proposal adds at most one extra sync `fs` call (rename) at shutdown and at startup. Not on any HTTP / agent-tick hot path; F22's concern is unaffected.

### Recommendation note

Recommended. Smallest change that closes both halves of the bug while preserving the existing producer/consumer surface area.

---

## Proposal B — Append-only shutdown history under `.saivage/tmp/state/shutdown-history/`

### Scope

Files touched:

- [src/store/project.ts](src/store/project.ts) — add `paths.shutdownHistory: join(saivageDir, "tmp", "state", "shutdown-history")` near [L83-L84](src/store/project.ts#L83-L84).
- [src/runtime/shutdown-handoff.ts](src/runtime/shutdown-handoff.ts) — `writeShutdownSummary` writes the summary as `${ISO_timestamp}-summary.json` inside `paths.shutdownHistory` (no separate "current" file). `consumeShutdownHandoff` scans the directory for unconsumed entries (entries lacking a sibling `${stem}.consumed` marker, or — equivalently — scanning `directory listing` minus consumed set), picks the most recent unconsumed one, formats it, then writes the marker. Same scheme for `shutdown-request.json`: drop the persistent "request" slot entirely and treat requests as ephemeral inputs to the summary, since the summary already records `requested_by`/`requested_at`/`reason`.
- [src/types.ts](src/types.ts) — no schema change to `ShutdownSummarySchema` ([L286-L306](src/types.ts#L286-L306)); the timestamp is encoded in the filename. Optionally rename the request fallback path or eliminate it (see "What it removes").
- [src/runtime/shutdown-handoff.test.ts](src/runtime/shutdown-handoff.test.ts) — rewrite all three tests against the directory layout. Add a new test for "two shutdowns in a row leave two history entries; consume picks the most recent".
- [src/server/cli.ts](src/server/cli.ts#L207-L230) — `request-shutdown` still writes a transient `shutdown-request.json` (so SIGTERM has a hand-off), but its lifecycle is now "consumed by `writeShutdownSummary`, then archived as part of the summary entry". `consumeShutdownHandoff`'s fallback request-only branch ([src/runtime/shutdown-handoff.ts](src/runtime/shutdown-handoff.ts#L84-L94)) collapses into "write a degenerate summary entry to history immediately on startup if we found a stranded request", then format from history.

### What it adds

- A directory of immutable shutdown records, naturally ordered by ISO timestamp.
- A scan/select step in `consumeShutdownHandoff`.
- A small `markConsumed(historyEntryPath)` primitive (could be a sibling `.consumed` marker file, or a `consumed_at` field appended to the JSON via re-write — choose the marker file so the original record stays immutable).
- A natural target for a future operator UI "shutdown history" tab without further schema work.

### What it removes

- The persistent `paths.shutdownSummary` single-slot file at [src/store/project.ts](src/store/project.ts#L84). Path constant is deleted; `ProjectContext.paths` shrinks by one field.
- The fallback "request-only directive" branch in its current shape — it becomes a synthesised history entry instead of a separate code path.
- The "delete on read" code at [src/runtime/shutdown-handoff.ts](src/runtime/shutdown-handoff.ts#L74), [L82](src/runtime/shutdown-handoff.ts#L82), [L88](src/runtime/shutdown-handoff.ts#L88).

### Risk

- Larger change. Tests and bootstrap touch more code.
- The directory grows unbounded unless we also add a sweep (e.g. keep last N entries). Adding a sweep adds the same scan-and-delete pattern we're trying to fix, just bounded. Defer the sweep — leave size policy to the operator until there is a real complaint, since each entry is small.
- Consume now performs a `readdirSync` of the history directory. Currently negligible (one entry per process lifetime) but worth noting against F22.

### What it enables / forbids

- Enables: a real audit trail; the basis for an operator "why did Saivage last crash/stop?" view; cleanly separates the production of shutdown records from their consumption.
- Forbids: pretending there is only ever one shutdown to think about (intentional — that pretence is what created F24).

### Cross-links

- F08: the natural follow-up is "move runtime-state mirror responsibilities into the same shutdown-history concept (snapshot a runtime tick into history at shutdown time)". Not in scope for this proposal but unlocked by it.
- F22: introduces `readdirSync` at startup. Acceptable in cold-start; do not extend to per-request handlers. Plan must call this out.

### Recommendation note

Not recommended for this round. The bug is small and well-bounded; B's larger surface area is only justified once a second consumer of shutdown history exists (operator UI, telemetry export). Re-evaluate when F08 lands.

---

## Recommendation

**Proposal A.** It closes both halves of the bug (no stale replay; forensic record preserved) with one rename helper, two assertion flips in tests, and no new paths or schemas. Proposal B is the right shape *eventually*, but only after a second consumer for shutdown history exists; introducing the directory machinery now would be over-engineering and would multiply the surface area touched by F22's eventual async-fs migration.
