# F24 — Analysis r2

## Changes from r1

- Narrowed the issue to **delete-on-read forensics loss and post-consume re-read prevention**. Removed the "stale files from a prior process generation must not be re-consumed" half. Reviewer r1 (item 1) correctly noted that the recommended fix (Proposal A) cannot prevent cross-generation stale replay — that scenario is the operator's "project repurposed without clean shutdown" case, which is an ownership/lineage problem (no `run_id` / project-identity stamp on the handoff files), not a delete-vs-rename problem. Solving it would require schema and bootstrap-startup changes that are out of scope for F24. The user-memory operator note about manually clearing stale `.saivage/tmp/state/*.json` files when repurposing the harness therefore remains the correct mitigation and is **not** rendered obsolete by this fix.
- Removed constraint #2 ("must close *both* halves") from the constraints list and replaced it with a single, narrower correctness constraint.
- Restated Failure (2) so it now describes only the **post-consume re-read** half (planner directive lost between `consume` and `queuePlannerDirective`, file already gone) — which Proposal A does fix.
- Tightened the "Constraints" section so the remaining items are the ones any in-scope solution must respect.

## Problem restated

`consumeShutdownHandoff` in [src/runtime/shutdown-handoff.ts](src/runtime/shutdown-handoff.ts#L79-L95) `unlink`s the shutdown summary (and the fallback shutdown request) the instant it reads them, and `writeShutdownSummary` `unlink`s the request right after writing the summary ([src/runtime/shutdown-handoff.ts](src/runtime/shutdown-handoff.ts#L74)). Two concrete in-scope failures follow:

1. **Forensics loss.** When `writeShutdownSummary` ([src/runtime/shutdown-handoff.ts](src/runtime/shutdown-handoff.ts#L33-L77)) succeeds, the schema in [src/types.ts](src/types.ts#L286-L306) captures shutdown reason, requester, timestamps, runtime status, uptime, current stage, active agents, and plan snapshot — i.e. the only structured record of how the previous process ended. The next bootstrap reads it once at [src/server/bootstrap.ts](src/server/bootstrap.ts#L255-L259) and then `deleteDoc` removes the only copy. If the planner directive that consumed the text is itself later dropped (planner restart loop, queue flush, log rotation), there is no on-disk artefact left to answer "why did Saivage last stop?".

2. **Post-consume re-read on failure window.** Today, `consumeShutdownHandoff` returns the formatted text only *after* it has already deleted the source file ([src/runtime/shutdown-handoff.ts](src/runtime/shutdown-handoff.ts#L82), [L88](src/runtime/shutdown-handoff.ts#L88)). If the caller crashes between the function returning and `queuePlannerDirective` writing ([src/server/bootstrap.ts](src/server/bootstrap.ts#L256-L259)), the directive is lost and so is the source. The rename-instead-of-delete approach replaces "data lost on crash" with "data preserved as `*.json.consumed` for the operator to recover from".

The issue summary in [SPEC/v2/review-2026-05/F24-shutdown-handoff-delete-on-read.md](SPEC/v2/review-2026-05/F24-shutdown-handoff-delete-on-read.md) captures the delete-on-read shape; cross-generation staleness ("the file still exists if the consumer was skipped because bootstrap took a different path") is acknowledged there but is being deferred — it requires a project-lineage / run-id design and is not what F24 solves.

## Contract

Inputs / outputs of the affected functions (today):

- `writeShutdownRequest(project, reason, requestedBy)` — writes `{reason, requested_by, requested_at}` to `paths.shutdownRequest` (`.saivage/tmp/state/shutdown-request.json`). Called from the `request-shutdown` CLI in [src/server/cli.ts](src/server/cli.ts#L207-L230) before SIGTERM.
- `writeShutdownSummary(project)` — reads optional `shutdownRequest`, `runtimeState`, `plan`, `planHistory`; writes `paths.shutdownSummary` (`.saivage/tmp/state/shutdown-summary.json`) conforming to `ShutdownSummarySchema`; **deletes** the request file on success ([src/runtime/shutdown-handoff.ts](src/runtime/shutdown-handoff.ts#L74)). Called once from the bootstrap shutdown hook at [src/server/bootstrap.ts](src/server/bootstrap.ts#L226).
- `consumeShutdownHandoff(project)` — if summary exists: **delete summary** → format → planner directive. Else if request exists: **delete request** → degraded directive. Else null. Called from bootstrap once at [src/server/bootstrap.ts](src/server/bootstrap.ts#L255).

Error modes today:

- `readOptionalDoc` swallows schema/parse errors and logs `[shutdown] Ignoring unreadable …`; consume falls through to the request-only path or to `null`. (See test "does not throw when a stale summary file is malformed" at [src/runtime/shutdown-handoff.test.ts](src/runtime/shutdown-handoff.test.ts#L162-L173).)
- Source file is deleted **before** the caller can confirm successful queueing of the directive — the post-consume re-read failure window in (2) above.

## Call sites & dependencies

- Producers: bootstrap shutdown hook (`writeShutdownSummary`), CLI `request-shutdown` command (`writeShutdownRequest`).
- Consumer: bootstrap startup once per process (`consumeShutdownHandoff`).
- Paths defined centrally in [src/store/project.ts](src/store/project.ts#L83-L84).
- Storage primitives from [src/store/documents.ts](src/store/documents.ts) (`writeDoc`, `readDocOrNull`, `deleteDoc`) — all synchronous; see F22 for the broader sync-fs concern.
- Tests in [src/runtime/shutdown-handoff.test.ts](src/runtime/shutdown-handoff.test.ts#L113-L173). The first test asserts the summary file is gone after consume ([src/runtime/shutdown-handoff.test.ts](src/runtime/shutdown-handoff.test.ts#L141)) — i.e. the test currently codifies the broken behaviour.

## Out of scope (and what addresses it instead)

- **Cross-generation / project-repurposed stale replay.** If bootstrap exits before reaching `consumeShutdownHandoff` (early init failure, container hot-swap, manual file move) the un-suffixed handoff files survive and the next clean bootstrap will treat them as fresh. Fixing this requires stamping handoffs with `run_id` (or the project's `saivage.json` identity) and rejecting on mismatch — a schema and bootstrap-startup change in its own right. Out of scope here. The user's operations memory note ("clear stale `shutdown-summary.json` / `shutdown-request.json` after stopping when repurposing the harness") remains the operator-side mitigation and survives this fix.
- **F22 sync-fs concern.** F24 adds at most one extra sync `fs` call (rename) at cold paths only (shutdown hook + bootstrap startup). F22 covers the broader migration.

## Constraints any solution must respect

1. Architecture-first / no backward compatibility: do not keep a "delete + keep-archive" dual path during a transition. Replace, do not augment.
2. The structured shutdown record must remain on disk after consume so operators can answer "why did the last shutdown happen?" without grepping logs.
3. A second consume call on the same project (re-shutdown sequence) must not require either special-case code or unbounded disk growth; one-most-recent-shutdown slot is acceptable.
4. No new responsibilities for the planner. Consumption stays a "format text, queue directive" operation; storage shape is the runtime's problem.
5. No new sync `fs` on hot paths (HTTP routes, per-agent activity ticks). Shutdown and startup paths may use sync fs — they already do.
6. Stay inside `.saivage/tmp/state/` (or a documented subdirectory of it). Do not introduce a new top-level project directory.
7. Do not invent a migration story for old un-suffixed files. On the first start after the fix lands, any pre-existing `shutdown-summary.json` is either consumed (then renamed per the new rule) or, if malformed/stale, surfaces through the normal "unreadable summary" log path — that is acceptable per the project's no-backward-compat guideline.
8. Respect the out-of-scope boundary: no changes to `src/skills/` or memory-related code.
