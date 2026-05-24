# F26 — Plan r1 (Proposal A)

Implementing Proposal A: shared `useAuthState` composable; delete the duplicated `"unauthorized"` paths.

## Ordered edit steps

### 1. Add the composable

Create `web/src/composables/useAuthState.ts`:

- Module-scope `unauthorized = ref(false)` and `retryHandlers = new Set<() => void>()`.
- Export `useAuthState()` returning `{ unauthorized: readonly(unauthorized), markUnauthorized, clearUnauthorized, onRetry, requestRetry }`.
- `requestRetry()` clears `unauthorized` and synchronously invokes each handler.
- `onRetry(h)` returns the unsubscribe closure.

No imports beyond `ref, readonly` from `vue`.

### 2. Wire token setter into recovery

Edit [web/src/utils/api.ts](web/src/utils/api.ts#L60-L69):

- Import `useAuthState` from `../composables/useAuthState`.
- At the end of `setApiToken`, call `useAuthState().requestRetry()`.
- No other changes to `apiFetch` itself (Proposal A leaves the HTTP error surface unchanged).

### 3. Switch WS composable to the shared bit

Edit [web/src/composables/useWebSocket.ts](web/src/composables/useWebSocket.ts):

- Remove `"unauthorized"` from `WsStatus` (line 9). New type: `"connecting" | "open" | "closed"`.
- In `ws.onclose` ([useWebSocket.ts#L62-L75](web/src/composables/useWebSocket.ts#L62-L75)) the auth-close branch becomes:
  ```ts
  if (event.code === 1008 || event.code === 4401 || event.code === 4403) {
    status.value = "closed";
    stopped = true;
    useAuthState().markUnauthorized();
    return;
  }
  ```
- At the top of `useWebSocket(...)` register a retry handler:
  ```ts
  const unsubscribeRetry = useAuthState().onRetry(() => { reconnect(); });
  ```
  and call `unsubscribeRetry()` from `disconnect()` and `onUnmounted`.
- Update the JSDoc block ([useWebSocket.ts#L17-L24](web/src/composables/useWebSocket.ts#L17-L24)) to describe the new contract (auth state lives in `useAuthState`). Do not add new docstrings beyond updating this one already-modified block.

### 4. Strip the duplicate in App.vue

Edit [web/src/App.vue](web/src/App.vue):

- Import `useAuthState` from `./composables/useAuthState`.
- In `pollTitleStatus` ([App.vue#L122-L139](web/src/App.vue#L122-L139)) replace the 401 branch:
  ```ts
  if (err instanceof ApiError && err.status === 401) {
    useAuthState().markUnauthorized();
    runtimeStatus.value = "";
    runtimeStage.value = "";
    return;
  }
  ```
  (Import `ApiError` from `./utils/api`.) The catch keeps clearing the runtime strings on other errors as today.
- In the title watcher ([App.vue#L152-L159](web/src/App.vue#L152-L159)) read `unauthorized` from `useAuthState()` rather than checking `status === "unauthorized"`. `runtimeStatus` becomes a pure phase/status string.

### 5. Simplify ChatWindow

Edit [web/src/components/ChatWindow.vue](web/src/components/ChatWindow.vue):

- Replace the WS-status-derived `"unauthorized"` branch in `connectionLabel` ([ChatWindow.vue#L59-L66](web/src/components/ChatWindow.vue#L59-L66)) with a derived value:
  ```ts
  const { unauthorized } = useAuthState();
  const connectionLabel = computed(() => {
    if (unauthorized.value) return "unauthorized";
    switch (displayStatus.value) {
      case "open": return "connected";
      case "connecting": return "connecting…";
      default: return "offline";
    }
  });
  ```
- Update the debounce watcher ([ChatWindow.vue#L44-L55](web/src/components/ChatWindow.vue#L44-L55)) — remove the `next === "unauthorized"` short-circuit; only `"open"` needs the immediate-update fast path now.
- `submitToken` ([ChatWindow.vue#L216-L222](web/src/components/ChatWindow.vue#L216-L222)) loses the explicit `reconnect()` call (it now happens via the retry handler set up in step 3).
- Anywhere the template branches on the unauthorized state (the auth form gate around line 285), switch to `unauthorized` from `useAuthState`.

### 6. Type sweep

Run typecheck and fix any remaining references to the removed `WsStatus = "unauthorized"` value.

## Test strategy

- **Existing tests.** Vitest config: [vitest.config.ts](vitest.config.ts). There is no SPA test coverage for `useWebSocket`, `useAuthState`, the title watcher, or `ChatWindow`. The SPA tests in this repo are limited to whatever lives under `web/src/**/*.test.ts` (none today, verified via directory listing). No existing test will break.
- **New tests.** Add `web/src/composables/useAuthState.test.ts` covering:
  - default `unauthorized` is `false`;
  - `markUnauthorized()` flips it true;
  - `requestRetry()` clears it and calls every registered handler exactly once;
  - `onRetry(h)` returns an unsubscribe that prevents `h` from being called.
  This is a pure-logic Vue composable; no DOM, no fake timers needed.
- **Manual smoke** (cannot be automated without an integration harness; document for the implementer): start the server with `SAIVAGE_API_TOKEN=xxx`, load the SPA without a token → both the title shows `⚠ unauthorized` and the ChatWindow shows the token form; submit the right token → both surfaces recover within one tick (no 8 s wait).

## Validation commands

Run from `/home/salva/g/ml/saivage`:

```bash
npm run typecheck
npm run build
npx vitest run web/src/composables/useAuthState.test.ts
```

The full suite is not required to gate this change but is cheap:

```bash
npx vitest run
```

## Rollback strategy

Single commit. Revert restores the duplicated `runtimeStatus = "unauthorized"` write and the `WsStatus = "unauthorized"` enum value with no data-migration concerns. No state is persisted from the new composable.

## Cross-issue ordering note

- **Independent of all other Fxx in the inventory**: F26 only touches `web/src/` plus a one-line read of an existing 401 close behaviour in `src/server/server.ts`. None of the analysis/design depends on a prior F-issue landing.
- **Mild affinity with F10 (orphan CSS, [F26-spa-auth-state-duplicated.md](../F26-spa-auth-state-duplicated.md) "Related" section):** the App.vue script shrinks by ~10 lines, which may surface or hide unused style selectors in App.vue's style block. F10 can land before or after; no required order.
- Does **not** block, and is not blocked by, any backend Fxx — `src/server/server.ts:L661-L668` is referenced read-only.
