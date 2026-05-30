# F26 Review r1

## Reviewer

GPT-5.5 (copilot)

## Documents reviewed

- [SPEC/v2/review-2026-05/_LOOP-CONVENTIONS.md](SPEC/v2/review-2026-05/_LOOP-CONVENTIONS.md)
- [SPEC/v2/review-2026-05/F26-spa-auth-state-duplicated.md](SPEC/v2/review-2026-05/F26-spa-auth-state-duplicated.md)
- [SPEC/v2/review-2026-05/F26/01-analysis-r1.md](SPEC/v2/review-2026-05/F26/01-analysis-r1.md)
- [SPEC/v2/review-2026-05/F26/02-design-r1.md](SPEC/v2/review-2026-05/F26/02-design-r1.md)
- [SPEC/v2/review-2026-05/F26/03-plan-r1.md](SPEC/v2/review-2026-05/F26/03-plan-r1.md)
- Spot-checks: [web/src/App.vue](web/src/App.vue#L44-L159), [web/src/composables/useWebSocket.ts](web/src/composables/useWebSocket.ts#L9-L133), [web/src/utils/api.ts](web/src/utils/api.ts#L60-L123), [web/src/components/ChatWindow.vue](web/src/components/ChatWindow.vue#L38-L66), [web/src/components/ChatWindow.vue](web/src/components/ChatWindow.vue#L279-L284), [src/server/server.ts](src/server/server.ts#L58-L72), [src/server/server.ts](src/server/server.ts#L661-L668)

## Findings

### Analysis

The core diagnosis is correct. The HTTP title-poll path stores auth failure as a local `runtimeStatus` magic string in [web/src/App.vue](web/src/App.vue#L123-L139), while the WebSocket path exposes `"unauthorized"` through `WsStatus` and latches reconnects in [web/src/composables/useWebSocket.ts](web/src/composables/useWebSocket.ts#L9-L133). The recovery asymmetry is also real: [web/src/utils/api.ts](web/src/utils/api.ts#L60-L69) only stores the token, while [web/src/components/ChatWindow.vue](web/src/components/ChatWindow.vue#L216-L222) separately calls `reconnect()`.

One citation should be tightened before the next round. The analysis cites [web/src/components/ChatWindow.vue](web/src/components/ChatWindow.vue#L38-L66) for both the connection chip and token form. That range covers the status derivation and connection label, but the token-form gate itself is the template branch at [web/src/components/ChatWindow.vue](web/src/components/ChatWindow.vue#L279-L284). This is easy to fix, but the loop conventions require concrete file-line references to match the actual code.

### Design

Proposal A is the right shape for F26. A shared `useAuthState` composable with one auth-failure bit and one retry signal removes the duplicated state without inventing a wider connection store. It also respects the architecture-first guidance by deleting the old `WsStatus = "unauthorized"` member and the `runtimeStatus === "unauthorized"` overload instead of keeping parallel compatibility paths.

Proposal B is reasonably rejected as too broad for this issue. The current source only needs a cross-transport auth signal; centralizing unrelated HTTP and WS health slots would create abstraction surface without a present second consumer.

### Plan

There is one blocking executability gap in the App.vue step. The plan says the title watcher should read the shared `unauthorized` ref, but it does not say to add that ref to the watch source. The current watcher only observes [web/src/App.vue](web/src/App.vue#L152-L159) `runtimeStatus`, `runtimeStage`, and `activeTabConfig`. In Vue, reading `unauthorized.value` inside a `watch` callback is not enough to make the watcher rerun when the ref changes.

That matters for the exact behavior F26 is meant to fix. After the proposed WS change, an auth close in [web/src/composables/useWebSocket.ts](web/src/composables/useWebSocket.ts#L63-L71) would call `markUnauthorized()` while `runtimeStatus` and `runtimeStage` may remain unchanged. Likewise, the proposed HTTP 401 branch clears those strings, so an initial unauthorized poll can leave them as already-empty values. Without `unauthorized` as an actual reactive dependency, the document title can fail to show the auth warning even though the shared auth bit is true.

The rest of the plan is executable: the token setter becomes the recovery API, the WebSocket stopped latch is released through retry, ChatWindow stops directly calling `reconnect()`, and the new pure composable test is a good focused unit test. The validation commands use the repo's Vitest, typecheck, and build conventions.

## Required changes

1. Update the App.vue design/plan so the document-title sync is reactive to the shared auth state. For example, include `unauthorized` in the `watch` source array or replace the watcher with an equivalent computed/effect that depends on `unauthorized`, `runtimeStatus`, `runtimeStage`, and `activeTabConfig`. The plan must make clear that both WS auth closes and HTTP 401s update the title immediately.
2. Correct the ChatWindow token-form citation in the analysis or split it into two references: [web/src/components/ChatWindow.vue](web/src/components/ChatWindow.vue#L38-L66) for status derivation/labeling and [web/src/components/ChatWindow.vue](web/src/components/ChatWindow.vue#L279-L284) for the auth-panel template gate.

## Strengths

The proposed architecture is appropriately small and removes the duplicated auth state at the source. The writer also correctly avoids server changes, avoids compatibility shims, scopes the test addition to the new composable, and keeps the validation commands aligned with this repo's tooling.

VERDICT: CHANGES_REQUESTED