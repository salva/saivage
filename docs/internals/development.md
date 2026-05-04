# Development Setup

Working on Saivage itself.

## Getting the source

```bash
git clone https://github.com/salva/saivage.git
cd saivage
npm ci
```

Outputs:

- `node_modules/` — server deps.
- `web/node_modules/` — web deps (installed automatically by the
  `prepare` script chain).

## Build

```bash
npm run build           # web + server
npm run build:server    # just tsup
npm run build:web       # just web
```

`tsup` produces `dist/cli.js`, `dist/index.js`, and `.d.ts` files for
library consumers. Source maps are emitted by default.

## Dev loop

The fastest iteration loop is:

```bash
npm run dev               # tsx src/server/cli.ts
```

`tsx` watches imports and recompiles on save. Pair with `npm --prefix
web run dev` for the dashboard.

For library work (no server), `vitest --watch` plus the typecheck task
gives quick feedback:

```bash
npm run test:watch
npm run typecheck
```

## Lint

```bash
npm run lint              # eslint src/
```

The configuration is at `eslint.config.js`. Rules favor explicit types
(`@typescript-eslint/explicit-module-boundary-types`) and forbid `any`
except in test files.

## Testing

See [Testing](./testing).

## Documentation

```bash
npm run docs:dev         # local VitePress server
npm run docs:build       # produce static site under docs/.vitepress/dist
npm run docs:api         # regenerate TypeDoc markdown into docs/api/
```

The `docs:dev` script regenerates `docs/api/` first, then launches
VitePress with hot reload. Markdown changes show up instantly; updates to
TS source require a rerun of `npm run docs:api` (or just `npm run
docs:dev` again).

## Editor

VS Code with the recommended TypeScript and ESLint extensions is the
supported setup. The repo includes a per-Vue-file linting workflow — see
the user-memory note about Vue SFC corruption mitigations.

## Common pitfalls

- Forgetting to run `npm run build:web` before `serve` — the daemon will
  serve a stale dashboard.
- Editing `src/types.ts` without updating consumers — `npm run typecheck`
  catches this immediately.
- Touching shared MCP tool schemas — the agent system prompts mention
  tool names; renaming a tool requires updating prompts under
  `SPEC/v2/prompts/`.
