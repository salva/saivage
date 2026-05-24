# F12 - Review r2

## Reviewer

GPT-5.5 (copilot)

## Documents reviewed

- [SPEC/v2/review-2026-05/_LOOP-CONVENTIONS.md](../_LOOP-CONVENTIONS.md)
- [SPEC/v2/review-2026-05/F12-mcp-cross-file-magic-coupling.md](../F12-mcp-cross-file-magic-coupling.md)
- [SPEC/v2/review-2026-05/F12/04-review-r1.md](04-review-r1.md)
- [SPEC/v2/review-2026-05/F12/01-analysis-r2.md](01-analysis-r2.md)
- [SPEC/v2/review-2026-05/F12/02-design-r2.md](02-design-r2.md)
- [SPEC/v2/review-2026-05/F12/03-plan-r2.md](03-plan-r2.md)

Spot-checked current code in [src/mcp/runtime.ts](../../../src/mcp/runtime.ts#L67), [src/mcp/runtime.ts](../../../src/mcp/runtime.ts#L169-L190), [src/mcp/builtins.ts](../../../src/mcp/builtins.ts#L36-L42), [src/mcp/builtins.ts](../../../src/mcp/builtins.ts#L382-L393), [src/mcp/builtins.ts](../../../src/mcp/builtins.ts#L397-L428), [src/config.ts](../../../src/config.ts#L70-L78), [src/config.ts](../../../src/config.ts#L182-L195), and [src/server/bootstrap.ts](../../../src/server/bootstrap.ts#L140-L141). Also checked the approved F11 dependency in [SPEC/v2/review-2026-05/F11/03-plan-r2.md](../F11/03-plan-r2.md#L93-L100).

## Findings

### Analysis

Approved. The r1 scope mismatch is fixed: F12 now explicitly narrows itself to the runtime/builtins timing invariant and removes worker-prompt prose from the required contract ([01-analysis-r2.md](01-analysis-r2.md#L5), [01-analysis-r2.md](01-analysis-r2.md#L19), [01-analysis-r2.md](01-analysis-r2.md#L72-L73)). That is consistent with the recommended Proposal A and with the current code: the runtime still owns the outer shell race in [src/mcp/runtime.ts](../../../src/mcp/runtime.ts#L169-L190), while builtins still owns both the duplicated inner max wall-clock literal and the unbounded caller-supplied path in [src/mcp/builtins.ts](../../../src/mcp/builtins.ts#L36-L42) and [src/mcp/builtins.ts](../../../src/mcp/builtins.ts#L382-L393).

The new invariants cover the actual failure modes r1 called out: every shell command path must be capped below `shellTimeoutMs - WALL_CLOCK_HEADROOM_MS`, the derived inner cap must be positive, and the timeout floor must not exceed the derived cap ([01-analysis-r2.md](01-analysis-r2.md#L50-L54)). The dependency on F11 is also stated correctly at the analysis level: F11 introduces `config.mcp.*`; F12 owns the derivation and caller clamp ([01-analysis-r2.md](01-analysis-r2.md#L73)).

### Design

The core design is sound. Proposal A now has the required schema-level envelope validation, the caller-supplied `timeout_ms` clamp, and fast structured timeout tests ([02-design-r2.md](02-design-r2.md#L17-L20), [02-design-r2.md](02-design-r2.md#L30-L37), [02-design-r2.md](02-design-r2.md#L44-L49)). The decision to keep worker-prompt literals out of F12 is internally consistent after the analysis narrowing.

One material wiring issue remains. F11's approved plan says the builtins factory signature changes to take `config.mcp`, so `MAX_OUTPUT`, `MAX_FETCH_CHARS`, and `MAX_DOWNLOAD_BYTES` become closure-captured config-derived locals ([../F11/03-plan-r2.md](../F11/03-plan-r2.md#L93-L100)). F12 design instead pins `registerBuiltinServices(runtime: McpRuntime, options: BuiltinServicesOptions = {})` as unchanged and says the other `config.mcp` values are already plumbed through `runtime` or maybe through a future `runtime.mcp` accessor ([02-design-r2.md](02-design-r2.md#L40)). That is not aligned with the approved F11 shape and reintroduces the exact ambiguity r1 asked F12 to remove. The implementation could be made correct either way, but the document must choose one concrete post-F11 signature and say where all F11 MCP config values live.

Minor cleanup while revising: the getter example in [02-design-r2.md](02-design-r2.md#L24) is recursively defined as written (`return this.shellTimeoutMs`). The plan later chooses `public readonly shellTimeoutMs`, which is fine; delete the getter option or rewrite it with a differently named private field so implementers do not copy a broken accessor.

### Plan

The plan fixes the r1 test blocker. The new builtins tests use a tiny positive inner cap (`shellTimeoutMs: 30_050`, floor `0`) and assert the structured `Command timed out after 50ms` message rather than waiting around thirty seconds ([03-plan-r2.md](03-plan-r2.md#L147-L157), [03-plan-r2.md](03-plan-r2.md#L161-L184)). The schema tests cover both invalid envelope classes plus the inclusive floor boundary ([03-plan-r2.md](03-plan-r2.md#L188-L225)), and the validation commands target real Vitest files plus typecheck/build/full-suite gates ([03-plan-r2.md](03-plan-r2.md#L246-L271)).

The remaining executable gap is the same F11/F12 builtins-registration mismatch. Step 3 says the `registerBuiltinServices(mcpRuntime, { ... })` call is unchanged ([03-plan-r2.md](03-plan-r2.md#L70-L74)), while F11's approved MCP step requires the builtins factory to receive `config.mcp` ([../F11/03-plan-r2.md](../F11/03-plan-r2.md#L93-L100)). Step 6's schema-import note also assumes `registerBuiltinServices` receives config values "via parameters / through runtime" without pinning which one ([03-plan-r2.md](03-plan-r2.md#L288)). This leaves the engineer to arbitrate between approved plans during implementation.

The `loadConfig({ ... })` snippets are not a blocker because the plan explicitly says to mirror the helper style already used in [src/config.test.ts](../../../src/config.test.ts#L30-L53), and the current `loadConfig` signature is easy to adapt via temp config files or a local test helper ([src/config.ts](../../../src/config.ts#L182-L195), [03-plan-r2.md](03-plan-r2.md#L225)).

## Required changes

1. Reconcile F12 with F11's approved builtins-registration shape. Either preserve F11's `registerBuiltinServices(..., config.mcp, ...)`/factory-parameter direction and add the F12 inner-cap read alongside it, or explicitly move all MCP config values that F11 assigned to the builtins factory onto `McpRuntime` and update the design, bootstrap step, tests, and risk note accordingly. Do not leave `registerBuiltinServices` both "unchanged" and dependent on F11-plumbed MCP values.
2. Remove or fix the recursive `shellTimeoutMs` getter example in the design so the only exposed runtime access pattern is executable TypeScript.

## Strengths

- Resolves the r1 worker-prompt scope contradiction without weakening the runtime invariant.
- Adds the missing timing-envelope validation at the config boundary.
- Replaces the slow timeout test idea with fast, exact, structured-result assertions.
- Keeps validation commands aligned with this repo's Vitest/typecheck/build conventions.

VERDICT: CHANGES_REQUESTED
