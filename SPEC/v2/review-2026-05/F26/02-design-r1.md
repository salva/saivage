# F26 — Design r1

Two proposals. Both delete the duplicated "unauthorized" handling rather than keeping both paths. They differ in how much surface they centralise.

## Proposal A — `useAuthState` composable owning the unauthorized bit and the retry signal

### Scope (files touched)

- **New:** `web/src/composables/useAuthState.ts` (~40 lines).
- **Modified:**
  - [web/src/utils/api.ts](web/src/utils/api.ts#L60-L69): `setApiToken` calls the composable to clear the unauthorized flag and broadcast retry.
  - [web/src/composables/useWebSocket.ts](web/src/composables/useWebSocket.ts#L26-L132): subscribe to the composable's retry signal to drop the `stopped` latch; on a 1008/4401/4403 close, call `markUnauthorized()` instead of (or alongside) setting its own `status`.
  - [web/src/App.vue](web/src/App.vue#L44-L159): drop the `runtimeStatus = "unauthorized"` overload; in `pollTitleStatus` call `markUnauthorized()` on 401; the title watcher reads `unauthorized` from the composable instead of from the `runtimeStatus` string.
  - [web/src/components/ChatWindow.vue](web/src/components/ChatWindow.vue#L38-L222): `submitToken` calls only `setApiToken(value)` (no separate `reconnect()`; that is now a side effect of `setApiToken`).

### What gets added

```ts
// web/src/composables/useAuthState.ts
const unauthorized = ref(false);
const retryHandlers = new Set<() => void>();

export function useAuthState() {
  return {
    unauthorized: readonly(unauthorized),
    markUnauthorized() { unauthorized.value = true; },
    clearUnauthorized() { unauthorized.value = false; },
    onRetry(handler: () => void) {
      retryHandlers.add(handler);
      return () => { retryHandlers.delete(handler); };
    },
    requestRetry() {
      unauthorized.value = false;
      for (const handler of retryHandlers) handler();
    },
  };
}
```

`setApiToken` becomes the single public recovery API:

```ts
export function setApiToken(token: string | null): void {
  cachedToken = token;
  // ... write localStorage ...
  useAuthState().requestRetry();
}
```

### What gets removed

- The `"unauthorized"` member of `WsStatus` in [web/src/composables/useWebSocket.ts](web/src/composables/useWebSocket.ts#L9). After the change, `status` only describes the WS connection (`"connecting" | "open" | "closed"`); whether the *reason for being closed* is auth is read from `useAuthState`. The `stopped` latch stays, but is released on the retry handler.
- The `status === "unauthorized"` branch in [web/src/components/ChatWindow.vue](web/src/components/ChatWindow.vue#L44-L66). The token form is shown when `useAuthState().unauthorized.value` is true, regardless of which transport reported it. `connectionLabel` only handles real WS states.
- The `runtimeStatus.value = "unauthorized"` write and the magic-string check in the title watcher ([web/src/App.vue](web/src/App.vue#L132-L155)). `runtimeStatus` goes back to being a pure phase/status string.

### Risk

Low. The state lives entirely in the SPA process; no protocol or server change. The only behavioural change visible to operators is the desirable one called out in the issue: submitting a new token recovers both transports in the same gesture.

Risk to existing tests: there is no Vitest coverage for `useWebSocket` or App.vue's title sync (verified by file presence — `web/src` has no `*.test.ts` files for these composables/SFCs). The change can be validated via type-check, build, and a manual smoke (token rejected → token accepted) — the same surface the current code has.

### What it enables (cross-links)

- Cross-link to **F10 (orphan CSS)** — `App.vue` shrinks slightly, which may make a follow-up pruning of orphan styles in `App.vue`'s style block easier, but no direct dependency.
- Centralised retry makes it cheap for any future component (e.g., a dashboard banner) to react to auth failures by adding a single watcher. No additional component change is in scope of F26.

### What it forbids

- No second "unauthorized boolean" anywhere in `web/src/` after this lands. A grep for `"unauthorized"` in the SPA should match only:
  - the composable definition,
  - the title-watcher rendering,
  - the close-code comment in `useWebSocket`,
  - the token-form copy in `ChatWindow`.

### Recommendation note

Recommend Proposal A. It directly removes the duplication, owns exactly the contract the analysis identified (the unauthorized bit + the retry signal + the token setter), and avoids inventing a broader "connection store" abstraction whose other slots have no current consumer.

---

## Proposal B — Move all transport state into a single `useConnectionState` store

### Scope (files touched)

- **New:** `web/src/state/connection.ts` exporting a reactive store with three slices:
  - `auth: { unauthorized: boolean }`
  - `ws: { status: "connecting" | "open" | "closed"; lastError: string | null }`
  - `http: { lastPollAt: number | null; lastPollOk: boolean }`
  - and actions `markUnauthorized()`, `setApiToken(token)` (re-exported from `api.ts`), `requestRetry()`.
- **Modified:**
  - [web/src/utils/api.ts](web/src/utils/api.ts#L106-L125): `apiFetch` reports `http.lastPollAt / lastPollOk` and calls `markUnauthorized()` on 401, **before** throwing — so individual components no longer need to inspect `ApiError.status`. The 401 catch in [App.vue](web/src/App.vue#L131-L138) becomes "catch and ignore"; the bit is set by the centralised fetch wrapper.
  - [web/src/composables/useWebSocket.ts](web/src/composables/useWebSocket.ts): publishes its status into `ws.status`; the local `status` ref is removed. On 1008/4401/4403 it calls `markUnauthorized()` and sets `ws.lastError = "unauthorized close"`. The `unauthorized` enum value disappears.
  - [web/src/App.vue](web/src/App.vue) and all components read `useConnectionState()` instead of holding their own status refs.
  - [web/src/components/ChatWindow.vue](web/src/components/ChatWindow.vue): reads `ws.status` and `auth.unauthorized` from the store; `submitToken` calls `setApiToken(value)` which broadcasts retry.

### What gets added

A single module-scope reactive object (`reactive({...})`) and a small action surface. ~80–100 lines including types. All existing imports of `useWebSocket` keep working but the returned shape narrows.

### What gets removed

Same removals as Proposal A, **plus**:

- The `status` ref returned by `useWebSocket` (the store owns it now).
- The 401 branch in `App.vue`'s `pollTitleStatus` (centralised in `apiFetch`).
- Per-component pattern of "catch ApiError, log, set local error string" gets a uniform `http.lastPollOk` channel — though F26 itself does not require consuming it.

### Risk

Medium. Wider blast radius across the SPA. Components that currently use `connected` from `useWebSocket` need to switch to `ws.status === "open"`. There is no test coverage to catch a missed call site; the change relies on type-check / build to flag stragglers. The centralised `markUnauthorized()` inside `apiFetch` slightly couples the HTTP utility to SPA reactive state, which is acceptable but worth flagging.

### What it enables (cross-links)

- A future global auth banner (no F-issue currently demanding it) becomes a one-liner.
- A future "connection health" indicator (no current consumer) is pre-wired.

### What it forbids

Same forbids as Proposal A, plus: no further `useWebSocket()` callers may keep their own `connected` / `status` mirrors; everyone reads the store.

### Recommendation note

Plausible as a follow-up if other Fxx need cross-transport signals, but for F26 alone it builds three slots (`auth`, `ws`, `http`) where only one (`auth`) currently has two writers and two readers. The other two slots are speculative — they violate "no abstractions used once" for the current change set.

---

## Recommendation

**Proposal A.** It removes exactly the duplication identified in F26 — the parallel "unauthorized" bits and the missing recover-both-transports gesture — without introducing speculative store slots. The shared composable has at least two writers (`apiFetch` 401 detection via `App.vue`, WS close-code handler) and at least two readers (title watcher, ChatWindow token-form gate), which clears the "no abstraction used once" bar.

Proposal B is deferred until at least one additional cross-transport signal needs a home; revisit if a future F-issue calls for it.
