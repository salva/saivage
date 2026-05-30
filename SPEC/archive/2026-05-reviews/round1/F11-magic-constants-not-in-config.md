# F11 — Operational constants are hardcoded across modules instead of in `SaivageConfig`

**Category**: over-engineering
**Severity**: medium
**Transversality**: cross-cutting

## Summary

`SaivageConfig` carefully exposes some knobs (`runtime.healthCheckIntervalMs`, `supervisor.intervalMs`, `agent.maxConcurrentAgents`) but not others. A non-exhaustive list of operationally-relevant constants embedded directly in source:

| Constant | File | Notes |
|---|---|---|
| `MAX_NUDGES = 15` | [src/agents/planner.ts](src/agents/planner.ts#L223) | Planner nudges before exit |
| `MAX_CONSECUTIVE_INVALID = 3` | [src/runtime/dispatcher.ts](src/runtime/dispatcher.ts#L68) | Aborts on bad tool names |
| `MAX_INVALID_FINAL_RESPONSES = 3` | [src/agents/base.ts](src/agents/base.ts#L131) | Aborts on text-only no-tool responses |
| `MAX_DIAGNOSTIC_ENTRIES = 30` | [src/agents/base.ts](src/agents/base.ts#L81) | Buffer cap |
| `transientCap = 500` | (BaseAgent) | LLM retry cap |
| `FORCE_CANCEL_DELAY_MS = 600_000` | [src/runtime/supervisor.ts](src/runtime/supervisor.ts#L12) | Re-cancel grace |
| `DEFAULT_VOLATILE_TTL_MS = 2h` | [src/runtime/notes.ts](src/runtime/notes.ts) | Note expiry |
| `MAX_OUTPUT = 100KB` | [src/mcp/builtins.ts](src/mcp/builtins.ts) | Shell tail cap |
| `MAX_FETCH_CHARS = 200_000` | [src/mcp/builtins.ts](src/mcp/builtins.ts) | Web fetch cap |
| `MAX_DOWNLOAD_BYTES = 250MB` | [src/mcp/builtins.ts](src/mcp/builtins.ts) | Download cap |
| `MAX_WALL_CLOCK_MS = SHELL_TIMEOUT_MS - 30s` | [src/mcp/builtins.ts](src/mcp/builtins.ts) | Coupled to F12 |
| `RECOVERY_DELAY_MS = 60_000` | [src/server/bootstrap.ts](src/server/bootstrap.ts) | Planner recovery |
| `BASE_DELAY_S = 30; MAX_DELAY_S = 20*60` | [src/agents/base.ts](src/agents/base.ts#L483-L485) | LLM backoff |
| WebSocket backoff (1s / 30s / 1.7×) | [web/src/composables/useWebSocket.ts](web/src/composables/useWebSocket.ts#L11-L13) | SPA-side |
| Title poll = 8s | [web/src/App.vue](web/src/App.vue#L150) | SPA-side |

## Why this matters

Operators tuning Saivage for a production deployment (slower link → longer backoff; cheaper compute → smaller download cap) have to fork the source. The numbers are also not visible to test harnesses, so the test suite relies on whatever values were committed today — making "behaviour under stress" untestable in isolation.

## Related

- F12 (`MAX_WALL_CLOCK_MS = SHELL_TIMEOUT_MS - 30s` coupling)
- F07 (`chars/4`)
