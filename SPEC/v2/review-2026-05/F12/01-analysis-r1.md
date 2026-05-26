# F12 — Analysis r1

## Problem restated

Three knobs that must satisfy a strict ordering — `worker-suggested timeout ≤ MAX_WALL_CLOCK_MS < McpRuntime.SHELL_TIMEOUT_MS` — are encoded as independent literals in five files, with the only safety net being a code comment.

- `McpRuntime.SHELL_TIMEOUT_MS = 4 * 60 * 60 * 1000` (private static, in-process race timer): [src/mcp/runtime.ts](src/mcp/runtime.ts#L169-L171), used at [src/mcp/runtime.ts](src/mcp/runtime.ts#L184-L191).
- `MAX_WALL_CLOCK_MS = 4 * 60 * 60 * 1000 - 30_000` (default kill cap when the agent omits `timeout_ms`): [src/mcp/builtins.ts](src/mcp/builtins.ts#L36-L39), used at [src/mcp/builtins.ts](src/mcp/builtins.ts#L372).
- `DEFAULT_MIN_TIMEOUT_MS = 10 * 60 * 1000` (floor that clamps agent-supplied timeouts upward): [src/mcp/builtins.ts](src/mcp/builtins.ts#L380), enforced at [src/mcp/builtins.ts](src/mcp/builtins.ts#L407).
- Worker prompts hardcode `600000 / 1800000 / 3600000` ms as plain prose: [src/agents/coder.ts](src/agents/coder.ts#L64), [src/agents/manager.ts](src/agents/manager.ts#L140), [src/agents/researcher.ts](src/agents/researcher.ts#L62), [src/agents/data-agent.ts](src/agents/data-agent.ts#L55), [src/agents/reviewer.ts](src/agents/reviewer.ts#L45), [src/agents/inspector.ts](src/agents/inspector.ts#L74).

The F12 finding paraphrases the coupling as `MAX_WALL_CLOCK_MS = SHELL_TIMEOUT_MS - 30_000`. The actual code is worse: the `4 * 60 * 60 * 1000` constant is duplicated as a literal, not algebraically tied. Editing `SHELL_TIMEOUT_MS` to e.g. `2h` leaves `MAX_WALL_CLOCK_MS` at `4h - 30s = 3h59m30s` — i.e. the inner default would exceed the outer race, so the outer race fires first and produces a stack-trace error instead of the structured timeout result the inner handler emits.

## Actual differences

Both files independently encode the same magnitude:

```ts
// src/mcp/runtime.ts:171
private static readonly SHELL_TIMEOUT_MS = 4 * 60 * 60 * 1000;

// src/mcp/builtins.ts:39
const MAX_WALL_CLOCK_MS = 4 * 60 * 60 * 1000 - 30_000; // 3 h 59 m 30 s
```

The comment at [src/mcp/builtins.ts](src/mcp/builtins.ts#L36-L38) names `McpRuntime.SHELL_TIMEOUT_MS` but the value is not imported. Worker prose at e.g. [src/agents/coder.ts](src/agents/coder.ts#L64) tells the LLM "Recommended: 600000 / 1800000 / 3600000" — these strings have no link to either constant; a config edit cannot move them.

## Contract

`McpRuntime.callTool` ([src/mcp/runtime.ts](src/mcp/runtime.ts#L177-L201)):

- Inputs: `serviceName`, `toolName`, `args`.
- For `serviceName === "shell"`: outer `withTimeout(handler, SHELL_TIMEOUT_MS, …)` race fires `Error("timed out after Nms")` if the inner shell runner has not resolved.
- For other in-process services: 5 min cap via `IN_PROCESS_TIMEOUT_MS = 300_000` ([src/mcp/runtime.ts](src/mcp/runtime.ts#L165-L166)).

`run_command` handler ([src/mcp/builtins.ts](src/mcp/builtins.ts#L354-L377)):

- Reads `args.timeout_ms` / `args.timeout` (alias); reads `args.inactivity_timeout_ms` / `args.idle_timeout_ms` (alias).
- Clamps each upward to `DEFAULT_MIN_TIMEOUT_MS` unless `SAIVAGE_SHELL_TIMEOUT_FLOOR_MS=0`.
- If `timeout_ms` is unspecified, applies `MAX_WALL_CLOCK_MS` as the hard wall-clock cap; otherwise uses the (clamped) supplied value.
- On timeout: returns a `CommandResult` with `exitCode: 124` and a structured `stderr` suffix ([src/mcp/builtins.ts](src/mcp/builtins.ts#L548-L562)). On non-timeout error: rejects.

Invariants the current design depends on:

1. `effective_timeout_ms ≤ SHELL_TIMEOUT_MS` for every code path through `runShellCommand`. Today this holds because both `MAX_WALL_CLOCK_MS` (the default) and any agent-supplied `timeout_ms` (no upper clamp) are *expected* to stay under `SHELL_TIMEOUT_MS`. An agent that requests `timeout_ms: 5 * 60 * 60 * 1000` will silently get the outer race instead of the inner structured timeout.
2. Worker-suggested timeouts ≤ `MAX_WALL_CLOCK_MS`. Today `3600000` (1h) << `3h59m30s`; safe but only by coincidence of the 4h envelope.
3. `DEFAULT_MIN_TIMEOUT_MS ≤` any value workers might suggest. Currently `600000 == 600000`; another coincidence.

## Call sites & dependencies

- `McpRuntime.callTool` is invoked from `runtime/dispatcher.ts` for every tool call; the `"shell"` branch is hit by every `run_command` invocation across all worker agents.
- Worker prompts that name the literal millisecond values: `coder`, `manager`, `researcher`, `data-agent`, `reviewer`, `inspector` (file:line above). Planner does not enumerate them.
- `SaivageConfig.runtime` already carries `maxServices`, `restartOnCrash`, `healthCheckIntervalMs`, `idleShutdownMs` ([src/config.ts](src/config.ts#L70-L78)) — but not the timeout envelope or the in-process cap. F11 covers the broader hoist-to-config theme.
- Tests touch these knobs via the env override: `SAIVAGE_SHELL_TIMEOUT_FLOOR_MS=0` at [src/mcp/builtins.test.ts](src/mcp/builtins.test.ts#L43-L59). No test asserts the `MAX_WALL_CLOCK_MS < SHELL_TIMEOUT_MS` invariant.

## Constraints any solution must respect

- Outer race must exist (defence against a misbehaving in-process handler), but it must not be the layer that triggers under normal "no timeout supplied" operation — the structured result path must always win.
- Worker prompts are LLM-facing free text; they must stay readable. The suggested values must come from the same source the runtime enforces, not a parallel hand-typed copy.
- Project guideline: NO backward compatibility — delete `MAX_WALL_CLOCK_MS` and any duplicated literals in the same change; do not keep them as fallbacks.
- `SAIVAGE_SHELL_TIMEOUT_FLOOR_MS=0` test override path must keep working.
- Out of scope: `src/skills/` (per loop conventions). Skills do not consume these constants.
- Cross-issue: F11 ("magic constants not in config") proposes hoisting many constants into `SaivageConfig`; F12's fix should compose with F11's hoist target rather than introduce a third home.
- Cross-issue: F28 ("registry unused") is unrelated to timing but lives in the same subsystem; do not entangle. F34 ("plan-server no cache") is in the same subsystem; do not entangle.
