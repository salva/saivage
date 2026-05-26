# G45 — Review r1

Round: 1 (reviewer: GPT-5.5).

## Findings

1. Medium — The proposed final grep gate does not catch the stale interface fields it is meant to prevent.

   [03-plan-r1.md](./03-plan-r1.md#L117-L123) only rejects `runtime.bus`, `runtime.mcp`, `runtime.spawn`, and `runtime.abort`, but the current bad interface in [docs/internals/server.md](../../../../docs/internals/server.md#L27-L36) uses bare field declarations: `bus: EventBus`, `mcp: McpRuntime`, `spawn: ChildSpawner`, and `abort(reason: string)`. That means the implementation could leave the original fictional runtime block in place and still pass the gate except for the unrelated `stop` and `stopped` checks. Tighten the gate to include the exact stale declarations, for example `bus: EventBus`, `mcp: McpRuntime`, `spawn: ChildSpawner`, `abort(reason`, `{ stop(): Promise<void> }`, and `status: "stopped"`, scoped to [docs/internals/server.md](../../../../docs/internals/server.md). This is the only blocking issue because the user explicitly asked whether the final-grep gate is appropriate.

2. Low — The startServer analysis overstates two facts even though the implementation plan mostly recovers.

   [01-analysis-r1.md](./01-analysis-r1.md#L61-L62) says a copy-pasted `.stop()` call would silently do nothing; a direct `await server.stop()` against the real return object throws a TypeError because `stop` is undefined. The real risk is an incorrect doc/API contract that can produce runtime failure or optional-chaining no-op code, not an unconditional silent no-op. [02-design-r1.md](./02-design-r1.md#L24) also says `ServerOptions` is required, but [src/server/server.ts](../../../../src/server/server.ts#L52-L55) has a defaulted parameter and TypeDoc reports the call-site parameter as optional. The redo should say options can be omitted and default to the server defaults, while still correcting the return shape to `{ close: () => Promise<void> }` from [src/server/server.ts](../../../../src/server/server.ts#L723-L727).

3. Low — Several source anchors in the round docs are stale against the current checkout.

   The main facts are right, but links such as the return-shape citation in [01-analysis-r1.md](./01-analysis-r1.md#L61), the runtime shutdown citation in [03-plan-r1.md](./03-plan-r1.md#L16), and the child-spawner citation in [03-plan-r1.md](./03-plan-r1.md#L45) no longer land on the exact live code. In this checkout the relevant anchors are [src/server/server.ts](../../../../src/server/server.ts#L723-L727), [src/server/bootstrap.ts](../../../../src/server/bootstrap.ts#L229-L245), and [src/server/bootstrap.ts](../../../../src/server/bootstrap.ts#L281-L287). The pre-work step already says to reread the source, so this is an easy cleanup before publishing the redo.

## What Looks Correct

- The analysis correctly identifies the real 13-field `SaivageRuntime` shape in [src/server/bootstrap.ts](../../../../src/server/bootstrap.ts#L47-L66): `config`, `router`, `routing`, `mcpRuntime`, `eventBus`, `planService`, `project`, `tracker`, `plannerControl`, `plannerStartupDirectives`, `agentRegistry`, `supervisor`, and `shutdown`.
- The proposed Proposal A scope is right for a medium-severity docs fix: rewrite [docs/internals/server.md](../../../../docs/internals/server.md), do not change runtime behavior, and do not add a docs-build plugin inside G45.
- The five-step `serve` teardown versus seven-step `runtime.shutdown()` split is materially correct: `serve` owns Telegram stop, planner wind-down, server close, and the call into runtime shutdown in [src/server/cli.ts](../../../../src/server/cli.ts#L365-L380); `runtime.shutdown()` owns tracker freeze, shutdown summary, supervisor stop, MCP shutdown, event-bus clear, final `idle` state, and lock release in [src/server/bootstrap.ts](../../../../src/server/bootstrap.ts#L229-L245).
- Rejecting Proposal B here is sound. The recurrence across G40/G44/G45 is real, but an auto-render system should be designed once as a batched follow-up rather than smuggled into this narrow documentation correction.
- `npm run docs:build` plus an eyeball/anchor check is the right validation layer for this docs page. The build will not prove semantic truth by itself, so it should complement, not replace, the corrected grep gate.

## Project-Wide Principle Check

- No regex for user intent: no violation. The only regexes under discussion are validation greps or a rejected source-snippet extraction idea, not user-intent parsing.
- Avoid hardcoded values: no blocking violation. The docs mention existing runtime constants/defaults such as the planner shutdown timeout and server defaults; that is acceptable when they are clearly tied to the source. Prefer naming the source constant/config path next to any literal value.
- No fragile agent-tool-call heuristics: no violation in Proposal A. If Proposal B is revived, use the TypeScript compiler API for symbol extraction rather than a brace-matching regex.

VERDICT: CHANGES_REQUESTED