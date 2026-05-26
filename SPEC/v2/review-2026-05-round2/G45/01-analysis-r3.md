# G45 — Analysis r3

Round: 3 (writer: Claude Opus 4.7).
Prior rounds: [01-analysis-r1.md](./01-analysis-r1.md), [01-analysis-r2.md](./01-analysis-r2.md), [04-review-r1.md](./04-review-r1.md), [04-review-r2.md](./04-review-r2.md).

## Round-3 deltas vs r2

- No new ground-truth claims. The r2 analysis was accepted by review r2: the silent-no-op vs TypeError distinction, the optional `options?: ServerOptions` rendering, and the source anchors at [src/server/bootstrap.ts](../../../../src/server/bootstrap.ts#L47-L66), [src/server/bootstrap.ts](../../../../src/server/bootstrap.ts#L229-L245), [src/server/bootstrap.ts](../../../../src/server/bootstrap.ts#L281-L287), [src/server/server.ts](../../../../src/server/server.ts#L47-L55), [src/server/server.ts](../../../../src/server/server.ts#L722-L727), and [src/server/cli.ts](../../../../src/server/cli.ts#L351-L386) were all re-verified by the reviewer against the live checkout.
- The r2 single blocker is a consistency bug in the plan, not in the ground truth: the validation gate's `-F` literal list contained a broad bare `"stopped"` token while the rewritten doc was directed to keep a one-line disclaimer of the form `There is no "stopped" runtime status`. That makes the gate's pass/fail rule depend on PR-description prose rather than on a deterministic zero-match check. The r3 design and plan resolve the contradiction without changing any of the verified facts in r2.
- Ground truth about the persisted status is unchanged and re-confirmed: [src/server/bootstrap.ts](../../../../src/server/bootstrap.ts#L242) writes `status: "idle"`, and the `RuntimeStateSchema` in [src/types.ts](../../../../src/types.ts) does not currently include a `"stopped"` literal. The doc must say `"idle"` and may optionally tell readers that `"stopped"` is fictional; the gate must be precise enough to distinguish the two uses.

## Carry-over from r2

The factual sections (1 through 6) of [01-analysis-r2.md](./01-analysis-r2.md) carry over verbatim; nothing changed in the source between r2 and r3. The substantive issue list for the doc rewrite remains:

1. `interface SaivageRuntime { … }` at [docs/internals/server.md](../../../../docs/internals/server.md#L26-L36) names three fields wrong (`bus`, `mcp`, `spawn`), invents one method (`abort`), and omits seven real fields. Authoritative declaration: [src/server/bootstrap.ts](../../../../src/server/bootstrap.ts#L47-L66).
2. `startServer` signature at [docs/internals/server.md](../../../../docs/internals/server.md#L42-L50) claims a `{ stop(): Promise<void> }` return. The real return shape is `{ close: () => Promise<void> }` at [src/server/server.ts](../../../../src/server/server.ts#L722-L727), and the `options` parameter is defaulted in source so the doc must render it optional ([src/server/server.ts](../../../../src/server/server.ts#L47-L55)).
3. "Graceful shutdown" attributes the entire five-step teardown to `runtime.shutdown()`. The real ownership split: the CLI `serve` closure ([src/server/cli.ts](../../../../src/server/cli.ts#L351-L386)) drives Telegram stop, planner restart-request, server `close()`, and finally `runtime.shutdown()`; `runtime.shutdown()` itself ([src/server/bootstrap.ts](../../../../src/server/bootstrap.ts#L229-L245)) does seven things and writes `status: "idle"`.

## Why this is an r3 and not a one-line plan patch

The reviewer's framing makes it clear that any of three plan-shape edits would close the blocker (scope the gate, drop the doc token, or split the gate). Picking the right one is a design call, not a mechanical fix — see [02-design-r3.md](./02-design-r3.md). The plan delta is correspondingly small ([03-plan-r3.md](./03-plan-r3.md) only modifies Step 6 and Step 7).
