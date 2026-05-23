# F26 — SPA duplicates auth-failure handling between `App.vue` and `useWebSocket`

**Category**: duplication
**Severity**: low
**Transversality**: local

## Summary

Two places in the SPA independently know that a 401 / 1008 / 4401 / 4403 response means "the API token is wrong, stop trying": `App.vue` for HTTP polling of `/api/state`, and `useWebSocket` for the WebSocket session. Each surfaces its own `"unauthorized"` status to the UI, and the document-title sync in `App.vue` consumes the HTTP version while the StatusPanel consumes the WS version.

## Evidence

- HTTP path in App.vue: [web/src/App.vue](web/src/App.vue#L129-L155) (`runtimeStatus.value = "unauthorized"`).
- WS path: [web/src/composables/useWebSocket.ts](web/src/composables/useWebSocket.ts#L62-L75).
- Both refer to the same backend gate: [src/server/server.ts](src/server/server.ts#L661-L668) (`socket.close(1008, "unauthorized")`).

## Why this matters

When the user enters a fresh token via `setApiToken`, the HTTP path sees it on the next 8s poll but the WS path stays stopped (it sets `stopped = true` on the unauthorized close). The UI then shows "title says we're authorised, but WS still disconnected" until the user manually reloads. A shared `auth-state` composable that owns the unauthorised flag and emits a `retry()` would let both transports recover together.

## Related

- F10 (orphan CSS)
