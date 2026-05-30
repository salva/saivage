# Development Setup

Working on Saivage itself.

## Getting the source

```bash
git clone https://github.com/salva/saivage.git
cd saivage
npm ci
cd web && npm ci && cd ..
```

Outputs:

- `node_modules/` — server deps.
- `web/node_modules/` — dashboard deps, installed from `web/package-lock.json`.

## Build

```bash
npm run build           # web + server
npm run build:server    # just tsup
npm run build:web       # just web
```

`tsup` produces the ESM CLI/server bundle at `dist/cli.js`, emits source maps,
and copies the runtime `skills/` and `prompts/` assets into `dist/`. It does not
emit declarations or a separate `dist/index.js` bundle.

## Dev loop

The fastest iteration loop is:

```bash
npm run dev               # tsx src/server/cli.ts
```

`tsx` runs the CLI directly without a prior build. Restart the command after
server changes, and pair it with `npm --prefix web run dev` for the dashboard.

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

The configuration is at `eslint.config.js`. It composes the recommended and
strict TypeScript ESLint configs, warns on explicit `any`, enforces unused
variable handling, bans `eval`, and adds an auth-specific ban on sync `fs`
imports outside tests/fixtures.

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

VS Code with TypeScript, ESLint, Vue, and VitePress tooling is the normal local
setup. The repository itself does not currently include a `.vscode/` extension
recommendation file.

## Common pitfalls

- Forgetting to run `npm run build:web` before `serve` — the daemon will
  serve a stale dashboard.
- Editing `src/types.ts` without updating consumers — `npm run typecheck`
  catches this immediately.
- Touching shared MCP tool schemas — the agent system prompts mention
  tool names; renaming a tool requires updating the relevant files under
  `prompts/`.
