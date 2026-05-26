# F12 — Analysis r2

## Changes from r1

- **Narrowed scope.** F12 is now scoped strictly to the runtime/builtins timing invariant: the unbounded caller-supplied `timeout_ms` path and the duplicated four-hour literal between [src/mcp/runtime.ts](src/mcp/runtime.ts#L168-L172) and [src/mcp/builtins.ts](src/mcp/builtins.ts#L39-L42). The "worker-prompt recommended millisecond values must come from the same source the runtime enforces" requirement is **removed** from the constraints list. Worker-prompt prose drift is a real but distinct hazard and is not addressed by F12; if the team later wants the prompt-policy abstraction, that is the level-up captured as Proposal B (kept for future reference, not recommended).
- **Added an explicit timing-envelope invariant** (see new bullet in "Invariants"): `shellTimeoutMs - WALL_CLOCK_HEADROOM_MS > 0` and `shellTimeoutFloorMs <= shellTimeoutMs - WALL_CLOCK_HEADROOM_MS`. r1 left this implicit; r2 makes it a thing the design and the schema must enforce.
- Reworded the problem restatement so the opening sentence does not assert the broader prompt-source constraint that the recommended design does not satisfy.

## Problem restated

Two knobs that must satisfy a strict ordering — the agent-supplied / default inner wall-clock cap (in [src/mcp/builtins.ts](src/mcp/builtins.ts)) MUST stay strictly under the outer `McpRuntime` race timeout (in [src/mcp/runtime.ts](src/mcp/runtime.ts)) — are encoded as independent literals, with the only safety net being a code comment.

- `McpRuntime.SHELL_TIMEOUT_MS = 4 * 60 * 60 * 1000` (private static, in-process race timer): [src/mcp/runtime.ts](src/mcp/runtime.ts#L169-L171), used at [src/mcp/runtime.ts](src/mcp/runtime.ts#L184-L191).
- `MAX_WALL_CLOCK_MS = 4 * 60 * 60 * 1000 - 30_000` (default kill cap when the agent omits `timeout_ms`, **and the only upper bound on agent-supplied `timeout_ms`** — which today is *not* applied; an oversized caller-supplied value bypasses it): [src/mcp/builtins.ts](src/mcp/builtins.ts#L36-L39), used at [src/mcp/builtins.ts](src/mcp/builtins.ts#L372).
- `DEFAULT_MIN_TIMEOUT_MS = 10 * 60 * 1000` (floor that clamps agent-supplied timeouts upward): [src/mcp/builtins.ts](src/mcp/builtins.ts#L380), enforced at [src/mcp/builtins.ts](src/mcp/builtins.ts#L407).

The F12 finding paraphrases the coupling as `MAX_WALL_CLOCK_MS = SHELL_TIMEOUT_MS - 30_000`. The actual code is worse: the `4 * 60 * 60 * 1000` constant is duplicated as a literal, not algebraically tied. Editing `SHELL_TIMEOUT_MS` to e.g. `2h` leaves `MAX_WALL_CLOCK_MS` at `4h - 30s = 3h59m30s` — i.e. the inner default would exceed the outer race, so the outer race fires first and produces a stack-trace error instead of the structured `exitCode: 124` result the inner handler emits at [src/mcp/builtins.ts](src/mcp/builtins.ts#L579). Separately, today's [src/mcp/builtins.ts](src/mcp/builtins.ts#L392) reads `const effectiveTimeout = timeout ?? MAX_WALL_CLOCK_MS;` — when the agent **does** supply `timeout_ms`, the inner cap is bypassed entirely, so an agent that asked for `timeout_ms: 5 * 60 * 60 * 1000` silently triggers the outer race instead of the structured result.

Worker-prompt drift (six agents prose-hardcoding `600000 / 1800000 / 3600000`) is **out of scope** for F12; those values are LLM hints, not enforced contracts, and the new inner clamp will protect the invariant regardless of what an LLM picks.

## Actual differences

Both files independently encode the same magnitude:

```ts
// src/mcp/runtime.ts:171
private static readonly SHELL_TIMEOUT_MS = 4 * 60 * 60 * 1000;

// src/mcp/builtins.ts:39
const MAX_WALL_CLOCK_MS = 4 * 60 * 60 * 1000 - 30_000; // 3 h 59 m 30 s
```

The comment at [src/mcp/builtins.ts](src/mcp/builtins.ts#L36-L38) names `McpRuntime.SHELL_TIMEOUT_MS` but the value is not imported — a textual breadcrumb, not a derivation.

## Contract

`McpRuntime.callTool` ([src/mcp/runtime.ts](src/mcp/runtime.ts#L177-L201)):

- Inputs: `serviceName`, `toolName`, `args`.
- For `serviceName === "shell"`: outer `withTimeout(handler, SHELL_TIMEOUT_MS, …)` race rejects with `Error("Tool \"…\" timed out after Nms")` if the inner shell runner has not resolved.
- For other in-process services: 5 min cap via `IN_PROCESS_TIMEOUT_MS = 300_000` ([src/mcp/runtime.ts](src/mcp/runtime.ts#L165-L166)).

`run_command` handler ([src/mcp/builtins.ts](src/mcp/builtins.ts#L354-L394)):

- Reads `args.timeout_ms` / `args.timeout` (alias); reads `args.inactivity_timeout_ms` / `args.idle_timeout_ms` (alias).
- Clamps each upward to `DEFAULT_MIN_TIMEOUT_MS` unless `SAIVAGE_SHELL_TIMEOUT_FLOOR_MS=0` (replaced by `config.mcp.shellTimeoutFloorMs` after F11).
- If `timeout_ms` is unspecified, applies `MAX_WALL_CLOCK_MS` as the hard wall-clock cap; otherwise uses the (floor-clamped) supplied value with **no upper bound**.
- On timeout: returns a `CommandResult` with `exitCode: 124` and a structured `stderr` containing `"Command timed out after <ms>ms"` ([src/mcp/builtins.ts](src/mcp/builtins.ts#L579)). On non-timeout error: rejects.

## Invariants the fix must enforce

1. **Inner cap < outer race** for every code path through `runShellCommand`, including the agent-supplied path. Formally: `effective_timeout_ms <= shellTimeoutMs - WALL_CLOCK_HEADROOM_MS` for every call. Today this is violated by the no-upper-bound caller path.
2. **Derived inner cap is positive.** `shellTimeoutMs - WALL_CLOCK_HEADROOM_MS > 0`. If an operator sets `shellTimeoutMs <= WALL_CLOCK_HEADROOM_MS` (e.g. `30_000` or smaller), the derived cap is zero or negative and every shell command would be killed instantly. The config schema must reject such envelopes at boundary load time, not let them propagate to runtime arithmetic.
3. **Floor does not exceed cap.** `shellTimeoutFloorMs <= shellTimeoutMs - WALL_CLOCK_HEADROOM_MS`. If the floor is above the derived cap, clamping a caller-supplied value up to the floor would push it past the cap — a self-contradiction. The schema must reject this combination.

Invariants 2 and 3 together define the "impossible timing envelope" class the reviewer flagged.

## Call sites & dependencies

- `McpRuntime.callTool` is invoked from `runtime/dispatcher.ts` for every tool call; the `"shell"` branch is hit by every `run_command` invocation across all worker agents.
- `SaivageConfig.runtime` already carries `maxServices`, `restartOnCrash`, `healthCheckIntervalMs`, `idleShutdownMs` ([src/config.ts](src/config.ts#L68-L78)) — but not the timeout envelope or the in-process cap. F11 r2 Proposal B introduces `config.mcp.shellTimeoutMs`, `config.mcp.shellTimeoutFloorMs`, `config.mcp.inProcessTimeoutMs`, etc. ([SPEC/v2/review-2026-05/F11/02-design-r2.md](../F11/02-design-r2.md), Proposal B).
- F11 r2 Step 6 ([SPEC/v2/review-2026-05/F11/03-plan-r2.md](../F11/03-plan-r2.md#L93-L100)) widens `McpRuntime` to read its timing keys from config and explicitly *defers* the inner-cap derivation to F12 ("**Do not touch `MAX_WALL_CLOCK_MS = SHELL_TIMEOUT_MS - 30_000`** — that derivation is F12's territory"). F12's plan must pin to one concrete shape of that interface; see Design r2 and Plan r2.
- Tests touch these knobs via the env override: `SAIVAGE_SHELL_TIMEOUT_FLOOR_MS=0` at [src/mcp/builtins.test.ts](src/mcp/builtins.test.ts#L43-L59). After F11 r2 Step 8 this becomes a `config.mcp.shellTimeoutFloorMs: 0` field on the test's constructed `SaivageConfig`. No existing test asserts the inner-cap < outer-race invariant; F12 adds two.

## Constraints any solution must respect

- Outer race must exist (defence against a misbehaving in-process handler), but it must not be the layer that triggers under normal "no timeout supplied" operation — the structured result path must always win.
- Project guideline: NO backward compatibility — delete `MAX_WALL_CLOCK_MS` and `DEFAULT_MIN_TIMEOUT_MS` and any duplicated literals in the same change; do not keep them as fallbacks.
- `shellTimeoutFloorMs: 0` test-override path must keep working (Vitest tests need short deterministic timeouts).
- The config schema must reject impossible timing envelopes (Invariants 2 and 3) at load time. Runtime arithmetic must not have to defend against zero or negative caps.
- Out of scope: `src/skills/` (per loop conventions). Skills do not consume these constants.
- **Out of scope for F12 (explicit narrowing):** worker-prompt prose at [src/agents/coder.ts](src/agents/coder.ts#L64), [src/agents/manager.ts](src/agents/manager.ts#L140), [src/agents/researcher.ts](src/agents/researcher.ts#L62), [src/agents/data-agent.ts](src/agents/data-agent.ts#L55), [src/agents/reviewer.ts](src/agents/reviewer.ts#L45), [src/agents/inspector.ts](src/agents/inspector.ts#L74). The `600000 / 1800000 / 3600000` literals stay; the new inner clamp guarantees they cannot cause real harm regardless of what an LLM picks.
- Cross-issue: F11 ("magic constants not in config") owns the `config.mcp.shellTimeoutMs` introduction; F12 owns the derivation and the agent-supplied clamp. F12 must land **after** F11.
- Cross-issue: F28 ("registry unused") and F34 ("plan-server no cache") are in the same subsystem but unrelated; do not entangle.
