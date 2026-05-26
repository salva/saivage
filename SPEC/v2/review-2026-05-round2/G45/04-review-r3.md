# G45 - Review r3

Round: 3 (reviewer: GitHub Copilot).

## Findings

None.

## Gate check

- The r2 blocker is resolved. [SPEC/v2/review-2026-05-round2/G45/02-design-r3.md](02-design-r3.md#L13-L14) removes the broad bare `"stopped"` gate token and removes the disclaimer prose that made the r2 pass/fail rule depend on manual review.
- The r3 gate in [SPEC/v2/review-2026-05-round2/G45/03-plan-r3.md](03-plan-r3.md#L56-L69) still checks the stale runtime field names, the fictional `stop()` return shape, and the precise stale persisted-status form `status: "stopped"`. It no longer includes `-e '"stopped"'`, so the plan and design no longer contradict each other.
- The pass rule is now strict zero-match again: [SPEC/v2/review-2026-05-round2/G45/03-plan-r3.md](03-plan-r3.md#L73) says there is no documented exception, no allow-list, and no PR-description hand-verification. The design acceptance criterion says the same in [SPEC/v2/review-2026-05-round2/G45/02-design-r3.md](02-design-r3.md#L87).
- I ran the r3 gate against the current stale [docs/internals/server.md](../../../../docs/internals/server.md). It catches the expected old lines: `bus: EventBus`, `mcp: McpRuntime`, `spawn: ChildSpawner`, `abort(reason`, `{ stop(): Promise<void> }`, and `status: "stopped"`. That confirms the gate still covers the original drift; the live page is expected to fail until the planned docs rewrite lands.

## Regression check

- Ground truth still matches the r2 review: [src/server/bootstrap.ts](../../../../src/server/bootstrap.ts#L47-L66) defines the 13-field `SaivageRuntime`, [src/server/server.ts](../../../../src/server/server.ts#L52-L55) exposes optional `options` and returns `{ close: () => Promise<void> }`, [src/server/server.ts](../../../../src/server/server.ts#L723-L727) returns only `close`, and [src/server/bootstrap.ts](../../../../src/server/bootstrap.ts#L229-L245) writes final runtime status `"idle"`.
- The shutdown ownership split is still correct: `serve` owns Telegram stop, planner wind-down, `server.close()`, and the final call to `runtime.shutdown()` in [src/server/cli.ts](../../../../src/server/cli.ts#L353-L380); `start` and `inspect` call `runtime.shutdown()` directly in the non-server paths.
- The round-2 accepted corrections did not regress: the TypeError vs optional-chained no-op distinction is retained, `options?: ServerOptions` is retained, the `close` return shape is retained, and the precise fixed-string gate still catches the stale declarations the r1 gate missed.
- Source-path note: the provided live input path ending in src/bootstrap.ts does not exist in this checkout. The round-3 docs consistently use the actual source path [src/server/bootstrap.ts](../../../../src/server/bootstrap.ts), which is the file I verified.

## Project-wide principle check

- Architecture-first, no backward compatibility: no violation. Removing the vestigial `"stopped"` disclaimer is consistent with deleting stale back-references rather than preserving a compatibility story for an on-disk status that does not exist.
- No regex for user intent: no violation. Proposal A remains a documentation rewrite plus a fixed-string validation gate. The rejected extractor options are not part of the selected plan.
- Avoid hardcoded values: no blocking violation. The docs plan mentions server defaults and `PLANNER_SHUTDOWN_TIMEOUT_MS` only where they are tied back to live source anchors.
- No fragile agent-tool-call heuristics: no violation. This remains a docs-only finding and does not add tool-call inference logic.

## Residual notes

- I did not run `npm run docs:build` because round 3 is still a critique of the analysis/design/plan set, not an implementation diff. The plan keeps that command as required validation after [docs/internals/server.md](../../../../docs/internals/server.md) is rewritten.
- Adjacent stale abort prose in [docs/internals/supervisor.md](../../../../docs/internals/supervisor.md) and [docs/internals/abort-recovery.md](../../../../docs/internals/abort-recovery.md) remains out of G45 scope, as in r2.

VERDICT: APPROVED