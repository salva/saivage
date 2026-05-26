# F24 — Analysis r1

## Problem restated

`consumeShutdownHandoff` in [src/runtime/shutdown-handoff.ts](src/runtime/shutdown-handoff.ts#L79-L95) `unlink`s the shutdown summary (and the fallback shutdown request) the instant it reads them. Two concrete failures follow:

1. **Forensics loss.** When `writeShutdownSummary` ([src/runtime/shutdown-handoff.ts](src/runtime/shutdown-handoff.ts#L33-L77)) succeeds, the schema in [src/types.ts](src/types.ts#L286-L306) captures shutdown reason, requester, timestamps, runtime status, uptime, current stage, active agents, and plan snapshot — i.e. the only structured record of how the previous process ended. The next bootstrap reads it once at [src/server/bootstrap.ts](src/server/bootstrap.ts#L255-L259) and then `deleteDoc` removes the only copy. If the planner directive that consumed the text is itself later dropped (planner restart loop, queue flush, log rotation), there is no on-disk artefact left to investigate "why did Saivage last stop?".

2. **Stale replay if consume is skipped.** The user's operations memory documents the actual production symptom: when the v2 harness is repurposed/stopped without going through a clean bootstrap, stale `shutdown-summary.json` / `shutdown-request.json` files persist under `.saivage/tmp/state/` and the *next* startup queues an old `SYSTEM RESTART HANDOFF` directive as if it were fresh. Because nothing on the write side stamps the file as "owned by run X" and nothing on the consume side checks ownership, the only thing protecting consumers from stale data is the delete that happens after a successful consume — and that delete is bypassed whenever the consume path is bypassed.

The issue summary in [SPEC/v2/review-2026-05/F24-shutdown-handoff-delete-on-read.md](SPEC/v2/review-2026-05/F24-shutdown-handoff-delete-on-read.md) captures this as "delete on read combines the worst of both: log forensics impossible, but file still survives if the consumer skips the read path."

## Contract

Inputs / outputs of the affected functions (today):

- `writeShutdownRequest(project, reason, requestedBy)` — writes `{reason, requested_by, requested_at}` to `paths.shutdownRequest` (`.saivage/tmp/state/shutdown-request.json`). Called from the `request-shutdown` CLI in [src/server/cli.ts](src/server/cli.ts#L207-L230) before SIGTERM.
- `writeShutdownSummary(project)` — reads optional `shutdownRequest`, `runtimeState`, `plan`, `planHistory`; writes `paths.shutdownSummary` (`.saivage/tmp/state/shutdown-summary.json`) conforming to `ShutdownSummarySchema`; **deletes** the request file on success ([src/runtime/shutdown-handoff.ts](src/runtime/shutdown-handoff.ts#L74)). Called once from the bootstrap shutdown hook at [src/server/bootstrap.ts](src/server/bootstrap.ts#L226).
- `consumeShutdownHandoff(project)` — if summary exists: format → planner directive → **delete summary**. Else if request exists: degraded directive → **delete request**. Else null. Called from bootstrap once at [src/server/bootstrap.ts](src/server/bootstrap.ts#L255).

Error modes today:

- `readOptionalDoc` swallows schema/parse errors and logs `[shutdown] Ignoring unreadable …`; consume falls through to the request-only path or to `null`. (See test "does not throw when a stale summary file is malformed" at [src/runtime/shutdown-handoff.test.ts](src/runtime/shutdown-handoff.test.ts#L162-L173).)
- If `consumeShutdownHandoff` returns text and the caller crashes before `queuePlannerDirective` ([src/server/bootstrap.ts](src/server/bootstrap.ts#L256-L259)) finishes, the directive is lost AND the file is already gone.

## Call sites & dependencies

- Producers: bootstrap shutdown hook (`writeShutdownSummary`), CLI `request-shutdown` command (`writeShutdownRequest`).
- Consumer: bootstrap startup once per process (`consumeShutdownHandoff`).
- Paths defined centrally in [src/store/project.ts](src/store/project.ts#L83-L84).
- Storage primitives from [src/store/documents.ts](src/store/documents.ts) (`writeDoc`, `readDocOrNull`, `deleteDoc`) — all synchronous; see F22 for the broader sync-fs concern.
- Tests in [src/runtime/shutdown-handoff.test.ts](src/runtime/shutdown-handoff.test.ts#L113-L173). The first test asserts the summary file is gone after consume ([src/runtime/shutdown-handoff.test.ts](src/runtime/shutdown-handoff.test.ts#L141)) — i.e. the test currently codifies the broken behaviour.
- Operator-side concern: the user memory note about manually clearing stale `shutdown-summary.json` after stopping the v2 harness exists *because* the runtime has no concept of "this file belonged to a previous deployment / project lineage".

## Constraints any solution must respect

1. Architecture-first / no backward compatibility: do not keep a "delete + keep-archive" dual path during a transition. Replace, do not augment.
2. The fix must close *both* halves of the bug:
   - Stale files from a prior process generation must not be re-consumed as if fresh.
   - The structured shutdown record must remain on disk after consume so operators can answer "why did the last shutdown happen?" without grepping logs.
3. No new responsibilities for the planner. Consumption stays a "format text, queue directive" operation; storage shape is the runtime's problem.
4. No new sync `fs` on hot paths (HTTP routes, per-agent activity ticks). Shutdown and startup paths may use sync fs — they already do, and F22 explicitly addresses the hot-path concern separately.
5. Stay inside `.saivage/tmp/state/` (or a documented subdirectory of it). Do not introduce a new top-level project directory.
6. Do not invent a migration story for old `.consumed`-less files. On the first start after the fix lands, any pre-existing `shutdown-summary.json` is either consumed (then handled per the new rule) or, if malformed/stale, surfaces through the normal "unreadable summary" log path — that is acceptable per the project's no-backward-compat guideline.
7. Respect the out-of-scope boundary: no changes to `src/skills/` or memory-related code.
