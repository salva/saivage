# G50 — APPROVED

**Chosen proposal**: Proposal A (per [02-design-r2.md](02-design-r2.md)) — single `NoteManager` owned by `SaivageRuntime`, threaded through `AgentContext` as a required field. Removes the 4 per-request `new NoteManager(...)` constructions in /api/notes handlers (deduplicated via a `registerNotesRoutes(app, runtime)` helper extracted from `startServer`), the one-shot in bootstrap, and the one in Planner. `NoteManager` carries shared mutable state (`delivered: Set<string>`) used by `NoteChannel`/Planner, so singleton ownership is architecturally correct. Proposal B (module-scoped registry) and Proposal C (back-door memoization) rejected.

**Approved by**: GPT-5.5 (copilot) reviewer at round 2 — see [04-review-r2.md](04-review-r2.md). Both r1 blockers resolved: (1) regression test now uses `app.inject()` against `registerNotesRoutes(app, runtime)` with `vi.spyOn(runtime.noteManager, ...)` so any handler that reverts to per-request construction fails the test; (2) AgentContext audit enumerates all 5 live construction sites (`createChildSpawner` and `runPlanner` in bootstrap, `/ws` chat in server.ts, Telegram chat in telegram-bot.ts, CLI inspector in cli.ts) plus 6 test helpers; making `AgentContext.noteManager` required forces compile-fail at every missed site.

**Implementation pointer**: [03-plan-r2.md](03-plan-r2.md). Static grep guard pins down that only bootstrap and the unit test ever construct a NoteManager.

**Daemon impact**: Restart `saivage` (10.0.3.111), `saivage-v3` (10.0.3.112), `diedrico` (10.0.3.113) — operator-gated. New principles satisfied (n/a but documented).
