# MCP Built-Ins Modularization

## Problem

`src/mcp/builtins.ts` contains filesystem, shell, git, web fetch, web search,
download, RAG registration, knowledge handlers, unavailable stubs, global limits,
path helpers, HTML parsing, and command process management in one file.

This creates several issues:

- Hard to test one service without loading all services.
- Mutable module-level limits make tests and runtime behavior harder to isolate.
- Handlers derive project root from `process.env` instead of injected context.
- Service-specific safety rules are interleaved.
- Adding a tool increases risk of changing unrelated services.

## Goal

Keep built-ins in-process, but organize them as small service modules with
injected context and limits.

## Target Layout

```text
src/mcp/builtins/
  index.ts
  filesystem.ts
  shell.ts
  git.ts
  web-fetch.ts
  web-search.ts
  download.ts
  rag.ts
  knowledge.ts
  stubs.ts
  paths.ts
  errors.ts
  limits.ts
```

## Service Factory Shape

```ts
interface BuiltinServiceFactoryArgs {
  project: ProjectContext;
  config: SaivageConfig["mcp"];
  security: SaivageConfig["security"];
  rag?: RagService;
  knowledge?: KnowledgeStore;
}

interface BuiltinServiceModule {
  name: string;
  tools: ToolEntry[];
  handler: InProcessToolHandler;
  available?: boolean;
}
```

`registerBuiltinServices` should only compose modules and register them with
`McpRuntime`.

## Context Rules

- No built-in service should call `process.env.PROJECT_ROOT` to resolve paths.
- `ProjectContext` should be injected once at service construction.
- Shell may receive a scrubbed environment from an `EnvironmentProvider`, but
  project root injection should still be explicit.
- Path helpers should operate on injected `project.projectRoot`.
- Secret/environment scrubbing must also be injected. Do not keep
  `secretEnvNamePredicate` as a module-level singleton derived from default
  security settings.

## Relationship To Agent Autonomy

This refactor is structural, not a permission redesign. Built-ins should keep
the existing broad role tool model. Service modules can still emit compliance
signals for convention drift, but they should not become a complex policy engine.

## Stubs

Unavailable stubs should either be deleted or isolated in `stubs.ts` with a
clear reason.

Preferred cleanup:

- Delete stubs for tools that are no longer part of the current architecture.
- Keep only stubs that the dashboard needs to display as intentionally
  unavailable.
- Do not register unavailable stubs into agent-facing tool catalogs.

## Migration Strategy

1. Extract pure path/error/limit helpers.
2. Extract filesystem service unchanged.
3. Extract shell service unchanged.
4. Extract git service unchanged.
5. Extract web fetch/search/download services.
6. Extract RAG and knowledge registration adapters.
7. Replace module-level mutable config with immutable per-service limits and
   injected security context.
8. Update tests to import service modules directly.
9. Leave `src/mcp/builtins.ts` as a temporary compatibility barrel, then delete
   it or reduce it to `export * from "./builtins/index.js"`.

## Validation

- Existing built-ins tests pass after each extraction.
- New focused tests can instantiate filesystem/shell/git independently.
- Grep gate: only shell/environment adapter reads process env directly.
- `npm run typecheck`, `npm test`.
