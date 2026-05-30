# F26 Review r2

## Reviewer

GPT-5.5 (copilot)

## Documents reviewed

- [SPEC/v2/review-2026-05/_LOOP-CONVENTIONS.md](SPEC/v2/review-2026-05/_LOOP-CONVENTIONS.md)
- [SPEC/v2/review-2026-05/F26-spa-auth-state-duplicated.md](SPEC/v2/review-2026-05/F26-spa-auth-state-duplicated.md)
- [SPEC/v2/review-2026-05/F26/04-review-r1.md](SPEC/v2/review-2026-05/F26/04-review-r1.md)
- [SPEC/v2/review-2026-05/F26/01-analysis-r2.md](SPEC/v2/review-2026-05/F26/01-analysis-r2.md)
- [SPEC/v2/review-2026-05/F26/02-design-r1.md](SPEC/v2/review-2026-05/F26/02-design-r1.md)
- [SPEC/v2/review-2026-05/F26/03-plan-r2.md](SPEC/v2/review-2026-05/F26/03-plan-r2.md)
- Spot-checks: [web/src/App.vue](web/src/App.vue#L122-L159), [web/src/composables/useWebSocket.ts](web/src/composables/useWebSocket.ts#L9-L133), [web/src/utils/api.ts](web/src/utils/api.ts#L60-L125), [web/src/components/ChatWindow.vue](web/src/components/ChatWindow.vue#L38-L66), [web/src/components/ChatWindow.vue](web/src/components/ChatWindow.vue#L216-L284), [src/server/server.ts](src/server/server.ts#L58-L76), [src/server/server.ts](src/server/server.ts#L661-L668)

## Findings

### Analysis

The r1 citation issue is resolved. The analysis now separates the connection-chip/status derivation at [web/src/components/ChatWindow.vue](web/src/components/ChatWindow.vue#L38-L66) from the token-form template gate at [web/src/components/ChatWindow.vue](web/src/components/ChatWindow.vue#L279-L284), and both references match the checked code.

The underlying diagnosis remains factual. The HTTP title path still turns a 401 from `apiFetchJson("/api/state")` into a local `runtimeStatus.value = "unauthorized"` state in [web/src/App.vue](web/src/App.vue#L122-L139), while the WebSocket path still exposes a separate `WsStatus = "unauthorized"` and stops reconnecting on auth close codes in [web/src/composables/useWebSocket.ts](web/src/composables/useWebSocket.ts#L9-L75). The token recovery asymmetry is also present: `setApiToken` only stores the token in [web/src/utils/api.ts](web/src/utils/api.ts#L60-L69), and [web/src/components/ChatWindow.vue](web/src/components/ChatWindow.vue#L216-L222) performs a separate `reconnect()`.

### Design

Proposal A remains the appropriate implementation target. It removes the duplicated SPA auth state at the root by introducing a shared `useAuthState` bit plus retry signal, while deleting the old `runtimeStatus === "unauthorized"` overload and the `WsStatus = "unauthorized"` variant. That satisfies the architecture-first and no-backward-compatibility guidelines.

Proposal B is still reasonably rejected for this issue. The checked code supports a narrow cross-transport auth-state fix; a broader connection store would add speculative HTTP/WS health surface that F26 does not require.

### Plan

The r1 executability gap is closed. Step 4 now explicitly adds `unauthorized` to the `watch` source array in [web/src/App.vue](web/src/App.vue#L152-L159), so title updates are reactive to auth failures from either transport rather than only to `runtimeStatus`, `runtimeStage`, or tab changes.

The remaining steps are executable against the current code. The new composable has clear writers and readers, `setApiToken` becomes the recovery API, `useWebSocket` releases its stopped latch through the retry callback, `ChatWindow` stops calling `reconnect()` directly, and the focused `useAuthState` Vitest coverage plus `npm run typecheck`, `npm run build`, and focused Vitest command match the repository conventions.

## Required changes

## Strengths

The round-2 plan addresses the only blocker without expanding scope. The proposed implementation is small, deletes the duplicated auth paths instead of preserving them, and gives an engineer enough concrete edit steps and validation commands to implement safely.

VERDICT: APPROVED