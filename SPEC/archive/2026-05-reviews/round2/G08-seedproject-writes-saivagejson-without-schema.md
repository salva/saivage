# G08 — `seedProject` writes `saivage.json` raw, bypassing `SaivageConfigSchema`

**Subsystem:** src/store/
**Category:** architecture / schema-bypass
**Severity:** medium
**Transversality:** local, but with security and drift implications

## Summary

`seedProject` writes the canonical runtime configuration `saivage.json` as a hand-rolled JS object literal serialized via `writeFile(..., JSON.stringify(...), "utf-8")`. Every other config write in the store uses `writeDoc(path, value, Schema)` — the function whose entire purpose is to enforce that on-disk documents validate against a Zod schema. `saivage.json` is the highest-stakes config file in the project (providers, failover, MCP servers, agent concurrency, notifications) and the only one not validated on the write path. The result: any future change to `SaivageConfigSchema` can silently produce a fresh seed that fails to load on the next restart, and the literal embedded here can drift from the schema's actual shape without any compile-time link.

## Evidence

[src/store/project.ts](src/store/project.ts#L8) imports `writeDoc` from the store; [src/store/project.ts](src/store/project.ts#L132) uses it correctly for the project config: `await writeDoc(configPath, config, ProjectConfigSchema);`.

[src/store/project.ts](src/store/project.ts#L135-L163) then writes `saivage.json` differently:

```ts
const saivageJson = {
  providers: {
    anthropic: {},
    openai: {},
    ollama: { baseUrl: "http://localhost:11434" },
    llamacpp: { baseUrl: "http://localhost:8080" },
  },
  failover: {},
  modelEquivalents: {},
  server: { port: 8080, host: "0.0.0.0" },
  agent: { maxConcurrentAgents: 3 },
  notifications: { channels: ["web"], filters: { min_severity: "info", categories: [] } },
  mcpServers: {
    playwright: {
      command: "npx",
      args: ["-y", "@playwright/mcp@latest", "--headless"],
      env: { PLAYWRIGHT_BROWSERS_PATH: "${HOME}/.cache/ms-playwright" },
      disabled: false, autostart: true, transport: "stdio",
    },
  },
};
await writeFile(saivageJsonPath, JSON.stringify(saivageJson, null, 2) + "\n", "utf-8");
```

There is no `SaivageConfigSchema.parse(saivageJson)` step, no `writeDoc`, no typed variable declaration (`const saivageJson: SaivageConfig = ...`). TypeScript only checks this as an inferred object literal — fields can be missing, extra, or wrong-shape without any error.

Also troubling: the seed *includes* a Playwright MCP server config, hardcoded. That is a project-policy decision (which MCP servers to autostart) baked into the framework's `seedProject`, not a runtime concern. Anyone running `seedProject` on a fresh project gets Playwright autostart whether they want it or not.

## Why this matters

- The Zod-validated, atomic, single-writer `writeDoc` contract was introduced (round-1) exactly to prevent on-disk drift. Bypassing it for the most security-sensitive config in the system defeats the purpose. A future round-1-style refactor (e.g. renaming `notifications.filters.min_severity` to `notifications.minSeverity`) will silently leave the literal here producing files that the loader then rejects with a Zod error at startup.
- Hardcoded MCP server defaults are a policy leak. The `playwright` entry survives every `seedProject` call, so projects that should not be running a browser autostart still get one. Combined with G13 (prompt-injection cop fail-open) this is an attack-surface expansion.
- The hardcoded ports (`server.port: 8080`, `ollama: localhost:11434`, `llamacpp: localhost:8080` — note `localhost:8080` collides with the saivage server) and `host: "0.0.0.0"` bind are all silent operational defaults that are usually wrong for production deployments and obviously wrong for any harness colocated with Ollama on the same host.

## Rough remediation direction

1. Type the literal explicitly: `const saivageJson: SaivageConfig = { ... }` so the compiler catches shape drift.
2. Write via `writeDoc(saivageJsonPath, saivageJson, SaivageConfigSchema)` — the Zod parse on the way to disk is the regression guard.
3. Move the literal out of `seedProject` into a `defaultSaivageConfig(): SaivageConfig` helper (or a `.template.json` in `prompts/` style) so the seeder doesn't own product policy. Make the Playwright autostart opt-in by removing it from the default; projects that need it can add it later.
4. Resolve the `llamacpp` port collision with the saivage server (`server.port: 8080`) — pick distinct defaults.

## Cross-links

- Related to round-1 F22 (async-fs / atomic writes); this file undermines the same invariant.
- Touches workspace memory: matches the "ml-workspace-saivage-ops" rule that GetRich-v2 seeding clobbers `saivage.json`; the workaround there (restore `saivage.json` after `seedProject`) exists because of this design.
