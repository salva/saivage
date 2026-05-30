# Testing

Saivage uses [Vitest](https://vitest.dev/). Most tests are colocated with
their source files as `*.test.ts`; top-level integration tests live under
`tests/**/*.test.ts`, and dashboard tests live under `web/src/**/*.test.ts`.

## Running

```bash
npm test               # run once
npm run test:watch     # watch mode
```

Vitest config is at [`vitest.config.ts`](https://github.com/salva/saivage/blob/main/vitest.config.ts).
The runner includes `src/**/*.test.ts`, `tests/**/*.test.ts`, and
`web/src/**/*.test.ts`, with a 30s test timeout, a 10s hook timeout, and the
`@channels/ws-schema` alias used by the web tests.

## Coverage

There is no checked-in coverage script or coverage provider dependency. Add a
Vitest coverage provider before relying on `vitest run --coverage` in CI.

## Test categories

| File pattern | Scope |
|--------------|-------|
| `src/store/**/*.test.ts` | Document store (atomic writes, schema validation). |
| `src/runtime/**/*.test.ts` | Runtime state, locks, compaction, stash, token counting, shutdown handoff. |
| `src/agents/**/*.test.ts` | Agent loops, prompts, tool filters, worker spawning, Chat/Librarian behavior. |
| `src/providers/**/*.test.ts` | Provider routing, model capabilities, response-id translation, provider adapters. |
| `src/auth/store.test.ts` | OAuth profile persistence. |
| `src/mcp/**/*.test.ts` | Built-in MCP tools, knowledge MCP tools, runtime registration, filesystem guard. |
| `src/security/*.test.ts` | Secret env scrubbing, secret detection, and no-copy invariants. |
| `src/knowledge/**/*.test.ts` | Skills/memory lifecycle, search, permissions, eager loading, concurrency. |
| `src/rag/**/*.test.ts` | RAG registry, ingestion/query pipeline, chunkers, watcher, cache, store, security. |
| `tests/rag/**/*.test.ts` | RAG end-to-end drift and ingest/query coverage. |
| `web/src/**/*.test.ts` | Dashboard composables, markdown utilities, and component helpers. |
| `src/server/**/*.test.ts` | HTTP/WebSocket integration, CLI actions, prompt snapshots, server-side RAG handlers. |
| `src/channels/telegram.test.ts` | Telegram message routing. |
| `src/events/bus.test.ts` | EventBus filter logic. |
| `src/routing/resolver.test.ts` | Routing rule resolution precedence. |

## Mocking the LLM

Tests do not call real providers. The pattern is:

```ts
const router = {
  getMaxContextTokens: () => 200_000,
  countTokens: () => 0,
  chat: async () => ({
    content: "ok",
    finishReason: "end_turn",
    usage: { inputTokens: 1, outputTokens: 1 },
  }),
};
```

There is no shared `makeMockRouter` helper. Tests either construct a
`ModelRouter`-shaped object inline or define a local helper such as
`makeRouter` / `makeScriptedRouter` for canned sequential responses. Tool
calls are described in the same shape as a real provider response.

## Mocking the filesystem

Most filesystem tests use `mkdtempSync(join(tmpdir(), "saivage-..."))` (or the
async equivalent) and operate on real disk under a unique prefix. Tests clean
up explicitly with `rmSync` / `rm`, and the store helpers (`writeDoc`,
`readDoc`) work the same way in tests as in production, so we exercise the
schema validation path on every run.

## Snapshotting

Vitest's `toMatchInlineSnapshot()` is preferred for small structured
outputs (plan diffs, runtime state). Avoid file snapshots — they encourage
lazy review.

## Adding tests

Test files mirror the module under test. Prefer:

- Pure unit tests for utility modules (router, resolver, bus, store).
- Integration tests with mocked providers for runtime modules
  (dispatcher, recovery, supervisor).
- One end-to-end test per code path that touches both the HTTP server and
  the agent loop (e.g. `server.test.ts`).
