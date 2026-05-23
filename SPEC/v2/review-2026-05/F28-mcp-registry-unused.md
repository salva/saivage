# F28 — MCP registry persists to disk but is not consulted by the in-process tools it tracks

**Category**: dead-code
**Severity**: low
**Transversality**: module

## Summary

`src/mcp/registry.ts` reads/writes a `.saivage/registry.json` listing MCP services. In practice every Saivage tool runs in-process via `McpRuntime` (filesystem, shell, git, web, plan, notes, skills, memory, index). The persistent registry is only consulted for *external* MCP servers configured under `config.mcpServers`, which today is just `playwright` in the default config — and that one is autostarted from the config directly, not from the registry file.

## Evidence

- The registry implementation: [src/mcp/registry.ts](src/mcp/registry.ts).
- In-process runtime: [src/mcp/runtime.ts](src/mcp/runtime.ts).
- Default `mcpServers` config block: [src/config.ts](src/config.ts#L121-L138).

## Why this matters

The registry file accumulates entries from every Saivage run and is never garbage-collected; recovery code has to skip it; users see a confusing `.saivage/registry.json` they don't know whether to commit. Either the in-process tools should also register themselves (so the file becomes the single source of truth) or the file should go away and `config.mcpServers` is the only declaration.

## Related

- F11 (registry-related constants)
