# F12 — Cross-file magic-number coupling in MCP builtins

**Category**: bad-design
**Severity**: medium
**Transversality**: module

## Summary

`MAX_WALL_CLOCK_MS` in `mcp/builtins.ts` is defined as `SHELL_TIMEOUT_MS - 30_000` where `SHELL_TIMEOUT_MS` lives in `mcp/runtime.ts`. The two values are spec-locked together via subtraction; whoever changes one has to remember the invariant in the other.

## Evidence

- `SHELL_TIMEOUT_MS = 4h` (`McpRuntime` static): [src/mcp/runtime.ts](src/mcp/runtime.ts).
- `MAX_WALL_CLOCK_MS = SHELL_TIMEOUT_MS - 30_000`: [src/mcp/builtins.ts](src/mcp/builtins.ts).
- Worker agents also reference shell timing in their system prompts ("3600000 (1 hour) for training/experiments"): [src/agents/coder.ts](src/agents/coder.ts#L44), [src/agents/manager.ts](src/agents/manager.ts#L91).

## Why this matters

Two implicit contracts here: (1) builtins must run inside the runtime's outer kill timer, (2) workers must request shell timeouts shorter than the runtime envelope. Encoding the first as subtraction (not as `min(requested, RUNTIME_BUDGET - 30s)` at call-time) and the second only in prose inside system prompts means a single config edit can silently desynchronise three independent knobs.

## Related

- F11 (constants generally)
