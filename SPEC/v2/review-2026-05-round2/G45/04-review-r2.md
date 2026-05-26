# G45 - Review r2

Round: 2 (reviewer: GPT-5.5).

## Findings

1. Medium - The final grep gate is no longer an executable zero-match gate.

   [03-plan-r2.md](03-plan-r2.md#L131-L155) adds the missing fixed-string checks for the stale bare declarations, but it also includes `-e '"stopped"'` while the implementation steps explicitly tell the doc to say `"idle", not "stopped"` at [03-plan-r2.md](03-plan-r2.md#L116) and then allow a documented `"stopped"` exception at [03-plan-r2.md](03-plan-r2.md#L155). That contradicts the design acceptance criterion that the grep gate returns zero matches at [02-design-r2.md](02-design-r2.md#L123). A reviewer cannot tell whether the PR should fail the gate, pass with a manually inspected exception, or avoid the quoted prose. Make this one rule: either remove the broad bare `"stopped"` check and keep exact stale forms such as `status: "stopped"`, or keep the broad check and require the final prose to avoid that quoted literal. Then update the design acceptance criterion and validation step so they agree.

## Resolved r1 blockers

- The r1 gate blocker is substantively addressed. [03-plan-r2.md](03-plan-r2.md#L131-L153) covers both dotted references and the stale bare declarations `bus: EventBus`, `mcp: McpRuntime`, `spawn: ChildSpawner`, and `abort(reason`, plus the fictional `stop` return and persisted `stopped` status. Running that gate against the current stale [docs/internals/server.md](../../../../docs/internals/server.md) caught the expected old lines.
- The silent-no-op vs TypeError distinction is now correct. [01-analysis-r2.md](01-analysis-r2.md#L81-L82) distinguishes direct `server.stop()` throwing a TypeError from optional-chained `server.stop?.()` silently leaking the Fastify socket, and [03-plan-r2.md](03-plan-r2.md#L80) carries that wording into the doc rewrite.
- `ServerOptions` is now rendered as optional with the default annotated. [02-design-r2.md](02-design-r2.md#L36) and [03-plan-r2.md](03-plan-r2.md#L76) show `options?: ServerOptions` with the source default, matching [src/server/server.ts](../../../../src/server/server.ts#L52-L55).
- The refreshed source anchors I checked match the live checkout: `SaivageRuntime` at [src/server/bootstrap.ts](../../../../src/server/bootstrap.ts#L47-L66), `runtime.shutdown` at [src/server/bootstrap.ts](../../../../src/server/bootstrap.ts#L229-L245), `createChildSpawner` at [src/server/bootstrap.ts](../../../../src/server/bootstrap.ts#L281-L287), `ServerOptions` and the `startServer` signature at [src/server/server.ts](../../../../src/server/server.ts#L47-L55), the return object at [src/server/server.ts](../../../../src/server/server.ts#L722-L727), and the `serve` shutdown closure at [src/server/cli.ts](../../../../src/server/cli.ts#L351-L386).

## Project-wide principle check

- No regex for user intent: no violation. The only search pattern under Proposal A is a fixed-string validation gate, and the rejected Proposal B explicitly uses the TypeScript compiler API rather than brace-matching regex.
- Avoid hardcoded values: no blocking violation. The docs mention source defaults and constants such as the server default and `PLANNER_SHUTDOWN_TIMEOUT_MS`; that is acceptable when they are clearly tied to source anchors.
- No fragile agent-tool-call heuristics: no violation. Proposal A is a docs rewrite only, and no tool-call inference logic is added.

## Residual notes

- I did not block on adjacent stale abort prose in [docs/internals/supervisor.md](../../../../docs/internals/supervisor.md) and [docs/internals/abort-recovery.md](../../../../docs/internals/abort-recovery.md), because G45's round-2 scope is the server internals page. It is worth tracking separately if the round wants all public `runtime.abort` mentions cleaned up.

VERDICT: CHANGES_REQUESTED