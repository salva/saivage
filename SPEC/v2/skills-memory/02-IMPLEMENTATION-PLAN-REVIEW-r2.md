# Phase C — Implementation Plan Review (round 2)

Status: REVIEW
Reviewer: GPT-5.5
Verdict: REVISE
Date: 2026-05-23

## Verdict

REVISE. The round-2 plan is substantially cleaner: the new WIs are mostly commit-sized, the dependency graph is acyclic, `.runtime.pid` is removed from implementation contexts, the FR matrix uses the new numbering, and `src/server/server.ts` is the right file for the new `/api/mcp/tools` route.

Two concrete implementer-blocking issues remain:

1. **WI-06 is still incomplete as the B1 fix.** It defines `ToolCallContext` with `stageId`, `channelId`, `projectRoot`, and `author`, then says `Dispatcher.executeLocalTool` constructs it from `AgentContext`. Current `AgentContext` does not carry `stageId`, `channelId`, or `author`; those values live in `WorkerInput` / `ChatInput` or can only be derived at spawn time. Without extending the context creation paths, worker stage-scope permission checks and session-scope authorization will receive `undefined` at runtime.
2. **§6 cutover never runs the idempotent init step.** The prose says deploy binary → `saivage init` populates `.saivage/{skills,memory}/` → restart, but the actual classic-LXC command block stops the service, deploys, and starts the service. Existing v2 projects call `loadProject` on service start, not `initProjectTree`, so the smoke step for empty knowledge trees can fail unless §6 explicitly runs the new idempotent init command before restart.

## Round-1 dispositions audit

§11 was read first. It lists all 8 blocking findings, all 6 non-blocking findings, all 19 spot-check FAILs as subsumed, and all 3 open-item decisions.

Confirmed applied:

- B2 project init is represented by new WI-10, with `src/store/project.ts`, `ProjectContext.paths.memory`, `.gitignore`, seeded indexes, and idempotence tests.
- B3 lifecycle archival is represented by new WI-11, with stage and chat-session hooks plus `lifecycle.test.ts`.
- B4 `/api/mcp/tools` is represented by new WI-12, and source inspection confirms no existing route in `src/server/server.ts`.
- B5 monolithic cutover was split: runtime context, init, lifecycle, and route are now prerequisites; cutover is WI-16.
- B6 `.runtime.pid` is only mentioned in rejection/non-goal contexts.
- B7 the error-code count is now 15 in WI-03/WI-18.
- B8 §6 now uses classic `sudo lxc-info` / `sudo lxc-attach` operations and excludes `saivage-v3-getrich-v2`.
- N1 rollback separates code rollback from live-state rollback.
- N2 per-scope index serialization is explicit in WI-03 and WI-19.
- N3 read-time secret redaction is covered by WI-05, WI-07, WI-08, and WI-21.
- N4 `BLOCKED_PATH` now targets body text / `body_path`, not `source_ref`.
- N5 FR-31a moved to opt-in `pnpm test:bundle` and default `vitest run` remains build-free.
- N6 built-in paths are normalized to repo-relative `skills/...` in implementation contexts.

Wrong-fix:

- B1 is visibly addressed by WI-06, but the fix is incomplete because it does not add the source of truth for `stageId` / `channelId` / `author` to `AgentContext` or the agent construction paths. Required correction: WI-06 must include `src/agents/types.ts` and the real context creation sites (`src/server/bootstrap.ts` child spawner, web chat in `src/server/server.ts`, Telegram chat in `src/server/telegram-bot.ts`, and any tests that instantiate Chat/worker agents). The acceptance test must prove a real spawned worker and a real Chat agent produce a `ToolCallContext` with the expected stage/session fields, not only a synthetic dispatcher fixture.

Not-applied: 0.

## New WIs audit

WI-06 `ToolCallContext`: shaped with goal/files/acceptance/tests/build-safe/depends/revert/diff size, and FR-mapped to FR-6 / FR-31e(i), but REVISE for the missing runtime source of `stageId`, `channelId`, and `author` described above. This is implementer-blocking because the permission engine cannot enforce the worker Y† scope rule without current-stage context.

WI-10 project init: ACCEPT. It is properly shaped, testable, FR-mapped to FR-1/21/23, idempotent, and independent in the graph. One optional tightening would be to assert indexes/audit files for all six leaves if the writer wants the acceptance text to mirror the goal exactly, but the current WI is not blocked on that.

WI-11 lifecycle hooks: ACCEPT. It is properly shaped, depends only on WI-03 and WI-10, and has testable acceptance for stage/session archival, idempotence, audit shape, and non-injection after archival. The hook files named are plausible for the current code structure.

WI-12 `/api/mcp/tools` route: ACCEPT. `src/server/server.ts` is the real file to modify; `grep` finds no existing `/api/mcp/tools` or `/api/mcp` route. The existing `onRequest` hook gates `/api/*` when `SAIVAGE_API_TOKEN` is set, so placing the route alongside `/api/config` is operationally coherent. Acceptance is testable for JSON-safe projection and 401 behavior.

Depends-on graph: acyclic. All WIs depend only on earlier WIs, except WI-12 which explicitly has no code dependency and only notes WI-07/WI-08 as logical prerequisites for the post-cutover assertion.

## Renumber spot-check

`.runtime.pid` re-check: `grep -n "\.runtime\.pid"` returns only the round-2 note, WI-03 explicit non-inclusion, §9 non-goal risk row, B6 disposition, and O2 rejection. No implementation step creates or requires it.

Five renumbered WIs spot-checked: WI-07, WI-08, WI-13, WI-16, and WI-21. Cross-references point to the new numbering: WI-07/08 depend on WI-03/04/06; WI-13 depends on WI-05/06/07/08/10; WI-16 depends on WI-09 through WI-15; WI-21 depends on WI-16. No stale old-WI references found in those bodies.

§10 FR matrix: mechanically covers FR-1 through FR-30 plus FR-31a, FR-31b, FR-31c, FR-31d, FR-31e(i), FR-31e(ii), FR-31f, and FR-31g. WI references are in the new 01–21 range. No FR is deferred.

## New regressions

Blocking: §6 is not yet operationally realistic because it omits the explicit init command required to create the new trees for already-initialized live projects. Current `bootstrap()` loads the existing project via `loadProject`; it does not call `initProjectTree`. Since WI-10 makes `saivage init` idempotent, §6.1 should add a command after deploy and before `systemctl start`, using the deployed CLI inside the container, for example:

```bash
sudo lxc-attach -n "$C" -- bash -lc "cd /opt/saivage && node dist/cli.js init '$PROJECT'"
```

Adjust the path to the deployed app directory if a given container uses a different service working directory, but keep the step explicit and before restart.

No other new regression found. The token-gated route plan, classic LXC framing, rollback split, FR-31a opt-in script, and code-vs-state rollback boundary are coherent after the above fixes.

## Sign-off

Not signed off yet. Fix WI-06 context propagation and add the explicit idempotent init step to §6.1; no broader plan rewrite is required. After those two changes, this plan should be acceptable without another full re-review.

Counts: confirmed 13, not-applied 0, wrong-fix 1, new-blocking 1.