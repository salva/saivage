# F12 - Review r3

## Reviewer

GPT-5.5 (copilot)

## Documents reviewed

- [SPEC/v2/review-2026-05/_LOOP-CONVENTIONS.md](SPEC/v2/review-2026-05/_LOOP-CONVENTIONS.md)
- [SPEC/v2/review-2026-05/F12-mcp-cross-file-magic-coupling.md](SPEC/v2/review-2026-05/F12-mcp-cross-file-magic-coupling.md)
- [SPEC/v2/review-2026-05/F12/04-review-r2.md](SPEC/v2/review-2026-05/F12/04-review-r2.md)
- [SPEC/v2/review-2026-05/F12/01-analysis-r2.md](SPEC/v2/review-2026-05/F12/01-analysis-r2.md)
- [SPEC/v2/review-2026-05/F12/02-design-r3.md](SPEC/v2/review-2026-05/F12/02-design-r3.md)
- [SPEC/v2/review-2026-05/F12/03-plan-r3.md](SPEC/v2/review-2026-05/F12/03-plan-r3.md)

Spot-checked current code in [src/mcp/runtime.ts](src/mcp/runtime.ts#L67), [src/mcp/runtime.ts](src/mcp/runtime.ts#L165-L191), [src/mcp/builtins.ts](src/mcp/builtins.ts#L33-L42), [src/mcp/builtins.ts](src/mcp/builtins.ts#L375-L394), [src/mcp/builtins.ts](src/mcp/builtins.ts#L1095-L1119), [src/config.ts](src/config.ts#L68-L78), and [src/server/bootstrap.ts](src/server/bootstrap.ts#L140-L141). Also rechecked F11's approved dependency in [SPEC/v2/review-2026-05/F11/03-plan-r2.md](SPEC/v2/review-2026-05/F11/03-plan-r2.md#L93-L107).

## Findings

### Analysis

Approved. The authoritative analysis remains [SPEC/v2/review-2026-05/F12/01-analysis-r2.md](SPEC/v2/review-2026-05/F12/01-analysis-r2.md): it correctly narrows F12 to the runtime/builtins timing invariant, states the caller-supplied timeout bypass, and defines the three invariants the implementation must enforce ([SPEC/v2/review-2026-05/F12/01-analysis-r2.md](SPEC/v2/review-2026-05/F12/01-analysis-r2.md#L5-L7), [SPEC/v2/review-2026-05/F12/01-analysis-r2.md](SPEC/v2/review-2026-05/F12/01-analysis-r2.md#L52-L54)). The current code still matches the analysis premise: the outer runtime race is a private static literal, while the inner shell wall-clock cap is a separate duplicated literal and the caller-supplied timeout path still bypasses the cap.

No new analysis round was required because r2 already resolved the r1 scope contradiction and the r3 changes only affect design/plan wiring.

### Design

Approved. r3 resolves the material r2 blocker by choosing the concrete post-F11 builtins-factory shape: `registerBuiltinServices(runtime, mcpConfig, options)` and a closure-local shell handler that derives `innerCapMs` from `mcpConfig.shellTimeoutMs` ([SPEC/v2/review-2026-05/F12/02-design-r3.md](SPEC/v2/review-2026-05/F12/02-design-r3.md#L5), [SPEC/v2/review-2026-05/F12/02-design-r3.md](SPEC/v2/review-2026-05/F12/02-design-r3.md#L47-L48)). That aligns with F11's approved direction for closure-capturing MCP size and timeout config values instead of leaving the engineer to arbitrate between `runtime` and factory parameters.

The second r2 blocker is also fixed. The design explicitly drops any public `McpRuntime.shellTimeoutMs` exposure and removes the recursive getter example ([SPEC/v2/review-2026-05/F12/02-design-r3.md](SPEC/v2/review-2026-05/F12/02-design-r3.md#L6-L7), [SPEC/v2/review-2026-05/F12/02-design-r3.md](SPEC/v2/review-2026-05/F12/02-design-r3.md#L27)). The remaining public shape is simpler: `McpRuntime` keeps private instance fields for dispatch, while builtins reads the same config slice it already receives.

Proposal A now has the required schema-level envelope validation, derived clamp, deletion of duplicated literals, and focused recommendation ([SPEC/v2/review-2026-05/F12/02-design-r3.md](SPEC/v2/review-2026-05/F12/02-design-r3.md#L18-L22), [SPEC/v2/review-2026-05/F12/02-design-r3.md](SPEC/v2/review-2026-05/F12/02-design-r3.md#L71-L73), [SPEC/v2/review-2026-05/F12/02-design-r3.md](SPEC/v2/review-2026-05/F12/02-design-r3.md#L134)). Proposal B is appropriately retained as the level-up alternative without being forced into this narrower fix.

### Plan

Approved. The plan now mirrors the approved design: it declares the F11 ordering dependency, updates the constructor and bootstrap call sites, converts `shellHandler` into the `registerBuiltinServices` closure, and applies the `Math.min(timeout ?? innerCapMs, innerCapMs)` cap from `mcpConfig.shellTimeoutMs - WALL_CLOCK_HEADROOM_MS` ([SPEC/v2/review-2026-05/F12/03-plan-r3.md](SPEC/v2/review-2026-05/F12/03-plan-r3.md#L7-L16), [SPEC/v2/review-2026-05/F12/03-plan-r3.md](SPEC/v2/review-2026-05/F12/03-plan-r3.md#L98-L101)). This closes the r2 executable gap around `registerBuiltinServices` being both "unchanged" and dependent on F11-plumbed MCP values.

The schema-validation step is executable enough to hand to an engineer. It enforces both impossible envelope cases, preserves the inclusive floor boundary, and names a fallback constants-module move if importing `WALL_CLOCK_HEADROOM_MS` from `builtins.ts` would create a runtime cycle after F11 ([SPEC/v2/review-2026-05/F12/03-plan-r3.md](SPEC/v2/review-2026-05/F12/03-plan-r3.md#L123-L160), [SPEC/v2/review-2026-05/F12/03-plan-r3.md](SPEC/v2/review-2026-05/F12/03-plan-r3.md#L311-L313)). The fallback is important but not a blocker; the plan instructs the implementer to verify import direction before merging.

The test plan is also sufficient: it adds fast structured timeout assertions for both omitted and oversized caller-supplied `timeout_ms`, adds schema boundary tests, updates direct `McpRuntime`/`registerBuiltinServices` call sites, and keeps the repo's Vitest/typecheck/build validation commands ([SPEC/v2/review-2026-05/F12/03-plan-r3.md](SPEC/v2/review-2026-05/F12/03-plan-r3.md#L180-L205), [SPEC/v2/review-2026-05/F12/03-plan-r3.md](SPEC/v2/review-2026-05/F12/03-plan-r3.md#L215-L238), [SPEC/v2/review-2026-05/F12/03-plan-r3.md](SPEC/v2/review-2026-05/F12/03-plan-r3.md#L266-L285)). The remaining `loadConfig({ ... })` snippets are acceptable because the plan explicitly tells the implementer to mirror the helper style already used in the config tests.

## Required changes

## Strengths

- Cleanly resolves both r2 required changes without expanding the F12 scope back into worker prompts.
- Keeps `shellTimeoutMs` private on `McpRuntime` and shares the F11 `mcpConfig` factory argument instead of adding a second access path.
- Adds validation at the config boundary rather than defensive runtime arithmetic.
- Uses fast deterministic timeout tests that prove the structured inner handler wins before the outer race.

VERDICT: APPROVED