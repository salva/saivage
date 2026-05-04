# Testing

Saivage uses [Vitest](https://vitest.dev/). Tests are colocated with
their source files as `*.test.ts`.

## Running

```bash
npm test               # run once
npm run test:watch     # watch mode
```

Vitest config is at [`vitest.config.ts`](https://github.com/salva/saivage/blob/main/vitest.config.ts).
The runner uses Node's native ESM resolution (matching the production
runtime).

## Coverage

```bash
npx vitest run --coverage
```

The coverage report writes to `coverage/`.

## Test categories

| File pattern | Scope |
|--------------|-------|
| `src/store/**/*.test.ts` | Document store (atomic writes, schema validation). |
| `src/runtime/**/*.test.ts` | Dispatcher, supervisor, shutdown handoff. |
| `src/agents/agents.test.ts` | Agent skeletons (mocked router). |
| `src/providers/**/*.test.ts` | Provider routing, response-id translation. |
| `src/auth/store.test.ts` | OAuth profile persistence. |
| `src/mcp/**/*.test.ts` | Built-in MCP tools, runtime registration. |
| `src/security/*.test.ts` | Prompt-injection cop. |
| `src/server/server.test.ts` | HTTP/WebSocket integration. |
| `src/channels/telegram.test.ts` | Telegram message routing. |
| `src/events/bus.test.ts` | EventBus filter logic. |
| `src/routing/resolver.test.ts` | Routing rule resolution precedence. |

## Mocking the LLM

Tests do not call real providers. The pattern is:

```ts
const router = makeMockRouter([
  // sequential responses
  { content: [{ type: "text", text: "ok" }], stop_reason: "end_turn" },
]);
```

`makeMockRouter` returns a `ModelRouter`-shaped object whose `chat()`
returns canned responses in order. Tool calls are described in the same
shape as a real provider response.

## Mocking the filesystem

Most tests use `tmp.dirSync()` and operate on real disk under a unique
prefix; cleanup is automatic. The store helpers (`writeDoc`, `readDoc`)
work the same way in tests as in production, so we exercise the schema
validation path on every run.

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
