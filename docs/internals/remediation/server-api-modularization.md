# Server API Modularization

## Problem

`src/server/server.ts` combines Fastify setup, API auth, static UI/docs serving,
plan routes, state routes, agent conversation views, config/provider redaction,
MCP tool listing, notes routes, chat history, file browsing, debug aggregation,
WebSocket chat lifecycle, and SPA fallback.

The server is therefore both transport and application layer.

## Goal

Make server startup a composition layer over route modules and read services.

## Target Layout

```text
src/server/
  server.ts
  auth.ts
  static-assets.ts
  routes/
    health.ts
    plan.ts
    state.ts
    agents.ts
    config.ts
    mcp.ts
    inspections.ts
    notes.ts
    chats.ts
    files.ts
    debug.ts
    websocket.ts
  read-models/
    config.ts
    debug.ts
    files.ts
    plan.ts
    stage.ts
```

## Design Rules

- Route modules register endpoints only.
- Redaction and safe response shaping live in read models.
- File path hiding and traversal logic live in `FileBrowserService`.
- WebSocket chat lifecycle lives in a dedicated route/module.
- Static asset mounting lives outside API route registration.
- Debug routes must never parse secret-bearing config files directly.

## Route Dependencies

Routes should receive explicit reads and commands instead of the entire mutable
runtime:

```ts
interface ServerReads {
  activePlan(): Promise<ActivePlanView | null>;
  stageDetails(stageId: string): Promise<StageDetailsView | null>;
  runtimeState(): Promise<RuntimeStateView | null>;
  safeConfig(): Promise<SafeConfigResponse>;
  debugTimeline(): Promise<DebugTimelineView>;
}

interface ServerCommands {
  restartPlanner(reason: string): Promise<void>;
  acknowledgeNote(noteId: string): Promise<void>;
  deleteNote(noteId: string): Promise<void>;
  startChatSession(input: ChatStartInput): Promise<ChatSessionHandle>;
}
```

This keeps route modules testable and prevents them from depending on
`ModelRouter`, `McpRuntime`, `EventBus`, or the full runtime object unless a
route truly needs that object.

## Migration Strategy

1. Extract token auth into `auth.ts`.
2. Extract static UI/docs mounting into `static-assets.ts`.
3. Extract notes routes first because they are already partially isolated.
4. Extract config/provider safe response helpers into a config read model.
5. Extract file browser route and path hiding into `FileBrowserService`.
6. Extract debug errors/timeline into `DebugReadModel`.
7. Extract WebSocket chat into its own module and move `ChatAgent` construction
   behind a chat/agent command service.
8. Reduce `startServer` to app construction, plugin registration, and listen.

## Validation

- Existing server tests pass after each route extraction.
- Add route-module tests using fake read models.
- Add file-browser tests for sensitive paths and traversal.
- Grep gate: raw JSON debug aggregation should live only in debug read model.

## Expected Result

The HTTP server becomes a thin adapter. Runtime and persistence changes no longer
require editing the same monolithic server file.
