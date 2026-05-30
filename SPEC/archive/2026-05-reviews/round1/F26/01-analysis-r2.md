# F26 — Analysis r2

## Changes from r1

- Split the ChatWindow citation: the connection chip / status derivation references stay at [web/src/components/ChatWindow.vue](web/src/components/ChatWindow.vue#L38-L66), and the token-form template gate is now cited separately at [web/src/components/ChatWindow.vue](web/src/components/ChatWindow.vue#L279-L284). The previous single range covered status derivation only and did not actually contain the `v-if="displayStatus === 'unauthorized'"` auth panel; this corrects the reviewer's r1 finding.
- No other content changes; the problem diagnosis, contract, and constraints are unchanged.

## Problem restated

The SPA has two independent detectors of "the API token is wrong" — one per transport — and they neither share state nor coordinate recovery.

1. HTTP polling in `App.vue` calls `/api/state` every 8 s and, on a 401 from `apiFetch`, sets a local `runtimeStatus = "unauthorized"` string used by the document-title watcher.
   - Trigger: [web/src/App.vue](web/src/App.vue#L122-L139), check at [web/src/App.vue](web/src/App.vue#L132-L135).
   - Consumer: [web/src/App.vue](web/src/App.vue#L152-L159) (title watcher renders `"⚠ unauthorized"`).
2. WebSocket session in `useWebSocket` watches for close codes `1008 / 4401 / 4403` and sets its own `status = "unauthorized"` plus a one-shot `stopped` flag that disables further reconnect attempts.
   - Trigger: [web/src/composables/useWebSocket.ts](web/src/composables/useWebSocket.ts#L62-L75).
   - Consumers:
     - Connection chip + status derivation in [web/src/components/ChatWindow.vue](web/src/components/ChatWindow.vue#L38-L66).
     - Token-form auth panel template branch in [web/src/components/ChatWindow.vue](web/src/components/ChatWindow.vue#L279-L284).

Both detectors observe the same backend gate (`apiToken` rejection inside the Fastify server: [src/server/server.ts](src/server/server.ts#L661-L668) for WS, plus the `/api/*` preHandler that returns 401 the same way). The recovery action — `setApiToken(newToken)` followed by reconnecting — is wired into only one of the two detectors: `ChatWindow.submitToken` calls `useWebSocket.reconnect()` ([web/src/components/ChatWindow.vue](web/src/components/ChatWindow.vue#L216-L222)) but does not nudge the HTTP poll. The App.vue side has no equivalent recover action at all; it just waits for the next 8 s tick.

## Actual differences

| Concern | HTTP path (`App.vue`) | WS path (`useWebSocket.ts`) |
| --- | --- | --- |
| Source signal | `ApiError.status === 401` thrown by `apiFetch` | close codes `1008`, `4401`, `4403` |
| State variable | `runtimeStatus: Ref<string>` (overloaded with phase strings) | `status: Ref<WsStatus>` (`"unauthorized"` as one of 4 enum values) |
| Latches further attempts? | No — every 8 s the poll retries and either succeeds or re-sets the same string | Yes — `stopped = true` disables `scheduleReconnect`; only the explicit `reconnect()` call re-enables it |
| Recovery trigger | None (passive — waits for next successful poll to overwrite the string) | `reconnect()` from `submitToken` after `setApiToken` |
| Token-set side effects | None on `setApiToken` ([web/src/utils/api.ts](web/src/utils/api.ts#L60-L69)): just writes localStorage | None on `setApiToken`; reconnect is a separate call site in `ChatWindow` |

The duplication is two-fold:

- Two predicates compute the same "auth is bad" condition from different backend signals.
- Two state variables expose it to the UI in different shapes (a string-typed flag vs an enum member), and the title-sync watcher reads one of them while the connection chip + token-form gate read the other.

## Contract

What a single source of truth for SPA auth state must provide:

- **Inputs (writes):**
  - `markUnauthorized()`: called by the HTTP path when `apiFetch` throws `ApiError { status: 401 }`, and by the WS path on close codes `1008 / 4401 / 4403`.
  - `setApiToken(token: string | null)`: replaces the bearer token in localStorage **and** clears the unauthorized flag **and** requests transports to retry.
- **Outputs (reads):**
  - `unauthorized: Readonly<Ref<boolean>>`: true while at least one transport has reported an auth failure since the last token change or successful exchange.
  - `onRetry(handler)`: subscription used by each transport to learn it should drop "stopped" state and reconnect / re-poll once the operator submits a new token.
- **Lifecycle:** module-scope singleton (a single browser tab has one set of credentials). No teardown is needed; `onUnmounted` of the SPA root is the end of life.
- **Error modes:** the composable itself does no I/O and cannot fail. Transports keep their own connection/error reporting; only the auth-bad bit is centralised.

## Call sites & dependencies

- HTTP transport: [web/src/utils/api.ts](web/src/utils/api.ts#L106-L125) throws `ApiError` with `status: 401`. Every component that calls `apiFetch` (`StatusPanel.vue`, `PlanView.vue`, `FilesView.vue`, `DebugView.vue`, `AgentsView.vue`, App.vue's `pollTitleStatus`) implicitly observes 401s via the thrown error, but only `App.vue` currently inspects `status === 401`. The others just log and ignore.
- WS transport: [web/src/composables/useWebSocket.ts](web/src/composables/useWebSocket.ts#L62-L75) is the only consumer of the WS close-code-based auth detection. `ChatWindow.vue` reads `status.value === "unauthorized"` (via the `displayStatus` debounce wrapper in [web/src/components/ChatWindow.vue](web/src/components/ChatWindow.vue#L44-L55)) to drive both the connection chip ([web/src/components/ChatWindow.vue](web/src/components/ChatWindow.vue#L60-L66)) and the token-form template branch ([web/src/components/ChatWindow.vue](web/src/components/ChatWindow.vue#L279-L284)).
- Token store: [web/src/utils/api.ts](web/src/utils/api.ts#L42-L82) — `getApiToken / setApiToken / withTokenQuery`. `setApiToken` is currently a pure setter with no recovery semantics.
- Server gate: [src/server/server.ts](src/server/server.ts#L661-L668) (WS 1008) and the matching HTTP 401 preHandler. The contract for both is unchanged by this issue.

## Constraints any solution must respect

- **Architecture-first, no backward compatibility (workspace guideline).** Do not leave the old `runtimeStatus === "unauthorized"` string or a parallel `WsStatus = "unauthorized"` variant alongside the new shared state. The old paths must be deleted in the same change.
- **No new abstractions used once.** The shared state must be consumed by **at least** the HTTP poll, the WS composable, and the token-submit flow; otherwise the duplication is just renamed.
- **No defensive code at internal boundaries.** `apiFetch` already throws `ApiError`; the auth composable can rely on that without additional `instanceof` guarding beyond what `App.vue` currently does. The WS composable can rely on its own close-code branch.
- **SPA must remain usable when no token is set** (private deployments — `withTokenQuery` returns the URL unchanged when no token is stored; see [web/src/utils/api.ts](web/src/utils/api.ts#L73-L82)). The shared state's default must be `unauthorized = false`, and it must not flip true just because a request returns 200 without a token.
- **Out-of-scope:** anything under `src/skills/`, `SPEC/v2/skills*`, and memory code. The shared state lives in `web/src/`, which is outside that boundary.
- **WS reconnect semantics:** the existing exponential backoff and the `stopped` latch must be preserved; the only behavioural change is that the latch is **released** when the auth composable broadcasts a retry, instead of only when `ChatWindow.submitToken` directly calls `reconnect()`.
- **Title-sync watcher must keep rendering the unauthorized warning** ([web/src/App.vue](web/src/App.vue#L152-L159)) — the source of the bit changes, not the rendering — and the watcher must be reactive to the shared `unauthorized` ref so that an auth failure from either transport updates the document title immediately (Vue's `watch` only reruns on sources listed in its source array, not on refs merely dereferenced inside the callback).
