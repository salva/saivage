# Source Tree

A directory-level guided tour. Use this as a map between the
[architecture](./architecture) diagram and concrete files.

```
saivage/
├── src/                        # daemon (TypeScript, ESM)
│   ├── index.ts                # public barrel — used as TypeDoc entry
│   ├── types.ts                # Zod schemas + TS types for all JSON docs
│   ├── config.ts               # SaivageConfig, env interpolation, defaults
│   ├── log.ts                  # structured logger (stdout + JSONL file)
│   ├── ids.ts                  # collision-resistant id generators
│   ├── agents/                 # one module per agent role + base
│   ├── runtime/                # dispatcher, compaction, self-check, abort, recovery
│   ├── providers/              # LLM provider implementations + router
│   ├── mcp/                    # MCP runtime, registry, in-process services
│   ├── auth/                   # OAuth flows and token store
│   ├── routing/                # ModelRoutingResolver
│   ├── channels/               # cli / oneshot / websocket / telegram
│   ├── server/                 # bootstrap, fastify server, cli, telegram bot
│   ├── store/                  # project context + JSON document store
│   ├── skills/                 # skill loader (trigger matching)
│   ├── security/               # prompt-injection cop
│   └── events/                 # in-process event bus
├── web/                        # Vite + Vue dashboard (built into web/dist)
├── deploy/                     # LXC create/provision scripts + Makefile
├── skills/                     # built-in skill catalogue
├── SPEC/v2/                    # canonical design specifications
├── SPECS/v2/                   # board specifications & analysis
├── tests/ (under src/**.test.ts) — vitest
├── tsconfig.json
├── tsup.config.ts              # bundler config (CJS + ESM dist)
├── vitest.config.ts
└── package.json
```

## Public surface

The `src/index.ts` barrel re-exports the **stable public API**: types
(`ProjectConfig`, `Plan`, `Stage`, `Task`, …), the `bootstrap` /
`runPlanner` / `startServer` entry points, and the agent classes. This is
the file consumed by [TypeDoc](/api/) when generating the API reference.

## Entry points

| Binary | Source | Built artifact |
|--------|--------|----------------|
| `saivage` (CLI) | `src/server/cli.ts` | `dist/cli.js` |
| Dev runner | `npm run dev` → `tsx src/server/cli.ts` | n/a |
| Web UI | `web/src/main.ts` | `web/dist/` |

## Tests

Test files are colocated as `<file>.test.ts`. Run with `npm test` (vitest).
The test runner mocks the LLM router; tests do not call real providers.
See [Testing](./testing).

## Build outputs

- `dist/` — server bundle (esbuild via tsup) + `.d.ts` files for library
  consumers.
- `web/dist/` — static assets served by the daemon.
- `docs/.vitepress/dist/` — VitePress site (this documentation).
- `docs/api/` — TypeDoc-generated markdown (regenerated on each docs build).
