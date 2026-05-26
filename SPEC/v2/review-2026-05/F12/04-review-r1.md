# F12 - Review r1

## Reviewer

GPT-5.5 (copilot)

## Documents reviewed

- [SPEC/v2/review-2026-05/_LOOP-CONVENTIONS.md](SPEC/v2/review-2026-05/_LOOP-CONVENTIONS.md)
- [SPEC/v2/review-2026-05/F12-mcp-cross-file-magic-coupling.md](SPEC/v2/review-2026-05/F12-mcp-cross-file-magic-coupling.md)
- [SPEC/v2/review-2026-05/F12/01-analysis-r1.md](SPEC/v2/review-2026-05/F12/01-analysis-r1.md)
- [SPEC/v2/review-2026-05/F12/02-design-r1.md](SPEC/v2/review-2026-05/F12/02-design-r1.md)
- [SPEC/v2/review-2026-05/F12/03-plan-r1.md](SPEC/v2/review-2026-05/F12/03-plan-r1.md)

Spot-checked current code in [src/mcp/runtime.ts](src/mcp/runtime.ts#L168-L189), [src/mcp/builtins.ts](src/mcp/builtins.ts#L39-L42), [src/mcp/builtins.ts](src/mcp/builtins.ts#L382-L392), [src/mcp/client.ts](src/mcp/client.ts), and [src/config.ts](src/config.ts#L68-L78).

## Findings

### Analysis

The analysis is factually stronger than the original issue file: current code really does duplicate the four-hour literal in both [src/mcp/runtime.ts](src/mcp/runtime.ts#L168-L172) and [src/mcp/builtins.ts](src/mcp/builtins.ts#L39-L42), rather than deriving one value from the other. The contract section also correctly identifies the unbounded caller-supplied `timeout_ms` path through [src/mcp/builtins.ts](src/mcp/builtins.ts#L382-L392).

The problem statement and constraints, however, make the worker-prompt literals part of the invariant: `worker-suggested timeout <= MAX_WALL_CLOCK_MS < McpRuntime.SHELL_TIMEOUT_MS` is the opening restatement, and the constraints say suggested values must come from the same source the runtime enforces ([SPEC/v2/review-2026-05/F12/01-analysis-r1.md](SPEC/v2/review-2026-05/F12/01-analysis-r1.md#L5-L10), [SPEC/v2/review-2026-05/F12/01-analysis-r1.md](SPEC/v2/review-2026-05/F12/01-analysis-r1.md#L56-L60)). The recommended design later leaves those literals in place. Either the analysis should narrow F12 to the runtime/builtins invariant, or the recommended design must satisfy the broader prompt-value constraint.

### Design

Proposal A addresses the core runtime/builtins bug by deriving the inner cap from `runtime.shellTimeoutMs` and clamping oversized caller input ([SPEC/v2/review-2026-05/F12/02-design-r1.md](SPEC/v2/review-2026-05/F12/02-design-r1.md#L13-L18)). That is the right direction.

But the proposal introduces a configurable `shellTimeoutMs` while leaving `WALL_CLOCK_HEADROOM_MS` fixed and does not say where the new invariant is validated. F11's planned schema addition is only `shellTimeoutMs: z.number().default(4 * 60 * 60 * 1000)` ([SPEC/v2/review-2026-05/F11/03-plan-r2.md](SPEC/v2/review-2026-05/F11/03-plan-r2.md#L38-L45)), and current `config.ts` has no MCP block at all ([src/config.ts](src/config.ts#L68-L78)). If an operator sets `shellTimeoutMs <= 30_000`, Proposal A computes a zero or negative inner cap; if `shellTimeoutFloorMs` is above the inner cap, the floor and cap contradict each other. The design needs an explicit config-boundary validation rule or a single policy computation that rejects impossible timing envelopes.

### Plan

The plan has an executable test gap. It notices that `shellTimeoutMs: 5_000` makes `shellTimeoutMs - 30_000` negative, then works around that by using `shellTimeoutMs: 60_000` and accepting a roughly 30-second timeout test ([SPEC/v2/review-2026-05/F12/03-plan-r1.md](SPEC/v2/review-2026-05/F12/03-plan-r1.md#L31-L42)). That both masks the invalid-config case and creates slow tests. Use a fast positive inner cap instead, for example `shellTimeoutMs = 30_050` with `shellTimeoutFloorMs = 0`, and assert the structured shell timeout message names the derived cap. That proves the inner handler wins over the outer race without making Vitest wait tens of seconds.

The implementation ordering is also still too dependent on an unapproved draft shape from F11. F12 says it must land after F11 ([SPEC/v2/review-2026-05/F12/03-plan-r1.md](SPEC/v2/review-2026-05/F12/03-plan-r1.md#L7-L8)), while F11 currently says `McpRuntime` may accept either a full `SaivageConfig` or a `config.mcp` slice ([SPEC/v2/review-2026-05/F11/03-plan-r2.md](SPEC/v2/review-2026-05/F11/03-plan-r2.md#L95-L100)). The F12 plan should pin its steps to the final approved F11 interface, or make the F12 edit self-contained enough that an engineer does not have to infer the constructor/factory shape from two draft plans. The current code path is `new McpRuntime(config.runtime)` plus `registerBuiltinServices(mcpRuntime)` in [src/server/bootstrap.ts](src/server/bootstrap.ts#L140-L141), so this ambiguity matters.

## Required changes

1. Decide whether F12's approved scope includes worker prompt literals. If yes, recommend Proposal B or revise Proposal A to source prompt recommendations from the same policy/config values. If no, revise the analysis constraints so Proposal A is not violating its own stated requirement.
2. Add an explicit timing-envelope validation rule to the design and plan. At minimum, invalid config must not allow `shellTimeoutMs - WALL_CLOCK_HEADROOM_MS <= 0`, and the floor/cap relationship must be defined.
3. Rewrite the new timeout tests to be fast and exact: use a tiny positive derived cap, disable/set the floor through config, and assert the structured `Command timed out after <derived cap>ms` result rather than only `duration_ms <= 30_000`.
4. Align the F12 implementation steps with the final F11 interface, or make the fallback path fully self-contained by specifying the exact `McpRuntime` constructor and `registerBuiltinServices` signatures to use.

## Strengths

- Correctly identifies that the current code duplicates the four-hour literal instead of deriving it.
- Keeps the focused runtime fix small and avoids the larger prompt-policy abstraction unless the broader scope requires it.
- Includes the right validation commands for this repo: `npm run typecheck`, `npm run build`, and Vitest-focused MCP tests.

VERDICT: CHANGES_REQUESTED